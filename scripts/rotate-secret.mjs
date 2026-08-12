#!/usr/bin/env node
// rotate-secret.mjs - orchestrates secret rotation for a Scaleway-hosted
// project (CONTRACT.md §2, §3). New file - the previous incarnation of this
// skill did everything inline as curl/bash against a password vault and a
// handful of now-removed hosting/database/worker providers (see CONTRACT.md's
// banned-provider list); none of that composes with an IAM-key-minting,
// Secret-Manager-backed world, so this reimplements the orchestration in JS
// against
// scripts/scaleway/*.mjs, the same way scripts/setup-db.mjs, scripts/deploy.mjs
// and scripts/scale.mjs already do (container name resolution below mirrors
// scale.mjs#resolveContainerName exactly, for the same --project-name
// --target --branch CLI convention across every skill that touches a
// container).
//
// *** THE CENTRAL MECHANIC THIS FILE EXISTS TO ENFORCE ***
// Serverless Containers CANNOT reference Secret Manager (open Scaleway
// feature request - CONTRACT.md "Hard platform facts"). The harness copies
// secret values into the container's own `secret_environment_variables`,
// and per container.mjs, a PATCH that touches that field triggers a new
// deploy of the SAME image with the refreshed secrets automatically. So:
// putSecret() alone does NOT make a rotated secret take effect on a running
// app - only that PATCH does. A container GET only ever returns argon2
// hashes of secret values (never plaintext, live-verified), so this file
// cannot read a container's current secrets and cannot merge client-side -
// Secret Manager is the only readable source of truth. Every rotation path
// below therefore ends by calling syncToContainer(), which - if a container
// exists for the given project/target - calls container.mjs's
// syncContainerSecrets(): it rebuilds the FULL secret map from Secret
// Manager and replaces the container's whole secret_environment_variables
// with it, rather than trying to guess whether the container "actually
// uses" this particular key. Guessing wrong in the direction of "skip the
// push" is exactly the silent, dangerous no-op CONTRACT.md's authors and
// this repo's task owner both flagged - so this file always pushes when a
// container exists, and only skips when there is truly no container yet.
//
// Serverless Jobs, in contrast, CAN reference Secret Manager natively
// (CONTRACT.md "Hard platform facts") - a Job started after rotation reads
// the new version with no redeploy step at all. That asymmetry is called
// out in each rotation's printed summary (see JOB_NOTE below), it is not
// something this script has to do anything about.
//
// Generating a fresh random value (for AUTH_SECRET, CRON_SECRET) is NOT this
// file's job - use the existing scripts/generate-secret.mjs (via the
// `_generate-secret` skill), the one shared helper every skill that needs a
// random secret already delegates to. Reimplementing that here would just
// be a second source of truth for the same 5 lines of crypto.
//
// Usage (run from the project root; needs SCW_* credentials, see
// scripts/scaleway/_scw-auth.mjs):
//
//   node rotate-secret.mjs push --project-name X [--target production|preview] [--branch B]
//        [--project-id ID] [--no-sync] KEY=VALUE [KEY2=VALUE2 ...]
//     -> stores each KEY=VALUE in Secret Manager (in --project-id if given,
//        else the current project) and syncs to the container unless --no-sync
//
//   node rotate-secret.mjs rotate-database-url --project-name X [--target ..] [--branch ..]
//     -> mints a new IAM key for "<project>-db", rebuilds DATABASE_URL, syncs,
//        revokes every other key on that Application
//
//   node rotate-secret.mjs rotate-iam --key NAME [--pair-key NAME2] --app APPNAME
//        --perm PERM1,PERM2 --project-name X [--target ..] [--branch ..]
//     -> mints a new IAM key under APPNAME (find-or-create), stores it under
//        NAME (single value) or NAME/NAME2 (accessKey/secretKey pair), syncs,
//        revokes every other key on that Application
//
// Every command prints a final JSON line (`{"ok":true,...}` or
// `{"ok":false,"error":...}`) for the calling skill to parse. Secret VALUES
// are never printed, matching scripts/setup-db.mjs's rule for DATABASE_URL.

import { requireCredentials, ScwError, slugify } from "./scaleway/_scw-auth.mjs";
import { getSecret, putSecret } from "./scaleway/secrets.mjs";
import { ensureApplication, ensurePolicy, createApiKey, listApiKeys, deleteApiKey, DELEGATED_DB_KEY_SECRET_NAME } from "./scaleway/iam.mjs";
import { ensureNamespace, findContainerByName, syncContainerSecrets } from "./scaleway/container.mjs";
import { getDatabase, buildConnectionString } from "./scaleway/sdb.mjs";
import { pathToFileURL } from "node:url";

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------ per-request delegation */

function needsAdminRotationMessage(appName, key) {
  return (
    `Votre clé Scaleway n’a pas les droits nécessaires pour créer une nouvelle clé sur l’application ${appName}. ` +
    `Demandez à l’administrateur de créer une nouvelle clé sur cette application, de mettre à jour le secret ${key} ` +
    "avec la nouvelle valeur, puis de supprimer l’ancienne clé. Voir docs/ADMIN-SCALEWAY.md, section « Renouveler la clé »."
  );
}

function needsAdminDbRotationMessage(projectName) {
  return (
    `Votre clé Scaleway n’a pas les droits nécessaires pour créer une nouvelle clé sur l’application ${projectName}-db. ` +
    "Demandez à l’administrateur de créer une nouvelle clé sur cette application, de mettre à jour le secret " +
    `${DELEGATED_DB_KEY_SECRET_NAME} avec la nouvelle paire {"application_id":"...","secret_key":"..."}, ` +
    "de supprimer l’ancienne clé, puis relancez cette commande pour reconstruire DATABASE_URL. " +
    "Voir docs/ADMIN-SCALEWAY.md, section « Renouveler la clé »."
  );
}

const MALFORMED_DELEGATED_KEY_MESSAGE =
  `Le secret ${DELEGATED_DB_KEY_SECRET_NAME} ne contient pas le format attendu. ` +
  'Il doit être un JSON avec les champs "application_id" et "secret_key" (deux chaînes non vides).';

function parseDelegatedDbKey(raw) {
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
  return { applicationId, secretKey };
}

/* ------------------------------------------------------------- container sync */

// Mirrors scale.mjs#resolveContainerName exactly - same naming convention
// for production vs. preview containers, do not let the two drift.
function resolveContainerName(projectName, target, branch) {
  if (target === "preview") {
    if (!branch) throw new ScwError("--branch is required when --target preview", { type: "usage" });
    return `${projectName}-preview-${slugify(branch)}`;
  }
  return projectName;
}

// Mirrors deploy.mjs#resolveDatabaseSecret's preview naming exactly -
// DATABASE_URL_PREVIEW_<BRANCH_SLUG uppercased, dashes to underscores>.
function previewDatabaseSecretName(branch) {
  return `DATABASE_URL_PREVIEW_${slugify(branch).toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Sync the target container's secret_environment_variables from Secret
 * Manager - the operation that actually makes a rotated secret take effect
 * (see file header). `values` were already put into Secret Manager by the
 * caller; syncContainerSecrets() reads the FULL current map back from Secret
 * Manager and replaces the container's whole secret set with it (a container
 * GET only ever returns hashes, so a partial/merged write is not possible -
 * see container.mjs). Skips only when no container exists yet for this
 * project/target (nothing deployed to redeploy).
 *
 * A preview container must never inherit production's canonical
 * ACCESS_RESTRICTED value from Secret Manager, so every preview sync forces
 * `overrides: { ACCESS_RESTRICTED: "true" }` (fails closed) and reads
 * DATABASE_URL from the branch's own DATABASE_URL_PREVIEW_<SLUG> secret
 * instead of the literal DATABASE_URL key.
 *
 * @returns {Promise<{synced:boolean, reason?:string, containerId?:string}>}
 */
async function syncToContainer({ projectName, target = "production", branch, values }) {
  if (!projectName) return { synced: false, reason: "no --project-name given" };
  const ns = await ensureNamespace(projectName);
  const name = resolveContainerName(projectName, target, branch);
  const container = await findContainerByName(ns.id, name);
  if (!container) return { synced: false, reason: "not_deployed" };

  // Preview overrides include APP_URL: buildContainerSecretMap would
  // otherwise project production's canonical APP_URL onto the preview.
  const syncOpts =
    target === "preview"
      ? {
          overrides: { ACCESS_RESTRICTED: "true", APP_URL: `https://${container.domain_name}` },
          databaseUrlFrom: previewDatabaseSecretName(branch),
        }
      : {};
  const ready = await syncContainerSecrets(container.id, syncOpts);
  return { synced: true, containerId: ready.id, keys: Object.keys(values) };
}

/* --------------------------------------------------------------------- IAM */

/**
 * Mint a fresh API key under an IAM Application (find-or-create by name),
 * store it under `key` (single value) or `key`/`pairKey` (accessKey/secretKey
 * pair), sync to the container, then revoke every OTHER key on that
 * Application - true rotation, not just "add a new one and hope". This is
 * safe even though the connection string / earlier secret never embedded the
 * OLD key's accessKey (iam.mjs#deleteApiKey only needs the accessKey, and
 * listApiKeys(applicationId) enumerates every key on the Application
 * regardless of how it was referenced elsewhere).
 */
async function rotateIam({ key, pairKey, appName, perms, projectName, target, branch, description }) {
  if (!appName) throw new ScwError("rotateIam requires --app", { type: "usage" });
  if (!perms || perms.length === 0) throw new ScwError("rotateIam requires --perm", { type: "usage" });
  const creds = requireCredentials();

  let app;
  let minted;
  try {
    app = await ensureApplication(appName);
    await ensurePolicy({ applicationId: app.id, projectId: creds.projectId, permissionSetNames: perms });
    minted = await createApiKey({
      applicationId: app.id,
      projectId: creds.projectId,
      description: description || `${key} (baudrier, no expiry, rotated ${today()})`,
    });
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;
    throw new ScwError(needsAdminRotationMessage(appName, key), {
      type: "needs_admin",
      details: { recipe: "rotation", appName, key },
    });
  }

  const values = pairKey ? { [key]: minted.accessKey, [pairKey]: minted.secretKey } : { [key]: minted.secretKey };
  for (const [k, v] of Object.entries(values)) await putSecret(k, v);

  const sync = await syncToContainer({ projectName, target, branch, values });

  const allKeys = await listApiKeys(app.id);
  const oldKeys = allKeys.filter((k) => k.accessKey !== minted.accessKey);
  for (const k of oldKeys) await deleteApiKey(k.accessKey);

  return { ok: true, key, pairKey: pairKey || null, application: app.id, revokedOldKeys: oldKeys.length, sync };
}

/**
 * DATABASE_URL special case: the value is not a plain secret, it's a
 * postgres:// URL composed from the (unchanged) IAM Application id, a FRESH
 * API key's secretKey, and the (unchanged) database endpoint/port/name -
 * mirrors scripts/setup-db.mjs#ensureIamAccess + storeSecret exactly, so a
 * rotation reuses the SAME "<project>-db" Application setup-db.mjs created.
 *
 * For `--target preview`, the database, the IAM Application and the Secret
 * Manager entry are all the branch's own (CONTRACT.md §2's
 * DATABASE_URL_PREVIEW_<SLUG> exception) - never production's, and never the
 * literal DATABASE_URL key, which stays production-canonical (mirrors
 * deploy.mjs#resolveDatabaseSecret's preview naming exactly).
 */
async function rotateDatabaseUrl({ projectName, target, branch }) {
  if (!projectName) throw new ScwError("rotate-database-url requires --project-name", { type: "usage" });
  if (target === "preview" && !branch) {
    throw new ScwError("--branch is required when --target preview", { type: "usage" });
  }
  const creds = requireCredentials();

  const isPreview = target === "preview";
  const branchSlug = isPreview ? slugify(branch) : null;
  const dbSlug = isPreview ? `${slugify(projectName)}-preview-${branchSlug}` : projectName;
  const secretName = isPreview ? previewDatabaseSecretName(branch) : "DATABASE_URL";
  const appName = isPreview ? `harness-db-${dbSlug}` : `${projectName}-db`;

  const db = await getDatabase(dbSlug);
  if (!db) {
    throw new ScwError(`no Serverless SQL Database named "${slugify(dbSlug)}" - run /add-db first`, {
      type: "not_found",
    });
  }

  let applicationId;
  let secretKey;
  let revokedOldKeys = 0;
  try {
    const app = await ensureApplication(slugify(appName));
    await ensurePolicy({
      applicationId: app.id,
      projectId: creds.projectId,
      permissionSetNames: ["ServerlessSQLDatabaseReadWrite"],
    });
    const minted = await createApiKey({
      applicationId: app.id,
      projectId: creds.projectId,
      description: `${secretName} for ${projectName} (baudrier, no expiry, rotated ${today()})`,
    });
    applicationId = app.id;
    secretKey = minted.secretKey;

    const allKeys = await listApiKeys(app.id);
    const oldKeys = allKeys.filter((k) => k.accessKey !== minted.accessKey);
    for (const k of oldKeys) await deleteApiKey(k.accessKey);
    revokedOldKeys = oldKeys.length;
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403) throw e;

    // No IAMManager: the admin owns the "<project>-db" application, so the
    // operator cannot mint a new key on it. Rebuilding from the CURRENT
    // BAUDRIER_DB_KEY pair would embed the SAME key - only useful once the
    // admin has actually rotated it, hence this deterministic pick-up rather
    // than a guess at whether the pair already changed.
    let raw;
    try {
      raw = await getSecret(DELEGATED_DB_KEY_SECRET_NAME);
    } catch (secretErr) {
      if (secretErr?.type !== "not_found") throw secretErr;
      throw new ScwError(`${needsAdminDbRotationMessage(projectName)} (${e?.message || e})`, {
        type: "needs_admin",
        details: {
          recipe: "rotation",
          appName,
          key: secretName,
          secretName: DELEGATED_DB_KEY_SECRET_NAME,
          cause: e?.message,
        },
      });
    }
    const delegated = parseDelegatedDbKey(raw);
    applicationId = delegated.applicationId;
    secretKey = delegated.secretKey;
  }

  const connectionString = buildConnectionString({
    endpoint: db.endpoint,
    port: db.port,
    dbName: db.dbName,
    applicationId,
    secretKey,
  });
  // Never logged, never written to disk - same rule as setup-db.mjs.
  await putSecret(secretName, connectionString);

  const sync = await syncToContainer({ projectName, target, branch, values: { [secretName]: connectionString } });

  return { ok: true, key: secretName, application: applicationId, revokedOldKeys, sync };
}

/* ------------------------------------------------------------------- push */

async function pushValues({ pairs, projectName, target, branch, projectId, noSync }) {
  if (Object.keys(pairs).length === 0) {
    throw new ScwError("push requires at least one KEY=VALUE argument", { type: "usage" });
  }
  for (const [k, v] of Object.entries(pairs)) {
    await putSecret(k, v, projectId ? { projectId } : {});
  }
  const sync = noSync
    ? { synced: false, reason: "--no-sync" }
    : await syncToContainer({ projectName, target, branch, values: pairs });
  return { ok: true, keys: Object.keys(pairs), sync };
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  (async () => {
    switch (cmd) {
      case "push": {
        const pairs = {};
        for (const p of positional) {
          const idx = p.indexOf("=");
          if (idx <= 0) throw new ScwError(`bad argument "${p}", expected KEY=VALUE`, { type: "usage" });
          pairs[p.slice(0, idx)] = p.slice(idx + 1);
        }
        const result = await pushValues({
          pairs,
          projectName: flags["project-name"],
          target: flags.target || "production",
          branch: flags.branch,
          projectId: flags["project-id"],
          noSync: Boolean(flags["no-sync"]),
        });
        console.log(`✅ stored ${result.keys.join(", ")}${result.sync.synced ? " · container redeployed" : ` · ${result.sync.reason}`}`);
        console.log(JSON.stringify(result));
        break;
      }
      case "rotate-database-url": {
        const result = await rotateDatabaseUrl({
          projectName: flags["project-name"],
          target: flags.target || "production",
          branch: flags.branch,
        });
        console.log(`✅ DATABASE_URL rotated · ${result.revokedOldKeys} old key(s) revoked${result.sync.synced ? " · container redeployed" : ` · ${result.sync.reason}`}`);
        console.log(JSON.stringify(result));
        break;
      }
      case "rotate-iam": {
        const result = await rotateIam({
          key: flags.key,
          pairKey: flags["pair-key"],
          appName: flags.app,
          perms: flags.perm ? String(flags.perm).split(",") : [],
          projectName: flags["project-name"],
          target: flags.target || "production",
          branch: flags.branch,
        });
        console.log(`✅ ${result.key}${result.pairKey ? `/${result.pairKey}` : ""} rotated · ${result.revokedOldKeys} old key(s) revoked${result.sync.synced ? " · container redeployed" : ` · ${result.sync.reason}`}`);
        console.log(JSON.stringify(result));
        break;
      }
      default:
        console.log(
          "usage: rotate-secret.mjs <push|rotate-database-url|rotate-iam> ...\n" +
            "  push --project-name X [--target production|preview] [--branch B] [--project-id ID] [--no-sync] KEY=VALUE...\n" +
            "  rotate-database-url --project-name X [--target ..] [--branch ..]\n" +
            "  rotate-iam --key NAME [--pair-key NAME2] --app APPNAME --perm PERM1,PERM2 --project-name X [--target ..] [--branch ..]",
        );
        process.exitCode = 1;
    }
  })().catch((e) => {
    console.log(`⚠️ ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message, type: e.type, details: e.details }));
    process.exitCode = 1;
  });
}
