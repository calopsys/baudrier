#!/usr/bin/env node
// setup-agent.mjs - Deterministic core for /add-agent.
//
// Scaffolds a Scaleway Generative APIs-powered agent into a Turborepo
// monorepo as `apps/{agent-name}/`, ready to run as a Scaleway Serverless
// Job (CONTRACT.md §1 - "Scheduling, agents: Scaleway Serverless Jobs").
//
// Pipeline (13 sub-steps, all run in sequence):
//   1. preflight          - args, paths, Next.js detection, monorepo check
//   2. generativeApiKey   - self-heal SCW_GENERATIVE_API_KEY in Secret Manager
//                            (mints a scoped IAM Application key - no manual
//                            console step needed)
//   3. temApiKey           - self-heal TEM_API_SECRET_KEY in Secret Manager,
//                            reuses the app's existing TEM_SENDER_EMAIL/NAME
//   4. ensureMonorepo      - convert to Turborepo if not already (delegates to caller)
//   5. scaffoldAgent       - copy templates/agent/* → apps/{name}/ with subst
//   6. patchSystemPrompt   - inject the user's system prompt into loop.ts
//   7. patchAgentName      - set TEMPLATE_AGENT_NAME = "<slug>" in loop.ts,
//                            memory-kv.ts and memory-pgvector.ts
//   8. patchTools          - remove tools the user opted out of
//   9. patchMemory         - comment out memory module(s) not selected;
//                            for pgvector, smoke-tests the embeddings API and
//                            writes a custom drizzle-kit migration (no DB
//                            connection - CONTRACT.md §4)
//  10. mergeSchema         - append schema-snippet.ts to main src/server/db/schema.ts
//  11. installDeps         - pnpm install (workspace-wide)
//  12. generateMigration   - `drizzle-kit generate` (writes SQL, no DB
//                            connection) for the new agent_* tables
//  13. handoff             - print structured JSON for Claude to consume
//
// Usage:
//   node setup-agent.mjs \
//     --name "newsletter-summarizer" \
//     --description "Summarize my RSS feeds every morning and send me a brief" \
//     --web-dir "apps/web" \
//     --trigger "cron"                    # cron | continuous | manual
//     --memory "kv"                       # none | kv | pgvector
//     --model "mistral-small-3.2-24b-instruct-2506"
//     --daily-budget "1"                  # EUR
//     --monthly-budget "10"               # EUR
//     --cron-schedule "0 7 * * *"         # required if --trigger cron
//     --cron-prompt "Read the RSS feeds and send today's brief."
//
// Output: live logs on stderr, final JSON object on stdout last line.
//
// Exit codes:
//   0 - success
//   1 - preflight failed
//   2 - pipeline failed mid-way (handoff JSON has details)

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { requireCredentials, resolveProjectId, ScwError } from "./scaleway/_scw-auth.mjs";
import { ensureApplication, ensurePolicy, createApiKey } from "./scaleway/iam.mjs";
import { getSecret, putSecret, secretExists } from "./scaleway/secrets.mjs";
import { recordDevFingerprint } from "./scaleway/dev-credentials.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "../templates/agent");

// Per-request delegation: when the operator's own key lacks IAMManager, the
// admin stores the FINAL canonical secret directly (unlike the DB key, there
// is no raw pair to compose here) - the secretExists() guards below are that
// delegated fulfilment path, already in place before this revision. Both
// needs_admin messages below are now a RARE last resort: the operator's own
// personal key powers the secret first (see the catch blocks), and these
// only fire if THAT putSecret call itself fails.
const NEEDS_ADMIN_AGENT_MESSAGE =
  "Ni votre clé Scaleway ni votre clé personnelle n’ont pu être enregistrées pour l’IA générative. " +
  "Demandez à l’administrateur de créer une clé avec le droit GenerativeApisModelAccess limité à ce projet, " +
  "puis de stocker la clé secrète dans le secret SCW_GENERATIVE_API_KEY de ce projet. " +
  "Voir docs/ADMIN-SCALEWAY.md.";

const NEEDS_ADMIN_TEM_MESSAGE =
  "Ni votre clé Scaleway ni votre clé personnelle n’ont pu être enregistrées pour l’envoi d’e-mails. " +
  "Demandez à l’administrateur de créer une clé avec le droit TransactionalEmailEmailApiCreate limité à ce projet, " +
  "puis de stocker la clé secrète dans le secret TEM_API_SECRET_KEY de ce projet. " +
  "Voir docs/ADMIN-SCALEWAY.md.";

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  name: "",
  description: "",
  webDir: "apps/web",
  trigger: "cron",
  memory: "kv",
  model: "mistral-small-3.2-24b-instruct-2506",
  systemPrompt: "",
  dailyBudget: "1",
  emailAllowedRecipients: "",
  monthlyBudget: "10",
  cronSchedule: "",
  cronPrompt: "",
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  switch (a) {
    case "--name": opts.name = next; i++; break;
    case "--description": opts.description = next; i++; break;
    case "--web-dir": opts.webDir = next; i++; break;
    case "--trigger": opts.trigger = next; i++; break;
    case "--memory": opts.memory = next; i++; break;
    case "--model": opts.model = next; i++; break;
    case "--system-prompt": opts.systemPrompt = next; i++; break;
    case "--daily-budget": opts.dailyBudget = next; i++; break;
    case "--email-allowed-recipients": opts.emailAllowedRecipients = next; i++; break;
    case "--monthly-budget": opts.monthlyBudget = next; i++; break;
    case "--cron-schedule": opts.cronSchedule = next; i++; break;
    case "--cron-prompt": opts.cronPrompt = next; i++; break;
    default: fail(`Unknown arg: ${a}`);
  }
}

const REPO_ROOT = process.cwd();
const AGENT_DIR = join(REPO_ROOT, "apps", opts.name);

// ─── handoff state ────────────────────────────────────────────────────
const STEPS = [
  "preflight", "generativeApiKey", "temApiKey", "ensureMonorepo", "scaffoldAgent",
  "patchSystemPrompt", "patchAgentName", "patchTools", "patchMemory",
  "mergeSchema", "installDeps", "generateMigration", "handoff",
];
const completed = [];
const warnings = [];
const state = {
  monorepoConverted: false,
  schemaPatched: false,
  migrationFiles: [],
};
let current = null;

async function step(name, fn) {
  current = name;
  log(name);
  await fn();
  completed.push(name);
  current = null;
}
function log(msg) { process.stderr.write(`\n▸ ${msg}\n`); }
function ok(msg) { process.stderr.write(`  ✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`  ⚠️  ${msg}\n`); warnings.push(msg); }
function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  if (completed.length || current) dumpHandoff(false, msg);
  process.exit(completed.length || current ? 2 : 1);
}
function dumpHandoff(success, errMsg) {
  const remaining = STEPS.filter(s => !completed.includes(s) && s !== current);
  process.stderr.write(`\n────────────────────────────────────────────────────────\n`);
  process.stderr.write(`setup-agent handoff state\n`);
  process.stderr.write(`────────────────────────────────────────────────────────\n`);
  process.stderr.write(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}\n`);
  if (current) process.stderr.write(`❌ Failed at: ${current}\n`);
  if (remaining.length) process.stderr.write(`⏸  Not attempted: ${remaining.join(", ")}\n`);
  if (warnings.length) {
    process.stderr.write(`\n⚠️  ${warnings.length} warning(s):\n`);
    for (const w of warnings) process.stderr.write(`   - ${w}\n`);
  }
}

process.on("uncaughtException", (e) => {
  process.stderr.write(`\n❌ Uncaught: ${e.message}\n`);
  if (e.stack) process.stderr.write(e.stack + "\n");
  dumpHandoff(false, e.message);
  process.exit(2);
});

function run(cmd, cwd, capture = false) {
  const res = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (res.status !== 0 && !capture) fail(`Command failed: ${cmd}`);
  return res;
}

// ─── Step 1 - preflight ──────────────────────────────────────────────
async function preflight() {
  if (!opts.name || !/^[a-z][a-z0-9-]{1,40}$/.test(opts.name)) {
    fail(`--name must be kebab-case, 2-41 chars (got: "${opts.name}")`);
  }
  if (!["cron", "continuous", "manual"].includes(opts.trigger)) {
    fail(`--trigger must be cron|continuous|manual (got: "${opts.trigger}")`);
  }
  if (!["none", "kv", "pgvector"].includes(opts.memory)) {
    fail(`--memory must be none|kv|pgvector (got: "${opts.memory}")`);
  }
  if (opts.trigger === "cron" && !opts.cronSchedule) {
    fail(`--cron-schedule is required when --trigger is "cron" (5-field cron expression, e.g. "0 7 * * *")`);
  }
  if (existsSync(AGENT_DIR)) {
    fail(`apps/${opts.name}/ already exists. Pick a different --name or remove it first.`);
  }
  if (!existsSync(TEMPLATE_DIR)) fail(`Templates not found at ${TEMPLATE_DIR}`);
  const webPkg = join(REPO_ROOT, opts.webDir, "package.json");
  if (!existsSync(webPkg)) fail(`No package.json at ${opts.webDir}/. Pass --web-dir if your Next.js app is elsewhere.`);
  ok(`agent will be scaffolded at: apps/${opts.name}/`);
  ok(`web app detected at: ${opts.webDir}/`);
}

// ─── Step 2 - generativeApiKey (self-heal, no manual console step) ───
// SCW_GENERATIVE_API_KEY is a per-app Secret Manager secret (CONTRACT.md §2),
// not a User-scope local var like the old LLM provider's key used to be. Since the
// operator's own SCW_ACCESS_KEY/SCW_SECRET_KEY already carries IAM
// permissions, we mint a dedicated, narrowly-scoped IAM Application key
// instead of asking the user to paste anything from a console.
async function generativeApiKey() {
  if (await secretExists("SCW_GENERATIVE_API_KEY")) {
    ok("SCW_GENERATIVE_API_KEY already in Secret Manager");
    return;
  }
  const creds = requireCredentials();
  log("Minting a scoped IAM key for Scaleway Generative APIs");
  try {
    const application = await ensureApplication(`baudrier-agents-${creds.projectId}`);
    await ensurePolicy({
      applicationId: application.id,
      projectId: creds.projectId,
      // Minimal scope: query models only, no deployment management.
      // https://www.scaleway.com/en/docs/iam/reference-content/permission-sets/
      permissionSetNames: ["GenerativeApisModelAccess"],
    });
    const key = await createApiKey({
      applicationId: application.id,
      projectId: creds.projectId,
      description: "SCW_GENERATIVE_API_KEY (baudrier, no expiry)",
    });
    await putSecret("SCW_GENERATIVE_API_KEY", key.secretKey);
    ok("SCW_GENERATIVE_API_KEY minted and stored in Secret Manager");
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;

    log("Cannot mint a dedicated IAM key - falling back to your personal Scaleway key for development");
    try {
      await putSecret("SCW_GENERATIVE_API_KEY", creds.secretKey);
      await recordDevFingerprint("SCW_GENERATIVE_API_KEY", creds.secretKey);
      ok("SCW_GENERATIVE_API_KEY runs on your personal Scaleway key until /publish.");
    } catch {
      throw new ScwError(NEEDS_ADMIN_AGENT_MESSAGE, {
        type: "needs_admin",
        details: {
          recipe: "agent",
          secretName: "SCW_GENERATIVE_API_KEY",
          permissionSets: ["GenerativeApisModelAccess"],
          projectId: creds.projectId,
        },
      });
    }
  }
}

// ─── Step 3 - temApiKey (self-heal) ───────────────────────────────────
// The agent Job sends its own failure-notification emails via the
// Transactional Email API directly (it's a separate process from the
// Next.js container - see templates/agent/mail.ts). TEM_API_SECRET_KEY is
// NOT yet in CONTRACT.md's env var table; flagged in this run's report for
// reconciliation with whichever skill ends up owning TEM provisioning
// end-to-end (add-email). Requires TEM_SENDER_EMAIL/TEM_SENDER_NAME to
// already exist (from /add-email) - if they don't, the agent still
// scaffolds fine, it just can't send failure emails (loop.ts warns at
// runtime instead of throwing).
async function temApiKey() {
  const senderConfigured = (await secretExists("TEM_SENDER_EMAIL")) && (await secretExists("TEM_SENDER_NAME"));
  if (!senderConfigured) {
    warn("TEM_SENDER_EMAIL/TEM_SENDER_NAME not found - the agent will scaffold, but won't be able to send failure-alert emails until /add-email is set up.");
  }
  if (await secretExists("TEM_API_SECRET_KEY")) {
    ok("TEM_API_SECRET_KEY already in Secret Manager");
    return;
  }
  if (!senderConfigured) {
    warn("Skipping TEM_API_SECRET_KEY provisioning (no TEM sender configured yet).");
    return;
  }
  const creds = requireCredentials();
  log("Minting a scoped IAM key for Transactional Email (send-only)");
  try {
    const application = await ensureApplication(`baudrier-agents-${creds.projectId}`);
    await ensurePolicy({
      applicationId: application.id,
      projectId: creds.projectId,
      // Minimal scope: create emails via API only, no domain/webhook management.
      permissionSetNames: ["TransactionalEmailEmailApiCreate"],
    });
    const key = await createApiKey({
      applicationId: application.id,
      projectId: creds.projectId,
      description: "TEM_API_SECRET_KEY (baudrier agents, no expiry)",
    });
    await putSecret("TEM_API_SECRET_KEY", key.secretKey);
    ok("TEM_API_SECRET_KEY minted and stored in Secret Manager");
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;

    log("Cannot mint a dedicated IAM key - falling back to your personal Scaleway key for development");
    try {
      await putSecret("TEM_API_SECRET_KEY", creds.secretKey);
      await recordDevFingerprint("TEM_API_SECRET_KEY", creds.secretKey);
      ok("TEM_API_SECRET_KEY runs on your personal Scaleway key until /publish.");
    } catch {
      throw new ScwError(NEEDS_ADMIN_TEM_MESSAGE, {
        type: "needs_admin",
        details: {
          recipe: "tem",
          secretName: "TEM_API_SECRET_KEY",
          permissionSets: ["TransactionalEmailEmailApiCreate"],
          projectId: creds.projectId,
        },
      });
    }
  }
}

// ─── Step 4 - ensureMonorepo ─────────────────────────────────────────
async function ensureMonorepo() {
  const wsFile = join(REPO_ROOT, "pnpm-workspace.yaml");
  const isMonorepo = existsSync(wsFile) && existsSync(join(REPO_ROOT, "apps", "web"));
  if (isMonorepo) {
    ok("Monorepo detected - apps/web/ ready");
    return;
  }
  fail(`Project is not yet a Turborepo monorepo. The /add-agent SKILL must invoke _convert-to-turborepo before re-running this script.`);
}

// ─── Step 5 - scaffoldAgent ──────────────────────────────────────────
async function scaffoldAgent() {
  mkdirSync(AGENT_DIR, { recursive: true });
  copyDirRecursive(TEMPLATE_DIR, AGENT_DIR, [
    // Don't copy the schema-snippet to apps/agent - it goes to the main schema (Step 10).
    "schema-snippet.ts",
    // Pages template: belongs to /add-agent-dashboard, not here.
    "pages",
  ]);

  // The APP's own Project id, not the operator's global default: the value
  // lands in job-definition.json as the agent's runtime SCW_DEFAULT_PROJECT_ID
  // (mail.ts needs it for TEM), so the by-name resolution must apply here too.
  const projectId = await resolveProjectId();
  let appUrl = "";
  try { appUrl = await getSecret("APP_URL"); } catch { /* not provisioned yet - fine, filled at deploy time */ }

  // Variable substitution on text files. Job-definition-specific keys only
  // ever appear in job-definition.json; harmless no-ops elsewhere.
  const vars = {
    AGENT_NAME: opts.name,
    PROJECT_NAME: detectProjectName(),
    AGENT_TRIGGER_MODE: opts.trigger,
    AGENT_CRON_SCHEDULE: opts.trigger === "cron" ? opts.cronSchedule : "",
    AGENT_CRON_PROMPT: opts.trigger === "cron" ? (opts.cronPrompt || "Run your scheduled task.") : "",
    AGENT_MODEL: opts.model,
    AGENT_DAILY_BUDGET_EUR: opts.dailyBudget,
    AGENT_MONTHLY_BUDGET_EUR: opts.monthlyBudget,
    AGENT_EMAIL_ALLOWED_RECIPIENTS: opts.emailAllowedRecipients,
    AGENT_JOB_TIMEOUT: opts.trigger === "continuous" ? "86400s" : "1800s",
    SCW_DEFAULT_PROJECT_ID: projectId,
    APP_URL: appUrl,
  };
  walkAndSubstitute(AGENT_DIR, vars);
  ok(`Scaffolded ${countFiles(AGENT_DIR)} files into apps/${opts.name}/`);
}

function copyDirRecursive(src, dst, exclude = []) {
  for (const entry of readdirSync(src)) {
    if (exclude.includes(entry)) continue;
    const sp = join(src, entry);
    const dp = join(dst, entry);
    if (statSync(sp).isDirectory()) {
      mkdirSync(dp, { recursive: true });
      copyDirRecursive(sp, dp, []);
    } else {
      copyFileSync(sp, dp);
    }
  }
}

function walkAndSubstitute(dir, vars) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { walkAndSubstitute(p, vars); continue; }
    if (!/\.(ts|tsx|js|json|yaml|yml|md|env)$/i.test(entry)) continue;
    let content = readFileSync(p, "utf8");
    let changed = false;
    for (const [k, v] of Object.entries(vars)) {
      const re = new RegExp(`\\{\\{${k}\\}\\}`, "g");
      if (re.test(content)) { content = content.replace(re, v ?? ""); changed = true; }
    }
    if (changed) writeFileSync(p, content, "utf8");
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function detectProjectName() {
  try {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return (root.name ?? "project").replace(/^@/, "").replace(/\//g, "-");
  } catch { return "project"; }
}

// ─── Step 6 - patchSystemPrompt ──────────────────────────────────────
async function patchSystemPrompt() {
  if (!opts.systemPrompt) {
    warn("No --system-prompt provided - keeping the placeholder. Edit apps/" + opts.name + "/loop.ts later.");
    return;
  }
  const p = join(AGENT_DIR, "loop.ts");
  let content = readFileSync(p, "utf8");
  const escaped = opts.systemPrompt.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  const re = /const TEMPLATE_SYSTEM_PROMPT = `[\s\S]*?`;/;
  if (!re.test(content)) fail("Could not locate TEMPLATE_SYSTEM_PROMPT in loop.ts");
  content = content.replace(re, `const TEMPLATE_SYSTEM_PROMPT = \`${escaped}\`;`);
  writeFileSync(p, content, "utf8");
  ok("System prompt injected into loop.ts");
}

// ─── Step 7 - patchAgentName ─────────────────────────────────────────
async function patchAgentName() {
  for (const file of ["loop.ts", "memory-kv.ts", "memory-pgvector.ts"]) {
    const p = join(AGENT_DIR, file);
    if (!existsSync(p)) continue;
    let content = readFileSync(p, "utf8");
    content = content
      .replace(/const TEMPLATE_AGENT_NAME = "[^"]*";/, `const TEMPLATE_AGENT_NAME = "${opts.name}";`)
      .replace(/const AGENT_NAME = "[^"]*";/, `const AGENT_NAME = "${opts.name}";`);
    writeFileSync(p, content, "utf8");
  }
  ok(`Agent slug "${opts.name}" set in loop.ts, memory-kv.ts and memory-pgvector.ts`);
}

// ─── Step 8 - patchTools (no-op for v1: keep all 3 default tools) ────
async function patchTools() {
  ok("Default tools kept: http_fetch, send_email, db_query");
}

// ─── Step 9 - patchMemory ────────────────────────────────────────────
async function patchMemory() {
  const kvPath = join(AGENT_DIR, "memory-kv.ts");
  const vecPath = join(AGENT_DIR, "memory-pgvector.ts");

  if (opts.memory === "kv") {
    if (existsSync(vecPath)) {
      writeFileSync(vecPath, "// Vector memory not selected at scaffold time - use memory-kv instead, or re-run /add-agent with --memory pgvector.\nexport {};\n");
    }
    ok("Memory mode: KV (Postgres table agent_memory_kv)");
    return;
  }

  if (opts.memory === "pgvector") {
    // No new credential needed - unlike an older embeddings-provider path,
    // embeddings reuse SCW_GENERATIVE_API_KEY (already minted in Step 2).
    const apiKey = await getSecret("SCW_GENERATIVE_API_KEY");
    const baseUrl = process.env.SCW_GENERATIVE_BASE_URL || "https://api.scaleway.ai/v1";

    log("Verifying the Generative APIs embeddings endpoint (qwen3-embedding-8b)");
    let smokeOk = false;
    let smokeDetail = "";
    try {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen3-embedding-8b", input: "smoke test" }),
      });
      smokeDetail = `HTTP ${res.status}`;
      if (res.ok) {
        const json = await res.json();
        smokeOk = Array.isArray(json?.data?.[0]?.embedding) && json.data[0].embedding.length >= 2000;
      } else {
        smokeDetail += `: ${(await res.text()).slice(0, 200)}`;
      }
    } catch (e) {
      smokeDetail = e instanceof Error ? e.message : String(e);
    }
    if (!smokeOk) {
      fail(`Generative APIs embeddings smoke test failed (${smokeDetail}). Check SCW_GENERATIVE_API_KEY has access to qwen3-embedding-8b.`);
    }
    ok("Embeddings endpoint reachable, qwen3-embedding-8b returns >= 2000 dims");

    // pgvector DDL: NOT run directly against the DB (CONTRACT.md §4 - the
    // operator's machine never holds a DATABASE_URL). Instead, generate an
    // empty custom drizzle-kit migration and write the DDL into it; it gets
    // applied later by the deploy pipeline's migration Job, same as any
    // other schema change.
    const webPath = join(REPO_ROOT, opts.webDir);
    log("Writing a custom migration to enable pgvector + create agent_memory_vector");
    const migrationName = `enable-pgvector-${opts.name}`;
    const before = listMigrationFiles(webPath);
    const r = run(`npx drizzle-kit generate --custom --name ${migrationName}`, webPath, true);
    if (r.status !== 0) {
      warn(`drizzle-kit generate --custom failed (exit ${r.status}). Create the migration manually with the DDL documented in schema-snippet.ts. stderr: ${(r.stderr ?? "").slice(0, 300)}`);
    } else {
      const after = listMigrationFiles(webPath);
      const created = after.filter((f) => !before.includes(f));
      if (created.length !== 1) {
        warn(`Expected exactly one new migration file, found ${created.length}. Add the pgvector DDL manually (see schema-snippet.ts) to whichever migration drizzle-kit just generated.`);
      } else {
        const ddl = `-- Enable pgvector and create agent_memory_vector for agent "${opts.name}"
-- (Scaleway Serverless SQL Database ships the pgvector extension - no separate provisioning.)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memory_vector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(2000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_memory_vector_agent_idx ON agent_memory_vector(agent_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_memory_vector_embedding_idx ON agent_memory_vector
  USING hnsw (embedding vector_cosine_ops);
`;
        writeFileSync(join(webPath, created[0]), ddl, "utf8");
        state.migrationFiles.push(created[0]);
        ok(`pgvector migration written: ${created[0]} (applied by the next /deploy)`);
      }
    }

    if (existsSync(kvPath)) {
      writeFileSync(kvPath, "// Vector memory selected at scaffold time - use memory-pgvector instead.\nexport {};\n");
    }
    ok("Memory mode: vector (Scaleway Generative APIs embeddings + pgvector, 2000 dims)");
    return;
  }

  // none → stateless
  if (existsSync(kvPath)) {
    writeFileSync(kvPath, "// Memory disabled at scaffold time - agent runs stateless.\nexport {};\n");
  }
  if (existsSync(vecPath)) {
    writeFileSync(vecPath, "// Memory disabled at scaffold time - agent runs stateless.\nexport {};\n");
  }
  ok("Memory mode: stateless");
}

function listMigrationFiles(webPath) {
  // drizzle-kit's default output dir is "drizzle"; respect drizzle.config.ts's
  // `out` if it says otherwise. Best-effort: falls back to "drizzle".
  let outDir = "drizzle";
  const cfgPath = join(webPath, "drizzle.config.ts");
  if (existsSync(cfgPath)) {
    const m = readFileSync(cfgPath, "utf8").match(/out:\s*["']([^"']+)["']/);
    if (m) outDir = m[1];
  }
  const dir = join(webPath, outDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join(outDir, f));
}

// ─── Step 10 - mergeSchema ────────────────────────────────────────────
async function mergeSchema() {
  const mainSchema = join(REPO_ROOT, opts.webDir, "src/server/db/schema.ts");
  if (!existsSync(mainSchema)) {
    warn(`No main schema at ${mainSchema} - agent tables NOT added to the main app. The agent Job has its own schema.ts copy and will work, but the Next.js app won't have direct Drizzle access to agent_* tables.`);
    return;
  }
  const snippet = readFileSync(join(TEMPLATE_DIR, "schema-snippet.ts"), "utf8");
  const main = readFileSync(mainSchema, "utf8");
  if (main.includes("agent_invocations")) {
    ok("Agent tables already present in main schema - skipping");
    return;
  }
  const marker = `\n\n// ─── Agent tables (added by /add-agent on ${new Date().toISOString().slice(0, 10)}) ───\n`;
  const body = snippet
    .replace(/^[\s\S]*?(?=export const agentInvocations)/, "")
    .trim();
  writeFileSync(mainSchema, main.trimEnd() + marker + body + "\n", "utf8");
  state.schemaPatched = true;
  ok("Agent tables appended to main schema");
}

// ─── Step 11 - installDeps ───────────────────────────────────────────
async function installDeps() {
  log("Running pnpm install (workspace) - this can take 30-60 s");
  run("pnpm install", REPO_ROOT);
  ok("Dependencies installed");
}

// ─── Step 12 - generateMigration ─────────────────────────────────────
// Per CONTRACT.md §4: the operator's machine NEVER connects to the database.
// `drizzle-kit generate` only writes SQL files (no DATABASE_URL needed); the
// migration is applied later by /deploy's migration Serverless Job.
async function generateMigration() {
  if (!state.schemaPatched) {
    warn("Schema not patched - skipping migration generation (run `npx drizzle-kit generate` manually if you wired it up).");
    return;
  }
  log("Running drizzle-kit generate (writes SQL, no DB connection)");
  const before = listMigrationFiles(join(REPO_ROOT, opts.webDir));
  const r = run("npx drizzle-kit generate", join(REPO_ROOT, opts.webDir), true);
  if (r.status !== 0) {
    warn(`drizzle-kit generate failed (exit ${r.status}). Run manually from ${opts.webDir}.`);
    if (r.stderr) process.stderr.write(r.stderr.slice(0, 500) + "\n");
    return;
  }
  const after = listMigrationFiles(join(REPO_ROOT, opts.webDir));
  const created = after.filter((f) => !before.includes(f));
  state.migrationFiles.push(...created);
  ok(`Migration written (${created.join(", ") || "no new file - schema already up to date"}). Applied automatically by the next /deploy.`);
}

// ─── Step 13 - handoff ───────────────────────────────────────────────
async function handoff() {
  ok("Pipeline complete. Returning structured handoff to Claude.");
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("generativeApiKey", generativeApiKey);
await step("temApiKey", temApiKey);
await step("ensureMonorepo", ensureMonorepo);
await step("scaffoldAgent", scaffoldAgent);
await step("patchSystemPrompt", patchSystemPrompt);
await step("patchAgentName", patchAgentName);
await step("patchTools", patchTools);
await step("patchMemory", patchMemory);
await step("mergeSchema", mergeSchema);
await step("installDeps", installDeps);
await step("generateMigration", generateMigration);
await step("handoff", handoff);

dumpHandoff(true);

// Final JSON on stdout (Claude parses this for the user-facing summary)
process.stdout.write(JSON.stringify({
  success: true,
  agentName: opts.name,
  agentDir: relative(REPO_ROOT, AGENT_DIR),
  trigger: opts.trigger,
  memory: opts.memory,
  model: opts.model,
  dailyBudgetEur: opts.dailyBudget,
  monthlyBudgetEur: opts.monthlyBudget,
  schemaPatched: state.schemaPatched,
  migrationFiles: state.migrationFiles,
  warnings,
  nextSteps: {
    commit: `git add . && git commit -m "feat(agent): scaffold ${opts.name} agent"`,
    push: "git push",
    deploy: [
      "Run /deploy. It fully creates and",
      "updates the agent's Scaleway Serverless Job automatically (from",
      `apps/${opts.name}/job-definition.json) - no manual dashboard step.`,
      "The same /deploy run applies the pending database migration(s) via",
      "the migration Job.",
    ],
  },
}) + "\n");
