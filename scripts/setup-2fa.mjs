#!/usr/bin/env node
// setup-2fa.mjs - Deterministic core for _setup-2fa-admin.
//
// Adds two-factor authentication (TOTP authenticator app) on top of an existing
// baudrier admin-credentials auth:
//   - TOTP code verified after the password (otpauth, ±1 window)
//   - "trusted device" cookie: 2FA asked once / 24h per browser
//   - one-off backup codes (hashed in an env var, no DB needed)
//   - idle auto-logout component (mounted by Claude in the protected layout)
//
// SECURITY: the TOTP secret + plaintext backup codes are written to Scaleway
// Secret Manager (secret <NAME>_2FA, in the app's own Project), NOT to the chat
// and NOT to a plaintext file. A QR png is written to <web>/.2fa-setup/
// (gitignored) ONLY as a scanning aid; Claude tells the user to delete it after
// enrolling. If Secret Manager is unavailable, the script falls back to a
// gitignored secrets.txt and flags it.
//
// Prereq: baudrier admin auth + Scaleway credentials (SCW_ACCESS_KEY /
// SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID) available to the operator machine.
//
// Usage:
//   node setup-2fa.mjs --name <project-name> [--issuer <Label>] [--web-dir .]

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";
import { render } from "./_render.mjs";
import { putSecret } from "./scaleway/secrets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let issuer = "";
let webDir = ".";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--issuer" && args[i + 1]) issuer = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else fail(`Unknown arg: ${a}`);
}
if (!name) fail("Usage: --name <project-name> is required");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) fail(`--name must be kebab-case. Got: ${name}`);
if (!issuer) issuer = name.charAt(0).toUpperCase() + name.slice(1);
const COOKIE_NAME = `${name.replace(/[^a-z0-9_]/g, "_")}_2fa_trust`;
const SECRET_NAME = `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_2FA`;
const WEB_DIR = resolve(process.cwd(), webDir);

// ─── plumbing (mirrors setup-auth-admin.mjs) ──────────────────────────
// Backup-code single-use tracking (consumed_backup_code), the trusted-device
// revocation table, and the one-time login-proof nonce all need a real
// table, not an env var - so /add-2fa now requires a database (patchSchema /
// pushSchema below), the same prerequisite /add-auth users-mode already has.
const STEPS = [
  "preflight",
  "installDeps",
  "generateSecret",
  "generateBackupCodes",
  "patchSchema",
  "generateMigration",
  "writeCode",
  "patchSignOut",
  "storeSecrets",
  "pushEnvVars",
];
const completed = [];
const warnings = [];
let current = null;
const state = { base32: null, otpauthUrl: null, backupCodes: [], backupHashes: [], qrPath: null, storedIn: null, migrationFiles: [] };

// Recognized src/lib/rate-limit.ts variants (see templates/2fa/rate-limit.ts
// for the DB-backed one and scripts/setup-security.mjs for the memory-only
// one it upgrades from). A file with neither marker is either hand-written
// or already customized - never overwritten.
const RATE_LIMIT_MARKER_MEMORY = "baudrier:rate-limit memory-only";
const RATE_LIMIT_MARKER_DB = "baudrier:rate-limit db-backed";

/** Creates or upgrades src/lib/rate-limit.ts to the DB-backed variant.
 * Returns "created" | "upgraded" | "already-db-backed" | "left-alone". */
function ensureDbBackedRateLimit(webDir) {
  const rlPath = join(webDir, "src/lib/rate-limit.ts");
  if (!existsSync(rlPath)) {
    mkdirSync(dirname(rlPath), { recursive: true });
    writeFileSync(rlPath, render("2fa/rate-limit.ts", {}));
    return "created";
  }
  const current = readFileSync(rlPath, "utf8");
  if (current.includes(RATE_LIMIT_MARKER_DB)) return "already-db-backed";
  if (current.includes(RATE_LIMIT_MARKER_MEMORY)) {
    writeFileSync(rlPath, render("2fa/rate-limit.ts", {}));
    return "upgraded";
  }
  return "left-alone";
}

async function step(n, fn) { current = n; await fn(); completed.push(n); current = null; }
function log(m) { console.log(`\n▸ ${m}`); }
function ok(m) { console.log(`  ✅ ${m}`); }
function warn(m) { console.warn(`  ⚠️  ${m}`); warnings.push(m); }
function dumpHandoff() {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-2fa handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) { console.log(`\n⚠️  ${warnings.length} warning(s):`); for (const w of warnings) console.log(`   - ${w}`); }
  console.log("────────────────────────────────────────────────────────");
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  if (completed.length || current) dumpHandoff();
  // Exit 1 = clean refusal (nothing changed yet, e.g. preflight). Exit 2 = a
  // step completed before failure → partial state, resume carefully.
  process.exit(completed.length ? 2 : 1);
}
process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e.stack) console.error(e.stack);
  dumpHandoff();
  process.exit(2);
});
function run(cmd, cwd, opts = {}) {
  const res = spawnSync(cmd, { cwd, stdio: opts.capture ? "pipe" : "inherit", shell: true, encoding: "utf8" });
  if (res.status !== 0 && !opts.allowFail) fail(`Command failed (exit ${res.status}): ${cmd}`);
  return res;
}

function base32Encode(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
// Same scrypt cost + format as templates/auth/admin/password.ts's
// hashPassword (verifyPassword there is what checks these hashes, via
// templates/2fa/auth-backup-codes.ts) - keep all four mint sites in
// lockstep. N=32768 is two times Node's default; the working set is
// `128 * N * r` bytes = 32 MiB per hash. The container is the ceiling:
// preset S gives 512 MB for 8 concurrent requests, and any credentials
// request can force one hash. CONTRACT.md records the coupling; verify
// check 71 enforces it.
const BACKUP_CODE_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashCode(code) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(code, salt, 64, BACKUP_CODE_SCRYPT_PARAMS).toString("hex");
  const tag = `N=${BACKUP_CODE_SCRYPT_PARAMS.N},r=${BACKUP_CODE_SCRYPT_PARAMS.r},p=${BACKUP_CODE_SCRYPT_PARAMS.p}`;
  return `scrypt:${tag}:${salt}:${hash}`;
}

// ─── steps ────────────────────────────────────────────────────────────
async function preflight() {
  log("Preflight");
  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) fail(`No package.json at ${WEB_DIR}. Pass --web-dir.`);
  const deps = (() => { const p = JSON.parse(readFileSync(pkgPath, "utf8")); return { ...p.dependencies, ...p.devDependencies }; })();
  if (!deps.next) fail(`${WEB_DIR} isn't a Next.js project.`);
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  if (!existsSync(authPath)) fail("src/server/auth.ts not found - run /add-auth (admin mode) first.");
  if (!/baudrier:auth-modes\s+admin\b/.test(readFileSync(authPath, "utf8"))) {
    fail("Auth isn't in baudrier admin mode (marker `// baudrier:auth-modes admin` not found).");
  }
  if (!existsSync(join(WEB_DIR, "src/lib/password.ts"))) fail("src/lib/password.ts not found - expected from /add-auth admin mode.");
  if (existsSync(join(WEB_DIR, "src/lib/auth-2fa.ts"))) fail("src/lib/auth-2fa.ts already exists - 2FA seems already installed.");

  // Backup-code single-use tracking, trusted-device revocation, and the
  // login-proof nonce are all persisted rows, not env-var state - unlike
  // plain admin auth, 2FA needs a real database.
  if (!deps["drizzle-orm"]) {
    fail(`${WEB_DIR} doesn't depend on drizzle-orm. Run /add-db before /add-2fa - 2FA needs a database (trusted devices, one-time login proofs, spent backup codes).`);
  }
  // Bootstrap always resets schema.ts to the plain pgTable convention
  // (CONTRACT.md §4: one database per app, no table-name-prefix helper),
  // so no further shape check is needed here.
  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  if (!existsSync(schemaPath)) {
    fail(`${schemaPath} not found - T3 db scaffold missing. Run /add-db first.`);
  }

  // loginAction imports checkRateLimit from ~/lib/rate-limit. Bootstrap creates
  // a memory-only version via setup-security.mjs; writeCode below upgrades it
  // to the DB-backed variant (a database is now guaranteed by the checks
  // above), or creates it directly if it's missing entirely.
  if (run("pnpm --version", WEB_DIR, { capture: true, allowFail: true }).status !== 0) fail("pnpm missing.");
  ok(`Web dir OK: ${WEB_DIR}`);
}

// ─── Step: patch schema.ts (imports + append 2FA + rate-limit tables) ──
async function patchSchema() {
  log("Patching src/server/db/schema.ts (2FA tables + rate-limit table)");
  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  let schema = readFileSync(schemaPath, "utf8");

  schema = ensureImport(schema, "drizzle-orm/pg-core", ["pgTable", "text", "integer", "primaryKey", "index", "timestamp"]);
  schema = ensureImport(schema, "drizzle-orm", ["sql"]);

  if (/^export const trustedDevices\s*=\s*pgTable\("trusted_device"/m.test(schema)) {
    warn("`trustedDevices` already declared in schema.ts - skipping 2FA schema patch.");
  } else {
    const twoFaTables = render("2fa/schema-additions.ts", {});
    schema = schema.trimEnd() + "\n\n" + twoFaTables;
  }

  if (/^export const loginAttempts\s*=\s*pgTable\("login_attempt"/m.test(schema)) {
    warn("`loginAttempts` already declared in schema.ts - skipping rate-limit schema patch.");
  } else {
    const rateLimitTable = render("auth/schema-additions-login-attempts.ts", {});
    schema = schema.trimEnd() + "\n\n" + rateLimitTable;
  }

  writeFileSync(schemaPath, schema.trimEnd() + "\n");
  ok("Schema patched: imports + trusted_device + login_proof + consumed_backup_code + login_attempt");
}

/**
 * Ensure a named import is present in the file. If a `from "<module>"` import
 * already exists, augment it to include the missing names. Otherwise prepend
 * a new import statement after the last existing import. (Mirrors
 * setup-auth-users.mjs's helper of the same name.)
 */
function ensureImport(content, module, names) {
  // Anchored to a line start (^, flag "m"): the bootstrapped schema.ts quotes
  // this same import shape inside a // comment, and an unanchored match
  // would merge names into that commented-out example instead of a real import.
  const reExisting = new RegExp(`^import\\s+\\{([^}]*)\\}\\s+from\\s+["']${escapeRe(module)}["'];?`, "m");
  const match = content.match(reExisting);
  if (match) {
    const existing = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    const existingSet = new Set(existing);
    const toAdd = names.filter((n) => !existingSet.has(n));
    if (toAdd.length === 0) return content;
    const merged = [...existing, ...toAdd].sort();
    return content.replace(reExisting, `import { ${merged.join(", ")} } from "${module}";`);
  }
  const newImport = `import { ${names.join(", ")} } from "${module}";`;
  const lastImport = content.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) return content.replace(lastImport[0], lastImport[0] + newImport + "\n");
  return newImport + "\n" + content;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ─── Step: drizzle-kit generate ───────────────────────────────────────
// Per CONTRACT.md §4: the operator's machine never connects to the database.
// `drizzle-kit generate` only writes SQL files; the migration Job applies
// them on the next /deploy. The schema patch above is a pure addition (new
// tables only), so drizzle-kit never hits its interactive rename prompt.
function listMigrationFiles(webDir) {
  let outDir = "drizzle";
  const cfgPath = join(webDir, "drizzle.config.ts");
  if (existsSync(cfgPath)) {
    const m = readFileSync(cfgPath, "utf8").match(/out:\s*["']([^"']+)["']/);
    if (m) outDir = m[1];
  }
  const dir = join(webDir, outDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join(outDir, f));
}

async function generateMigration() {
  log("Running drizzle-kit generate (writes SQL, no DB connection)");
  const before = listMigrationFiles(WEB_DIR);
  const res = spawnSync("npx drizzle-kit generate", { cwd: WEB_DIR, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    fail(
      `drizzle-kit generate failed (exit ${res.status}). Schema patched on disk but no migration ` +
        "was written. Retry manually: `cd " + WEB_DIR + " && npx drizzle-kit generate`",
    );
  }
  const after = listMigrationFiles(WEB_DIR);
  const created = after.filter((f) => !before.includes(f));
  state.migrationFiles.push(...created);
  ok(`Migration written (${created.join(", ") || "no new file - schema already up to date"}). Applied by the next /deploy.`);
}

async function installDeps() {
  log("Installing otpauth + qrcode");
  run("pnpm add otpauth", WEB_DIR);
  run("pnpm add -D qrcode", WEB_DIR);
  ok("otpauth (runtime) + qrcode (setup-only) installed");
}

async function generateSecret() {
  log("Generating TOTP secret");
  state.base32 = base32Encode(randomBytes(20));
  const enc = encodeURIComponent(issuer);
  state.otpauthUrl = `otpauth://totp/${enc}:admin?secret=${state.base32}&issuer=${enc}&algorithm=SHA1&digits=6&period=30`;
  ok("Secret + otpauth URL ready");
}

async function generateBackupCodes() {
  log("Generating backup codes (8)");
  for (let i = 0; i < 8; i++) {
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const code = `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
    state.backupCodes.push(code);
    state.backupHashes.push(hashCode(code));
  }
  ok("8 backup codes generated + hashed");
}

async function writeCode() {
  log("Writing 2FA code (auth.ts, lib, signin, idle-timeout)");
  const writes = [
    ["src/server/auth.ts", "2fa/auth.ts", {}],
    ["src/lib/auth-2fa.ts", "2fa/auth-2fa.ts", { COOKIE_NAME, ISSUER: issuer }],
    ["src/lib/auth-backup-codes.ts", "2fa/auth-backup-codes.ts", {}],
    ["src/lib/revoke-trusted-device-action.ts", "2fa/revoke-trusted-device-action.ts", {}],
    ["src/app/admin/signin/actions.ts", "2fa/signin-actions.ts", {}],
    ["src/app/admin/signin/page.tsx", "2fa/signin-page.tsx", {}],
    ["src/components/dashboard/idle-timeout.tsx", "2fa/idle-timeout.tsx", {}],
  ];
  for (const [relDest, tpl, vars] of writes) {
    const dest = join(WEB_DIR, relDest);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, render(tpl, vars));
  }

  const rlResult = ensureDbBackedRateLimit(WEB_DIR);
  if (rlResult === "left-alone") {
    warn("src/lib/rate-limit.ts exists but isn't a recognized baudrier variant - left untouched.");
  } else {
    ok(`src/lib/rate-limit.ts: ${rlResult}`);
  }
  ok("Code written");
}

// ─── Step: wire trusted-device revocation into the sign-out button ────
//
// setup-auth-admin.mjs wrote src/app/admin/(protected)/page.tsx with a
// "Se déconnecter" button whose server action only calls signOut(). Signing
// out should also mean "forget this device" - patch that action to revoke
// the trusted-device grant first. Best-effort: if the page was customized
// enough that the pattern no longer matches, warn instead of failing - the
// rest of 2FA still works, this only means the trusted-device cookie
// outlives an explicit sign-out until fixed by hand.
async function patchSignOut() {
  log("Wiring trusted-device revocation into the admin sign-out action");
  const pagePath = join(WEB_DIR, "src/app/admin/(protected)/page.tsx");
  if (!existsSync(pagePath)) {
    warn(`${pagePath} not found - wire \`await revokeTrustedDevice()\` into your sign-out action manually.`);
    return;
  }
  let content = readFileSync(pagePath, "utf8");

  if (content.includes("revokeTrustedDevice")) {
    ok("Sign-out action already revokes the trusted device (no-op)");
    return;
  }

  const signOutCall = /(\bawait\s+signOut\()/;
  if (!signOutCall.test(content)) {
    warn(`${pagePath}: no \`await signOut(\` call found - wire \`await revokeTrustedDevice()\` into your sign-out action manually.`);
    return;
  }

  content = content.replace(signOutCall, "await revokeTrustedDevice();\n            $1");

  const importLine = 'import { revokeTrustedDevice } from "~/lib/auth-2fa";\n';
  const lastImport = content.match(/^((?:import[^;]+;[\r\n]+)+)/);
  content = lastImport ? content.replace(lastImport[0], lastImport[0] + importLine) : importLine + content;

  writeFileSync(pagePath, content);
  ok("Sign-out action now revokes the trusted device before ending the session");
}

async function storeSecrets() {
  log("Storing secret + backup codes in Scaleway Secret Manager + writing QR (scan aid)");
  // QR png in a gitignored folder (a scanning convenience - deleted after setup).
  const dir = join(WEB_DIR, ".2fa-setup");
  mkdirSync(dir, { recursive: true });
  const QRCode = createRequire(join(WEB_DIR, "package.json"))("qrcode");
  state.qrPath = join(dir, "qrcode.png");
  await QRCode.toFile(state.qrPath, state.otpauthUrl, { width: 400, margin: 2 });
  const giPath = join(WEB_DIR, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (!gi.split(/\r?\n/).some((l) => l.trim() === ".2fa-setup/")) {
    appendFileSync(giPath, `${gi.endsWith("\n") || gi === "" ? "" : "\n"}.2fa-setup/\n`);
  }

  // Primary store: Scaleway Secret Manager, in the app's own Project (encrypted,
  // never in chat / plaintext on disk). One secret, JSON-encoded, so the TOTP
  // key + otpauth URL + backup codes stay together under a single name.
  try {
    const payload = JSON.stringify({
      totp_secret: state.base32,
      otpauth_url: state.otpauthUrl,
      backup_codes: state.backupCodes,
    });
    const { revision } = await putSecret(SECRET_NAME, payload);
    state.storedIn = "secretmanager";
    ok(`Secret + backup codes stored in Scaleway Secret Manager: ${SECRET_NAME} (revision ${revision})`);
  } catch (e) {
    // Fallback: gitignored secrets.txt (Secret Manager unreachable / no credentials).
    const secretsPath = join(dir, "secrets.txt");
    writeFileSync(
      secretsPath,
      [
        `${issuer} - 2FA admin`,
        `Cle TOTP : ${state.base32}`,
        `URL      : ${state.otpauthUrl}`,
        "",
        "Codes de secours :",
        ...state.backupCodes.map((c, i) => `  ${i + 1}. ${c}`),
        "",
        "Sauvegarde-les puis SUPPRIME le dossier .2fa-setup/.",
        "",
      ].join("\n"),
      "utf8",
    );
    state.storedIn = "file";
    warn(`Scaleway Secret Manager indisponible (${e.message}). Repli : secrets écrits dans ${secretsPath} (gitignoré).`);
  }
}

async function pushEnvVars() {
  log("Pushing ADMIN_TOTP_SECRET + ADMIN_2FA_BACKUP_HASHES");
  const helper = join(__dirname, "push-env-vars.mjs");
  if (!existsSync(helper)) fail(`Sibling script missing: ${helper}`);
  const kvs = [`ADMIN_TOTP_SECRET=${state.base32}`, `ADMIN_2FA_BACKUP_HASHES=${JSON.stringify(state.backupHashes)}`];
  // Pairs travel over stdin, not argv, so neither secret shows up in the
  // process list for another process on the machine to read via ps/proc.
  const res = spawnSync("node", [helper, "--env", "production", "--stdin"], {
    cwd: WEB_DIR,
    input: kvs.join("\n") + "\n",
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (res.status !== 0) fail("push-env-vars.mjs failed. Code is in place but env vars didn't land.");
  ok("Env vars pushed");
}

// ─── main ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("installDeps", installDeps);
await step("generateSecret", generateSecret);
await step("generateBackupCodes", generateBackupCodes);
await step("patchSchema", patchSchema);
await step("generateMigration", generateMigration);
await step("writeCode", writeCode);
await step("patchSignOut", patchSignOut);
await step("storeSecrets", storeSecrets);
await step("pushEnvVars", pushEnvVars);

dumpHandoff();
console.log(`
🎉 setup-2fa complete.

   TOTP issuer:    ${issuer} (label: admin)
   Trusted device: 24h cookie (__Host-${COOKIE_NAME}), revocable in DB (trusted_device)
   Secrets stored: ${state.storedIn === "secretmanager" ? `Scaleway Secret Manager, secret ${SECRET_NAME}` : `file ${state.qrPath ? dirname(state.qrPath) : ".2fa-setup"}/secrets.txt`}
   QR (scan aid):  ${state.qrPath}
   Migration:      ${state.migrationFiles.join(", ") || "none written"} (applied by the next /deploy)

The trusted_device, login_proof and consumed_backup_code tables do not exist
until the next /deploy runs the migration Job - tell the user 2FA will not work
until then.

Next: Claude mounts <IdleTimeout/> in the admin protected layout, updates
CLAUDE.md, then tells the user where to find the secret + codes (Secret Manager
or file) and to delete the .2fa-setup/ folder after enrolling. No secret in
this output.
`);
console.log(
  JSON.stringify({
    success: true,
    issuer,
    storedIn: state.storedIn,
    secretName: state.storedIn === "secretmanager" ? SECRET_NAME : null,
    qrPath: state.qrPath,
    migrationFiles: state.migrationFiles,
    envVars: ["ADMIN_TOTP_SECRET", "ADMIN_2FA_BACKUP_HASHES"],
  }),
);
