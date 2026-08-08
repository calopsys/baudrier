#!/usr/bin/env node
// dev-credentials.mjs - fallback IAM credentials for development, per-request
// delegation (CONTRACT.md §1, §2, §7).
//
// This module exists to remove admin friction during development. The
// operator's key normally mints a scoped IAM key for each service (database,
// generative AI, email) directly. When the operator's key lacks IAMManager,
// the harness used to stop at every single addon and ask an administrator
// for a per-purpose delegated key. That interrupts the user constantly.
//
// The new rule: during development, each caller falls back SILENTLY to the
// operator's own personal key as the credential material for the service
// secret. This module records a hash of the resulting value in the
// BAUDRIER_DEV_FINGERPRINTS manifest - never the value itself. The /publish
// skill reads that manifest through checkDevBacked() and refuses to publish
// while any secret still matches its recorded fingerprint. This batches
// every admin-key request into one moment, at /publish, instead of one
// interruption per addon.
//
// This fallback is acceptable ONLY while the app is IP-restricted
// (CONTRACT.md §2 carve-out): the operator's personal key can administer the
// whole Scaleway Project, so it must never reach a publicly reachable app.
//
// `swap-all` (CONTRACT.md §3) is the generalised /publish migration: it runs
// swap-db and adopt-app-key - each tolerant of "nothing to do" - then
// a fresh check, and reports one consolidated result. Migrating never edits
// generated-app code: it only ever touches Secret Manager, the container
// secret map, the GitHub Actions secret and this fingerprints manifest.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { api, sdkCall, requireCredentials, ScwError, slugify } from "./_scw-auth.mjs";
import { getSecret, putSecret, deleteSecret } from "./secrets.mjs";
import { DELEGATED_DB_KEY_SECRET_NAME } from "./iam.mjs";
import { getDatabase, buildConnectionString } from "./sdb.mjs";
import { ensureNamespace, findContainerByName, syncContainerSecrets } from "./container.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_MJS_PATH = path.join(MODULE_DIR, "secrets.mjs");

/** Secret Manager entry (app project) holding {secretName: "sha256:<hex>"} for every dev-backed secret. */
export const DEV_FINGERPRINTS_SECRET_NAME = "BAUDRIER_DEV_FINGERPRINTS";

// CONTRACT.md §2 exception 4: an admin-minted IAM application carrying the
// app project's own service permission sets (never ProjectManager/IAMManager).
// adoptAppKey() below live-validates it before adopting it.
export const APP_KEY_SECRET_NAME = "BAUDRIER_APP_KEY";

const MALFORMED_MANIFEST_MESSAGE =
  `Le secret ${DEV_FINGERPRINTS_SECRET_NAME} ne contient pas du JSON valide. ` +
  "Supprimez-le dans Secret Manager pour repartir d’un état propre.";

const MALFORMED_DELEGATED_KEY_MESSAGE =
  `Le secret ${DELEGATED_DB_KEY_SECRET_NAME} ne contient pas le format attendu. ` +
  'Il doit être un JSON avec les champs "application_id" et "secret_key" (deux chaînes non vides).';

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

/**
 * Parse the {access_key, secret_key} JSON shape used by BAUDRIER_APP_KEY -
 * same malformed-key error pattern as MALFORMED_DELEGATED_KEY_MESSAGE above,
 * generalised to this pair's field names.
 * @param {string} raw
 * @param {string} secretName  for the error message only
 * @returns {{accessKey:string, secretKey:string}}
 */
function parseAccessSecretPair(raw, secretName) {
  const message =
    `Le secret ${secretName} ne contient pas le format attendu. ` +
    'Il doit être un JSON avec les champs "access_key" et "secret_key" (deux chaînes non vides).';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScwError(message, { type: "malformed_key" });
  }
  const accessKey = typeof parsed?.access_key === "string" ? parsed.access_key.trim() : "";
  const secretKey = typeof parsed?.secret_key === "string" ? parsed.secret_key.trim() : "";
  if (!accessKey || !secretKey) {
    throw new ScwError(message, { type: "malformed_key" });
  }
  return { accessKey, secretKey };
}

/** Read the fingerprint manifest. Absent secret -> {}. */
async function readManifest() {
  let raw;
  try {
    raw = await getSecret(DEV_FINGERPRINTS_SECRET_NAME);
  } catch (e) {
    if (e?.type === "not_found") return {};
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScwError(MALFORMED_MANIFEST_MESSAGE, { type: "malformed_manifest" });
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

/**
 * Resolve the IAM principal behind the operator's own personal key, for use
 * as the "username" half of a Serverless SQL Database connection string
 * (CONTRACT.md §4 - the DB "user" is an IAM Application id, or here, the
 * operator's own user/application id).
 * SDK call: Iam.getAPIKey({ accessKey }) - the key object carries `userId`
 * for a user-held key, or `applicationId` for an application-held one.
 * @returns {Promise<{principalId:string, secretKey:string}>}
 */
export async function devDbCredentials() {
  const creds = requireCredentials();
  const iam = await api("Iam", "v1alpha1");
  const key = await sdkCall(() => iam.getAPIKey({ accessKey: creds.accessKey }));
  const principalId = key?.userId || key?.applicationId;
  if (!principalId) {
    throw new ScwError(
      "Impossible de déterminer le principal IAM de votre clé personnelle : " +
        "ni identifiant utilisateur ni identifiant application n’a été trouvé.",
      { type: "principal_unresolved" },
    );
  }
  return { principalId, secretKey: creds.secretKey };
}

/**
 * Record the CURRENT value of a dev-backed secret as a hash in the
 * fingerprint manifest. Called right after a caller writes `secretName` with
 * dev-fallback material, so /publish can later detect whether it has since
 * been replaced by an admin-provisioned value.
 * @param {string} secretName
 * @param {string} value  plain value just stored - hashed here, never persisted as-is
 */
export async function recordDevFingerprint(secretName, value) {
  const manifest = await readManifest();
  manifest[secretName] = sha256(value);
  await putSecret(DEV_FINGERPRINTS_SECRET_NAME, JSON.stringify(manifest));
}

/**
 * Check every secret named in the manifest against its recorded fingerprint.
 * A secret still matching is still dev-backed. A secret that changed (an
 * admin rotated it) or disappeared is cleared - and pruned from the manifest,
 * written back only if something actually changed.
 * @returns {Promise<{devBacked:string[], cleared:string[]}>}
 */
export async function checkDevBacked() {
  const manifest = await readManifest();
  const names = Object.keys(manifest);
  if (names.length === 0) return { devBacked: [], cleared: [] };

  const devBacked = [];
  const cleared = [];
  const next = { ...manifest };

  for (const name of names) {
    let current;
    try {
      current = await getSecret(name);
    } catch (e) {
      if (e?.type !== "not_found") throw e;
      cleared.push(name);
      delete next[name];
      continue;
    }
    if (sha256(current) === manifest[name]) {
      devBacked.push(name);
    } else {
      cleared.push(name);
      delete next[name];
    }
  }

  if (cleared.length > 0) {
    await putSecret(DEV_FINGERPRINTS_SECRET_NAME, JSON.stringify(next));
  }

  return { devBacked, cleared };
}

/**
 * Which manifest entries block publishing a given environment. The personal
 * key inside a secret only matters for the environment whose container (or
 * shared Job) actually reads it: a preview-branch DATABASE_URL does not feed
 * the production container, and vice versa. Shared secrets (agent, TEM,
 * storage) feed every environment and always block.
 * @param {string[]} devBacked
 * @param {{env?:"production"|"preview", branchSlug?:string}} [scope]
 */
export function filterBlocking(devBacked, { env, branchSlug } = {}) {
  if (!env) return devBacked;
  const previewSuffix = branchSlug ? branchSlug.toUpperCase().replace(/-/g, "_") : null;
  return devBacked.filter((name) => {
    if (name === "DATABASE_URL") return env === "production";
    if (name.startsWith("DATABASE_URL_PREVIEW_")) {
      return env === "preview" && previewSuffix !== null && name === `DATABASE_URL_PREVIEW_${previewSuffix}`;
    }
    // Every other shared secret (agent, TEM, storage) feeds every
    // environment through the fallthrough below, so it blocks both
    // production and preview publish.
    return true;
  });
}

/**
 * Rebuild every dev-backed database secret (production DATABASE_URL and each
 * DATABASE_URL_PREVIEW_* in the manifest) from the admin-delegated
 * {application_id, secret_key} pair, the way rotate-secret.mjs does, and push
 * each into its container. One pair covers every database in the Project (the
 * admin's policy is project-scoped). A preview whose database no longer
 * exists gets its secret DELETED instead (it holds personal-key material and
 * its database is gone; the next preview deploy recreates it properly).
 * @param {{projectName:string}} args
 * @returns {Promise<{swapped:boolean, reason?:string, swappedSecrets?:string[], orphaned?:string[]}>}
 */
export async function swapDatabaseUrl({ projectName } = {}) {
  if (!projectName) throw new ScwError("swapDatabaseUrl requires projectName", { type: "usage" });

  const manifest = await readManifest();
  const dbNames = Object.keys(manifest).filter(
    (n) => n === "DATABASE_URL" || n.startsWith("DATABASE_URL_PREVIEW_"),
  );
  if (dbNames.length === 0) {
    return { swapped: false, reason: "aucun secret de base de données n’est adossé à la clé personnelle" };
  }

  let raw;
  try {
    raw = await getSecret(DELEGATED_DB_KEY_SECRET_NAME);
  } catch (e) {
    if (e?.type !== "not_found") throw e;
    return { swapped: false, reason: "BAUDRIER_DB_KEY absent" };
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

  const ns = await ensureNamespace(projectName);
  const swappedSecrets = [];
  const orphaned = [];

  for (const secretName of dbNames) {
    // DATABASE_URL_PREVIEW_<SLUG> reverses to the deploy.mjs naming: slugify
    // output has no underscores, so the underscore/uppercase transform is
    // bijective and the database/container names reconstruct exactly.
    const isPreview = secretName !== "DATABASE_URL";
    const branchSlug = isPreview
      ? secretName.slice("DATABASE_URL_PREVIEW_".length).toLowerCase().replace(/_/g, "-")
      : null;
    const dbName = isPreview ? `${slugify(projectName)}-preview-${branchSlug}` : projectName;
    const containerName = isPreview ? `${slugify(projectName)}-preview-${branchSlug}` : projectName;

    const db = await getDatabase(dbName);
    if (!db) {
      if (!isPreview) {
        throw new ScwError(
          `aucune base de données Serverless SQL nommée « ${slugify(projectName)} » - lancez /add-db d’abord`,
          { type: "not_found" },
        );
      }
      await deleteSecret(secretName);
      delete manifest[secretName];
      orphaned.push(secretName);
      continue;
    }

    const connectionString = buildConnectionString({
      endpoint: db.endpoint,
      port: db.port,
      dbName: db.dbName,
      applicationId,
      secretKey,
    });
    // Never logged, never written to disk - same rule as setup-db.mjs/rotate-secret.mjs.
    // Written BEFORE the container sync below, so syncContainerSecrets()
    // reads this fresh value back from Secret Manager.
    await putSecret(secretName, connectionString);

    // syncContainerSecrets() waits for the container internally (CONTRACT.md
    // §1 - a container in a transient state refuses writes, and a secret
    // write itself triggers a new deploy), so no wait is needed here.
    // secretName is "DATABASE_URL" for production or the branch's own
    // DATABASE_URL_PREVIEW_<SLUG> for a preview - either way it names the
    // secret this loop just wrote, so databaseUrlFrom always reads it back.
    const container = await findContainerByName(ns.id, containerName);
    if (container) {
      // Preview containers fail closed on every sync: without the override,
      // buildContainerSecretMap would project production's canonical
      // ACCESS_RESTRICTED/APP_URL (possibly "false" after a /publish) onto
      // the preview.
      const syncOpts = isPreview
        ? {
            databaseUrlFrom: secretName,
            overrides: { ACCESS_RESTRICTED: "true", APP_URL: `https://${container.domain_name}` },
          }
        : { databaseUrlFrom: secretName };
      await syncContainerSecrets(container.id, syncOpts);
    }

    delete manifest[secretName];
    swappedSecrets.push(secretName);
  }

  await putSecret(DEV_FINGERPRINTS_SECRET_NAME, JSON.stringify(manifest));
  return { swapped: swappedSecrets.length > 0 || orphaned.length > 0, swappedSecrets, orphaned };
}

/**
 * Live-validate a candidate {accessKey, secretKey} pair with exactly one
 * listSecrets call, scoped to the app's own project (CONTRACT.md §1, §2
 * exception 4). Runs in a CHILD process, never in-process: _scw-auth.mjs
 * memoises one SDK client per module lifetime, and by the time this runs this
 * module's own process has already built one for the operator's key (reading
 * the manifest above) - reusing it here would validate the WRONG key, not the
 * candidate. Key material travels via the child's environment only; argv
 * carries nothing but this file's own path (not sensitive).
 * @param {{accessKey:string, secretKey:string, projectId?:string, region?:string}} args
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
async function liveValidateAppKey({ accessKey, secretKey, projectId, region }) {
  const script = [
    'import { pathToFileURL } from "node:url";',
    `const { listSecrets } = await import(pathToFileURL(${JSON.stringify(SECRETS_MJS_PATH)}).href);`,
    "try {",
    "  await listSecrets();",
    "  process.stdout.write(JSON.stringify({ ok: true }));",
    "} catch (e) {",
    "  process.stdout.write(JSON.stringify({ ok: false, message: String(e?.message || e) }));",
    "}",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      SCW_ACCESS_KEY: accessKey,
      SCW_SECRET_KEY: secretKey,
      SCW_DEFAULT_PROJECT_ID: projectId,
      SCW_DEFAULT_REGION: region,
    },
  });

  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    return { ok: false, message: (result.stderr || "échec inattendu du processus de validation").slice(0, 300) };
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return { ok: false, message: "réponse de validation illisible" };
  }
}

/**
 * Live-validate an admin-provisioned BAUDRIER_APP_KEY against the app's own
 * project (CONTRACT.md §1, §2 exception 4, §3).
 *
 * Credentials are env-only now (CONTRACT.md §2): there is no repo-local file
 * left to persist an adopted key into, so this only confirms the key works -
 * it does not change which credential the current process uses. Switching an
 * app over to a delegated key is env-configuration work for the operator: on
 * success this prints the exact env lines they need to set (access key in
 * full - never the secret, which is never echoed anywhere; the operator
 * already holds it, from whoever provisioned BAUDRIER_APP_KEY) and, since the
 * instructions differ by platform (CONTRACT.md §7), which one applies here.
 * @param {{dir?:string}} [args]  dir defaults to process.cwd() - the app repo root
 * @returns {Promise<{ok:boolean, adopted?:boolean, reason?:string, detail?:string, envLines?:string[], platform?:string, instructions?:string}>}
 */
export async function adoptAppKey({ dir = process.cwd() } = {}) {
  let raw;
  try {
    raw = await getSecret(APP_KEY_SECRET_NAME);
  } catch (e) {
    if (e?.type !== "not_found") throw e;
    return { ok: true, adopted: false, reason: `${APP_KEY_SECRET_NAME} absent de Secret Manager` };
  }
  const { accessKey, secretKey } = parseAccessSecretPair(raw, APP_KEY_SECRET_NAME);

  const creds = requireCredentials();
  const validation = await liveValidateAppKey({
    accessKey,
    secretKey,
    projectId: creds.projectId,
    region: creds.region,
  });
  if (!validation.ok) {
    return { ok: false, reason: "validation_failed", detail: validation.message };
  }

  const envLines = [`SCW_ACCESS_KEY=${accessKey}`, "SCW_SECRET_KEY=<utilisez le secret que vous détenez déjà - ne jamais l’afficher ni le stocker en clair ici>"];
  const platform = "web";
  const instructions =
    "Ouvrez la boîte de dialogue d’environnement Claude Code web, remplacez SCW_ACCESS_KEY/SCW_SECRET_KEY par cette paire, puis démarrez une NOUVELLE session (une conversation en cours ne peut pas relire ces variables).";

  // Printed to stderr (never stdout, which the CLI block below reserves for
  // exactly one parseable JSON line) so a human running this by hand sees the
  // lines directly, while a caller parsing stdout still gets the same data
  // structured in the return value.
  console.error(`\n${instructions}\n\n${envLines.join("\n")}\n`);

  return { ok: true, adopted: true, envLines, platform, instructions };
}

/**
 * Run every /publish migration sub-swap in one pass - swap-db and
 * adopt-app-key, each tolerant of "nothing to do" - then a fresh check, so the
 * caller re-evaluates `blocking` from ONE consolidated result instead of
 * chaining calls itself. Every sub-swap is independently idempotent and
 * failures are caught per sub-swap: one throwing does not stop the others,
 * and simply re-running swapAll afterward is always safe.
 * @param {{projectName:string, env?:"production"|"preview", branchSlug?:string}} args
 * @returns {Promise<{swapped:object, devBacked:string[], blocking:string[]}>}
 */
export async function swapAll({ projectName, env, branchSlug } = {}) {
  if (!projectName) throw new ScwError("swapAll requires projectName", { type: "usage" });
  // Fail fast with the standard, clean error shape when credentials are
  // entirely absent, instead of the same error surfacing three times over
  // (once per sub-swap below) before this function ever gets to checkDevBacked.
  requireCredentials();

  const swapped = {};

  try {
    swapped.db = await swapDatabaseUrl({ projectName });
  } catch (e) {
    swapped.db = { swapped: false, error: e.message };
  }

  try {
    swapped.appKey = await adoptAppKey();
  } catch (e) {
    swapped.appKey = { ok: false, error: e.message };
  }

  const check = await checkDevBacked();
  const blocking = filterBlocking(check.devBacked, { env, branchSlug });

  return { swapped, devBacked: check.devBacked, blocking };
}

/* ------------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : undefined;
  };

  (async () => {
    switch (cmd) {
      case "check": {
        const env = flag("env");
        if (env && env !== "production" && env !== "preview") {
          throw new ScwError("--env doit valoir production ou preview", { type: "usage" });
        }
        const result = await checkDevBacked();
        // `blocking` scopes the gate to the environment being published;
        // `devBacked` stays the full list for reporting.
        const blocking = filterBlocking(result.devBacked, { env, branchSlug: flag("branch-slug") });
        console.log(JSON.stringify({ ok: true, ...result, blocking }));
        break;
      }
      case "swap-db": {
        const projectName = flag("project-name");
        if (!projectName) {
          throw new ScwError("usage: node dev-credentials.mjs swap-db --project-name <name> [--json]", { type: "usage" });
        }
        const result = await swapDatabaseUrl({ projectName });
        console.log(JSON.stringify({ ok: true, ...result }));
        break;
      }
      case "adopt-app-key": {
        const projectName = flag("project-name");
        if (!projectName) {
          throw new ScwError("usage: node dev-credentials.mjs adopt-app-key --project-name <name> [--json]", { type: "usage" });
        }
        const result = await adoptAppKey();
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "swap-all": {
        const projectName = flag("project-name");
        if (!projectName) {
          throw new ScwError(
            "usage: node dev-credentials.mjs swap-all --project-name <name> [--env production|preview] [--branch-slug <slug>] [--json]",
            { type: "usage" },
          );
        }
        const env = flag("env");
        if (env && env !== "production" && env !== "preview") {
          throw new ScwError("--env doit valoir production ou preview", { type: "usage" });
        }
        const result = await swapAll({ projectName, env, branchSlug: flag("branch-slug") });
        console.log(JSON.stringify({ ok: true, ...result }));
        break;
      }
      default:
        console.log(
          "usage: node dev-credentials.mjs check [--env production|preview] [--branch-slug <slug>] [--json]\n" +
            "       node dev-credentials.mjs swap-db --project-name <name> [--json]\n" +
            "       node dev-credentials.mjs adopt-app-key --project-name <name> [--json]\n" +
            "       node dev-credentials.mjs swap-all --project-name <name> [--env production|preview] [--branch-slug <slug>] [--json]",
        );
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, type: err.type, reason: err.message }));
    process.exitCode = 1;
  });
}
