#!/usr/bin/env node
// Push environment variables to (a) the local .env file, (b) Scaleway Secret
// Manager, and (c) a Serverless Container's secret_environment_variables.
// See CONTRACT.md §1-3 and §5 for the architecture: the split that used to be
// per-hosting-target on a since-removed platform is now production vs
// preview CONTAINER.
//
// Usage:
//   ... | node push-env-vars.mjs --stdin [--env production|preview]
//     Preferred: reads newline-delimited KEY=VALUE records from stdin, so a
//     secret value never sits on argv (visible to every other process on the
//     machine via /proc or `ps`) or in shell history.
//   node push-env-vars.mjs [--env production|preview] KEY1=VALUE1 [KEY2=VALUE2 ...]
//     Legacy form, kept only because a couple of callers still pass secrets
//     this way; do not add new callers using it. --stdin and positional
//     KEY=VALUE pairs are mutually exclusive.
//
// --env selects which Serverless Container receives the values, via
// container.mjs#syncContainerSecrets:
//   - omitted            → best-effort sync of BOTH the production and
//                           preview containers (whichever are linked). This
//                           mirrors the old "production + preview by default"
//                           behaviour.
//   - --env production    → only the production container
//   - --env preview        → only the preview container for the CURRENT git
//                           branch (see CONTRACT.md §5: every non-main branch
//                           gets its own preview container)
//
// A container GET only ever returns argon2 hashes of secret values, never the
// plaintext (live-verified against Scaleway Containers v1) - so this script
// cannot read a container's current secrets, and a client-side merge is not
// possible. Secret Manager is the only readable source of truth. This script
// therefore does NOT write the pushed KEY=VALUE pairs to the container
// directly: it writes them to Secret Manager first (see Step 3 below), then
// calls syncContainerSecrets(containerId, ...), which reads the FULL secret
// map back from Secret Manager and replaces the container's whole
// secret_environment_variables with it in one write. A partial write would
// silently delete every other variable already on the container.
//
// A preview container must never inherit production's canonical
// ACCESS_RESTRICTED value from Secret Manager (that value may be "false"
// once the app is published). Every preview sync therefore passes
// `overrides: { ACCESS_RESTRICTED: "true" }` - the preview stays restricted
// (fails closed) until an explicit /publish re-opens it - plus
// `databaseUrlFrom` naming the branch's own `DATABASE_URL_PREVIEW_<SLUG>`
// secret (see resolveContainerId() below for how the branch is derived; if
// the current branch cannot be derived, the preview push is skipped with a
// warning and the next `/deploy` projects the values instead).
//
// Container linkage is resolved by NAME (CONTRACT.md §2, §7 - app repos carry
// no Scaleway metadata at all): the app name (deriveAppName()) names the
// Project, the registry/container namespace, and the production container
// itself; a preview container is `<app-name>-preview-<branch-slug>` in that
// same namespace. If the Project or the container cannot be resolved, or
// Scaleway credentials aren't configured, the container step is skipped with
// a warning - the .env write always happens regardless.
//
// The Secret Manager write is unconditional (given credentials): a secret's
// name IS the env var name (CONTRACT.md §2 "Secret Manager naming") - there
// is exactly one canonical value per key, independent of production/preview.
//
// Exit codes:
//   0 = success. Includes the case where Secret Manager / container pushes
//       were SKIPPED because Scaleway isn't configured yet or no container is
//       linked yet - that's expected during early bootstrap, not a failure.
//   1 = invalid args, or a Secret Manager / container push genuinely FAILED
//       (i.e. credentials and/or linkage were present but the API call
//       errored).

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { findContainerByName, syncContainerSecrets, waitForContainerReady } from "./scaleway/container.mjs";
import { putSecret } from "./scaleway/secrets.mjs";
import { loadCredentials, slugify, deriveAppName, resolveProjectId, api, sdkCall, REGION } from "./scaleway/_scw-auth.mjs";

const VALID_ENVS = ["production", "preview"];

// ─── Parse args ────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error("Usage: ... | node push-env-vars.mjs --stdin [--env production|preview]");
  process.exit(1);
}

function parseKvLine(line) {
  const idx = line.indexOf("=");
  if (idx <= 0) return null;
  return { key: line.slice(0, idx), value: line.slice(idx + 1) };
}

let explicitEnv = null;
let useStdin = false;
const positionalPairs = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--env") {
    explicitEnv = rawArgs[++i];
    continue;
  }
  if (arg.startsWith("--env=")) {
    explicitEnv = arg.slice("--env=".length);
    continue;
  }
  if (arg === "--stdin") {
    useStdin = true;
    continue;
  }
  // Legacy path (see the usage comment above): a non-flag arg is a KEY=VALUE
  // pair on argv. Refused once --stdin is also given, to avoid a caller
  // silently mixing a secret pushed on-argv with the safe path in one call.
  const parsed = parseKvLine(arg);
  if (!parsed) {
    console.error(`Invalid arg: ${arg} (expected KEY=VALUE with a non-empty key)`);
    process.exit(1);
  }
  positionalPairs.push(parsed);
}

if (explicitEnv !== null && !VALID_ENVS.includes(explicitEnv)) {
  console.error(`Invalid --env value: "${explicitEnv}". Allowed: ${VALID_ENVS.join(", ")}.`);
  process.exit(1);
}
if (useStdin && positionalPairs.length > 0) {
  console.error("--stdin and positional KEY=VALUE args are mutually exclusive.");
  process.exit(1);
}

let pairs;
if (useStdin) {
  const raw = readFileSync(0, "utf8");
  pairs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = parseKvLine(line);
      if (!parsed) {
        console.error(`Invalid stdin line: ${line} (expected KEY=VALUE with a non-empty key)`);
        process.exit(1);
      }
      return parsed;
    });
} else {
  pairs = positionalPairs;
}

if (pairs.length === 0) {
  console.error("No KEY=VALUE pairs provided.");
  process.exit(1);
}

const targetEnvs = explicitEnv ? [explicitEnv] : [...VALID_ENVS];

// ─── Step 1 - Update .env ──────────────────────────────────────────────
const envPath = ".env";
const existingContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const lines = existingContent.split("\n");

const keysToReplace = new Set(pairs.map((p) => p.key));
const filtered = lines.filter((line) => {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!m) return true;
  return !keysToReplace.has(m[1]);
});

while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
  filtered.pop();
}

for (const { key, value } of pairs) {
  filtered.push(`${key}=${value}`);
}

// {mode} only takes effect when writeFileSync creates the file; an already
// existing .env keeps whatever perms it had. chmodSync afterwards covers that
// case without opening a window where a brand-new file is briefly world-readable.
writeFileSync(envPath, filtered.join("\n") + "\n", { mode: 0o600 });
try {
  chmodSync(envPath, 0o600);
} catch {}
console.log(`✅ Updated ${envPath} (${pairs.length} var${pairs.length > 1 ? "s" : ""})`);

const gitignorePath = ".gitignore";
const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
const alreadyIgnored = gitignore.split("\n").some((l) => l.trim() === ".env");
if (!alreadyIgnored) {
  const suffix = gitignore.length === 0 || gitignore.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, gitignore + suffix + ".env\n");
  console.log("✅ Added .env to .gitignore");
}

// ─── Step 2 - Resolve Scaleway credentials ─────────────────────────────
const creds = loadCredentials();
const hasCreds = !!(creds.accessKey && creds.secretKey);

const results = []; // {key, target: "secret-manager"|"production"|"preview", ok, error?, skipped?}

if (!hasCreds) {
  console.log(
    "⚠️ SCW_ACCESS_KEY/SCW_SECRET_KEY not configured - skipping Secret Manager and container push. Values are only in local .env.",
  );
} else {
  // ─── Step 3 - Write each value to Scaleway Secret Manager ────────────
  console.log("▸ writing to Scaleway Secret Manager");
  for (const { key, value } of pairs) {
    try {
      await putSecret(key, value);
      results.push({ key, target: "secret-manager", ok: true });
      console.log(`✅ ${key} → Secret Manager`);
    } catch (err) {
      results.push({ key, target: "secret-manager", ok: false, error: err.message });
      console.error(`⚠️ ${key} → Secret Manager failed: ${err.message}`);
    }
  }

  // ─── Step 4 - Push into the target container(s)' secret_environment_variables ──
  const appName = deriveAppName();
  let namespaceId = null;
  let namespaceLookupError = null;
  try {
    const projectId = await resolveProjectId({ appName });
    const slug = slugify(appName);
    const containersApi = await api("Container", "v1");
    const namespaces = await sdkCall(() =>
      containersApi.listNamespaces({ region: REGION, projectId, name: slug }).all(),
    );
    namespaceId = namespaces.find((n) => n.name === slug)?.id || null;
  } catch (e) {
    namespaceLookupError = e.message;
  }

  if (!namespaceId) {
    const reason = namespaceLookupError || `no container namespace named "${slugify(appName)}" found`;
    console.log(`⚠️ Could not resolve this app's Scaleway container namespace (${reason}) - skipping container push.`);
    for (const env of targetEnvs) {
      for (const { key } of pairs) results.push({ key, target: env, ok: false, skipped: true, error: "container namespace not found" });
    }
  } else {
    for (const env of targetEnvs) {
      const containerName = env === "production" ? appName : null;
      let branch = null;
      let resolvedName = containerName;
      if (env === "preview") {
        branch = currentBranchSlug();
        if (!branch) {
          console.log(
            `⚠️ current git branch not derivable - skipping preview container push. The values are already in Secret Manager; the next /deploy will project them.`,
          );
          for (const { key } of pairs) results.push({ key, target: env, ok: false, skipped: true, error: "branch not derivable" });
          continue;
        }
        resolvedName = `${appName}-preview-${branch}`;
      }
      const container = await findContainerByName(namespaceId, resolvedName);
      const containerId = container?.id || null;
      if (!containerId) {
        console.log(`⚠️ no ${env} container named "${resolvedName}" found - skipping.`);
        for (const { key } of pairs) results.push({ key, target: env, ok: false, skipped: true, error: `no ${env} container found` });
        continue;
      }
      const syncOpts = {};
      if (env === "preview") {
        // APP_URL override: the map is built from Secret Manager, whose
        // APP_URL is production's - the preview must keep its own domain.
        // waitForContainerReady doubles as the lookup for that domain.
        const previewContainer = await waitForContainerReady(containerId, { timeoutMs: 180_000 });
        syncOpts.overrides = {
          ACCESS_RESTRICTED: "true",
          APP_URL: `https://${previewContainer.domain_name}`,
        };
        syncOpts.databaseUrlFrom = `DATABASE_URL_PREVIEW_${branch.toUpperCase().replace(/-/g, "_")}`;
      }
      try {
        await syncContainerSecrets(containerId, syncOpts);
        for (const { key } of pairs) results.push({ key, target: env, ok: true });
        console.log(`✅ synced ${env} container (${containerId}) from Secret Manager (${pairs.length} var${pairs.length > 1 ? "s" : ""} updated)`);
      } catch (err) {
        for (const { key } of pairs) results.push({ key, target: env, ok: false, error: err.message });
        console.error(`⚠️ sync to ${env} container failed: ${err.message}`);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function currentBranchSlug() {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  const branch = res.stdout.trim();
  if (!branch || branch === "HEAD") return null; // detached HEAD
  return slugify(branch);
}

// ─── Step 5 - Report ───────────────────────────────────────────────────
console.log("");
for (const { key } of pairs) {
  const smResult = results.find((r) => r.key === key && r.target === "secret-manager");
  const smStatus = !hasCreds ? "⏭️" : smResult?.ok ? "✅" : "❌";
  const envStatuses = targetEnvs
    .map((env) => {
      const r = results.find((x) => x.key === key && x.target === env);
      if (!hasCreds || !r) return `${env}:⏭️`;
      if (r.skipped) return `${env}:⏭️`;
      return r.ok ? `${env}:✅` : `${env}:❌`;
    })
    .join("  ");
  console.log(`  ${key}  secrets:${smStatus}  ${envStatuses}`);
}

const hardFailures = results.filter((r) => !r.ok && !r.skipped);
if (hardFailures.length > 0) {
  console.error("");
  console.error("Failures:");
  const seen = new Set();
  for (const f of hardFailures) {
    const sig = `${f.key}|${f.target}|${f.error}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    console.error(`  ${f.key} (${f.target}): ${f.error}`);
  }
  process.exit(1);
}

console.log("");
const envSummary = explicitEnv ? explicitEnv : `${VALID_ENVS.join(" + ")} (best-effort)`;
console.log(
  `✅ Pushed ${pairs.length} env var${pairs.length > 1 ? "s" : ""} to .env${hasCreds ? ` + Secret Manager + container(s) (${envSummary})` : ""}.`,
);
