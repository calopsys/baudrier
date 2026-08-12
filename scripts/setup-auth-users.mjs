#!/usr/bin/env node
// setup-auth-users.mjs - Deterministic core for /add-auth in user-credentials mode.
//
// Real user accounts in DB. Signup + signin + delete account flows. Optional
// forgot-password / reset-password if email is configured (detected via
// check-deps.mjs).
//
// FRESH INSTALL ONLY: refuses if `src/server/auth.ts` already exists. The
// upgrade case (users already exists, user wants to add admin, or vice versa)
// is handled by Claude in the SKILL Step 0 - it reads the existing auth.ts and
// edits it contextually rather than re-running this script.
//
// Usage:
//   node setup-auth-users.mjs --name <project-name> [--web-dir .]
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end
//   - Last line on success: JSON Claude can parse:
//       {"success":true,"authMode":"users","emailReset":bool,"emailProvider":"tem|none","envVars":["AUTH_SECRET"]}

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { render } from "./_render.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let webDir = ".";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else fail(`Unknown arg: ${a}`);
}

if (!name) fail("Usage: --name <project-name> is required");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}

const WEB_DIR = resolve(process.cwd(), webDir);

// ─── helpers ──────────────────────────────────────────────────────────
const STEPS = [
  "preflight",
  "detectEmail",
  "installDeps",
  "generateAuthSecret",
  "patchSchema",
  "generateMigration",
  "writePasswordTs",
  "writeAuthTs",
  "ensureRateLimitInfra",
  "addProtectedProcedure",
  "writeAuthRouter",
  "registerAuthRouter",
  "writeApiRoute",
  "writeAuthPages",
  "pushEnvVars",
];
const completed = [];
const warnings = [];
let current = null;
const state = {
  authSecret: null,
  emailOk: false,
  emailProvider: "none", // "tem" | "none" - Scaleway Transactional Email is the only provider
  migrationFiles: [],
};

async function step(stepName, fn) {
  current = stepName;
  await fn();
  completed.push(stepName);
  current = null;
}

function log(msg) { console.log(`\n▸ ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); warnings.push(msg); }

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-auth-users handoff state");
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
        `  - Web dir: ${WEB_DIR}\n` +
        `  - Email status: emailOk=${state.emailOk} provider=${state.emailProvider}\n` +
        "  - Each step in this script maps 1:1 to a section of _setup-auth-users SKILL.md.\n",
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
    cwd, stdio: opts.capture ? "pipe" : "inherit", shell: true, encoding: "utf8",
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
    fail(`No package.json at ${WEB_DIR}. Pass --web-dir <path> if needed.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) fail(`${WEB_DIR} doesn't depend on Next.js.`);
  if (!deps["@trpc/server"]) fail(`${WEB_DIR} doesn't depend on @trpc/server.`);
  if (!deps["drizzle-orm"]) {
    fail(`${WEB_DIR} doesn't depend on drizzle-orm. Run /add-db before /add-auth in users mode.`);
  }

  // Refuse if any auth.ts exists (fresh install only).
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  if (existsSync(authPath)) {
    fail(
      `${authPath} already exists. setup-auth-users only handles fresh installs. ` +
        "If you want to ADD users on top of an existing admin setup, Claude must edit " +
        "the existing auth.ts contextually - see add-auth SKILL Step 0.",
    );
  }

  // Block if dependent target files already exist (would clobber user data)
  const collisions = [
    "src/lib/password.ts",
    "src/server/api/routers/auth.ts",
    "src/app/api/auth/[...nextauth]/route.ts",
    "src/app/signin/page.tsx",
    "src/app/signup/page.tsx",
    "src/app/dashboard/page.tsx",
    "src/app/account/page.tsx",
  ];
  for (const rel of collisions) {
    if (existsSync(join(WEB_DIR, rel))) {
      fail(
        `${rel} already exists. setup-auth-users only handles fresh installs. ` +
          "Delete this file manually if you really mean to regenerate it, then re-run.",
      );
    }
  }

  // Schema must exist. Bootstrap always resets it to the plain pgTable
  // convention (CONTRACT.md §4: one database per app, no table-name-prefix
  // helper), so no further shape check is needed here.
  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  if (!existsSync(schemaPath)) {
    fail(`${schemaPath} not found - T3 db scaffold missing. Run /add-db first.`);
  }

  // rate-limit.ts is created by setup-security in bootstrap.
  if (!existsSync(join(WEB_DIR, "src/lib/rate-limit.ts"))) {
    warn(
      "src/lib/rate-limit.ts not found - bootstrap usually creates it via setup-security.mjs. " +
        "The API route template imports `checkRateLimit` from ~/lib/rate-limit, so the build " +
        "will fail until you create that utility.",
    );
  }

  // pnpm available?
  if (capture("pnpm --version", WEB_DIR).status !== 0) fail("pnpm CLI is missing.");

  ok(`Web dir OK: ${WEB_DIR}`);
}

// ─── Step 2: detect email config ──────────────────────────────────────
async function detectEmail() {
  log("Detecting email configuration (for forgot-password flow)");

  const checkDeps = join(__dirname, "check-deps.mjs");
  if (!existsSync(checkDeps)) {
    warn("check-deps.mjs not found - skipping email detection. Forgot-password flow disabled.");
    return;
  }

  const res = capture(`node "${checkDeps}" email`, WEB_DIR);
  if (res.status !== 0) {
    warn(`check-deps email failed (exit ${res.status}). Forgot-password flow disabled.`);
    return;
  }

  try {
    const data = JSON.parse(res.stdout);
    state.emailOk = !!data.email?.ok;
    // Scaleway Transactional Email (TEM) is the only email provider in this
    // harness - no per-provider branching needed once email is configured.
    state.emailProvider = state.emailOk ? "tem" : "none";
    if (state.emailOk) {
      ok("Email configured (Scaleway TEM) - forgot-password flow enabled");
    } else {
      ok("Email not configured - forgot-password flow disabled (run /add-email to enable)");
    }
  } catch (e) {
    warn(`Could not parse check-deps output: ${e.message}. Forgot-password flow disabled.`);
  }
}

// ─── Step 3: install NextAuth + Drizzle adapter ───────────────────────
async function installDeps() {
  log("Installing next-auth@beta + @auth/drizzle-adapter");
  run("pnpm add next-auth@beta @auth/drizzle-adapter", WEB_DIR);
  ok("Deps installed");
}

// ─── Step 4: generate AUTH_SECRET ─────────────────────────────────────
async function generateAuthSecret() {
  log("Generating AUTH_SECRET (32 bytes base64url)");
  state.authSecret = randomBytes(32).toString("base64url");
  ok("AUTH_SECRET generated");
}

// ─── Step 5: patch schema.ts (imports + append tables) ────────────────
async function patchSchema() {
  log("Patching src/server/db/schema.ts (add imports + append NextAuth tables)");
  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  let schema = readFileSync(schemaPath, "utf8");

  // 1. Ensure imports are present.
  // Bootstrap resets schema.ts to the plain `pgTable` convention (CONTRACT.md §4).
  // Our schema-additions needs pgTable, text, integer, primaryKey, index, and
  // timestamp from drizzle-orm/pg-core, plus `sql` from drizzle-orm.
  schema = ensureImport(schema, "drizzle-orm/pg-core", [
    "pgTable",
    "text",
    "integer",
    "primaryKey",
    "index",
    "timestamp",
  ]);
  schema = ensureImport(schema, "drizzle-orm", ["sql"]);
  schema = ensureImport(
    schema,
    "next-auth/adapters",
    ["AdapterAccount"],
    /* typeOnly */ true,
  );

  // 2. Idempotency: skip if `users` table already declared
  if (/export const users\s*=\s*pgTable\("user"/.test(schema)) {
    warn("`users` table already declared in schema.ts - skipping NextAuth table patch.");
  } else {
    // 3. Append NextAuth tables (template body, no imports)
    const authTables = render("auth/users/schema-additions.ts", {});
    schema = schema.trimEnd() + "\n\n" + authTables;

    // 4. Conditionally append password_reset_tokens
    if (state.emailOk) {
      const resetTokens = render("auth/users/schema-additions-reset-tokens.ts", {});
      schema = schema.trimEnd() + "\n\n" + resetTokens;
    }
  }

  // 5. Append the shared rate-limit table (backs ensureRateLimitInfra's
  // DB-backed src/lib/rate-limit.ts). Checked independently of the `users`
  // idempotency above - a re-run that already has `users` may still be
  // missing this table (e.g. it was added by a harness version predating M2).
  if (/export const loginAttempts\s*=\s*pgTable\("login_attempt"/.test(schema)) {
    warn("`loginAttempts` already declared in schema.ts - skipping rate-limit table patch.");
  } else {
    const rateLimitTable = render("auth/schema-additions-login-attempts.ts", {});
    schema = schema.trimEnd() + "\n\n" + rateLimitTable;
  }

  writeFileSync(schemaPath, schema.trimEnd() + "\n");
  ok(
    state.emailOk
      ? "Schema patched: imports + 4 NextAuth tables + password_reset_tokens + login_attempt"
      : "Schema patched: imports + 4 NextAuth tables + login_attempt (no reset tokens - email not configured)",
  );
}

/**
 * Ensure a named import is present in the file. If a `from "<module>"` import
 * already exists, augment it to include the missing names. Otherwise prepend
 * a new import statement after the last existing import.
 */
function ensureImport(content, module, names, typeOnly = false) {
  const reExisting = new RegExp(
    `import\\s+${typeOnly ? "type\\s+" : ""}\\{([^}]*)\\}\\s+from\\s+["']${escapeRe(module)}["'];?`,
  );
  const match = content.match(reExisting);
  if (match) {
    const existing = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    const existingSet = new Set(existing);
    const toAdd = names.filter((n) => !existingSet.has(n));
    if (toAdd.length === 0) return content; // already complete
    const merged = [...existing, ...toAdd].sort();
    const newImport = `import ${typeOnly ? "type " : ""}{ ${merged.join(", ")} } from "${module}";`;
    return content.replace(reExisting, newImport);
  }
  // No existing import for this module → prepend after the last import line
  const newImport = `import ${typeOnly ? "type " : ""}{ ${names.join(", ")} } from "${module}";`;
  const lastImport = content.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    return content.replace(lastImport[0], lastImport[0] + newImport + "\n");
  }
  return newImport + "\n" + content;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ─── Step 6: drizzle-kit generate ─────────────────────────────────────
// Per CONTRACT.md §4: the operator's machine never connects to the database.
// `drizzle-kit generate` only writes SQL files; the migration Job applies
// them on the next /deploy. The schema patch above is a pure addition (new
// tables only), so drizzle-kit never hits its interactive rename prompt
// (bootstrap-init.mjs ~908-912 documents the same reasoning).
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

// ─── Step 7: write src/lib/password.ts ────────────────────────────────
async function writePasswordTs() {
  log("Writing src/lib/password.ts");
  const dest = join(WEB_DIR, "src/lib/password.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("auth/users/password.ts", {}));
  ok("password.ts written");
}

// ─── Step 8: write src/server/auth.ts ─────────────────────────────────
async function writeAuthTs() {
  log("Writing src/server/auth.ts");
  const dest = join(WEB_DIR, "src/server/auth.ts");
  writeFileSync(dest, render("auth/users/auth.ts", {}));
  ok("auth.ts written (mode: users)");
}

// ─── Step 8b: ensure rate-limit infrastructure (rate-limit.ts + rateLimitedProcedure) ───
//
// Bootstrap's setup-security.mjs creates these. If we're running standalone
// (without bootstrap), they may be missing. The auth-router templates use
// rateLimitedProcedure for signup/forgot/reset routes, so we ensure both pieces
// exist before writing the router. Idempotent - no-op if already present.
// Recognized src/lib/rate-limit.ts variants (see templates/2fa/rate-limit.ts
// for the DB-backed one and scripts/setup-security.mjs for the memory-only
// one it upgrades from). A file with neither marker is either hand-written
// or already customized - never overwritten.
const RATE_LIMIT_MARKER_MEMORY = "baudrier:rate-limit memory-only";
const RATE_LIMIT_MARKER_DB = "baudrier:rate-limit db-backed";

async function ensureRateLimitInfra() {
  log("Ensuring rate-limit infrastructure (rate-limit.ts + rateLimitedProcedure)");

  // Users mode always has a database (preflight requires drizzle-orm), so
  // any rate-limit.ts this step creates or upgrades goes straight to the
  // DB-backed variant - a login-attempt counter that resets every cold
  // start or gets N-way inflated by concurrent instances is the exact gap
  // this upgrade closes.
  const rateLimitPath = join(WEB_DIR, "src/lib/rate-limit.ts");
  if (!existsSync(rateLimitPath)) {
    mkdirSync(dirname(rateLimitPath), { recursive: true });
    writeFileSync(rateLimitPath, render("2fa/rate-limit.ts", {}));
    ok("Created src/lib/rate-limit.ts (DB-backed)");
  } else {
    const current = readFileSync(rateLimitPath, "utf8");
    if (current.includes(RATE_LIMIT_MARKER_DB)) {
      ok("rate-limit.ts already DB-backed");
    } else if (current.includes(RATE_LIMIT_MARKER_MEMORY)) {
      writeFileSync(rateLimitPath, render("2fa/rate-limit.ts", {}));
      ok("Upgraded rate-limit.ts to the DB-backed variant");
    } else {
      warn("rate-limit.ts exists but isn't a recognized baudrier variant - left untouched.");
    }
  }

  // Patch trpc.ts - add rateLimitedProcedure if missing.
  const trpcPath = join(WEB_DIR, "src/server/api/trpc.ts");
  if (!existsSync(trpcPath)) fail(`${trpcPath} not found.`);
  let trpc = readFileSync(trpcPath, "utf8");

  if (trpc.includes("rateLimitedProcedure")) {
    ok("rateLimitedProcedure already in trpc.ts");
    return;
  }

  // Ensure TRPCError import (T3 may not have it imported)
  if (!/import\s+\{[^}]*\bTRPCError\b[^}]*\}\s+from\s+["']@trpc\/server["']/.test(trpc)) {
    const trpcServerImport = trpc.match(/import\s+\{([^}]*)\}\s+from\s+["']@trpc\/server["'];?/);
    if (trpcServerImport) {
      const names = trpcServerImport[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (!names.includes("TRPCError")) names.push("TRPCError");
      trpc = trpc.replace(
        trpcServerImport[0],
        `import { ${names.sort().join(", ")} } from "@trpc/server";`,
      );
    } else {
      // Prepend
      trpc = `import { TRPCError } from "@trpc/server";\n${trpc}`;
    }
  }

  // Ensure checkRateLimit + resolveClientIp imports
  if (!trpc.includes(`from "~/lib/rate-limit"`)) {
    const lastImport = trpc.match(/^((?:import[^;]+;[\r\n]+)+)/);
    const insertion = `import { checkRateLimit } from "~/lib/rate-limit";\nimport { resolveClientIp } from "~/proxy";\n`;
    trpc = lastImport ? trpc.replace(lastImport[0], lastImport[0] + insertion) : insertion + trpc;
  }

  // Append rateLimitedProcedure at end of file
  const block = `
export const rateLimitedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const ip = ctx.headers ? (resolveClientIp(ctx.headers) ?? "unknown") : "unknown";
  const { allowed, retryAfterMs } = await checkRateLimit(ip);
  if (!allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: \`Trop de tentatives. Réessaie dans \${Math.ceil((retryAfterMs ?? 0) / 1000 / 60)} minutes.\`,
    });
  }
  return next();
});
`;
  trpc = trpc.trimEnd() + "\n" + block;
  writeFileSync(trpcPath, trpc);
  ok("Added rateLimitedProcedure to trpc.ts");
}

// ─── Step 8c: ensure protectedProcedure exists in trpc.ts ─────────────
//
// T3 only generates protectedProcedure when the user opts into NextAuth at
// scaffold time. We bypass --nextAuth at bootstrap (NextAuth is added later by
// /add-auth), so we have to inject protectedProcedure ourselves now.
async function addProtectedProcedure() {
  log("Adding protectedProcedure to trpc.ts");

  const trpcPath = join(WEB_DIR, "src/server/api/trpc.ts");
  let trpc = readFileSync(trpcPath, "utf8");

  if (trpc.includes("protectedProcedure")) {
    ok("protectedProcedure already in trpc.ts");
    return;
  }

  // Ensure auth import
  if (!/import\s+\{[^}]*\bauth\b[^}]*\}\s+from\s+["']~\/server\/auth["']/.test(trpc)) {
    const lastImport = trpc.match(/^((?:import[^;]+;[\r\n]+)+)/);
    const insertion = `import { auth } from "~/server/auth";\n`;
    trpc = lastImport ? trpc.replace(lastImport[0], lastImport[0] + insertion) : insertion + trpc;
  }

  // Ensure TRPCError import (might already be there from rateLimitedProcedure)
  if (!/import\s+\{[^}]*\bTRPCError\b[^}]*\}\s+from\s+["']@trpc\/server["']/.test(trpc)) {
    const trpcServerImport = trpc.match(/import\s+\{([^}]*)\}\s+from\s+["']@trpc\/server["'];?/);
    if (trpcServerImport) {
      const names = trpcServerImport[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (!names.includes("TRPCError")) names.push("TRPCError");
      trpc = trpc.replace(
        trpcServerImport[0],
        `import { ${names.sort().join(", ")} } from "@trpc/server";`,
      );
    } else {
      trpc = `import { TRPCError } from "@trpc/server";\n${trpc}`;
    }
  }

  const block = `
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const session = await auth();
  if (!session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: { ...session, user: session.user },
    },
  });
});
`;
  trpc = trpc.trimEnd() + "\n" + block;
  writeFileSync(trpcPath, trpc);
  ok("Added protectedProcedure to trpc.ts");
}

// ─── Step 9: write tRPC auth router ───────────────────────────────────
async function writeAuthRouter() {
  log("Writing src/server/api/routers/auth.ts");
  const dest = join(WEB_DIR, "src/server/api/routers/auth.ts");
  mkdirSync(dirname(dest), { recursive: true });

  const templatePath = state.emailOk
    ? "auth/users/auth-router-with-reset.ts"
    : "auth/users/auth-router.ts";

  writeFileSync(dest, render(templatePath, {}));
  ok(`auth router written (${state.emailOk ? "with password reset, via Scaleway TEM" : "no reset"})`);
}

// ─── Step 10: register authRouter in root.ts ──────────────────────────
async function registerAuthRouter() {
  log("Registering authRouter in src/server/api/root.ts");
  const rootPath = join(WEB_DIR, "src/server/api/root.ts");
  if (!existsSync(rootPath)) {
    fail(`${rootPath} not found - register authRouter manually.`);
  }
  let root = readFileSync(rootPath, "utf8");

  if (root.includes("authRouter")) {
    ok("authRouter already registered (no-op)");
    return;
  }

  const importLine = `import { authRouter } from "~/server/api/routers/auth";\n`;
  const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    root = root.replace(lastImport[0], lastImport[0] + importLine);
  } else {
    root = importLine + root;
  }

  const replaced = root.replace(
    /createTRPCRouter\(\s*\{/,
    `createTRPCRouter({\n  auth: authRouter,`,
  );
  if (replaced === root) {
    fail(
      "Could not find createTRPCRouter({...}) in root.ts. Register authRouter manually: " +
        "add `auth: authRouter,` inside the router object.",
    );
  }
  writeFileSync(rootPath, replaced);
  ok("authRouter registered");
}

// ─── Step 11: write API route ─────────────────────────────────────────
async function writeApiRoute() {
  log("Writing src/app/api/auth/[...nextauth]/route.ts");
  const dest = join(WEB_DIR, "src/app/api/auth/[...nextauth]/route.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("auth/users/route.ts", {}));
  ok("NextAuth API route written");
}

// ─── Step 12: write 4 (or 6) auth pages ───────────────────────────────
async function writeAuthPages() {
  log("Writing auth pages");

  // No i18n in this harness - the product is French-only, always the plain
  // (hardcoded French) template variant.
  const variant = "plain";

  // signin: the "Forgot password?" link in the form footer is conditional on
  // whether email is configured.
  const forgotLink = state.emailOk
    ? '<Link href="/forgot-password" className="text-muted-foreground hover:text-foreground hover:underline">Mot de passe oublié ?</Link>'
    : "<span></span>";

  // Feature manifest: each entry maps a feature folder to its destination path.
  const features = [
    { id: "auth-signin", dest: "src/app/signin/page.tsx", vars: { FORGOT_PASSWORD_LINK: forgotLink } },
    { id: "auth-signup", dest: "src/app/signup/page.tsx", vars: {} },
    { id: "auth-dashboard", dest: "src/app/dashboard/page.tsx", vars: {} },
    { id: "auth-account", dest: "src/app/account/page.tsx", vars: {} },
  ];
  if (state.emailOk) {
    features.push({ id: "auth-forgot-password", dest: "src/app/forgot-password/page.tsx", vars: {} });
    features.push({ id: "auth-reset-password", dest: "src/app/reset-password/page.tsx", vars: {} });
  }

  for (const f of features) {
    writeFile(f.dest, render(`${f.id}/${variant}.tsx`, f.vars));
  }

  ok(
    `Pages written (${variant} variant): ${features.map((f) => "/" + f.dest.replace(/^src\/app\//, "").replace(/\/page\.tsx$/, "")).join(", ")}`,
  );

  function writeFile(rel, content) {
    const dest = join(WEB_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

// ─── Step 13: push env vars ───────────────────────────────────────────
async function pushEnvVars() {
  log("Pushing AUTH_SECRET");
  const helper = join(__dirname, "push-env-vars.mjs");
  if (!existsSync(helper)) fail(`Sibling script missing: ${helper}`);

  // AUTH_SECRET travels over stdin, not argv, so it never shows up in the
  // process list for another process on the machine to read via ps/proc.
  const res = spawnSync("node", [helper, "--env", "production", "--stdin"], {
    cwd: WEB_DIR,
    input: `AUTH_SECRET=${state.authSecret}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (res.status !== 0) {
    fail(
      "push-env-vars.mjs failed. Code is in place but AUTH_SECRET didn't land. " +
        "Retry manually with the value visible in this run's logs.",
    );
  }
  ok("AUTH_SECRET pushed");
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("detectEmail", detectEmail);
await step("installDeps", installDeps);
await step("generateAuthSecret", generateAuthSecret);
await step("patchSchema", patchSchema);
await step("generateMigration", generateMigration);
await step("writePasswordTs", writePasswordTs);
await step("writeAuthTs", writeAuthTs);
await step("ensureRateLimitInfra", ensureRateLimitInfra);
await step("addProtectedProcedure", addProtectedProcedure);
await step("writeAuthRouter", writeAuthRouter);
await step("registerAuthRouter", registerAuthRouter);
await step("writeApiRoute", writeApiRoute);
await step("writeAuthPages", writeAuthPages);
await step("pushEnvVars", pushEnvVars);

dumpHandoff(true);

const pageList = state.emailOk
  ? "/signin, /signup, /dashboard, /account, /forgot-password, /reset-password"
  : "/signin, /signup, /dashboard, /account";

console.log(`
🎉 setup-auth-users complete.

   Mode:           users (real accounts in DB, signup/signin/account flows)
   Email reset:    ${state.emailOk ? `enabled (${state.emailProvider})` : "disabled (run /add-email then /add-auth re-config to enable)"}
   auth.ts:        src/server/auth.ts (with marker // baudrier:auth-modes users)
   password.ts:    src/lib/password.ts
   tRPC router:    src/server/api/routers/auth.ts (registered as 'auth' in root.ts)
   API route:      src/app/api/auth/[...nextauth]/route.ts (with rate limiting)
   Pages:          ${pageList}
   DB tables:      users, accounts, sessions, verificationTokens${state.emailOk ? ", password_reset_tokens" : ""}
   Migration:      ${state.migrationFiles.join(", ") || "none written"} (applied by the next /deploy)
   Env vars:       AUTH_SECRET

The DB tables above do not exist until the next /deploy runs the migration Job -
tell the user signin will not work until then.

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md), the user-menu
integration in layout.tsx (must be done contextually since the user's layout structure
varies), and the user-facing summary.
`);

console.log(
  JSON.stringify({
    success: true,
    authMode: "users",
    emailReset: state.emailOk,
    emailProvider: state.emailProvider,
    envVars: ["AUTH_SECRET"],
    migrationFiles: state.migrationFiles,
  }),
);
