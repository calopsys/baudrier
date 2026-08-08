#!/usr/bin/env node
// setup-email.mjs - Deterministic core for /add-email (Scaleway Transactional
// Email / TEM - the only email provider in this harness, see CONTRACT.md).
//
// Unlike some other providers' free/test tiers, TEM has no shared "test
// sender" you can send from immediately: a sending domain must be added to
// TEM and its SPF/DKIM/DMARC/MX records published before ANY email can be
// sent. So domain setup is not an optional "later" step here - it's part of
// the deterministic core, right alongside scaffolding mail.ts.
//
// Usage:
//   node setup-email.mjs --name <project-name> --sender-email <email> \
//     [--sender-name <name>] [--web-dir .]
//
// Args:
//   --name          required, kebab-case project name (also the default sender name)
//   --sender-email  required, e.g. contact@mydomain.com - its domain becomes
//                   the TEM sending domain
//   --sender-name   optional, default = --name
//   --web-dir       default: cwd
//
// Prerequisites assumed by the script:
//   - Scaleway operator credentials are already available (SCW_ACCESS_KEY /
//     SCW_SECRET_KEY env vars, or the scw CLI profile) - see
//     scripts/scaleway/_scw-auth.mjs. No vault, no per-provider API key: TEM
//     is billed straight to the Scaleway Project, same credentials as every
//     other scripts/scaleway/*.mjs module.
//   - The project has a working T3 scaffold (Next.js + tRPC + setup-security
//     from /bootstrap, because the contact router uses rateLimitedProcedure).
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end (success OR failure)
//   - Last line on success: a single JSON object Claude can parse
//
// Exit codes:
//   0 = success
//   1 = preflight failed (bad args, missing deps)
//   2 = a step failed mid-pipeline; partial state on disk; handoff banner explains

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./_render.mjs";
import { ensureDomain, getDomainRecords, checkDomain } from "./scaleway/tem.mjs";
import { zoneExists, isDelegatedToScaleway, upsertRecords } from "./scaleway/dns.mjs";
import { putSecret } from "./scaleway/secrets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Declared before arg parsing: fail() (usable from the very first line of
// arg validation) reads `completed`/`current`, so both must exist before any
// `fail()` call can happen, not just before the pipeline steps run.
const completed = [];
const warnings = [];
let current = null;

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let webDir = ".";
let senderEmail = "";
let senderName = "";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else if (a === "--sender-email" && args[i + 1]) senderEmail = args[++i];
  else if (a === "--sender-name" && args[i + 1]) senderName = args[++i];
  else fail(`Unknown arg: ${a}`);
}

if (!name) fail("--name <project-name> is required");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}
if (!senderEmail) fail("--sender-email <email> is required (Scaleway TEM has no shared test sender)");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
  fail(`--sender-email must be a valid email. Got: ${senderEmail}`);
}
if (!senderName) senderName = name;

const domain = senderEmail.split("@")[1].toLowerCase();
const WEB_DIR = resolve(process.cwd(), webDir);

// ─── helpers ──────────────────────────────────────────────────────────
const STEPS = ["preflight", "configureDomain", "writeMailTs", "writeContactRouter", "registerRouter", "pushEnvVars"];
const state = {
  senderEmail,
  senderName,
  domain,
  temDomainId: null,
  temDomainStatus: null,
  dnsAutoPublished: false,
  dnsRecords: [],
  envVarsPushed: [],
};

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
  console.log(`setup-email handoff state (Scaleway TEM, domain: ${domain})`);
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) during the run:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }
  if (state.dnsRecords.length) {
    console.log(`\nTEM DNS records for "${domain}" (${state.dnsAutoPublished ? "published automatically" : "PUBLISH THESE MANUALLY"}):`);
    for (const r of state.dnsRecords) console.log(`   ${r.type.padEnd(6)} ${r.name || "@"}  ->  ${r.value}`);
  }
  if (!success) {
    console.log(
      "\nFor the agent picking this up:\n" +
        `  - Web dir: ${WEB_DIR}\n` +
        "  - Each step in this script maps 1:1 to a section of add-email SKILL.md.\n",
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
  if (e.stack) console.error(e.stack);
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

// ─── Step 1: preflight ────────────────────────────────────────────────
async function preflight() {
  log("Preflight");

  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`No package.json at ${WEB_DIR}. Pass --web-dir <path-to-nextjs-app> if needed.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) fail(`${WEB_DIR} doesn't depend on Next.js - add-email requires a Next.js project.`);
  if (!deps["@trpc/server"]) {
    fail(`${WEB_DIR} doesn't depend on @trpc/server - the contact router requires tRPC.`);
  }

  // Check rateLimitedProcedure exists (created by setup-security.mjs in bootstrap).
  // Without it, the contact router won't compile.
  const trpcPath = join(WEB_DIR, "src/server/api/trpc.ts");
  if (existsSync(trpcPath)) {
    const trpcContent = readFileSync(trpcPath, "utf8");
    if (!trpcContent.includes("rateLimitedProcedure")) {
      warn(
        "rateLimitedProcedure not found in src/server/api/trpc.ts. The contact router uses it " +
          "for rate limiting. Either run /bootstrap (which calls setup-security.mjs to add it), " +
          "or expect a TS build error after this script and fall back to publicProcedure manually.",
      );
    }
  } else {
    warn(`${trpcPath} not found - T3 may have moved tRPC config. Verify the contact router compiles.`);
  }

  // Block accidental overwrites: refuse if mail.ts or contact router already exists.
  // Re-config flow is handled by Claude in SKILL Step 0 - by the time we're here, this
  // should be a fresh install.
  const mailPath = join(WEB_DIR, "src/server/mail.ts");
  if (existsSync(mailPath)) {
    fail(
      `${mailPath} already exists. If you meant to re-configure email, use the /add-email ` +
        "re-configuration menu (Step 0 of the SKILL). To force a fresh install, delete the " +
        "file manually first.",
    );
  }
  const contactRouterPath = join(WEB_DIR, "src/server/api/routers/contact.ts");
  if (existsSync(contactRouterPath)) {
    fail(
      `${contactRouterPath} already exists. If you meant to re-configure email, use the ` +
        "/add-email re-configuration menu. To force a fresh install, delete the file manually first.",
    );
  }

  // pnpm available?
  const pnpm = capture("pnpm --version", WEB_DIR);
  if (pnpm.status !== 0) fail("pnpm CLI is missing or broken.");

  ok(`Web dir OK: ${WEB_DIR}`);
  ok(`Sender: ${senderName} <${senderEmail}> (domain: ${domain})`);
}

// ─── Step 2: configure the TEM sending domain ─────────────────────────
async function configureDomain() {
  log(`Ensuring TEM domain "${domain}"`);

  // TEM caps a fresh (pre-KYC) account at 500 emails/month and 2 domains;
  // once identity verification is done that rises to 5,000/month and 5
  // domains. Surfaced here (not just in tem.mjs's JSDoc) so it reaches the
  // console output the SKILL relays to the user - see CONTRACT.md §3.
  warn(
    "Un compte Scaleway récent (avant vérification d'identité) est limité à 500 emails/mois " +
      "et 2 domaines d'envoi. Après vérification KYC : 5 000 emails/mois et 5 domaines.",
  );

  const d = await ensureDomain(domain);
  state.temDomainId = d.id;
  state.temDomainStatus = d.status;
  ok(`TEM domain ${d.id} (status: ${d.status})`);

  const records = await getDomainRecords(d.id);
  state.dnsRecords = records;
  if (records.length === 0) {
    warn(`Scaleway TEM returned no DNS records for "${domain}" - check the domain manually in the Scaleway console.`);
    return;
  }
  log(`${records.length} DNS record(s) to publish (SPF/DKIM/DMARC/MX)`);

  const delegated = await isDelegatedToScaleway(domain).catch(() => false);
  const hasZone = delegated && (await zoneExists(domain).catch(() => false));

  if (hasZone) {
    await upsertRecords(
      domain,
      records.map((r) => ({ name: r.name, type: r.type, data: r.value })),
    );
    state.dnsAutoPublished = true;
    ok(`DNS records published automatically via Scaleway DNS.`);
  } else {
    state.dnsAutoPublished = false;
    warn(
      `"${domain}" is not delegated to Scaleway DNS (or its zone doesn't exist yet) - the DNS records ` +
        "below must be added manually at your current DNS provider, or run /add-domain first to delegate " +
        "this domain to Scaleway DNS, then re-run this step.",
    );
  }

  // Best-effort nudge so a Claude session revisiting the domain later sees a
  // fresher status. Verification is asynchronous regardless and can take up
  // to 48h after the records above are actually live - never block on it.
  try {
    const rechecked = await checkDomain(d.id);
    state.temDomainStatus = rechecked.status;
    ok(`Domain check triggered (status: ${rechecked.status}). Full verification can take up to 48h.`);
  } catch (e) {
    warn(`Could not trigger an immediate domain re-check: ${e.message}`);
  }
}

// ─── Step 3: write src/server/mail.ts ─────────────────────────────────
async function writeMailTs() {
  log("Writing src/server/mail.ts");
  const dest = join(WEB_DIR, "src/server/mail.ts");
  writeFileSync(dest, render("email/mail.ts", {}));
  ok(`${dest} written`);
}

// ─── Step 4: write contact tRPC router ────────────────────────────────
async function writeContactRouter() {
  log("Writing src/server/api/routers/contact.ts");
  const dest = join(WEB_DIR, "src/server/api/routers/contact.ts");
  writeFileSync(dest, render("email/contact-router.ts", {}));
  ok(`${dest} written`);
}

// ─── Step 5: register contactRouter in root.ts ────────────────────────
async function registerRouter() {
  log("Registering contactRouter in src/server/api/root.ts");
  const rootPath = join(WEB_DIR, "src/server/api/root.ts");
  if (!existsSync(rootPath)) {
    fail(`${rootPath} not found - T3 may have moved the appRouter. Register contactRouter manually.`);
  }
  let root = readFileSync(rootPath, "utf8");

  if (root.includes("contactRouter")) {
    ok("contactRouter already registered (no-op)");
    return;
  }

  const importLine = `import { contactRouter } from "~/server/api/routers/contact";\n`;
  const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    root = root.replace(lastImport[0], lastImport[0] + importLine);
  } else {
    root = importLine + root;
  }

  // Inject `contact: contactRouter,` inside createTRPCRouter({ ... }).
  const replaced = root.replace(
    /createTRPCRouter\(\s*\{/,
    `createTRPCRouter({\n  contact: contactRouter,`,
  );
  if (replaced === root) {
    fail(
      "Could not find createTRPCRouter({ ... }) in root.ts. " +
        "Register contactRouter manually: add `contact: contactRouter,` inside the router object.",
    );
  }
  writeFileSync(rootPath, replaced);
  ok("contactRouter registered");
}

// ─── Step 6: push env vars (.env + Scaleway Secret Manager) ───────────
async function pushEnvVars() {
  log("Writing TEM_SENDER_EMAIL / TEM_SENDER_NAME (.env + Scaleway Secret Manager)");

  const pairs = { TEM_SENDER_EMAIL: senderEmail, TEM_SENDER_NAME: senderName };

  // Local .env (dev). Kept in sync with Secret Manager below, which is the
  // source of truth mirrored into the deployed container's
  // secret_environment_variables at deploy time (see CONTRACT.md §1).
  const envPath = join(WEB_DIR, ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const kept = existing.split("\n").filter((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    return !m || !(m[1] in pairs);
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  for (const [k, v] of Object.entries(pairs)) kept.push(`${k}=${v}`);
  writeFileSync(envPath, kept.join("\n") + "\n");
  ok(`.env updated (${Object.keys(pairs).join(", ")})`);

  const gitignorePath = join(WEB_DIR, ".gitignore");
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.split("\n").some((l) => l.trim() === ".env")) {
    const suffix = gitignore.length === 0 || gitignore.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, gitignore + suffix + ".env\n");
    ok(".env added to .gitignore");
  }

  for (const [k, v] of Object.entries(pairs)) {
    await putSecret(k, v);
  }
  ok(`Scaleway Secret Manager updated: ${Object.keys(pairs).join(", ")}`);

  state.envVarsPushed = Object.keys(pairs);
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("configureDomain", configureDomain);
await step("writeMailTs", writeMailTs);
await step("writeContactRouter", writeContactRouter);
await step("registerRouter", registerRouter);
await step("pushEnvVars", pushEnvVars);

dumpHandoff(true);

console.log(`
🎉 setup-email complete (Scaleway TEM).

   Sender:        ${senderName} <${senderEmail}>
   TEM domain:    ${domain} (id ${state.temDomainId}, status: ${state.temDomainStatus})
   DNS records:   ${state.dnsAutoPublished ? "published automatically" : "MUST be published manually - see above"}
   mail.ts:       src/server/mail.ts
   Contact route: src/server/api/routers/contact.ts (registered as \`contact\` in root.ts)
   Env vars:      ${state.envVarsPushed.join(", ")}

Reminder: TEM domain verification is asynchronous and can take up to 48h even
after the DNS records above are live. Sending will fail until it completes.

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md), the
RGPD subprocessor registry update, the optional contact-page creation (via
_create-contact-page), and the user-facing summary.
`);

// Last line: structured JSON for Claude to parse.
console.log(
  JSON.stringify({
    success: true,
    senderEmail,
    senderName,
    domain,
    temDomainId: state.temDomainId,
    temDomainStatus: state.temDomainStatus,
    dnsAutoPublished: state.dnsAutoPublished,
    envVars: state.envVarsPushed,
  }),
);
