#!/usr/bin/env node
// setup-db.mjs - Deterministic core for /add-db (Scaleway Serverless SQL Database
// + Drizzle, single-project mode).
//
// Creates a dedicated IAM Application + policy + non-expiring API key for the app
// to connect with, provisions a Scaleway Serverless SQL Database (PostgreSQL 16,
// region fr-par), builds the IAM-authenticated DATABASE_URL and stores it in
// Secret Manager, swaps the Next.js project's Drizzle client onto `pg` +
// drizzle-orm/node-postgres, and ships `src/server/db/safe.ts` (the `tryDb`
// resilience helper - CONTRACT.md §4/§6). IAM access is created first so a
// hard IAM failure never leaves an orphan database behind (see the comment
// above STEPS).
//
// MONOREPO is NOT supported in this v1 - the script refuses --monorepo with a
// clear message; Claude is expected to handle that case manually (rare, involves
// non-trivial code moves into packages/db/) following add-db SKILL.md Step 2.
//
// What this script deliberately does NOT do (see CONTRACT.md §1/§4):
//   - It never writes DATABASE_URL to a local .env file, and never runs
//     `drizzle-kit push` / `drizzle-kit studio` / any command that opens a
//     connection to the database. The operator's machine never connects to the
//     database - DATABASE_URL lives only in Scaleway Secret Manager. Schema
//     changes are applied by `drizzle-kit migrate` running inside the migration
//     Serverless Job that `/deploy` launches, never here.
//   - It never enables "backups" as an action - Scaleway Serverless SQL Database
//     backs itself up automatically (daily, 7-day retention) with no on/off
//     switch and no separate API to call. Verified against Scaleway's own docs:
//     https://www.scaleway.com/en/docs/serverless-sql-databases/how-to/manage-backups/
//     ("Serverless SQL Databases are automatically backed up every day at the
//     same time. Backups are stored for 7 days.") - there is no on-demand
//     backup-creation API, which is exactly why deleteDatabase() (sdb.mjs) is
//     guarded (_destructive-guard.mjs) and this script never calls it.
//
// Usage:
//   node setup-db.mjs --name <project-name> [--web-dir .] [--monorepo]
//
// Args:
//   --name        Database name (also used to derive the IAM Application name)
//   --web-dir     Directory containing package.json + next dep (default: cwd)
//   --monorepo    If passed, the script fails - monorepo handling is Claude-piloted in v1.
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end (success OR failure)
//   - Last line on success: a single JSON object Claude can parse:
//       {"success": true, "databaseId": "...", "endpoint": "...", "databaseName": "..."}
//
// Exit codes:
//   0 = success
//   1 = preflight failed (bad args, missing credentials, in monorepo)
//   2 = a step failed mid-pipeline; partial state on disk/on Scaleway; handoff banner explains

import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { render } from "./_render.mjs";
import { requireCredentials, ScwError } from "./scaleway/_scw-auth.mjs";
import { ensureDatabase, waitForDatabaseReady, buildConnectionString } from "./scaleway/sdb.mjs";
import { ensureApplication, ensurePolicy, createApiKey, DELEGATED_DB_KEY_SECRET_NAME } from "./scaleway/iam.mjs";
import { getSecret, putSecret } from "./scaleway/secrets.mjs";
import { devDbCredentials } from "./scaleway/app-credentials.mjs";

// Permission set for the app's own database connection: read/write, not
// full-access. ServerlessSQLDatabaseFullAccess also grants provisioning and
// deletion of database *instances*, which a running app connection has no
// business doing - see scripts/scaleway/iam.mjs header comment.
const DB_PERMISSION_SETS = ["ServerlessSQLDatabaseReadWrite"];

// Per-request delegation: the operator's own key mints its own IAM access
// when it can. When it cannot (no IAMManager), the operator's personal key
// powers the database connection instead (see scripts/scaleway/app-credentials.mjs) -
// so this message is now a RARE last resort, only reached when even the
// personal-key fallback fails (devDbCredentials()'s principal cannot be
// resolved). It is the forwardable French request for that rare handover.
const NEEDS_ADMIN_DB_MESSAGE =
  "Ni votre clé Scaleway ni votre clé personnelle ne permettent de créer les accès de la base de données. " +
  "Ce cas est rare : contactez le support si vous le rencontrez. " +
  "L’administrateur doit créer une application IAM, une politique limitée à ce projet avec le droit " +
  "ServerlessSQLDatabaseReadWrite, une clé API, puis stocker " +
  '{"application_id":"...","secret_key":"..."} dans le secret BAUDRIER_DB_KEY de ce projet. ' +
  "Voir docs/ADMIN-SCALEWAY.md.";

const MALFORMED_DELEGATED_KEY_MESSAGE =
  `Le secret ${DELEGATED_DB_KEY_SECRET_NAME} ne contient pas le format attendu. ` +
  'Il doit être un JSON avec les champs "application_id" et "secret_key" (deux chaînes non vides).';

// ─── run state (declared before arg parsing - fail()/dumpHandoff() below can
// be called from inside the arg-parsing loop itself, so everything they touch
// must already be initialized by then, not just declared with a later const) ─
// ensureIamAccess runs before ensureDatabase: the IAM step does not need the
// database (it only derives the IAM Application name from --name), and
// creating IAM access first closes the orphan-database window - if IAM
// creation fails hard, no database exists yet for _destructive-guard.mjs to
// refuse to clean up. A hard failure here is already rare (the
// personal-key fallback absorbs most permission gaps), but this ordering
// removes the window entirely rather than just shrinking it.
const STEPS = ["preflight", "ensureIamAccess", "ensureDatabase", "storeSecret", "installDriver", "swapDriver"];
const completed = [];
const warnings = [];
let current = null;
let WEB_DIR = null;
// State accumulated during the run; emitted as JSON on success.
const state = {
  databaseName: null,
  databaseId: null,
  endpoint: null,
  port: null,
  applicationId: null,
  connectionString: null,
};

// ─── helpers ──────────────────────────────────────────────────────────
async function step(stepName, fn) {
  current = stepName;
  await fn();
  completed.push(stepName);
  current = null;
}

function log(msg) {
  console.log(`\n▸ ${msg}`);
}
function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
  warnings.push(msg);
}

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-db handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) during the run:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }
  if (!success) {
    console.log(
      "\nFor the agent picking this up:\n" +
        `  - Web dir: ${WEB_DIR || "(not resolved yet)"}\n` +
        `  - IAM Application (if created): ${state.applicationId || "not created"}\n` +
        `  - Database (if created): ${state.databaseId || "not created"}\n` +
        "  - Each step in this script maps 1:1 to a section of add-db SKILL.md.\n" +
        "  - DATABASE_URL, if it was built, was never printed to a persistent file - it only\n" +
        "    ever lives in Secret Manager (once storeSecret has run) or in this process's memory.\n",
    );
  }
  console.log("────────────────────────────────────────────────────────");
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  if (completed.length || current) dumpHandoff(false);
  process.exit(completed.length || current ? 2 : 1);
}

process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e instanceof ScwError && e.details) console.error(JSON.stringify(e.details));
  else if (e.stack) console.error(e.stack);
  dumpHandoff(false);
  process.exit(2);
});

function run(cmd, cwd, opts = {}) {
  const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
  const res = spawnSync(cmdStr, {
    cwd,
    stdio: opts.capture ? "pipe" : "inherit",
    shell: true,
    encoding: "utf8",
  });
  if (res.status !== 0 && !opts.allowFail) {
    if (opts.capture) {
      if (res.stdout) process.stderr.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    fail(`Command failed (exit ${res.status}): ${cmdStr}`);
  }
  return res;
}

function capture(cmd, cwd) {
  return run(cmd, cwd, { capture: true, allowFail: true });
}

// ─── args ─────────────────────────────────────────────────────────────
// Parsed after every helper above is defined, so a bad/missing arg can safely
// call fail() (which reads `completed`/`current`/`WEB_DIR` - all already
// declared, even if not yet assigned).
const args = process.argv.slice(2);
let name = "";
let webDir = ".";
let monorepoFlag = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else if (a === "--monorepo") monorepoFlag = true;
  else fail(`Unknown arg: ${a}`);
}

if (!name) {
  fail('Usage: node setup-db.mjs --name NAME [--web-dir .] [--monorepo]');
}
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}

WEB_DIR = resolve(process.cwd(), webDir);
state.databaseName = name;

// ─── Step 1: preflight ────────────────────────────────────────────────
async function preflight() {
  log("Preflight");

  if (monorepoFlag) {
    fail(
      "MONOREPO_NOT_SUPPORTED_IN_V1: setup-db.mjs only handles single-project setups. " +
        "For monorepos (apps/web + packages/db pattern), Claude must scaffold the shared " +
        "packages/db package manually following the add-db SKILL.md Step 2 instructions.",
    );
  }

  // Fail fast with a friendly, actionable message rather than letting the
  // first Scaleway API call surface a raw error deep inside a later step.
  requireCredentials();

  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`No package.json at ${WEB_DIR}. Pass --web-dir <path-to-nextjs-app> if needed.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) fail(`${WEB_DIR} doesn't depend on Next.js - add-db requires a Next.js project.`);
  if (!deps["drizzle-orm"]) {
    fail(
      `${WEB_DIR} doesn't depend on drizzle-orm - this script assumes a T3 scaffold has run first. ` +
        "Run /bootstrap before /add-db, or install Drizzle manually.",
    );
  }

  // pnpm available?
  const pnpm = capture("pnpm --version", WEB_DIR);
  if (pnpm.status !== 0) fail("pnpm CLI is missing or broken.");

  ok(`Web dir OK: ${WEB_DIR}`);
}

// ─── Step 2: dedicated IAM Application + policy + non-expiring API key ─
// (or the admin-delegated key, when the operator's own key lacks IAMManager)
// Runs before the database is provisioned - see the comment above STEPS.
async function ensureIamAccess() {
  log(`Creating dedicated IAM access for "${name}"`);
  const creds = requireCredentials();

  try {
    const application = await ensureApplication(`${name}-db`);
    state.applicationId = application.id;
    ok(`IAM Application ${application.name} (${application.id})`);

    await ensurePolicy({
      applicationId: application.id,
      projectId: creds.projectId,
      permissionSetNames: DB_PERMISSION_SETS,
    });
    ok(`Policy attached: ${DB_PERMISSION_SETS.join(", ")}`);

    // Deliberately NO expiry (see scripts/scaleway/iam.mjs createApiKey docs) -
    // DATABASE_URL embeds this key, so an expiring key would silently break the
    // app in production the day it lapses.
    const key = await createApiKey({
      applicationId: application.id,
      projectId: creds.projectId,
      description: `DATABASE_URL for ${name} (baudrier, no expiry)`,
    });
    state.dbSecretKey = key.secretKey;
    ok(`API key created (no expiry): ${key.accessKey}`);
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;

    log("Operator key lacks IAMManager - looking for the admin-delegated key");
    let raw;
    try {
      raw = await getSecret(DELEGATED_DB_KEY_SECRET_NAME);
    } catch (secretErr) {
      if (secretErr?.type !== "not_found") throw secretErr;

      log("No admin-delegated key yet - falling back to your personal Scaleway key for development");
      let dev;
      try {
        dev = await devDbCredentials();
      } catch {
        throw new ScwError(NEEDS_ADMIN_DB_MESSAGE, {
          type: "needs_admin",
          details: {
            recipe: "db",
            secretName: DELEGATED_DB_KEY_SECRET_NAME,
            appName: `${name}-db`,
            permissionSets: DB_PERMISSION_SETS,
            projectId: creds.projectId,
          },
        });
      }
      state.applicationId = dev.principalId;
      state.dbSecretKey = dev.secretKey;
      ok("Using your personal Scaleway key for now.");
      return;
    }

    let delegated;
    try {
      delegated = JSON.parse(raw);
    } catch {
      throw new ScwError(MALFORMED_DELEGATED_KEY_MESSAGE, { type: "malformed_delegated_key" });
    }
    const applicationId = typeof delegated?.application_id === "string" ? delegated.application_id.trim() : "";
    const secretKey = typeof delegated?.secret_key === "string" ? delegated.secret_key.trim() : "";
    if (!applicationId || !secretKey) {
      throw new ScwError(MALFORMED_DELEGATED_KEY_MESSAGE, { type: "malformed_delegated_key" });
    }
    state.applicationId = applicationId;
    state.dbSecretKey = secretKey;
    ok(`Using the admin-delegated key from secret ${DELEGATED_DB_KEY_SECRET_NAME}`);
  }
}

// ─── Step 3: provision the Serverless SQL Database ─────────────────────
async function ensureDatabaseStep() {
  log(`Provisioning Scaleway Serverless SQL Database "${name}" (region fr-par, PostgreSQL 16)`);
  let db = await ensureDatabase(name);
  state.databaseId = db.id;

  if (db.status !== "ready") {
    log("Waiting for the database to become ready...");
    db = await waitForDatabaseReady(db.id);
  }
  state.endpoint = db.endpoint;
  state.port = db.port;
  ok(`Database ${db.id} ready · endpoint: ${db.endpoint}:${db.port}`);
}

// ─── Step 4: build DATABASE_URL and store it in Secret Manager ────────
async function storeSecret() {
  log("Building DATABASE_URL and storing it in Secret Manager");
  state.connectionString = buildConnectionString({
    endpoint: state.endpoint,
    port: state.port,
    dbName: name,
    applicationId: state.applicationId,
    secretKey: state.dbSecretKey,
  });
  // Never persisted to disk, never logged - handed straight to Secret Manager.
  await putSecret("DATABASE_URL", state.connectionString);
  // Drop the in-memory copy of the raw secret once it's safely stored; keep
  // only what the rest of the script and the handoff banner need.
  delete state.dbSecretKey;
  ok("DATABASE_URL stored in Secret Manager (never written to a local file)");
}

// ─── Step 5: install pg + drizzle-orm/node-postgres, drop any leftover serverless-driver dependency ─
async function installDriver() {
  log("Installing pg (node-postgres) driver");
  run("pnpm add pg", WEB_DIR);
  run("pnpm add -D @types/pg", WEB_DIR);

  const pkgPath = join(WEB_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["@neondatabase/serverless"]) {
    run("pnpm remove @neondatabase/serverless", WEB_DIR, { allowFail: true });
  }
  ok("pg + @types/pg installed");
}

// ─── Step 6: swap Drizzle client to node-postgres, ship the resilience helper ─
async function swapDriver() {
  log("Swapping Drizzle client to drizzle-orm/node-postgres");
  const dbIndexPath = join(WEB_DIR, "src/server/db/index.ts");
  if (!existsSync(dbIndexPath)) {
    fail(
      `${dbIndexPath} not found - T3 may have moved the db client. ` +
        "Locate the db client manually and swap its driver to pg + drizzle-orm/node-postgres " +
        "(see templates/db/index.ts for the exact shape to copy).",
    );
  }

  // Overwrite with the canonical pg-flavored client (template: templates/db/index.ts).
  // We intentionally don't try to preserve user edits to this file - at /add-db time
  // it's the T3 default.
  writeFileSync(dbIndexPath, render("db/index.ts", {}));
  ok("src/server/db/index.ts rewritten for pg + drizzle-orm/node-postgres");

  // Harness-owned, so overwriting on re-run is fine (idempotent) - see
  // templates/db/safe.ts for the rationale (CONTRACT.md §4/§6).
  const dbSafePath = join(WEB_DIR, "src/server/db/safe.ts");
  writeFileSync(dbSafePath, render("db/safe.ts", {}));
  ok("src/server/db/safe.ts written (tryDb helper for DB-outage resilience)");
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("ensureIamAccess", ensureIamAccess);
await step("ensureDatabase", ensureDatabaseStep);
await step("storeSecret", storeSecret);
await step("installDriver", installDriver);
await step("swapDriver", swapDriver);

dumpHandoff(true);

console.log(`
🎉 setup-db complete.

   Database:     ${state.databaseName} (${state.databaseId})
   Endpoint:     ${state.endpoint}:${state.port}
   IAM app:      ${state.applicationId}
   DATABASE_URL: stored in Secret Manager only (never written locally, never logged)

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md) and the user-facing summary.
Reminder: migrations are applied by the migration Serverless Job that /deploy launches -
never locally, never by this script.
`);

// Last line: structured JSON for Claude to parse.
console.log(
  JSON.stringify({
    success: true,
    databaseId: state.databaseId,
    endpoint: state.endpoint,
    port: state.port,
    applicationId: state.applicationId,
    databaseName: state.databaseName,
  }),
);
