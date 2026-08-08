// templates/deploy/migrate.mjs - dependency-light migration runner.
//
// The migration Serverless Job (scripts/deploy.mjs's migrate() step) runs
// `node migrate.mjs` on the same image the app serves from (CONTRACT.md §5).
// That image's runner stage carries only the traced standalone server - no
// devDependencies, so no `drizzle-kit`, and no drizzle/*.sql beyond what the
// Dockerfile COPYs in alongside this file. This script is the migration
// runner that ships in its place: node builtins plus the `pg` driver only.
//
// It reproduces drizzle-orm's node-postgres migrator bookkeeping (schema,
// table, columns, hash algorithm) exactly, so a project that later switches
// back to the official `drizzle-kit migrate` sees a state it recognizes as
// its own. Verified against drizzle-orm's PgDialect.migrate() source
// (drizzle-orm/src/pg-core/dialect.ts): table/column names, the "select
// ... order by created_at desc limit 1" query, the sha256-of-full-file hash
// and the "hash","created_at" insert all match byte for byte. One
// difference is deliberate: the official migrator runs every pending
// migration inside ONE shared transaction; this runner opens one
// transaction PER migration instead, so a Job retry after a mid-batch
// failure never re-attempts work that already committed.
//
// A brand-new project has no database yet, no `pg` in the standalone trace
// (setup-db.mjs, not the base scaffold, adds it - see CONTRACT.md §4) and a
// placeholder DATABASE_URL. The empty-journal check below runs BEFORE the
// `pg` import and before DATABASE_URL is read, so that project stays a safe
// no-op.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(__dirname, "drizzle");
const JOURNAL_PATH = join(DRIZZLE_DIR, "meta", "_journal.json");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

function readJournal() {
  if (!existsSync(JOURNAL_PATH)) return null;
  try {
    return JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
  } catch (e) {
    console.error(`migrate.mjs: could not parse ${JOURNAL_PATH}: ${e.message}`);
    process.exit(1);
  }
}

const journal = readJournal();
if (!journal || !Array.isArray(journal.entries) || journal.entries.length === 0) {
  console.log("migrate.mjs: no migrations to apply (journal is missing or empty).");
  process.exit(0);
}

// Deferred until after the empty-journal check above - see the module
// comment for why: bootstrap-init.mjs guarantees the journal file exists,
// but not that `pg` is installed, and it must not be on a project that
// never ran /add-db.
let Client;
try {
  ({ Client } = await import("pg"));
} catch (e) {
  console.error(`migrate.mjs: could not load the "pg" driver: ${e.message}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("migrate.mjs: DATABASE_URL is not set. Cannot run migrations.");
  process.exit(1);
}

// A single Client, never a Pool: BEGIN/COMMIT must land on the same physical
// connection, and Serverless SQL's session SET/search_path leaks across a
// pooled connection (CONTRACT.md §1/§3) - `Pool.query()` would round-robin
// across connections and silently break both guarantees.
const client = new Client({ connectionString: databaseUrl, ssl: true });

function splitStatements(sql) {
  // Each resulting statement stays under Serverless SQL's 1 MB limit in
  // practice because drizzle-kit already emits one DDL statement per
  // breakpoint - this runner does not re-chunk a statement that is too big.
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  try {
    await client.connect();
  } catch (e) {
    console.error(`migrate.mjs: could not connect to the database: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );

  const { rows } = await client.query(
    `SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`,
  );
  const lastAppliedAt = rows[0] ? Number(rows[0].created_at) : null;

  const pending = journal.entries.filter((entry) => lastAppliedAt === null || entry.when > lastAppliedAt);
  if (pending.length === 0) {
    console.log("migrate.mjs: database already up to date, nothing to apply.");
    return;
  }

  for (const entry of pending) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    let began = false;
    try {
      const fileContent = readFileSync(sqlPath, "utf8");
      const hash = createHash("sha256").update(fileContent).digest("hex");
      const statements = splitStatements(fileContent);

      await client.query("BEGIN");
      began = true;
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES ($1, $2)`,
        [hash, entry.when],
      );
      await client.query("COMMIT");
    } catch (e) {
      if (began) await client.query("ROLLBACK");
      console.error(`migrate.mjs: migration "${entry.tag}" failed: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`migrate.mjs: applied "${entry.tag}"`);
  }
}

try {
  await main();
} finally {
  // A failed connect() leaves nothing to close - swallow that case so it
  // does not overwrite the real error already logged above.
  await client.end().catch(() => {});
}
process.exit(process.exitCode ?? 0);
