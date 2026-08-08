#!/usr/bin/env node
// Check project dependencies (DB, email, auth, etc.) with robust heuristics.
//
// Usage:
//   node check-deps.mjs <check1> [<check2> ...]
//
// Output:
//   JSON object on stdout, one key per check requested.
//   Exit code is always 0 - the result is in the JSON, not the exit code.
//
// Supported checks:
//   db           - is a real Scaleway Serverless SQL Database wired up? (not a T3 placeholder / localhost default)
//   email        - is Scaleway TEM configured? (TEM_SENDER_EMAIL non-placeholder)
//   auth         - is NextAuth installed & configured? (detects admin vs users mode)
//   scaleway     - are SCW_ACCESS_KEY/SCW_SECRET_KEY set AND valid? (live API call)
//   container    - is the project linked to a Scaleway Serverless Container?
//   github-repo  - is the project pushed to a GitHub remote?
//   storage      - is Scaleway Object Storage configured? (STORAGE_* vars)
//   analytics    - is Matomo configured? (NEXT_PUBLIC_MATOMO_URL + NEXT_PUBLIC_MATOMO_SITE_ID)
//   dark-mode    - is next-themes installed AND ThemeProvider mounted in the root layout?
//
// Example:
//   node check-deps.mjs db email auth
//   → {"db":{"ok":true,...},"email":{"ok":false,...},"auth":{"ok":true,...}}

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadCredentials, deriveAppName, resolveProjectId, api, sdkCall, REGION, slugify } from "./scaleway/_scw-auth.mjs";
import { listSecrets } from "./scaleway/secrets.mjs";
import { findContainerByName } from "./scaleway/container.mjs";

const args = process.argv.slice(2);
const checks = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    console.error(`Unknown flag: ${args[i]}`);
    process.exit(1);
  }
  checks.push(args[i]);
}

// -----------------------------------------------------------------------------
// dispatch table - declared up front so the "no checks given" usage message
// (below) can list the real supported set programmatically instead of a
// hand-maintained (and previously stale) string.
// -----------------------------------------------------------------------------
const dispatchers = {
  db: checkDb,
  email: checkEmail,
  auth: checkAuth,
  scaleway: checkScaleway,
  container: checkContainer,
  "github-repo": checkGithubRepo,
  storage: checkStorage,
  analytics: checkAnalytics,
  "dark-mode": checkDarkMode,
};

if (checks.length === 0) {
  console.error("Usage: check-deps.mjs <check1> [<check2> ...]");
  console.error(`Supported checks: ${Object.keys(dispatchers).join(", ")}`);
  process.exit(1);
}

// Read env files following Next.js precedence (lowest → highest priority):
//   .env  <  .env.development  <  .env.development.local  <  .env.local
// We merge them all so a var set in ANY file is detected. Higher-priority values win on conflict.
// (We scan dev-time files since skills typically run in a dev context, not prod.)
function parseEnvContent(content) {
  const vars = {};
  if (!content) return vars;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith("#") || !line.includes("=")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      let value = m[2];
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[m[1]] = value;
    }
  }
  return vars;
}

function readMergedEnv() {
  // Lower priority first - later ones override earlier ones
  const files = [".env", ".env.development", ".env.development.local", ".env.local"];
  let merged = {};
  for (const f of files) {
    const p = resolve(f);
    if (!existsSync(p)) continue;
    const parsed = parseEnvContent(readFileSync(p, "utf8"));
    merged = { ...merged, ...parsed };
  }
  return merged;
}

const env = readMergedEnv();

// -----------------------------------------------------------------------------
// db check - real Scaleway Serverless SQL Database wired up?
// -----------------------------------------------------------------------------
function checkDb() {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    return { ok: false, reason: "DATABASE_URL absent du .env" };
  }

  // Reject patterns that indicate a placeholder / local-only / default / non-cloud
  // setup. The host-shape check further below also rejects any leftover
  // connection string from a since-removed database provider (CONTRACT.md §2
  // banned list) - anything not shaped like a Scaleway endpoint is rejected,
  // so no provider-specific pattern needs to be named here.
  const disqualifyingPatterns = [
    { re: /@localhost:/i, label: "pointe sur localhost" },
    { re: /@127\.0\.0\.1:/i, label: "pointe sur 127.0.0.1" },
    { re: /placeholder/i, label: "contient le mot 'placeholder'" },
    { re: /\/\/postgres:postgres@/i, label: "utilise le duo postgres:postgres@ (default T3/Docker)" },
    { re: /YOUR_DB/i, label: "contient le marker 'YOUR_DB' d'un .env.example" },
    { re: /^file:/i, label: "pointe sur un fichier SQLite local (pas une DB cloud)" },
  ];

  for (const { re, label } of disqualifyingPatterns) {
    if (re.test(url)) {
      return { ok: false, reason: `DATABASE_URL ${label} → pas une vraie base cloud` };
    }
  }

  // Extract host for both the friendly reason line and the Scaleway shape check.
  const hostMatch = url.match(/@([^/:]+)/);
  const host = hostMatch ? hostMatch[1] : null;
  if (!host) {
    return { ok: false, reason: "DATABASE_URL malformée (aucun host trouvé après le @)" };
  }

  // Scaleway Serverless SQL Database endpoints look like
  // <id>.pg.sdb.fr-par.scw.cloud (CONTRACT.md §4). Anything else is either a
  // stale value from a removed provider or a typo - flag it rather than
  // silently trusting an unrecognised host.
  if (!/\.pg\.sdb\.[a-z0-9-]+\.scw\.cloud$/i.test(host)) {
    return {
      ok: false,
      reason: `DATABASE_URL host (${host}) ne ressemble pas à un endpoint Scaleway Serverless SQL (attendu *.pg.sdb.fr-par.scw.cloud)`,
    };
  }

  // Check a drizzle.config.ts (or .js) exists somewhere plausible
  const drizzleLocations = [
    "drizzle.config.ts",
    "drizzle.config.js",
    "apps/web/drizzle.config.ts",
    "apps/web/drizzle.config.js",
    "packages/db/drizzle.config.ts",
    "packages/db/drizzle.config.js",
  ];

  const foundDrizzle = drizzleLocations.find((p) => existsSync(resolve(p)));
  if (!foundDrizzle) {
    return { ok: false, reason: "DATABASE_URL a l'air vrai mais aucun drizzle.config.{ts,js} trouvé" };
  }

  return {
    ok: true,
    reason: `DB Scaleway Serverless SQL détectée (host: ${host}, config: ${foundDrizzle})`,
    host,
    drizzleConfig: foundDrizzle,
  };
}

// -----------------------------------------------------------------------------
// email check - Scaleway TEM configured?
// -----------------------------------------------------------------------------
function checkEmail() {
  const sender = env.TEM_SENDER_EMAIL;
  const senderName = env.TEM_SENDER_NAME;

  if (!sender || sender.trim() === "") {
    return { ok: false, reason: "TEM_SENDER_EMAIL absente du .env" };
  }
  if (/placeholder|your[-_]?email|example\.com$/i.test(sender)) {
    return { ok: false, reason: "TEM_SENDER_EMAIL ressemble à un placeholder" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    return { ok: false, reason: `TEM_SENDER_EMAIL ("${sender}") ne ressemble pas à une adresse email valide` };
  }

  return {
    ok: true,
    provider: "tem",
    reason: `Scaleway TEM configuré (expéditeur : ${sender})`,
    sender,
    senderName: senderName && senderName.trim() !== "" ? senderName : null,
  };
}

// -----------------------------------------------------------------------------
// auth check
// -----------------------------------------------------------------------------
function checkAuth() {
  // Search a broad set of locations - projects use different conventions (T3, Next.js app router, better-auth, etc.)
  const basePaths = [
    "src/server/auth.ts",
    "src/server/auth/index.ts",
    "src/server/auth.config.ts",
    "src/lib/auth.ts",
    "src/lib/auth/index.ts",
    "src/auth.ts",
    "src/auth/index.ts",
    "src/app/auth.ts",
    "auth.ts",
    "auth.config.ts",
  ];
  // Also try each path prefixed with apps/web/ (monorepo case)
  const authLocations = [...basePaths, ...basePaths.map((p) => `apps/web/${p}`)];
  const authFile = authLocations.find((p) => existsSync(resolve(p)));
  if (!authFile) {
    return { ok: false, reason: "fichier auth.ts introuvable" };
  }

  // Accept AUTH_SECRET (NextAuth v5, baudrier standard) or NEXTAUTH_SECRET (NextAuth v4 legacy)
  const secret = env.AUTH_SECRET || env.NEXTAUTH_SECRET;
  const secretVar = env.AUTH_SECRET ? "AUTH_SECRET" : env.NEXTAUTH_SECRET ? "NEXTAUTH_SECRET" : null;
  if (!secret || secret.trim() === "") {
    return { ok: false, reason: `${authFile} trouvé mais aucun secret auth dans l'env (AUTH_SECRET ou NEXTAUTH_SECRET)` };
  }
  if (/placeholder|your_/i.test(secret)) {
    return { ok: false, reason: `${authFile} trouvé mais ${secretVar} ressemble à un placeholder` };
  }

  // Infer mode from env: ADMIN_PASSWORD_HASH_* → admin mode, otherwise assume users mode
  const isAdmin = !!env.ADMIN_PASSWORD_HASH_DEV || !!env.ADMIN_PASSWORD_HASH_PROD;
  const mode = isAdmin ? "admin-credentials" : "user-credentials";

  return {
    ok: true,
    reason: `${authFile} + ${secretVar} configurés (mode détecté: ${mode})`,
    authFile,
    secretVar,
    mode,
  };
}

// -----------------------------------------------------------------------------
// scaleway check - operator credentials set AND valid (live API call)
//
// This is the harness's documented gate before any Scaleway provider
// operation. SCW_ACCESS_KEY/SCW_SECRET_KEY are OPERATOR MACHINE credentials
// (CONTRACT.md §2), never read from .env - resolution goes through
// _scw-auth.mjs#loadCredentials() (SCW_* environment variables, the only
// source), exactly like every scripts/scaleway/*.mjs module.
// -----------------------------------------------------------------------------
async function checkScaleway() {
  const creds = loadCredentials();
  if (!creds.accessKey || !creds.secretKey) {
    return {
      ok: false,
      reason: "SCW_ACCESS_KEY et/ou SCW_SECRET_KEY introuvables (variables d'environnement)",
    };
  }
  try {
    // Cheap, real, project-scoped call - validates the key pair actually
    // authenticates against the Scaleway API, not just that the vars exist.
    const secrets = await listSecrets({ projectId: creds.projectId, region: creds.region });
    return {
      ok: true,
      reason: `identifiants Scaleway valides (source: ${creds.source}, ${secrets.length} secret(s) dans le projet)`,
      source: creds.source,
      secretCount: secrets.length,
    };
  } catch (e) {
    return { ok: false, reason: `validation API Scaleway échouée : ${String(e.message || e).slice(0, 200)}` };
  }
}

// -----------------------------------------------------------------------------
// container check - is the project linked to a Scaleway Serverless Container?
//
// Resolved by NAME, live against the SDK (CONTRACT.md §2, §7 - app repos
// carry no Scaleway metadata at all): the app name (deriveAppName()) names
// the Project, the container namespace, and the production container itself;
// a preview container is `<app-name>-preview-<branch-slug>` in that same
// namespace. Read-only - never creates a namespace or container as a side
// effect of checking.
// -----------------------------------------------------------------------------
async function checkContainer() {
  const appName = deriveAppName();
  const slug = slugify(appName);
  let projectId;
  try {
    projectId = await resolveProjectId({ appName });
  } catch (e) {
    return { ok: false, reason: `résolution du projet Scaleway impossible : ${e.message}` };
  }

  const containersApi = await api("Container", "v1");
  let namespaces;
  try {
    namespaces = await sdkCall(() => containersApi.listNamespaces({ region: REGION, projectId, name: slug }).all());
  } catch (e) {
    return { ok: false, reason: `liste des espaces de noms Scaleway impossible : ${e.message}` };
  }
  const ns = namespaces.find((n) => n.name === slug);
  if (!ns) {
    return { ok: false, reason: `projet pas lié à un Serverless Container (aucun espace de noms "${slug}")` };
  }

  const production = await findContainerByName(ns.id, appName);
  if (!production) {
    return {
      ok: false,
      reason: `espace de noms "${slug}" trouvé mais aucun container de production nommé "${slug}"`,
    };
  }

  const all = await sdkCall(() => containersApi.listContainers({ region: REGION, namespaceId: ns.id }).all());
  const previewPrefix = `${slug}-preview-`;
  const previewBranches = all
    .filter((c) => c.name.startsWith(previewPrefix))
    .map((c) => c.name.slice(previewPrefix.length));

  return {
    ok: true,
    reason: `projet lié à un Serverless Container (namespace: ${ns.name}, container prod: ${production.id})`,
    namespaceId: ns.id,
    productionContainerId: production.id,
    previewBranches,
  };
}

// -----------------------------------------------------------------------------
// github-repo check
// -----------------------------------------------------------------------------
function findGitConfigWalkUp() {
  // Walk up from cwd until we find .git/config or hit the filesystem root.
  // This is useful for monorepo sub-apps (e.g. books/apps/hyperarme) where .git lives at the monorepo root.
  let dir = resolve(".");
  while (true) {
    const candidate = resolve(dir, ".git", "config");
    if (existsSync(candidate)) return { path: candidate, root: dir };
    const parent = resolve(dir, "..");
    // Reached filesystem root when parent === dir (resolve stabilizes)
    if (parent === dir) return null;
    dir = parent;
  }
}

function checkGithubRepo() {
  const found = findGitConfigWalkUp();
  if (!found) {
    return { ok: false, reason: "pas un repo git (aucun .git/config trouvé en remontant l'arborescence)" };
  }
  const content = readFileSync(found.path, "utf8");
  // Match github.com URL: https://github.com/owner/repo(.git) OR git@github.com:owner/repo(.git)
  // Allow dots in repo name (e.g., `my-project.com`) - capture greedily then strip trailing `.git` if present.
  const match = content.match(/url\s*=\s*(?:https?:\/\/[^@\s]*@?|git@)github\.com[:/]([^/\s]+)\/([^\s]+?)\s*$/m);
  if (!match) {
    return { ok: false, reason: "repo git sans remote GitHub" };
  }
  const owner = match[1];
  let repo = match[2];
  // Strip trailing `.git` extension if present
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  // If .git was found by walking up, surface the root dir so callers can cd there if needed
  const walkedUp = found.root !== resolve(".");
  return {
    ok: true,
    reason: walkedUp
      ? `remote GitHub: ${owner}/${repo} (repo racine: ${found.root.replace(/\\/g, "/")})`
      : `remote GitHub: ${owner}/${repo}`,
    owner,
    repo,
    nameWithOwner: `${owner}/${repo}`,
    repoRoot: found.root.replace(/\\/g, "/"),
  };
}

// -----------------------------------------------------------------------------
// storage check - Scaleway Object Storage configured?
// -----------------------------------------------------------------------------
function checkStorage() {
  const bucket = env.STORAGE_BUCKET;
  const accessKey = env.STORAGE_ACCESS_KEY;
  const secretKey = env.STORAGE_SECRET_KEY;
  const endpoint = env.STORAGE_ENDPOINT;
  const region = env.STORAGE_REGION;

  const missing = [];
  if (!bucket || bucket.trim() === "") missing.push("STORAGE_BUCKET");
  if (!accessKey || accessKey.trim() === "") missing.push("STORAGE_ACCESS_KEY");
  if (!secretKey || secretKey.trim() === "") missing.push("STORAGE_SECRET_KEY");
  if (missing.length > 0) {
    return { ok: false, reason: `absent(e)s: ${missing.join(", ")}` };
  }

  if ([bucket, accessKey, secretKey].some((v) => /placeholder|your_/i.test(v))) {
    return { ok: false, reason: "une des vars STORAGE_* ressemble à un placeholder" };
  }

  // Region check replaces the old R2 "EU jurisdiction" endpoint-suffix logic:
  // this harness only ever targets fr-par (CONTRACT.md §1 REGION constant), so
  // anything else is worth a warning rather than a silent accept.
  const regionOk = region === "fr-par";
  const regionWarning = !region
    ? "STORAGE_REGION absente - impossible de vérifier la région"
    : !regionOk
    ? `STORAGE_REGION="${region}" ≠ "fr-par" (seule région supportée par ce harness)`
    : null;

  return {
    ok: true,
    reason: "Scaleway Object Storage configuré",
    bucket,
    endpoint: endpoint ?? null,
    region: region ?? null,
    publicUrl: env.STORAGE_PUBLIC_URL ?? null,
    regionWarning,
  };
}

// -----------------------------------------------------------------------------
// analytics check - Matomo configured?
// -----------------------------------------------------------------------------
function checkAnalytics() {
  const matomoUrl = env.NEXT_PUBLIC_MATOMO_URL;
  const siteId = env.NEXT_PUBLIC_MATOMO_SITE_ID;

  if (!matomoUrl || matomoUrl.trim() === "") {
    return { ok: false, reason: "NEXT_PUBLIC_MATOMO_URL absente" };
  }
  if (!siteId || siteId.trim() === "") {
    return { ok: false, reason: "NEXT_PUBLIC_MATOMO_SITE_ID absente" };
  }
  if (/placeholder|your_/i.test(matomoUrl) || /placeholder|your_/i.test(siteId)) {
    return { ok: false, reason: "NEXT_PUBLIC_MATOMO_URL ou NEXT_PUBLIC_MATOMO_SITE_ID ressemble à un placeholder" };
  }
  if (!/^\d+$/.test(siteId.trim())) {
    return { ok: false, reason: `NEXT_PUBLIC_MATOMO_SITE_ID ("${siteId}") ne ressemble pas à un ID numérique` };
  }
  try {
    // eslint-disable-next-line no-new
    new URL(matomoUrl);
  } catch {
    return { ok: false, reason: `NEXT_PUBLIC_MATOMO_URL ("${matomoUrl}") n'est pas une URL valide` };
  }

  return {
    ok: true,
    reason: `Matomo configuré (site ${siteId} @ ${matomoUrl})`,
    matomoUrl,
    siteId,
  };
}

// -----------------------------------------------------------------------------
// dark-mode check - is next-themes installed AND wired up in the root layout?
// -----------------------------------------------------------------------------
function checkDarkMode() {
  const pkgLocations = ["package.json", "apps/web/package.json"];
  let pkgFound = null;
  let nextThemesInstalled = false;
  for (const p of pkgLocations) {
    const path = resolve(p);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next-themes"]) {
        nextThemesInstalled = true;
        pkgFound = p;
        break;
      }
    } catch {
      // ignore malformed package.json
    }
  }

  if (!nextThemesInstalled) {
    return { ok: false, reason: "next-themes pas installé" };
  }

  // Check that ThemeProvider is actually mounted in a root layout.
  // Without this, the package is installed but inert.
  const layoutLocations = [
    "src/app/layout.tsx",
    "app/layout.tsx",
    "apps/web/src/app/layout.tsx",
    "apps/web/app/layout.tsx",
  ];

  let providerMounted = false;
  let layoutFile = null;
  for (const loc of layoutLocations) {
    const lp = resolve(loc);
    if (!existsSync(lp)) continue;
    const c = readFileSync(lp, "utf8");
    if (c.includes("next-themes") || /ThemeProvider/.test(c)) {
      providerMounted = true;
      layoutFile = loc;
      break;
    }
  }

  // Detect Tailwind v4 dark variant in globals.css (best-effort, not blocking)
  const cssLocations = [
    "src/app/globals.css",
    "src/styles/globals.css",
    "app/globals.css",
    "apps/web/src/app/globals.css",
    "apps/web/src/styles/globals.css",
    "apps/web/app/globals.css",
  ];
  let darkVariantConfigured = false;
  let cssFile = null;
  for (const loc of cssLocations) {
    const cp = resolve(loc);
    if (!existsSync(cp)) continue;
    const c = readFileSync(cp, "utf8");
    cssFile = loc;
    if (/@custom-variant\s+dark/.test(c)) {
      darkVariantConfigured = true;
    }
    break;
  }

  if (!providerMounted) {
    return {
      ok: false,
      reason: `next-themes installé (${pkgFound}) mais ThemeProvider absent du root layout - installation incomplète`,
      packageJson: pkgFound,
      cssFile,
      darkVariantConfigured,
    };
  }

  return {
    ok: true,
    reason: `next-themes installé + ThemeProvider monté dans ${layoutFile}${darkVariantConfigured ? "" : " (⚠️ @custom-variant dark absent du CSS)"}`,
    packageJson: pkgFound,
    layoutFile,
    cssFile,
    darkVariantConfigured,
  };
}

// -----------------------------------------------------------------------------
// run
// -----------------------------------------------------------------------------
const result = {};
for (const check of checks) {
  const fn = dispatchers[check];
  if (!fn) {
    result[check] = { ok: false, reason: `check inconnu: ${check} (supportés: ${Object.keys(dispatchers).join(", ")})` };
    continue;
  }
  result[check] = await fn();
}

process.stdout.write(JSON.stringify(result));
