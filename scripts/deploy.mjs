#!/usr/bin/env node
// deploy.mjs - the ONLY deploy path (CONTRACT.md §5). Direct build pipeline on
// every platform: this script itself builds the Docker image and pushes it,
// no GitHub Actions anywhere. This script orchestrates everything AFTER the
// "production or preview?" question, which is asked conversationally by the
// `/deploy` skill and passed in as --target.
//
// Sequence (CONTRACT.md §5, all steps after "ask the target"):
//   1. commit + push the current branch
//   2. ensureDocker() (starts the daemon if needed, CONTRACT.md §1/§7), then
//      build + push the image directly (scripts/_docker-build.mjs), tagged
//      with the commit SHA - skip the rebuild when that exact tag already
//      exists in the registry (e.g. a re-deploy with no new commits)
//   3. run migrations as a Serverless Job on the freshly built image
//      (overridden command `node migrate.mjs`), WAIT for success.
//      If this fails: ABORT before touching the container.
//   4. update the container's registry_image, wait until ready
//   5. prune old registry tags (Container Registry has no retention policy)
//   6. smoke-test /api/healthz - proxy.ts exempts that exact path from the IP
//      gate, so it must answer 200 {"ok":true} from ANY machine; then fetch
//      the homepage with the ACCESS_BYPASS_TOKEN header and require 200
//      (sole downgrade: 403 despite the token = pre-token src/proxy.ts, warn)
//
// main -> production, any other branch -> its own preview container AND its
// own preview Serverless SQL database (CONTRACT.md §5). Preview credentials
// are minted once (IAM Application + non-expiring API key, CONTRACT.md §4)
// and cached in Secret Manager under a per-branch name so reruns reuse them
// instead of minting a new key every deploy.
//
// DEVIATION worth flagging: CONTRACT.md §2 says "a secret's name IS the env
// var name" (one Scaleway Project per app). That convention assumes a single
// DATABASE_URL. Preview environments need their own, distinct connection
// string per branch without clobbering production's, so preview databases
// are stored under `DATABASE_URL_PREVIEW_<BRANCH_SLUG>` and only mapped back
// onto the literal `DATABASE_URL` env var name at the point of use (Job
// secretRefs' `envVarName`, and the container's secret_environment_variables
// key) - never as the Secret Manager entry's own name.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ScwError, requireCredentials, slugify } from "./scaleway/_scw-auth.mjs";
import {
  ensureNamespace,
  findContainerByName,
  createContainer,
  updateContainer,
  waitForContainerReady,
  syncContainerSecrets,
} from "./scaleway/container.mjs";
import { ensureJobDefinition, startJob, waitForJobRun, setSchedule } from "./scaleway/jobs.mjs";
import { ensureRegistryNamespace, findRegistryNamespace, listImages, pruneTags } from "./scaleway/registry.mjs";
import { ensureDatabase, waitForDatabaseReady, buildConnectionString } from "./scaleway/sdb.mjs";
import { ensureApplication, ensurePolicy, createApiKey, DELEGATED_DB_KEY_SECRET_NAME } from "./scaleway/iam.mjs";
import { getSecret, putSecret, secretExists, listSecrets } from "./scaleway/secrets.mjs";
import { devDbCredentials } from "./scaleway/app-credentials.mjs";
import { ensureDocker } from "./ensure-dockerd.mjs";
import { buildAndPushImage } from "./_docker-build.mjs";

// Per-request delegation: falls back to the admin-provisioned raw key pair
// when the operator's own key lacks IAMManager, then to the operator's
// personal key (see scripts/scaleway/app-credentials.mjs) when even that
// pair is absent. This message is now a RARE last resort, only reached when
// the personal-key fallback itself fails (devDbCredentials()'s principal
// cannot be resolved). Same message as setup-db.mjs's ensureIamAccess - one
// forwardable French request either way.
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

/**
 * Fetch and validate the admin-delegated DB key pair. The admin's policy on
 * it is Project-scoped, so the same pair reaches every database in the
 * Project - production and every preview branch alike. Falls back to the
 * operator's personal key (`devFallback: true`) when the pair hasn't been
 * provisioned yet, instead of failing outright.
 */
async function resolveDelegatedDbKey(creds) {
  let raw;
  try {
    raw = await getSecret(DELEGATED_DB_KEY_SECRET_NAME);
  } catch (e) {
    if (e?.type !== "not_found") throw e;

    log("No admin-delegated key yet - falling back to your personal Scaleway key for development");
    try {
      const dev = await devDbCredentials();
      return { applicationId: dev.principalId, secretKey: dev.secretKey, devFallback: true };
    } catch {
      throw new ScwError(NEEDS_ADMIN_DB_MESSAGE, {
        type: "needs_admin",
        details: {
          recipe: "db",
          secretName: DELEGATED_DB_KEY_SECRET_NAME,
          permissionSets: ["ServerlessSQLDatabaseReadWrite"],
          projectId: creds.projectId,
        },
      });
    }
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
  return { applicationId, secretKey, devFallback: false };
}

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log(
    "usage: deploy.mjs --target production|preview --project-name <name> [options]\n" +
      "  --project-dir <path>          default: cwd\n" +
      "  --branch <branch>             default: current git branch\n" +
      "  --registry-namespace <ns>     default: slugified project name\n" +
      "  --keep-tags <n>               default: 10\n" +
      "  --build-timeout-ms <n>        default: 900000 (15 min)\n" +
      "  --job-timeout-ms <n>          default: 600000 (10 min)\n" +
      "  --container-timeout-ms <n>    default: 300000 (5 min)\n" +
      "  --no-commit                   skip commit+push (already done by the caller)\n",
  );
  process.exit(0);
}

const TARGET = flag("target");
const PROJECT_NAME = flag("project-name");
const PROJECT_DIR = flag("project-dir", process.cwd());
const REGISTRY_NAMESPACE = flag("registry-namespace", PROJECT_NAME ? slugify(PROJECT_NAME) : undefined);
const REGISTRY_NAMESPACE_OVERRIDE = has("registry-namespace");
const KEEP_TAGS = Number(flag("keep-tags", 10));
const BUILD_TIMEOUT_MS = Number(flag("build-timeout-ms", 900_000));
const JOB_TIMEOUT_MS = Number(flag("job-timeout-ms", 600_000));
const CONTAINER_TIMEOUT_MS = Number(flag("container-timeout-ms", 300_000));
const SKIP_COMMIT = has("no-commit");
let BRANCH = flag("branch");

/* --------------------------------------------------------------- state */

const STEPS = ["preflight", "commitPush", "buildPush", "migrate", "updateContainer", "agentJobs", "pruneTags", "smokeTest"];
const completed = [];
const warnings = [];
let current = null;

let SHA = null;
let IMAGE_URI = null;
let DB_SECRET = null;
let CONTAINER_ID = null;
let CONTAINER_URL = null;

async function step(name, fn) {
  current = name;
  await fn();
  completed.push(name);
  current = null;
}

function log(msg) {
  console.log(`▸ ${msg}`);
}
function ok(msg) {
  console.log(`✅ ${msg}`);
}
function warn(msg) {
  console.log(`⚠️ ${msg}`);
  warnings.push(msg);
}

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("Deploy handoff state");
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
        `  - Target: ${TARGET || "(unknown)"} · branch: ${BRANCH || "(unknown)"} · project: ${PROJECT_NAME || "(unknown)"}\n` +
        "  - The failure is above the handoff banner. Read the actual error there.\n" +
        "  - If the failure is at or before \"migrate\", the container was never touched -\n" +
        "    the previous revision is still serving traffic. Safe to fix and re-run.\n" +
        "  - If the failure is at \"updateContainer\" or later, the migration already ran;\n" +
        "    re-running the migration Job is a no-op only if it's actually idempotent -\n" +
        "    check drizzle's migration state before blindly re-running.\n" +
        "  - Each step here maps 1:1 to a section of skills/deploy/SKILL.md.\n",
    );
  }
  console.log("────────────────────────────────────────────────────────");
}

function fail(msg) {
  console.log(`❌ ${msg}`);
  dumpHandoff(false);
  console.log(JSON.stringify({ success: false, failedStep: current, error: msg, warnings }));
  process.exit(1);
}

process.on("uncaughtException", (e) => {
  console.log(`❌ Unhandled exception: ${e.message}`);
  if (e instanceof ScwError && e.details) console.log(JSON.stringify(e.details));
  dumpHandoff(false);
  console.log(JSON.stringify({ success: false, failedStep: current, error: e.message, warnings }));
  process.exit(1);
});

/* ---------------------------------------------------------------- shell */

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: PROJECT_DIR, encoding: "utf8", ...opts });
}
function shOrFail(cmd, args, label) {
  const res = sh(cmd, args);
  if (res.status !== 0) fail(`${label} failed: ${(res.stderr || res.stdout || "").trim() || `exit ${res.status}`}`);
  return res.stdout.trim();
}

/* --------------------------------------------------------------- steps */

async function preflight() {
  if (TARGET !== "production" && TARGET !== "preview") {
    fail('--target must be "production" or "preview" (this must be asked explicitly, never inferred).');
  }
  if (!PROJECT_NAME) fail("--project-name is required.");
  requireCredentials();

  const inRepo = sh("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") {
    fail(`${PROJECT_DIR} is not a git repository.`);
  }

  // Direct pipeline on every platform (CONTRACT.md §5, §7): this machine
  // builds and pushes the image itself, so Docker must be reachable before
  // anything else runs. ensureDocker() starts the daemon lazily when this
  // process can plausibly do so (root, or a Claude Code web sandbox) and
  // throws a clear, actionable message otherwise.
  try {
    await ensureDocker();
  } catch (e) {
    fail(e.message);
  }

  if (!BRANCH) BRANCH = shOrFail("git", ["rev-parse", "--abbrev-ref", "HEAD"], "git rev-parse");

  if (TARGET === "production" && BRANCH !== "main") {
    fail(
      `Target "production" can only be deployed from the "main" branch (current branch: "${BRANCH}"). ` +
        `Use --target preview, or switch to main.`,
    );
  }
  if (TARGET === "preview" && BRANCH === "main") {
    fail('The "main" branch is production. Use --target production, or deploy a different branch for a preview.');
  }

  ok(`Target: ${TARGET} · branch: ${BRANCH} · project: ${PROJECT_NAME}`);
}

async function commitPush() {
  if (SKIP_COMMIT) {
    SHA = shOrFail("git", ["rev-parse", "HEAD"], "git rev-parse");
    ok(`Skipping commit/push (--no-commit), current commit ${SHA.slice(0, 7)}`);
    return;
  }
  const status = sh("git", ["status", "--porcelain"]);
  if (status.stdout.trim()) {
    log("Local changes detected, committing...");
    shOrFail("git", ["add", "-A"], "git add");
    const commit = sh("git", ["commit", "-m", `chore: deploy ${new Date().toISOString()}`]);
    if (commit.status !== 0) fail(`git commit failed: ${(commit.stderr || commit.stdout || "").trim()}`);
    ok("Commit created");
  } else {
    ok("No local changes to commit");
  }
  log(`Pushing branch ${BRANCH}...`);
  const push = sh("git", ["push", "-u", "origin", BRANCH]);
  if (push.status !== 0) fail(`git push failed: ${(push.stderr || push.stdout || "").trim()}`);
  ok("Branch pushed");
  SHA = shOrFail("git", ["rev-parse", "HEAD"], "git rev-parse");
}

let REGISTRY = null;

/**
 * Resolve the Container Registry namespace once, on first use, and reuse it
 * for both buildPush and pruneTagsStep - /deploy only ever discovers a
 * namespace, it never mints one out of thin air (CONTRACT.md §2: only
 * /bootstrap creates, the exception being the legacy create-on-first-deploy
 * fallback below for an app bootstrapped with --skip-deploy).
 */
async function resolveRegistry() {
  if (REGISTRY) return REGISTRY;
  if (REGISTRY_NAMESPACE_OVERRIDE) {
    // A typo'd override must fail loudly, not silently mint a new namespace.
    REGISTRY = await ensureRegistryNamespace(REGISTRY_NAMESPACE, { exact: true, createIfMissing: false });
  } else {
    const found = await findRegistryNamespace(PROJECT_NAME);
    REGISTRY = found || (await ensureRegistryNamespace(slugify(PROJECT_NAME), { exact: true }));
  }
  return REGISTRY;
}

// Direct build + push (CONTRACT.md §5): this machine builds the image itself
// and pushes it straight to the registry, tagged with the commit SHA -
// skipping the rebuild when that exact tag already exists (a re-deploy of an
// unchanged commit must not pay for a second image build). Replaces the old
// GitHub Actions dispatch-and-poll entirely; BUILD_TIMEOUT_MS is unused by
// this step (a local `docker build`/`push` has no external run to time out
// on) but is kept as a CLI flag for compatibility with existing callers.
async function buildPush() {
  const registry = await resolveRegistry();
  const imageName = slugify(PROJECT_NAME);

  log(`Building + pushing the Docker image (tag ${SHA.slice(0, 7)})...`);
  const result = await buildAndPushImage({
    projectDir: PROJECT_DIR,
    registryEndpoint: registry.endpoint,
    registryNamespaceId: registry.id,
    imageName,
    tag: SHA,
    log,
  });
  IMAGE_URI = result.imageUri;
  ok(result.skipped ? `Image already present under this tag, reused: ${IMAGE_URI}` : `Image built and pushed: ${IMAGE_URI}`);
}

/**
 * Resolve the Secret Manager entry backing DATABASE_URL for this deploy.
 * Production reuses the secret provisioned by /add-db (never creates one -
 * deploy.mjs does not own database provisioning for production). Preview
 * provisions its own database + IAM credentials on first deploy of a branch,
 * then reuses them on every subsequent deploy of that branch (see file header
 * for why the Secret Manager entry's name differs from "DATABASE_URL").
 *
 * Returns the secret's `name`, not its plaintext value: the container's
 * secret env is now synced straight from Secret Manager by
 * syncContainerSecrets() (container.mjs), which reads the value itself -
 * this deploy no longer needs to carry it in memory. `name` feeds that
 * call's `databaseUrlFrom` for a preview deploy.
 */
async function resolveDatabaseSecret() {
  if (TARGET === "production") {
    const secrets = await listSecrets();
    const found = secrets.find((s) => s.name === "DATABASE_URL");
    if (!found) {
      fail(
        'Secret "DATABASE_URL" not found in Secret Manager. Run /add-db to provision the production ' +
          "database before deploying to production.",
      );
    }
    return { secretId: found.id, name: "DATABASE_URL" };
  }

  const branchSlug = slugify(BRANCH);
  const dbSlug = `${slugify(PROJECT_NAME)}-preview-${branchSlug}`;
  const secretName = `DATABASE_URL_PREVIEW_${branchSlug.toUpperCase().replace(/-/g, "_")}`;

  if (await secretExists(secretName)) {
    const secrets = await listSecrets();
    const found = secrets.find((s) => s.name === secretName);
    return { secretId: found.id, name: secretName };
  }

  log(`No preview database yet for branch "${BRANCH}", provisioning "${dbSlug}"...`);
  const db = await ensureDatabase(dbSlug, {});
  const ready = await waitForDatabaseReady(db.id, { timeoutMs: 300_000 });
  ok(`Preview database ready (${ready.endpoint})`);

  const creds = requireCredentials();
  let applicationId;
  let secretKey;
  let devFallbackUsed = false;
  try {
    const app = await ensureApplication(slugify(`harness-db-${dbSlug}`));
    await ensurePolicy({
      applicationId: app.id,
      projectId: creds.projectId,
      permissionSetNames: ["ServerlessSQLDatabaseReadWrite"],
    });
    const key = await createApiKey({ applicationId: app.id, projectId: creds.projectId, description: `preview db ${dbSlug}` });
    applicationId = app.id;
    secretKey = key.secretKey;
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;
    const delegated = await resolveDelegatedDbKey(creds);
    applicationId = delegated.applicationId;
    secretKey = delegated.secretKey;
    devFallbackUsed = delegated.devFallback;
  }
  const connectionString = buildConnectionString({
    endpoint: ready.endpoint,
    port: ready.port,
    dbName: ready.dbName,
    applicationId,
    secretKey,
  });
  await putSecret(secretName, connectionString);
  if (devFallbackUsed) {
    ok("This preview database runs on your personal Scaleway key for now.");
  }
  const secrets = await listSecrets();
  const found = secrets.find((s) => s.name === secretName);
  return { secretId: found.id, name: secretName };
}

async function migrate() {
  DB_SECRET = await resolveDatabaseSecret();

  const jobName = TARGET === "production" ? `${PROJECT_NAME}-migrate` : `${PROJECT_NAME}-migrate-preview-${slugify(BRANCH)}`;
  log(`Ensuring migration job definition "${jobName}"...`);
  const jobDef = await ensureJobDefinition({
    name: jobName,
    imageUri: IMAGE_URI,
    // Migrations run ONLY here, never at container start (CONTRACT.md §1):
    // min_scale=0 means several container instances can cold-start at once,
    // Serverless SQL's pg_advisory_lock isn't guaranteed, and a migration
    // runner has no concurrency protection of its own. A Job is strictly
    // sequential - this is the one safe place to run it.
    //
    // The Job runs on the app image, which carries no devDependencies -
    // `drizzle-kit migrate` dies at container start with a truncated OCI
    // runtime error (verified on a live run). `migrate.mjs`
    // (templates/deploy/migrate.mjs, copied into the runner stage by
    // templates/deploy/Dockerfile) is a dependency-light stand-in that
    // reproduces drizzle-kit's own migration bookkeeping and safely no-ops
    // on a project with an empty migration journal, so this command always
    // runs - no separate "skip if no migrations" branch is needed here.
    command: "node migrate.mjs",
    cpuLimit: 250,
    memoryLimit: 512,
    timeout: "600s",
    secretRefs: [{ secretManagerId: DB_SECRET.secretId, envVarName: "DATABASE_URL" }],
  });
  ok(`Job definition ready (${jobDef.name})`);

  log("Starting the migration...");
  const runId = await startJob(jobDef.id, {});
  log(`Migration run started (${runId}), waiting for completion...`);
  // waitForJobRun throws on failed/canceled/internal_error - this propagates
  // up to main()'s catch, which fails BEFORE updateContainer ever runs, so
  // the previous revision keeps serving. Do not swallow this error.
  const result = await waitForJobRun(runId, { timeoutMs: JOB_TIMEOUT_MS });
  ok(`Migration finished: ${result.state}`);
}

async function updateContainerStep() {
  const ns = await ensureNamespace(PROJECT_NAME);
  const containerName = TARGET === "production" ? PROJECT_NAME : `${PROJECT_NAME}-preview-${slugify(BRANCH)}`;

  let container = await findContainerByName(ns.id, containerName);
  if (!container) {
    log(`Container "${containerName}" does not exist yet, creating it...`);
    container = await createContainer({
      namespaceId: ns.id,
      name: containerName,
      registryImage: IMAGE_URI,
      scale: "S",
      minScale: 0,
    });
    CONTAINER_ID = container.id;
    log("Waiting for the container to leave its creation state...");
    container = await waitForContainerReady(container.id, { timeoutMs: CONTAINER_TIMEOUT_MS });
    ok(`Container created (${container.id})`);
  } else {
    CONTAINER_ID = container.id;
    log(`Updating container "${containerName}" to image tag ${IMAGE_URI.split(":").pop()}...`);
    // wait-write-wait (CONTRACT.md §1): a container in a transient state
    // refuses writes with a 409, and this write itself starts a new deploy.
    await waitForContainerReady(container.id, { timeoutMs: CONTAINER_TIMEOUT_MS });
    container = await updateContainer(container.id, { registryImage: IMAGE_URI });
    container = await waitForContainerReady(container.id, { timeoutMs: CONTAINER_TIMEOUT_MS });
    ok("Container image updated");
  }

  // No linkage file is written or read (CONTRACT.md §2, §7: app repos carry
  // no Scaleway metadata at all) - `ns` and `container` above were already
  // found/created by NAME, so nothing here needs to persist their ids for a
  // later run to find them again (the namespace is discovered by name-prefix
  // within the Project - CONTRACT.md §2).

  // Secret Manager, not this deploy's own state, is the canonical source for
  // a container's secret env (container.mjs's header comment - a container
  // GET can only return argon2 hashes, never plaintext, so it can never be
  // trusted as a merge source; a write REPLACES the whole map, so a partial
  // one deletes whatever it omits). syncContainerSecrets() does its own
  // wait-write-wait around the secrets write.
  //
  // Production reads DATABASE_URL / ACCESS_RESTRICTED / ACCESS_ALLOWED_IPS /
  // APP_URL straight from Secret Manager, where they are canonical
  // (bootstrap-init.mjs seeds them; /add-db, /publish and /unpublish keep
  // them current) - no overrides needed here.
  //
  // Preview containers are ALWAYS re-restricted on deploy: this run has no
  // way to know whether an operator ran /publish on this exact preview
  // earlier, and defaulting open would leave a stale preview reachable by
  // anyone. A published preview therefore reverts to ACCESS_RESTRICTED=true
  // on its very next deploy - fail closed, not fail open.
  // ACCESS_BYPASS_TOKEN (CONTRACT.md §6): apps bootstrapped before the token
  // existed have no such secret; mint it here so the sync below projects it
  // and the smoke test can authenticate. Their src/proxy.ts may still lack
  // the check - smokeTest() downgrades that case to a warning.
  if (!(await secretExists("ACCESS_BYPASS_TOKEN"))) {
    await putSecret("ACCESS_BYPASS_TOKEN", randomBytes(32).toString("hex"));
    log("Minted the missing ACCESS_BYPASS_TOKEN secret (pre-token app).");
  }

  log("Syncing container secrets from Secret Manager...");
  if (TARGET === "production") {
    container = await syncContainerSecrets(container.id, { timeoutMs: CONTAINER_TIMEOUT_MS });
  } else {
    container = await syncContainerSecrets(container.id, {
      databaseUrlFrom: DB_SECRET.name,
      overrides: {
        ACCESS_RESTRICTED: "true",
        ...(container.domain_name ? { APP_URL: `https://${container.domain_name}` } : {}),
      },
      timeoutMs: CONTAINER_TIMEOUT_MS,
    });
  }
  ok(`Container ready (status: ${container.status})`);

  // v1beta1's Container resource exposes its default public hostname as
  // `domain_name` (bare hostname, no scheme). Defensive fallback: if a future
  // API revision renames/omits it, don't crash the whole deploy over a
  // cosmetic smoke-test skip - warn and let pruneTags still run.
  CONTAINER_URL = container.domain_name ? `https://${container.domain_name}` : null;
  if (!CONTAINER_URL) {
    warn("Could not determine the container's public URL (no domain_name field on the API response) - smoke test will be skipped.");
  }
}

/**
 * Bug 3 fix: templates/agent/job-definition.json's own `_comment`, plus
 * scripts/setup-agent.mjs's handoff and skills/add-agent/SKILL.md (3+
 * places), all promise that `/deploy` reads every `apps/<name>/job-definition.json`
 * and calls `ensureJobDefinition` + (when scheduled) `setSchedule`. That scan
 * never existed - deploy.mjs didn't even import `setSchedule` - so every
 * agent scaffolded by `/add-agent` was scaffolded locally but never actually
 * created or scheduled on Scaleway. This implements the exact 5-step flow
 * documented in that file's `_comment`.
 *
 * Uses the SAME image just built for the web container (IMAGE_URI): this is
 * a Turborepo monorepo with one image, `command` overrides what runs inside
 * it - exactly like the migration Job overrides its command to
 * `node migrate.mjs` on this same image (see migrate() above).
 *
 * Non-fatal by design: the web container has already deployed and passed
 * its own smoke test earlier in this run, so a broken agent Job definition
 * must not roll that back or block pruneTags - failures here are reported
 * as warnings, per-agent, and the loop continues.
 *
 * Job names are suffixed for preview the same way the migration Job already
 * is (`<name>-migrate` -> `<name>-migrate-preview-<slug>`, see migrate()) -
 * otherwise a preview deploy would silently overwrite (and reschedule) the
 * production agent's Job under the same slugified name.
 */
async function agentJobs() {
  const appsDir = join(PROJECT_DIR, "apps");
  if (!existsSync(appsDir)) {
    log("No apps/ directory - no agent Jobs to reconcile.");
    return;
  }
  const defs = readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ appName: e.name, defPath: join(appsDir, e.name, "job-definition.json") }))
    .filter((d) => existsSync(d.defPath));

  if (defs.length === 0) {
    log("No apps/*/job-definition.json found - no agent Jobs to reconcile.");
    return;
  }

  // Resolved once, lazily, and shared across every job-definition.json in
  // this run - avoids one listSecrets() round-trip per secretRef per agent.
  let secretsCache = null;
  async function resolveSecretId(secretName) {
    // DATABASE_URL isn't a plain Secret Manager lookup by that literal name
    // for preview (see the file header DEVIATION note): reuse the exact
    // secret this deploy already resolved/provisioned for the migration Job
    // and the container, so the agent talks to the same database.
    if (secretName === "DATABASE_URL") return DB_SECRET?.secretId || null;
    if (!secretsCache) secretsCache = await listSecrets();
    return secretsCache.find((s) => s.name === secretName)?.id || null;
  }

  for (const { appName, defPath } of defs) {
    log(`Reconciling agent Job for apps/${appName}...`);
    let def;
    try {
      def = JSON.parse(readFileSync(defPath, "utf8"));
    } catch (e) {
      warn(`apps/${appName}/job-definition.json could not be parsed (${e.message}) - skipping this agent.`);
      continue;
    }
    if (!def.name || String(def.name).includes("{{")) {
      warn(`apps/${appName}/job-definition.json has no resolved "name" (still a template placeholder?) - skipping.`);
      continue;
    }

    try {
      const secretRefs = [];
      for (const ref of def.secretRefs || []) {
        const id = await resolveSecretId(ref.secretManagerId);
        if (!id) {
          warn(
            `Secret "${ref.secretManagerId}" (apps/${appName}/job-definition.json) not found in Secret Manager - ` +
              `the Job will boot without ${ref.envVarName}.`,
          );
          continue;
        }
        secretRefs.push({ secretManagerId: id, envVarName: ref.envVarName });
      }

      const jobName = TARGET === "production" ? def.name : `${def.name}-preview-${slugify(BRANCH)}`;
      const definition = await ensureJobDefinition({
        name: jobName,
        imageUri: IMAGE_URI,
        command: def.command,
        env: def.env,
        secretRefs,
        cpuLimit: def.cpuLimit,
        memoryLimit: def.memoryLimit,
        timeout: def.timeout,
      });
      ok(`Agent Job definition ready (${definition.name})`);

      const timezone = def.cronTimezone || "Europe/Paris";
      let cron = null;
      if (def.triggerMode === "cron") cron = def.cronSchedule;
      else if (def.triggerMode === "manual") cron = def.manualPollCron;
      else if (def.triggerMode === "continuous") cron = def.continuousRestartCron;

      if (cron) {
        await setSchedule(definition.id, { cron, timezone });
        ok(`Agent Job "${definition.name}" scheduled (${def.triggerMode}: "${cron}" ${timezone})`);
      } else {
        warn(
          `apps/${appName}/job-definition.json has triggerMode "${def.triggerMode}" - no recognised schedule ` +
            `field for it, "${definition.name}" was created/updated but left unscheduled.`,
        );
      }
    } catch (e) {
      warn(`Agent Job for apps/${appName} failed to reconcile: ${e.message}`);
    }
  }
}

async function pruneTagsStep() {
  log("Pruning old registry tags (Container Registry has no retention policy)...");
  const reg = await resolveRegistry();
  const images = await listImages(reg.id);
  const image = images.find((i) => i.name === slugify(PROJECT_NAME)) || images[0];
  if (!image) {
    warn("No image found in the registry namespace to prune.");
    return;
  }
  const result = await pruneTags(image.id, { keep: KEEP_TAGS });
  ok(`Deleted ${result.deleted.length} old tag(s), kept the ${KEEP_TAGS} most recent`);
}

async function smokeTest() {
  if (!CONTAINER_URL) {
    warn("Smoke test skipped (no URL).");
    return;
  }
  // /api/healthz is exempt from the IP gate by src/proxy.ts (exact-path
  // match, CONTRACT.md §6), so it must answer 200 from ANY machine - VPN,
  // web sandbox, or CI. A 403 here means the exemption itself is broken; a
  // homepage 403 on a gated app is normal and must never fail the deploy.
  // pruneTags already ran by the time this probe runs (see STEPS above), so
  // a failure here no longer blocks tag pruning.
  const healthzUrl = `${CONTAINER_URL}/api/healthz`;
  log(`Smoke-testing ${healthzUrl}...`);
  let res;
  try {
    res = await fetch(healthzUrl, { redirect: "follow" });
  } catch (e) {
    fail(`Smoke test could not reach ${healthzUrl}: ${e.message}`);
  }
  if (res.status === 403) {
    fail(
      `Smoke test failed: HTTP 403 on ${healthzUrl}. The IP gate must never apply to the ` +
        `exact /api/healthz path - the exemption is missing from the project's src/proxy.ts. ` +
        `Restore the \`pathname === HEALTHZ_PATH\` check (templates/deploy/proxy.ts) and redeploy.`,
    );
  }
  if (res.status !== 200) {
    fail(`Smoke test failed: HTTP ${res.status} on ${healthzUrl}.`);
  }
  const body = await res.text();
  if (!body.replace(/\s+/g, "").includes('"ok":true')) {
    fail(`Smoke test failed: ${healthzUrl} answered 200 but not {"ok":true} (got: ${body.slice(0, 200)}).`);
  }
  ok(`${healthzUrl} responds 200 {"ok":true}`);

  // Homepage probe, authenticated with ACCESS_BYPASS_TOKEN (CONTRACT.md §6):
  // the token passes the IP gate from any machine, so a 200 is required and
  // a broken homepage fails the deploy. Sole downgrade: a 403 DESPITE the
  // token means the app's src/proxy.ts predates the bypass check (the token
  // secret was minted above but the deployed code ignores it) - warn with
  // the migration path instead of blocking every deploy of a pre-token app.
  let bypassToken = null;
  try {
    bypassToken = await getSecret("ACCESS_BYPASS_TOKEN");
  } catch (e) {
    warn(`Could not read ACCESS_BYPASS_TOKEN (${e.message}) - probing the homepage unauthenticated.`);
  }
  let home;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      home = await fetch(CONTAINER_URL, {
        redirect: "follow",
        headers: bypassToken ? { "x-baudrier-access-token": bypassToken } : {},
      });
      break; // an HTTP status is deterministic - retrying cannot change it
    } catch (e) {
      if (attempt === 3) {
        fail(`Homepage smoke test could not reach ${CONTAINER_URL} after 3 attempts: ${e.message} (healthz was green just before).`);
      }
      log(`  attempt ${attempt}/3: network error (${e.message}) - waiting 5s`);
      await sleep(5000);
    }
  }
  if (home.status === 403) {
    if (bypassToken) {
      warn(
        `${CONTAINER_URL} answers 403 despite a valid ACCESS_BYPASS_TOKEN: this app's src/proxy.ts predates ` +
          "the token bypass. Copy the bypassTokenMatches() check from templates/deploy/proxy.ts into the " +
          "app's src/proxy.ts and redeploy to get a fully asserted smoke test.",
      );
    } else {
      log(`${CONTAINER_URL} answers 403 and no token was available - the IP gate is up (gated, unverified).`);
    }
    return;
  }
  if (home.status !== 200) {
    fail(`Homepage smoke test failed: HTTP ${home.status} on ${CONTAINER_URL} (healthz is green, the page is not).`);
  }
  const html = await home.text();
  const hasStyling = /_next\/static\/css|<link[^>]+rel=["']stylesheet["']|<style[\s\S]*?<\/style>/i.test(html);
  if (!hasStyling) {
    warn(`${CONTAINER_URL} responded 200 but no stylesheet was detected in the HTML - check visually.`);
  } else {
    ok(`${CONTAINER_URL} responds 200 with styling present`);
  }
}

/* ---------------------------------------------------------------- main */

// Guarded like every scripts/scaleway/*.mjs module: importing this file
// (e.g. from a test, or from another script) must never trigger the deploy
// pipeline as a side effect - only running it directly does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (async () => {
    await step("preflight", preflight);
    await step("commitPush", commitPush);
    await step("buildPush", buildPush);
    await step("migrate", migrate);
    await step("updateContainer", updateContainerStep);
    await step("agentJobs", agentJobs);
    await step("pruneTags", pruneTagsStep);
    await step("smokeTest", smokeTest);

    dumpHandoff(true);
    console.log(
      JSON.stringify({
        success: true,
        target: TARGET,
        branch: BRANCH,
        containerId: CONTAINER_ID,
        url: CONTAINER_URL,
        image: IMAGE_URI,
        warnings,
      }),
    );
  })().catch((e) => {
    fail(e instanceof ScwError ? e.message : `Unexpected error: ${e.message}`);
  });
}
