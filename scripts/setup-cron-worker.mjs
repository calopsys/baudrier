#!/usr/bin/env node
// setup-cron-worker.mjs - Deterministic core for /add-cron.
//
// Upstream had THREE clocks (a shared account-wide worker, a dedicated
// worker, a GitHub Action fallback) because the old edge-hosting provider's
// accounts capped out at 5 cron triggers total. That whole decision tree
// existed to dodge one platform limit. Scaleway Serverless Jobs have native
// cron (with real IANA timezones), allow up to 1,000 job definitions per
// Organization, and run up to 24h - there is no slot scarcity to route
// around. So there is exactly ONE mechanism here: a Serverless Job with a
// cron trigger, created directly via scripts/scaleway/jobs.mjs
// (ensureJobDefinition + setSchedule). No CLI tool to install, no shared
// registry file, no GitHub Actions fallback, no account slot counting.
//
// The Job's body is always the same tiny image: the public `curlimages/curl`
// image (Scaleway Serverless Jobs, like Containers, can pull public images -
// no push, no registry namespace, no build pipeline). Its `command` is a
// single `curl` call with NO embedded spaces in any argument, so it survives
// unchanged whether Scaleway parses `command` as a shell string or splits it
// naively on whitespace - there is nothing to disambiguate. That is also why
// CRON_SECRET travels as a `?secret=` query string param instead of an
// `Authorization` header: a header value needs its own quoting/escaping
// inside the command string, a query param appended to a URL that already
// has none does not.
//
// Three modes (chosen by the SKILL, never asked to the user):
//
//   app-route    (the default, for anything that touches the app's own DB,
//                email, or business logic) - scaffolds a protected
//                `/api/cron/<task-name>` route in the Next.js app, generates
//                nothing itself (the SKILL already pushed CRON_SECRET via
//                _generate-secret + _push-env-vars before calling this
//                script) and points the Job at
//                `<APP_URL>/api/cron/<task-name>?secret=<CRON_SECRET>`.
//                Also exempts `/api/cron/` from the project's IP allowlist
//                gate (CONTRACT.md §6) in src/proxy.ts, the same way
//                the ACME challenge and health-check paths already are -
//                the route authenticates itself via the secret, so gating
//                it by IP too would only break the Job (whose requests do
//                not originate from the VPN) for no additional safety.
//
//   keep-warm    a Job hitting the app's own already-exempted health-check
//                endpoint (`/api/healthz`, wired by
//                bootstrap-init.mjs). No new route, no secret: this task
//                exists ONLY to generate genuine HTTP traffic, because
//                Scaleway's platform health probe does NOT wake a
//                scaled-to-zero container - only real traffic reaching the
//                app does (CONTRACT.md §1).
//
//   ping-external a Job hitting a plain third-party URL the user gave
//                (a webhook, a public status endpoint) with no
//                transformation and no app involvement at all - the ONE
//                case where the task's whole "logic" really is just the
//                Job itself, nothing to scaffold in the app.
//
// Actions (--action): ensure (default) | delete | run-now | list.
//
// Usage:
//   node setup-cron-worker.mjs --action ensure \
//     --task-name daily-report --mode app-route \
//     --cron-expr "0 9 * * *" [--timezone Europe/Paris] \
//     --project-name my-app [--web-dir apps/web] \
//     [--description "send the weekly SEO report"]
//
//   node setup-cron-worker.mjs --action ensure \
//     --task-name keep-warm --mode keep-warm \
//     --cron-expr "*/10 * * * *" --project-name my-app
//
//   node setup-cron-worker.mjs --action ensure \
//     --task-name ping-partner --mode ping-external \
//     --cron-expr "0 * * * *" --project-name my-app \
//     --target-url "https://partner.example.com/webhooks/tick"
//
//   node setup-cron-worker.mjs --action run-now --task-name daily-report --project-name my-app
//   node setup-cron-worker.mjs --action delete  --task-name daily-report --project-name my-app [--remove-route]
//   node setup-cron-worker.mjs --action list --project-name my-app
//
// Output: progress on stderr (▸/✅/⚠️), one JSON line on stdout at the end.

import { writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { slugify } from "./scaleway/_scw-auth.mjs";
import { ensureJobDefinition, setSchedule, startJob, waitForJobRun, listJobDefinitions, deleteJobDefinition } from "./scaleway/jobs.mjs";
import { getSecret } from "./scaleway/secrets.mjs";

// The public curlimages/curl image: Scaleway Serverless Jobs can reference
// any public registry image, not only Scaleway Container Registry - no
// build, no push, no per-task Docker image. Pinned (not `:latest`) so a
// Job's behaviour never shifts under a project's feet.
const CURL_IMAGE = "docker.io/curlimages/curl:8.10.1";
const CPU_LIMIT_MVCPU = 70; // curl needs almost nothing - lightest Scaleway Jobs preset
const MEMORY_LIMIT_MB = 128;
const JOB_TIMEOUT = "60s";

function log(msg) { process.stderr.write(`▸ ${msg}\n`); }
function ok(msg) { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️ ${msg}\n`); }
function fail(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// ─── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const ACTION = flag("action", "ensure");
const TASK_NAME = flag("task-name", "");
const MODE = flag("mode", "app-route"); // app-route | keep-warm | ping-external
const CRON_EXPR = flag("cron-expr", "");
const TIMEZONE = flag("timezone", "Europe/Paris");
const PROJECT_NAME = flag("project-name", "");
const WEB_DIR = flag("web-dir", ".");
const TARGET_URL = flag("target-url", "");
const DESCRIPTION = flag("description", "");
const REMOVE_ROUTE = argv.includes("--remove-route");

if (!PROJECT_NAME) fail("--project-name is required.");
if (!TASK_NAME) fail("--task-name is required.");
if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(TASK_NAME)) fail(`--task-name must be kebab-case. Got: "${TASK_NAME}"`);

const JOB_NAME = `${slugify(PROJECT_NAME)}-cron-${TASK_NAME}`;

async function findExistingDefinition() {
  const defs = await listJobDefinitions();
  return defs.find((d) => d.name === slugify(JOB_NAME)) || null;
}

/* --------------------------------------------------------------- ensure */

async function actionEnsure() {
  if (!["app-route", "keep-warm", "ping-external"].includes(MODE)) {
    fail(`--mode must be app-route|keep-warm|ping-external. Got: "${MODE}"`);
  }
  if (!CRON_EXPR) fail("--cron-expr is required (5-field cron expression, wall-clock time in --timezone).");
  if (MODE === "ping-external" && !TARGET_URL) fail("--target-url is required when --mode is ping-external.");

  let targetUrl = null;
  let routeCreated = false;
  let proxyPatched = false;
  const warnings = [];

  if (MODE === "ping-external") {
    targetUrl = TARGET_URL;
  } else {
    // app-route and keep-warm both need the app's own public URL, only
    // known once the app has been deployed at least once (CONTRACT.md §5 -
    // Serverless Containers get their domain_name at creation time, there
    // is no way to predict it beforehand). Degrade gracefully: scaffold
    // everything that does not need it, skip creating the Job, and let the
    // caller re-run this exact command after the first /deploy.
    let appUrl = "";
    try { appUrl = await getSecret("APP_URL"); } catch { /* not deployed yet */ }

    if (MODE === "app-route") {
      let cronSecret = "";
      try { cronSecret = await getSecret("CRON_SECRET"); } catch {
        fail('Secret "CRON_SECRET" not found. Generate and push it first (_generate-secret + _push-env-vars) before calling this script.');
      }
      routeCreated = ensureCronRoute();
      proxyPatched = ensureProxyExemption();
      if (!appUrl) {
        warnings.push("APP_URL not provisioned yet (project not deployed) - the route is ready, but the schedule was not activated. Re-run this exact command after the first /deploy.");
      } else {
        targetUrl = `${appUrl.replace(/\/$/, "")}/api/cron/${TASK_NAME}?secret=${cronSecret}`;
      }
    } else {
      // keep-warm
      if (!appUrl) {
        warnings.push("APP_URL not provisioned yet (project not deployed) - keep-warm has nothing to ping yet. Re-run this exact command after the first /deploy.");
      } else {
        targetUrl = `${appUrl.replace(/\/$/, "")}/api/healthz`;
      }
    }
  }

  let jobDef = null;
  let jobCreated = false;
  if (targetUrl) {
    log(`Ensuring Job definition "${JOB_NAME}"`);
    jobDef = await ensureJobDefinition({
      name: JOB_NAME,
      imageUri: CURL_IMAGE,
      // No spaces inside any single argument (see file header) - the secret
      // travels as a query param, never as a header, so this string needs
      // no quoting to survive either shell-string or naive whitespace
      // splitting of the API's `command` field.
      command: `curl -fsS -X POST ${targetUrl}`,
      cpuLimit: CPU_LIMIT_MVCPU,
      memoryLimit: MEMORY_LIMIT_MB,
      timeout: JOB_TIMEOUT,
    });
    await setSchedule(jobDef.id, { cron: CRON_EXPR, timezone: TIMEZONE });
    jobCreated = true;
    ok(`Job "${jobDef.name}" scheduled: ${CRON_EXPR} (${TIMEZONE})`);
  }

  console.log(JSON.stringify({
    ok: true,
    action: "ensure",
    mode: MODE,
    taskName: TASK_NAME,
    jobName: JOB_NAME,
    jobId: jobDef?.id ?? null,
    jobCreated,
    routeCreated,
    proxyPatched,
    cronExpr: CRON_EXPR,
    timezone: TIMEZONE,
    warnings,
  }));
}

/** Writes <web-dir>/src/app/api/cron/<task-name>/route.ts if it does not
 * already exist. Never overwrites - a re-run must not clobber business
 * logic the user (or Claude) already wrote in there. Returns whether it was
 * created. */
function ensureCronRoute() {
  const routeDir = join(WEB_DIR, "src/app/api/cron", TASK_NAME);
  const routePath = join(routeDir, "route.ts");
  if (existsSync(routePath)) {
    log(`${routePath} already exists - leaving your logic untouched`);
    return false;
  }
  mkdirSync(routeDir, { recursive: true });
  writeFileSync(
    routePath,
    `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Triggered by a Scaleway Serverless Job on a cron schedule (see /add-cron).
// Authenticated with a \`?secret=\` query param rather than a header - the
// Job that calls this route is a plain \`curl\` command, this keeps its
// command line free of any quoting. Exempted from the IP allowlist gate in
// src/proxy.ts for the same reason a header couldn't have been
// IP-restricted anyway: the Job's requests do not originate from the VPN.
${DESCRIPTION ? `//\n// Purpose: ${DESCRIPTION}\n` : ""}
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // YOUR CRON LOGIC HERE (${TASK_NAME})

  return NextResponse.json({ success: true, task: "${TASK_NAME}", timestamp: new Date().toISOString() });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
`,
  );
  ok(`Created ${routePath}`);
  return true;
}

/** Adds "/api/cron/" to src/proxy.ts's ALWAYS_ALLOWED_PREFIXES if not
 * already present. Idempotent, and a no-op (with a warning, not a failure)
 * if proxy.ts does not match the expected shape - the route still
 * works for anyone whose IP is already allowed, it just also needs the Job
 * to get through. */
function ensureProxyExemption() {
  const proxyPath = join(WEB_DIR, "src/proxy.ts");
  if (!existsSync(proxyPath)) {
    warn(`${proxyPath} not found - could not exempt /api/cron/ from the IP gate. If this project has one elsewhere, add "/api/cron/" to ALWAYS_ALLOWED_PREFIXES by hand.`);
    return false;
  }
  const content = readFileSync(proxyPath, "utf8");
  if (content.includes('"/api/cron/"')) {
    log("src/proxy.ts already exempts /api/cron/");
    return false;
  }
  const re = /(const ALWAYS_ALLOWED_PREFIXES = \[)([^\]]*)(\];)/;
  if (!re.test(content)) {
    warn(`${proxyPath} does not match the expected ALWAYS_ALLOWED_PREFIXES shape - add "/api/cron/" to it by hand so the Job's pings are not blocked by the IP gate.`);
    return false;
  }
  const patched = content.replace(re, (_m, head, body, tail) => `${head}${body.trimEnd()}, "/api/cron/"${tail}`);
  writeFileSync(proxyPath, patched, "utf8");
  ok("Exempted /api/cron/ from the IP allowlist gate in src/proxy.ts");
  return true;
}

/* --------------------------------------------------------------- delete */

async function actionDelete() {
  const def = await findExistingDefinition();
  if (!def) {
    console.log(JSON.stringify({ ok: true, action: "delete", found: false }));
    return;
  }
  log(`Deleting Job definition "${def.name}"`);
  await deleteJobDefinition(def.id);
  ok("Job deleted");

  let routeRemoved = false;
  if (REMOVE_ROUTE) {
    const routeDir = join(WEB_DIR, "src/app/api/cron", TASK_NAME);
    if (existsSync(routeDir)) {
      rmSync(routeDir, { recursive: true, force: true });
      routeRemoved = true;
      ok(`Removed ${routeDir}`);
    }
  }
  console.log(JSON.stringify({ ok: true, action: "delete", found: true, routeRemoved }));
}

/* -------------------------------------------------------------- run-now */

async function actionRunNow() {
  const def = await findExistingDefinition();
  if (!def) fail(`No Job definition found for task "${TASK_NAME}" (looked for "${JOB_NAME}").`);
  log(`Starting "${def.name}" now`);
  const runId = await startJob(def.id, {});
  const result = await waitForJobRun(runId, { timeoutMs: 60_000 });
  ok(`Run finished: ${result.state}`);
  console.log(JSON.stringify({ ok: true, action: "run-now", jobId: def.id, runId, ...result }));
}

/* ------------------------------------------------------------------ list */

async function actionList() {
  const defs = await listJobDefinitions();
  const prefix = `${slugify(PROJECT_NAME)}-cron-`;
  const tasks = defs
    .filter((d) => d.name.startsWith(prefix))
    .map((d) => ({
      taskName: d.name.slice(prefix.length),
      jobId: d.id,
      cron: d.cron_schedule?.schedule ?? null,
      timezone: d.cron_schedule?.timezone ?? null,
    }));
  console.log(JSON.stringify({ ok: true, action: "list", tasks }));
}

/* ------------------------------------------------------------------ main */

try {
  switch (ACTION) {
    case "ensure": await actionEnsure(); break;
    case "delete": await actionDelete(); break;
    case "run-now": await actionRunNow(); break;
    case "list": await actionList(); break;
    default: fail(`Unknown --action "${ACTION}". Expected ensure|delete|run-now|list.`);
  }
} catch (e) {
  fail(e.message);
}
