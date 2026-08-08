#!/usr/bin/env node
// secrets.mjs - Scaleway Secret Manager (region-scoped).
//
// Talks to the official @scaleway/sdk (`Secret` v1beta1) via `api()`/`sdkCall()`
// from _scw-auth.mjs, not hand-written REST. See CONTRACT.md §3.
// Reference: https://www.scaleway.com/en/developers/api/secret-manager/
//
// Two things surprised us enough to call out up front:
//
//   1. Reading a value is a DIFFERENT call than reading metadata. `listSecrets`
//      returns only names/ids/counts. The actual payload comes from a distinct
//      `accessSecretVersion` call, and only ever one version at a time.
//   2. Version payloads are base64 both ways: `createSecretVersion` requires
//      `data` to be base64-encoded, and `accessSecretVersion` returns `data`
//      base64-encoded too (confirmed against the SDK's own type doc: "The
//      base64-encoded secret payload of the version"). This module hides that
//      entirely - callers of getSecret()/putSecret() only ever see/give plain
//      UTF-8 strings.
//
// A secret version's `revision` parameter also accepts the literal strings
// "latest" and "latest_enabled" instead of a number (confirmed in the SDK's
// AccessSecretVersionRequest type doc). We always use "latest_enabled" for
// getSecret() because "latest" can point at a version that was deliberately
// disabled (e.g. mid-rotation), which is never what a running app should read.

import { api, sdkCall, requireCredentials, ScwError, REGION } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

function resolveScope(opts = {}) {
  const creds = requireCredentials();
  return {
    projectId: opts.projectId || creds.projectId,
    region: opts.region || creds.region || REGION,
  };
}

/**
 * Find a secret by exact name within a Project.
 * SDK call: Secret.listSecrets({ projectId, region, name })
 * The `name` filter is not guaranteed exact-match, so we re-check equality
 * client-side.
 */
async function findSecretByName(name, { projectId, region }) {
  const secrets = await api("Secret", "v1beta1");
  const results = await sdkCall(() => secrets.listSecrets({ projectId, region, name }).all());
  return results.find((s) => s.name === name) || null;
}

/**
 * Resolve the LATEST ENABLED version of `name` and return it as a UTF-8 string.
 * SDK calls:
 *   Secret.listSecrets({ projectId, region, name })          (resolve id by name)
 *   Secret.accessSecretVersion({ region, secretId, revision: "latest_enabled" })
 * @param {string} name
 * @param {{projectId?:string, region?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function getSecret(name, opts = {}) {
  const { projectId, region } = resolveScope(opts);
  const secret = await findSecretByName(name, { projectId, region });
  if (!secret) {
    throw new ScwError(`secret "${name}" not found in project ${projectId} (${region})`, {
      type: "not_found",
      details: { name, projectId, region },
    });
  }
  const secrets = await api("Secret", "v1beta1");
  const res = await sdkCall(() =>
    secrets.accessSecretVersion({ region, secretId: secret.id, revision: "latest_enabled" }),
  );
  if (!res || typeof res.data !== "string") {
    throw new ScwError(`secret "${name}" has no enabled version to access`, {
      type: "no_enabled_version",
      details: { name, secretId: secret.id },
    });
  }
  // `data` is base64-encoded (the SDK's own type doc: "The base64-encoded
  // secret payload of the version") - decode it back to plain UTF-8 here so
  // callers never see the encoding.
  return Buffer.from(res.data, "base64").toString("utf8");
}

/**
 * Create-or-add-version: creates the secret if it doesn't exist yet, then
 * always adds a new version carrying `value`.
 * SDK calls:
 *   Secret.listSecrets({ projectId, region, name })    (find by name)
 *   Secret.createSecret({ projectId, region, name })   (create if absent)
 *   Secret.createSecretVersion({ region, secretId, data })
 * @param {string} name
 * @param {string} value  plain UTF-8 text; base64-encoded here before sending
 * @param {{projectId?:string, region?:string}} [opts]
 * @returns {Promise<{id:string, revision:number}>}
 */
export async function putSecret(name, value, opts = {}) {
  const { projectId, region } = resolveScope(opts);
  const secrets = await api("Secret", "v1beta1");
  let secret = await findSecretByName(name, { projectId, region });
  if (!secret) {
    secret = await sdkCall(() => secrets.createSecret({ projectId, region, name }));
  }
  const version = await sdkCall(() =>
    secrets.createSecretVersion({
      region,
      secretId: secret.id,
      data: Buffer.from(String(value), "utf8").toString("base64"),
    }),
  );
  return { id: secret.id, revision: version.revision };
}

/**
 * SDK call: Secret.listSecrets({ projectId, region, name })
 * @param {string} name
 * @param {{projectId?:string, region?:string}} [opts]
 * @returns {Promise<boolean>}
 */
export async function secretExists(name, opts = {}) {
  const { projectId, region } = resolveScope(opts);
  return (await findSecretByName(name, { projectId, region })) !== null;
}

/**
 * SDK call: Secret.listSecrets({ projectId, region })
 * @param {{projectId?:string, region?:string}} [opts]
 * @returns {Promise<Array<{id:string, name:string, versionCount:number}>>}
 */
export async function listSecrets(opts = {}) {
  const { projectId, region } = resolveScope(opts);
  const secrets = await api("Secret", "v1beta1");
  const results = await sdkCall(() => secrets.listSecrets({ projectId, region }).all());
  return results.map((s) => ({ id: s.id, name: s.name, versionCount: s.versionCount }));
}

/**
 * Idempotent: does nothing (does not throw) if the secret is already absent.
 * SDK call: Secret.deleteSecret({ region, secretId })
 * @param {string} name
 * @param {{projectId?:string, region?:string}} [opts]
 */
export async function deleteSecret(name, opts = {}) {
  const { projectId, region } = resolveScope(opts);
  const secret = await findSecretByName(name, { projectId, region });
  if (!secret) return;
  const secrets = await api("Secret", "v1beta1");
  await sdkCall(() => secrets.deleteSecret({ region, secretId: secret.id }));
}

/* ------------------------------------------------------------------------ CLI */

// Read a whole stream (fd or path) to completion as a UTF-8 string.
function readAllSync(pathOrFd) {
  return readFileSync(pathOrFd, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "get": {
        const reveal = rest.includes("--reveal");
        const [name] = rest.filter((a) => a !== "--reveal");
        if (!name) throw new ScwError("usage: node secrets.mjs get <NAME> [--reveal]", { type: "usage" });
        console.log(`▸ resolving latest enabled version of ${name}`);
        const value = await getSecret(name);
        console.log(`✅ resolved ${name} (${value.length} chars)`);
        // Plaintext only leaves this process on an explicit --reveal: the
        // default shape prints a length so a caller can confirm a secret
        // exists and is non-empty without it ever touching a log or a
        // terminal scrollback.
        console.log(JSON.stringify(reveal ? { ok: true, name, value } : { ok: true, name, length: value.length }));
        break;
      }
      case "put": {
        const stdinFlag = rest.includes("--stdin");
        const valueFileIdx = rest.indexOf("--value-file");
        const valueFile = valueFileIdx !== -1 ? rest[valueFileIdx + 1] : undefined;
        const consumed = new Set(valueFileIdx !== -1 ? [valueFileIdx, valueFileIdx + 1] : []);
        const name = rest.find((a, i) => !consumed.has(i) && a !== "--stdin" && a !== "--value-file");
        if (!name || (!stdinFlag && !valueFile)) {
          throw new ScwError(
            "usage: node secrets.mjs put <NAME> --stdin | --value-file <path>  " +
              "(a VALUE argv positional is refused - it would sit in plaintext in the process list and shell history; " +
              'pipe the value in instead, e.g.: printf \'%s\' "$VALUE" | node secrets.mjs put <NAME> --stdin)',
            { type: "usage" },
          );
        }
        // A single trailing newline is a shell artifact (echo, heredoc), not
        // part of the secret - strip at most one so `printf` and `echo`
        // callers both land on the same stored value.
        const value = (stdinFlag ? readAllSync(0) : readAllSync(valueFile)).replace(/\r?\n$/, "");
        console.log(`▸ writing new version of ${name}`);
        const res = await putSecret(name, value);
        console.log(`✅ wrote ${name} (revision ${res.revision})`);
        console.log(JSON.stringify({ ok: true, name, ...res }));
        break;
      }
      case "exists": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node secrets.mjs exists <NAME>", { type: "usage" });
        const found = await secretExists(name);
        console.log(found ? `✅ ${name} exists` : `⚠️ ${name} not found`);
        console.log(JSON.stringify({ ok: true, name, exists: found }));
        break;
      }
      case "list": {
        console.log("▸ listing secrets");
        const res = await listSecrets();
        console.log(`✅ ${res.length} secret(s)`);
        console.log(JSON.stringify({ ok: true, secrets: res }));
        break;
      }
      case "delete": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node secrets.mjs delete <NAME>", { type: "usage" });
        console.log(`▸ deleting ${name}`);
        await deleteSecret(name);
        console.log(`✅ deleted ${name} (or already absent)`);
        console.log(JSON.stringify({ ok: true, name }));
        break;
      }
      default:
        console.log("usage: node secrets.mjs <get|put|exists|list|delete> [args]");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, type: err.type, details: err.details }));
    process.exitCode = 1;
  });
}
