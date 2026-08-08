#!/usr/bin/env node
// sdb.mjs - Scaleway Serverless SQL Database (PostgreSQL 16), region fr-par only.
//
// Thin adapter over @scaleway/sdk's ServerlessSqldb v1alpha1 API (see
// CONTRACT.md §3). Talks to /serverless-sqldb/v1alpha1/regions/{region}/databases
// through the SDK instead of hand-written REST.
// Docs: https://www.scaleway.com/en/developers/api/serverless-databases
//       https://www.scaleway.com/en/docs/serverless-sql-databases/how-to/connect-to-a-database/
//
// Confirmed from Scaleway's own docs/tutorials:
//   - cpu_min defaults to 0, cpu_max defaults to 15 (CPU units, not mvCPU - this
//     product scales its own compute independently of Serverless Containers).
//   - The connection endpoint is a bare hostname of the form
//     "{database-id}.pg.sdb.{region}.scw.cloud". The SDK's `Database` type has
//     no `port` field at all, so the port is always the Postgres default 5432.
//   - Auth is IAM: connect with an IAM Application id as the username and that
//     application's API secret key as the password - there is no separate
//     database-level user/password.
//
//   - The REAL status enum (from @scaleway/sdk-serverless-sqldb's
//     dist/v1alpha1/types.gen.d.ts, which ships as part of the pinned SDK -
//     see CONTRACT.md §3 on pinned versions), replacing a previous revision's
//     guessed `/error|disk_full|locked/i` regex:
//
//       export type DatabaseStatus =
//         'unknown_status' | 'error' | 'creating' | 'ready' | 'deleting' |
//         'restoring' | 'locked';
//
//     `disk_full` does NOT exist in the real enum - it was a guess. The SDK
//     also ships `DATABASE_TRANSIENT_STATUSES` (content.gen.js):
//     `["creating", "deleting", "restoring"]` - i.e. `deleting` and
//     `restoring` are indeed real, and are transient (still in progress), not
//     failures. `waitForDatabaseReady()` below uses the SDK's own
//     `waitForDatabase` waiter, whose default `stop` condition is exactly
//     "status is not in DATABASE_TRANSIENT_STATUSES" - so creating/deleting/
//     restoring are polled through automatically instead of falling through
//     to a misleading timeout, and we no longer hard-code the transient set
//     ourselves. Once the waiter resolves, `status` is one of
//     unknown_status/error/ready/locked - we treat `ready` as success and
//     `error`/`locked` as terminal failures explicitly (see
//     TERMINAL_FAILURE_STATUSES below); `unknown_status` reaching us here
//     would mean the waiter gave up without the database ever becoming ready,
//     so it is also treated as a failure rather than silently returned as if
//     it were success.

import { ScwError, requireCredentials, api, sdkCall, slugify } from "./_scw-auth.mjs";
import { assertDestructiveAllowed } from "./_destructive-guard.mjs";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 5432;
const SDB_PRODUCT = "ServerlessSqldb";
const SDB_VERSION = "v1alpha1";

/** Real terminal-failure values of DatabaseStatus (quoted from the SDK's types.gen.d.ts - see header). */
const TERMINAL_FAILURE_STATUSES = new Set(["error", "locked"]);

function normalize(db) {
  if (!db) return null;
  let endpoint = db.endpoint;
  let port = DEFAULT_PORT;
  // Defensive: some Scaleway docs show `endpoint` as a bare hostname
  // ("<id>.pg.sdb.fr-par.scw.cloud"), older examples show it as a full
  // "postgres://host/db" URI. Handle both without throwing. The SDK's
  // `Database` type carries no separate `port` field, so DEFAULT_PORT is the
  // only source of truth unless a URI-style endpoint says otherwise.
  if (typeof endpoint === "string" && endpoint.includes("://")) {
    try {
      const u = new URL(endpoint);
      port = u.port ? Number(u.port) : DEFAULT_PORT;
      endpoint = u.hostname;
    } catch {
      /* leave endpoint as-is */
    }
  }
  return {
    id: db.id,
    name: db.name,
    dbName: db.name,
    status: db.status,
    endpoint,
    port,
    region: db.region,
    cpuMin: db.cpuMin,
    cpuMax: db.cpuMax,
    createdAt: db.createdAt,
    raw: db,
  };
}

// Harness autoscaling bounds. The API's own cpu_max default is 15 CPU units;
// the harness caps new databases at 5 so an unnoticed traffic spike (or a
// runaway query) cannot scale a small app's bill to triple what /scale
// showed the user. `/scale` raises or lowers the bounds on request via
// setDatabaseCpuBounds() below.
export const DB_CPU_MIN_DEFAULT = 0;
export const DB_CPU_MAX_DEFAULT = 5;

/**
 * Find-or-create a Serverless SQL Database by name (idempotent).
 * Endpoint: GET  /serverless-sqldb/v1alpha1/regions/{region}/databases  (find, filtered by name)
 *           POST /serverless-sqldb/v1alpha1/regions/{region}/databases  (create, if not found)
 * @param {string} name
 * @param {object} [o]
 * @param {number} [o.minCpu=0]   cpu_min
 * @param {number} [o.maxCpu=5]   cpu_max (harness default - the API's own is 15)
 * @param {object} [o.opts]       {projectId, organizationId} overrides
 * @returns {Promise<{id,name,dbName,endpoint,port,status}>}
 */
export async function ensureDatabase(name, { minCpu = DB_CPU_MIN_DEFAULT, maxCpu = DB_CPU_MAX_DEFAULT, opts = {} } = {}) {
  const slug = slugify(name);
  const found = await getDatabase(slug, opts);
  if (found) return found;

  const creds = requireCredentials();
  const dbApi = await api(SDB_PRODUCT, SDB_VERSION);
  // Note: CreateDatabaseRequest has no organizationId field in the SDK - only
  // projectId. opts.organizationId is still accepted (used by getDatabase's
  // listDatabases filter above) to keep this function's signature frozen.
  const created = await sdkCall(() =>
    dbApi.createDatabase({
      projectId: opts.projectId || creds.projectId,
      name: slug,
      cpuMin: minCpu,
      cpuMax: maxCpu,
    }),
  );
  return normalize(created);
}

/**
 * Change a database's autoscaling bounds in place.
 * SDK call: updateDatabase({ databaseId, cpuMin, cpuMax }) - verified against
 * the pinned SDK's UpdateDatabaseRequest type (@scaleway/sdk-serverless-sqldb
 * 2.7.1, dist/v1alpha1/types.gen.d.ts: region?, databaseId, cpuMin?, cpuMax?).
 * @param {string} name
 * @param {{minCpu:number, maxCpu:number, opts?:object}} bounds
 * @returns {Promise<{id,name,dbName,endpoint,port,status,cpuMin,cpuMax}>}
 */
export async function setDatabaseCpuBounds(name, { minCpu, maxCpu, opts = {} }) {
  if (!Number.isInteger(minCpu) || !Number.isInteger(maxCpu) || minCpu < 0 || maxCpu > 15 || minCpu > maxCpu) {
    throw new ScwError(
      "bornes CPU invalides : min et max doivent être des entiers, avec 0 <= min <= max <= 15.",
      { type: "invalid_argument" },
    );
  }
  const db = await getDatabase(name, opts);
  if (!db) {
    throw new ScwError(`aucune base de données Serverless SQL nommée « ${slugify(name)} »`, { type: "not_found" });
  }
  const dbApi = await api(SDB_PRODUCT, SDB_VERSION);
  const updated = await sdkCall(() => dbApi.updateDatabase({ databaseId: db.id, cpuMin: minCpu, cpuMax: maxCpu }));
  return normalize(updated);
}

/**
 * Look up a database by exact name. Returns null if none exists.
 * Endpoint: GET /serverless-sqldb/v1alpha1/regions/{region}/databases
 * @param {string} name
 * @param {object} [opts]  {projectId, organizationId}
 * @returns {Promise<object|null>}
 */
export async function getDatabase(name, opts = {}) {
  const slug = slugify(name);
  const creds = requireCredentials();
  const dbApi = await api(SDB_PRODUCT, SDB_VERSION);
  const rows = await sdkCall(() =>
    dbApi
      .listDatabases({
        name: slug,
        projectId: opts.projectId || creds.projectId,
        organizationId: opts.organizationId || creds.organizationId,
      })
      .all(),
  );
  const match = rows.find((d) => d.name === slug) || null;
  return normalize(match);
}

/**
 * Wait for a database to become "ready", or throw on a terminal failure
 * status or timeout. Uses the SDK's own `waitForDatabase` waiter, whose
 * default stop condition is "status is not in DATABASE_TRANSIENT_STATUSES"
 * (creating/deleting/restoring) - see the module header for the confirmed
 * real `DatabaseStatus` enum. Once it stops, only `ready` counts as success;
 * `error` and `locked` are explicit terminal failures, and the residual
 * `unknown_status` is treated as a failure too rather than silently returned
 * as if the database were ready.
 * Endpoint: GET /serverless-sqldb/v1alpha1/regions/{region}/databases/{id}
 * @param {string} id
 * @param {object} [o]
 * @param {number} [o.timeoutMs=300000]
 * @returns {Promise<object>} the normalized, ready database
 */
export async function waitForDatabaseReady(id, { timeoutMs = 300_000 } = {}) {
  const dbApi = await api(SDB_PRODUCT, SDB_VERSION);
  const db = await sdkCall(
    () => dbApi.waitForDatabase({ databaseId: id }, { timeout: Math.max(1, Math.round(timeoutMs / 1000)) }),
    { label: `database ${id} ready` },
  );

  if (db.status === "ready") return normalize(db);

  if (TERMINAL_FAILURE_STATUSES.has(db.status)) {
    throw new ScwError(`Serverless SQL Database ${id} entered failure status "${db.status}"`, {
      type: "database_failed",
      details: db,
    });
  }

  // Only "unknown_status" can reach here (the waiter's stop condition already
  // excludes creating/deleting/restoring, and ready/error/locked are handled
  // above) - treat it as a failure rather than silently returning as ready.
  throw new ScwError(`Serverless SQL Database ${id} left creation with unexpected status "${db.status}"`, {
    type: "database_failed",
    details: db,
  });
}

/**
 * Endpoint: DELETE /serverless-sqldb/v1alpha1/regions/{region}/databases/{id}
 *
 * GUARDED - refuses by default. See _destructive-guard.mjs: Serverless SQL
 * Database has no on-demand backup API, so an accidental deletion here is
 * unrecoverable beyond Scaleway's own 7-day automatic backup window. This
 * harness never deletes a database on its own; a human must set
 * BAUDRIER_ALLOW_DESTRUCTIVE="database:<id>" in their own shell first.
 *
 * @param {string} id
 */
export async function deleteDatabase(id) {
  assertDestructiveAllowed("database", id);
  const dbApi = await api(SDB_PRODUCT, SDB_VERSION);
  await sdkCall(() => dbApi.deleteDatabase({ databaseId: id }));
}

/**
 * Build the IAM-authenticated Postgres connection string.
 *
 * Auth model: Serverless SQL Database has no database-local users. The
 * "username" is an IAM Application id and the "password" is that
 * application's API secret key (see CONTRACT.md §4 - create the key with no
 * expiry so this string stays stable). Credentials are URL-encoded because
 * both the application id (a UUID, safe as-is) and the secret key (opaque,
 * NOT guaranteed URL-safe) go in the userinfo component of the URI.
 *
 * @param {object} o
 * @param {string} o.endpoint       bare hostname, e.g. "<id>.pg.sdb.fr-par.scw.cloud"
 * @param {number} o.port           usually 5432
 * @param {string} o.dbName
 * @param {string} o.applicationId  IAM Application id (used as the DB user)
 * @param {string} o.secretKey      that application's API secret key (used as the DB password)
 * @returns {string} postgres://<applicationId>:<secretKey>@<endpoint>:<port>/<dbName>?sslmode=require
 */
export function buildConnectionString({ endpoint, port, dbName, applicationId, secretKey }) {
  const user = encodeURIComponent(applicationId);
  const pass = encodeURIComponent(secretKey);
  return `postgres://${user}:${pass}@${endpoint}:${port}/${dbName}?sslmode=require`;
}

/* --------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
  };

  (async () => {
    try {
      switch (cmd) {
        case "ensure": {
          const name = rest[0];
          if (!name) throw new Error("usage: sdb.mjs ensure <name> [--min-cpu N] [--max-cpu N]");
          console.log(`▸ ensuring Serverless SQL Database "${name}"...`);
          const db = await ensureDatabase(name, {
            minCpu: Number(flag("min-cpu", 0)),
            maxCpu: Number(flag("max-cpu", 15)),
          });
          console.log(`✅ database ${db.id} (status: ${db.status})`);
          console.log(JSON.stringify(db));
          break;
        }
        case "get": {
          const name = rest[0];
          if (!name) throw new Error("usage: sdb.mjs get <name>");
          const db = await getDatabase(name);
          if (!db) console.log(`⚠️ no database named "${name}"`);
          console.log(JSON.stringify(db));
          break;
        }
        case "wait": {
          const id = rest[0];
          if (!id) throw new Error("usage: sdb.mjs wait <id> [--timeout ms]");
          console.log(`▸ waiting for database ${id} to become ready...`);
          const db = await waitForDatabaseReady(id, { timeoutMs: Number(flag("timeout", 300_000)) });
          console.log(`✅ ready`);
          console.log(JSON.stringify(db));
          break;
        }
        case "delete": {
          const id = rest[0];
          if (!id) throw new Error("usage: sdb.mjs delete <id>");
          console.log(`▸ deleting database ${id}...`);
          await deleteDatabase(id);
          console.log(`✅ deleted`);
          console.log(JSON.stringify({ deleted: id }));
          break;
        }
        case "connection-string": {
          const cs = buildConnectionString({
            endpoint: flag("endpoint"),
            port: Number(flag("port", 5432)),
            dbName: flag("db-name"),
            applicationId: flag("application-id"),
            secretKey: flag("secret-key"),
          });
          console.log(`✅ built connection string`);
          console.log(JSON.stringify({ connectionString: cs }));
          break;
        }
        default:
          console.log(
            "usage: sdb.mjs <ensure|get|wait|delete|connection-string> ...\n" +
              "  ensure <name> [--min-cpu N] [--max-cpu N]\n" +
              "  get <name>\n" +
              "  wait <id> [--timeout ms]\n" +
              "  delete <id>\n" +
              "  connection-string --endpoint H --port P --db-name D --application-id A --secret-key S",
          );
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      console.log(JSON.stringify({ error: e.message, type: e.type, status: e.status }));
      process.exit(1);
    }
  })();
}
