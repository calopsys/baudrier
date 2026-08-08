#!/usr/bin/env node
// rgpd-audit.mjs - Scan a Next.js project to detect data processors in use,
// compare with the subprocessors registry (src/lib/subprocessors.json), and
// report gaps. Pure read-only, no network calls, no Scaleway credentials
// needed - outputs JSON.
//
// Rewritten for the Scaleway stack (CONTRACT.md). This audit gets STRONGER
// in a sovereign-by-default product: hosting, database, storage and email
// are now always Scaleway (France, région fr-par) instead of a scattered
// mix of US providers, so the vast majority of a project's subprocessors
// are French/EU by construction. This script computes that as a real
// number (see `sovereignty` in the output) rather than just asserting it -
// see the note on overclaiming below.
//
// Three result buckets, on purpose:
//   - `subprocessors` : things that belong in src/lib/subprocessors.json
//     because they process END-USER (visitor/customer) personal data. This
//     is what gets compared against the registry for missing/stale entries.
//   - `otherThirdParties` : third parties involved in building/operating the
//     project that do NOT belong in the privacy policy, because they don't
//     process end-user data - GitHub (source hosting + CI, in the deploy
//     path per CONTRACT.md §5, but it never touches a visitor's data),
//     Google SEO tooling (PageSpeed Insights / Search Console, read PUBLIC
//     page data and the operator's own search analytics, not visitor PII),
//     `push` (Web Push delivery goes through the visitor's own browser
//     vendor, not a service this app contracts with), and `indexnow` (a
//     no-PII ping telling search engines a page changed). Surfaced for
//     transparency (a project owner should still know they exist) without
//     inflating the legal registry with entries that don't belong there. Do
//     NOT report these as "missing from the registry".
//   - `undeclaredHosts` : every external https:// hostname found in source
//     that isn't already explained by one of the two buckets above or a
//     small known-EU/self allowlist. Purely informational, never compared
//     against the registry or auto-added to it (no legal metadata to attach
//     automatically) - just a nudge for a human to go look.
//
// Usage:
//   node rgpd-audit.mjs                # JSON to stdout
//   node rgpd-audit.mjs --pretty       # human-readable

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const PRETTY = args.includes("--pretty");

// ─── Web root detection ───────────────────────────────────────────────────
function detectWebRoot() {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "apps/web/package.json"))) return join(cwd, "apps/web");
  if (existsSync(join(cwd, "package.json"))) return cwd;
  return null;
}

const WEB_ROOT = detectWebRoot();
if (!WEB_ROOT) {
  console.error("[rgpd-audit] Cannot detect web root: no package.json at ./ or ./apps/web/");
  process.exit(1);
}
const ROOT = process.cwd();

// ─── Helpers ──────────────────────────────────────────────────────────────
function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readTextSafe(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function fileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function dirExists(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function globFirst(dir, re) {
  try {
    return readdirSync(dir).find((f) => re.test(f)) || null;
  } catch {
    return null;
  }
}

// Recursively grep for any of the patterns under a directory. Stops at the
// first match per pattern (we just need a yes/no).
function grepDir(dir, patterns) {
  const found = new Set();
  function walk(d) {
    if (found.size === patterns.length) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (found.size === patterns.length) return;
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        let text;
        try { text = readFileSync(full, "utf8"); } catch { continue; }
        for (const p of patterns) {
          if (!found.has(p) && text.includes(p)) found.add(p);
        }
      }
    }
  }
  walk(dir);
  return found;
}

// ─── Read package.json (deps + devDeps) ───────────────────────────────────
const webPkg = readJsonSafe(join(WEB_ROOT, "package.json")) || {};
const rootPkg = readJsonSafe(join(ROOT, "package.json")) || {};
const allDeps = {
  ...(webPkg.dependencies || {}),
  ...(webPkg.devDependencies || {}),
  ...(rootPkg.dependencies || {}),
  ...(rootPkg.devDependencies || {}),
};
function hasDep(name) { return Object.prototype.hasOwnProperty.call(allDeps, name); }

// ─── Read .env files (best-effort - for hint detection only) ─────────────
// NOTE: several project secrets (DATABASE_URL, STORAGE_ACCESS_KEY/SECRET_KEY,
// SCW_GENERATIVE_API_KEY, TEM_API_SECRET_KEY) live ONLY in Scaleway Secret
// Manager and are never written to a local .env (CONTRACT.md §4, and
// scripts/setup-db.mjs's explicit "never written to a local file" rule).
// This script makes no network calls and asks for no credentials, so it
// cannot see those - detection below leans on `.env` hints for the vars
// that ARE mirrored locally (STORAGE_ENDPOINT/BUCKET, TEM_SENDER_*,
// NEXT_PUBLIC_MATOMO_*) plus dependencies and source code, which is enough
// to detect that a feature is wired up even when the credential itself is
// invisible to a local scan.
function readEnvHints() {
  const hints = new Set();
  for (const f of [".env", ".env.local", ".env.example"]) {
    const text = readTextSafe(join(WEB_ROOT, f));
    if (!text) continue;
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (m) hints.add(m[1]);
    }
  }
  return hints;
}
const envHints = readEnvHints();

// ─── Look for a few key source files / dirs ───────────────────────────────
const SRC_DIR = join(WEB_ROOT, "src");
const HAS_SRC = dirExists(SRC_DIR);

// "next-matomo-tracker" used to be in this list but was never wired to
// anything: no template or skill in this repo ever installs a package by
// that name (Matomo is a hand-rolled <Script> component, see
// skills/add-analytics/SKILL.md) - it was dead detection code since the
// Scaleway conversion introduced it. Dropped rather than left as a pattern
// that can never match.
const sourcePatterns = HAS_SRC
  ? grepDir(SRC_DIR, [
      "MatomoAnalytics",
      "s3.fr-par.scw.cloud",
      "transactional-email",
      "api.scaleway.ai",
      "api.indexnow.org",
      "web-push",
      "PushManager.subscribe",
    ])
  : new Set();

// ─── Generic egress scan: undeclared external hosts (informational) ──────
// Catches a third-party call not covered by any of the specific detectors
// above - a widget or SDK someone (human or agent) wired up directly, source
// text an app author pasted in, etc. Not compared against the registry (no
// legal metadata to attach automatically, and it would be too noisy) - just
// surfaced so a human looks. False positives are expected and acceptable for
// an informational-only list: a legal reference link (cnil.fr), an XML
// namespace (w3.org), or the project's own self-hosted Matomo domain can all
// appear here; only the last is excluded automatically (see matomoHost below).
const KNOWN_HOST_ALLOWLIST = [
  /(^|\.)scw\.cloud$/i,
  /(^|\.)scaleway\.com$/i,
  /(^|\.)scaleway\.ai$/i,
  /(^|\.)openfreemap\.org$/i,
  /(^|\.)maplibre\.org$/i,
  /(^|\.)matomo\.org$/i,
  /(^|\.)matomo\.cloud$/i,
  /(^|\.)cnil\.fr$/i,
  /(^|\.)w3\.org$/i,
  /(^|\.)schema\.org$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)googleapis\.com$/i, // fonts.googleapis.com - build-time only, see next/font/google
  /(^|\.)gstatic\.com$/i,
  /(^|\.)indexnow\.org$/i,
  /(^|\.)ipify\.org$/i, // operator-side egress detection at bootstrap, not a visitor path
];

function readEnvValue(name) {
  for (const f of [".env", ".env.local"]) {
    const text = readTextSafe(join(WEB_ROOT, f));
    const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}
const matomoUrlValue = readEnvValue("NEXT_PUBLIC_MATOMO_URL");
const matomoHost = (() => {
  if (!matomoUrlValue) return null;
  try {
    return new URL(matomoUrlValue).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

function isKnownHost(host) {
  return host === matomoHost || KNOWN_HOST_ALLOWLIST.some((re) => re.test(host));
}

// Collects every distinct https:// hostname found anywhere in source - unlike
// grepDir (built for a fixed yes/no pattern list, stops early once every
// pattern has one hit), this needs the full set of hosts actually present.
function scanExternalHosts(dir) {
  const hosts = new Set();
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        hosts.add(m[1].toLowerCase());
      }
    }
  }
  walk(dir);
  return [...hosts].filter((h) => !isKnownHost(h)).sort();
}
const undeclaredHosts = HAS_SRC ? scanExternalHosts(SRC_DIR) : [];

// Deploy pipeline detection (GitHub Actions -> Container Registry, CONTRACT.md §5).
const HAS_GHA_BUILD_WORKFLOW = fileExists(join(ROOT, ".github/workflows/build.yml"));
const gitConfig = readTextSafe(join(ROOT, ".git/config"));
const HAS_GITHUB_REMOTE = /github\.com/i.test(gitConfig);

// Google Search Console verification file (public/google<hash>.html), left
// behind by the /gsc skill - the only reliable local signal that Search
// Console is wired up (the token itself lives with the operator's Google
// account, not in this repo).
const PUBLIC_DIR = join(WEB_ROOT, "public");
const GSC_VERIFICATION_FILE = dirExists(PUBLIC_DIR) ? globFirst(PUBLIC_DIR, /^google[0-9a-f]+\.html$/i) : null;
const USES_PAGESPEED = envHints.has("PAGESPEED_API_KEY");

// Privacy policy page detection - search for any politique-de-confidentialite path
function findPrivacyPolicyPage() {
  if (!HAS_SRC) return null;
  const candidates = [
    join(SRC_DIR, "app/politique-de-confidentialite/page.tsx"),
    join(SRC_DIR, "app/(public)/politique-de-confidentialite/page.tsx"),
    join(SRC_DIR, "app/(site)/politique-de-confidentialite/page.tsx"),
    join(SRC_DIR, "app/(site)/(public)/politique-de-confidentialite/page.tsx"),
  ];
  for (const c of candidates) if (fileExists(c)) return c;
  return null;
}
const PRIVACY_POLICY_PAGE = findPrivacyPolicyPage();

// Mentions légales - same logic
function findMentionsLegalesPage() {
  if (!HAS_SRC) return null;
  const candidates = [
    join(SRC_DIR, "app/mentions-legales/page.tsx"),
    join(SRC_DIR, "app/(public)/mentions-legales/page.tsx"),
    join(SRC_DIR, "app/(site)/mentions-legales/page.tsx"),
    join(SRC_DIR, "app/(site)/(public)/mentions-legales/page.tsx"),
  ];
  for (const c of candidates) if (fileExists(c)) return c;
  return null;
}
const MENTIONS_LEGALES_PAGE = findMentionsLegalesPage();

// ─── Detection rules: subprocessors (belong in subprocessors.json) ───────
// Keys match scripts/update-privacy-policy.mjs's CATALOG exactly - the two
// files must not drift, since this script's whole point is comparing
// against what that catalog can produce.
const detected = {};
const evidence = {};

// scaleway - hosting is always Scaleway Serverless Containers + Container
// Registry (CONTRACT.md §1). There is no other hosting option in this
// harness, so this is unconditional - same treatment the previous version of
// this script gave the hosting provider it targeted, just for the provider
// that actually hosts this stack now.
detected.scaleway = true;
evidence.scaleway = "Hosting is always Scaleway Serverless Containers (CONTRACT.md §1) - no other option in this harness";

// scaleway-sdb - pg + drizzle-orm/node-postgres (CONTRACT.md §4)
if (hasDep("drizzle-orm") && hasDep("pg")) {
  detected["scaleway-sdb"] = true;
  evidence["scaleway-sdb"] = "Detected via deps: drizzle-orm + pg (Serverless SQL Database wiring)";
}

// scaleway-object-storage - @aws-sdk/client-s3 + a Scaleway-shaped signal
// (STORAGE_* env hint or the s3.fr-par.scw.cloud endpoint in source), so a
// project that merely has the S3 SDK installed for an unrelated reason
// isn't flagged.
if (
  hasDep("@aws-sdk/client-s3") &&
  ([...envHints].some((k) => k.startsWith("STORAGE_")) || sourcePatterns.has("s3.fr-par.scw.cloud"))
) {
  detected["scaleway-object-storage"] = true;
  evidence["scaleway-object-storage"] = "Detected via deps: @aws-sdk/client-s3 + STORAGE_* wiring";
}

// scaleway-tem - TEM_SENDER_* env hints (mirrored to local .env, see
// CONTRACT.md §2) or the TEM API referenced in source (src/server/mail.ts).
if (envHints.has("TEM_SENDER_EMAIL") || envHints.has("TEM_SENDER_NAME") || sourcePatterns.has("transactional-email")) {
  detected["scaleway-tem"] = true;
  evidence["scaleway-tem"] = envHints.has("TEM_SENDER_EMAIL")
    ? "TEM_SENDER_EMAIL in .env"
    : "Transactional Email API referenced in source (src/server/mail.ts)";
}

// matomo - NEXT_PUBLIC_MATOMO_* env hints, or the tracking component in source.
if (envHints.has("NEXT_PUBLIC_MATOMO_URL") || envHints.has("NEXT_PUBLIC_MATOMO_SITE_ID") || sourcePatterns.has("MatomoAnalytics")) {
  detected.matomo = true;
  evidence.matomo = envHints.has("NEXT_PUBLIC_MATOMO_URL")
    ? "NEXT_PUBLIC_MATOMO_URL in .env"
    : "MatomoAnalytics component referenced in source";
}

// scaleway-generative - the OpenAI-compatible Generative APIs client always
// references its base URL in source (setup-agent.mjs-generated code); the
// key itself is Secret-Manager-only (CONTRACT.md §2), never mirrored to a
// local .env, so the source pattern is the only local signal available.
if (sourcePatterns.has("api.scaleway.ai")) {
  detected["scaleway-generative"] = true;
  evidence["scaleway-generative"] = "api.scaleway.ai referenced in source (Scaleway Generative APIs client)";
}

// ─── Detection rules: other third parties (NOT subprocessor-registry material) ───
const otherThirdParties = {};
const otherEvidence = {};

if (HAS_GHA_BUILD_WORKFLOW || HAS_GITHUB_REMOTE) {
  otherThirdParties.github = true;
  otherEvidence.github = HAS_GHA_BUILD_WORKFLOW
    ? ".github/workflows/build.yml present - source hosting + CI, in the deploy path (CONTRACT.md §5)"
    : "Git remote points at github.com - source hosting";
}

if (GSC_VERIFICATION_FILE || USES_PAGESPEED) {
  otherThirdParties.google = true;
  otherEvidence.google = GSC_VERIFICATION_FILE
    ? `Search Console verification file present (public/${GSC_VERIFICATION_FILE})`
    : "PAGESPEED_API_KEY configured (Google PageSpeed Insights, used by /seo-perf)";
}

// push - Web Push (VAPID) wiring. Informational, not a subprocessor: once a
// visitor opts in, delivery is handled by whichever push service their own
// browser vendor uses (Mozilla Autopush for Firefox, Google FCM for Chrome/
// Edge, Apple's push service for Safari) - the app never picks or contracts
// with one directly, so there is no single legal entity to register.
if (
  envHints.has("VAPID_PUBLIC_KEY") ||
  envHints.has("VAPID_PRIVATE_KEY") ||
  sourcePatterns.has("web-push") ||
  sourcePatterns.has("PushManager.subscribe")
) {
  otherThirdParties.push = true;
  otherEvidence.push =
    "Web Push (VAPID) wiring detected - delivery goes through the visitor's own browser vendor (Mozilla/Google/Apple push service), not a service this app contracts with directly";
}

// indexnow - a ping notifying search engines that a page changed. No visitor
// data involved (it carries a URL and a pre-generated key, nothing personal).
if (sourcePatterns.has("api.indexnow.org")) {
  otherThirdParties.indexnow = true;
  otherEvidence.indexnow =
    "api.indexnow.org referenced in source - notifies Microsoft (and other IndexNow-participating search engines) that a page changed";
}

// ─── Compare with registry (subprocessors only - otherThirdParties never compared) ───
const registryPath = join(WEB_ROOT, "src/lib/subprocessors.json");
const registry = readJsonSafe(registryPath) || [];
const registryKeys = new Set(registry.map((e) => e.key));
const detectedKeys = new Set(Object.keys(detected));

// A "manual": true entry (e.g. openfreemap, see skills/add-map/SKILL.md) was
// added by hand for a subprocessor this script has no way to grep-detect
// (a third-party service with no dependency, no env var, no source string to
// look for). It must never be reported as stale just because nothing here
// detected it - that would prompt a human to remove a legitimate entry.
const manualKeys = new Set(registry.filter((e) => e.manual === true).map((e) => e.key));

const missing = [...detectedKeys].filter((k) => !registryKeys.has(k));
const stale = [...registryKeys].filter((k) => !detectedKeys.has(k) && !manualKeys.has(k));

// ─── Sovereignty summary ───────────────────────────────────────────────────
// Computed from the registry's own `isEUResident` field (set by
// scripts/update-privacy-policy.mjs's CATALOG), not asserted here - this
// script only counts what is actually declared, so the number can't drift
// from what the privacy policy page itself renders. Absent registry ->
// {declared: 0, ...} rather than a misleading 0/0 "100%".
const euResidentCount = registry.filter((e) => e.isEUResident === true).length;
const sovereignty = {
  declaredSubprocessors: registry.length,
  euOrFrenchResident: euResidentCount,
  nonEuResident: registry.length - euResidentCount,
  summary:
    registry.length === 0
      ? "Aucun sous-traitant déclaré pour l'instant."
      : `${euResidentCount}/${registry.length} sous-traitant(s) déclaré(s) sont basés en France/UE.`,
};

// ─── Output ───────────────────────────────────────────────────────────────
const result = {
  webRoot: WEB_ROOT.replace(/\\/g, "/"),
  registryPath: registryPath.replace(/\\/g, "/"),
  registryExists: existsSync(registryPath),
  policyPagePath: PRIVACY_POLICY_PAGE ? PRIVACY_POLICY_PAGE.replace(/\\/g, "/") : null,
  mentionsLegalesPath: MENTIONS_LEGALES_PAGE ? MENTIONS_LEGALES_PAGE.replace(/\\/g, "/") : null,
  registryKeys: [...registryKeys],
  detectedKeys: [...detectedKeys],
  detected,
  evidence,
  missing,
  stale,
  otherThirdParties,
  otherEvidence,
  undeclaredHosts,
  sovereignty,
};

if (PRETTY) {
  console.log(`Web root            : ${result.webRoot}`);
  console.log(`Registry            : ${result.registryExists ? "✓ exists" : "✗ missing"} (${result.registryPath})`);
  console.log(`Privacy policy page : ${result.policyPagePath ? "✓ " + result.policyPagePath : "✗ missing"}`);
  console.log(`Mentions légales    : ${result.mentionsLegalesPath ? "✓ " + result.mentionsLegalesPath : "✗ missing"}`);
  console.log("");
  console.log(`Detected subprocessors (${detectedKeys.size}):`);
  for (const k of detectedKeys) {
    const inRegistry = registryKeys.has(k) ? "✓" : "✗";
    console.log(`  ${inRegistry} ${k.padEnd(24)} (${evidence[k]})`);
  }
  if (stale.length) {
    console.log("");
    console.log(`Stale registry entries (in registry but not detected, ${stale.length}):`);
    for (const k of stale) console.log(`  ⚠ ${k}`);
  }
  const otherKeys = Object.keys(otherThirdParties);
  if (otherKeys.length) {
    console.log("");
    console.log(`Other third parties involved (informational, NOT part of the privacy policy registry):`);
    for (const k of otherKeys) console.log(`  ℹ ${k.padEnd(24)} (${otherEvidence[k]})`);
  }
  if (undeclaredHosts.length) {
    console.log("");
    console.log(`Undeclared potential third parties (informational, not auto-registered - ${undeclaredHosts.length}):`);
    for (const h of undeclaredHosts) console.log(`  ? ${h}`);
  }
  console.log("");
  console.log(`Sovereignty: ${sovereignty.summary}`);
  console.log("");
  if (missing.length === 0 && stale.length === 0) {
    console.log("✅ Registry is up to date with detected subprocessors.");
  } else {
    if (missing.length) console.log(`❌ Missing in registry: ${missing.join(", ")}`);
    if (stale.length) console.log(`⚠️  Stale in registry: ${stale.join(", ")}`);
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}
