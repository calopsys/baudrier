#!/usr/bin/env node
// _scw-auth.mjs - shared Scaleway credential resolution and HTTP layer.
//
// Every module under scripts/scaleway/ imports from here. It has no
// dependencies beyond node: builtins, because the plugin directory has no
// node_modules.
//
// Identity and secrets come from the environment ONLY (CONTRACT.md §2):
// SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_DEFAULT_ORGANIZATION_ID,
// SCW_DEFAULT_REGION (default "fr-par"). There is no repo-local credentials
// file and no scw config-file tier - the harness never writes a credential to
// disk.
//
// The Project id is the one field env alone may not carry, since /bootstrap
// creates one Scaleway Project per app: resolveProjectId() below covers the
// per-app map -> env -> session cache -> live-lookup-by-name order
// (CONTRACT.md §2).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadScalewayClient, loadScalewaySdk } from "./_deps.mjs";

export const REGION = "fr-par";
const API_BASE = "https://api.scaleway.com";

/** Error carrying Scaleway's structured API failure detail. */
export class ScwError extends Error {
  constructor(message, { status, type, details, apiPath } = {}) {
    super(message);
    this.name = "ScwError";
    this.status = status;
    this.type = type;
    this.details = details;
    this.apiPath = apiPath;
  }
}

/* ---------------------------------------------------------------- public API */

/** Resolve credentials without throwing. Returns partial data if incomplete. */
export function loadCredentials() {
  return {
    accessKey: process.env.SCW_ACCESS_KEY,
    secretKey: process.env.SCW_SECRET_KEY,
    projectId: process.env.SCW_DEFAULT_PROJECT_ID,
    organizationId: process.env.SCW_DEFAULT_ORGANIZATION_ID,
    region: process.env.SCW_DEFAULT_REGION || REGION,
    source: "environment",
  };
}

/** Resolve credentials or throw a message a non-technical user can act on. */
export function requireCredentials() {
  const c = loadCredentials();
  const missing = [];
  if (!c.accessKey) missing.push("SCW_ACCESS_KEY");
  if (!c.secretKey) missing.push("SCW_SECRET_KEY");
  if (missing.length) {
    throw new ScwError(
      `Scaleway credentials missing (${missing.join(", ")}). ` +
        `Run /start to configure them, or set the SCW_* environment variables.`,
      { type: "missing_credentials" },
    );
  }
  return c;
}

/**
 * The app name behind a per-app Scaleway Project (CONTRACT.md §2): the
 * basename of the git repo root, or of the current directory outside a repo.
 */
export function deriveAppName() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = !r.error && r.status === 0 ? r.stdout.trim() : "";
  return path.basename(top || process.cwd());
}

/**
 * The operator's provisioning mode for this run (CONTRACT.md §1). Read from
 * BAUDRIER_SCW_MODE; any value other than "poc" defaults to "full".
 * @returns {"full"|"poc"}
 */
export function readScwMode() {
  return process.env.BAUDRIER_SCW_MODE === "poc" ? "poc" : "full";
}

/**
 * Call the Scaleway API.
 *
 * @param {string} apiPath  path beginning with "/" (e.g. "/secret-manager/v1beta1/...")
 *                          or an absolute URL (used for Cockpit's Loki endpoint)
 * @param {object} [o]
 * @param {string} [o.method="GET"]
 * @param {object} [o.body]        JSON-serialised
 * @param {object} [o.query]       undefined/null values are dropped
 * @param {object} [o.headers]
 * @param {boolean} [o.raw=false]  resolve with the Response instead of parsed JSON
 * @param {string} [o.token]       override the auth token (Cockpit uses its own)
 * @param {number} [o.retries=3]   retried on 429 and 5xx with backoff
 */
export async function scwFetch(apiPath, o = {}) {
  const { method = "GET", body, query, headers = {}, raw = false, token, retries = 3 } = o;
  const creds = token ? loadCredentials() : requireCredentials();

  const url = new URL(apiPath.startsWith("http") ? apiPath : API_BASE + apiPath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }

  const init = {
    method,
    headers: {
      "X-Auth-Token": token || creds.secretKey,
      "Content-Type": "application/json",
      "User-Agent": "baudrier",
      ...headers,
    },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = new ScwError(`network error calling ${url.pathname}: ${e.message}`, {
        type: "network",
        apiPath: url.pathname,
      });
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new ScwError(`Scaleway API ${res.status} on ${url.pathname}`, {
        status: res.status,
        type: "retryable",
        apiPath: url.pathname,
      });
      continue;
    }

    if (raw) return res;

    if (res.status === 204) return null;

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      throw new ScwError(parsed?.message || `Scaleway API ${res.status} on ${url.pathname}`, {
        status: res.status,
        type: parsed?.type,
        details: parsed?.details || parsed,
        apiPath: url.pathname,
      });
    }
    return parsed;
  }
  throw lastErr;
}

/**
 * Collect every page of a list endpoint.
 * @param {string} apiPath
 * @param {object} o
 * @param {string} o.key       the array property in the response (e.g. "secrets")
 * @param {object} [o.query]
 * @param {number} [o.pageSize=100]
 */
export async function scwPaginate(apiPath, { key, query = {}, pageSize = 100, ...rest } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await scwFetch(apiPath, { ...rest, query: { ...query, page, page_size: pageSize } });
    const batch = res?.[key];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    const total = res.total_count ?? res.totalCount;
    if (total !== undefined && out.length >= total) break;
    if (batch.length < pageSize) break;
  }
  return out;
}

/* ------------------------------------------------------- official SDK client */

/**
 * The harness talks to Scaleway through the official SDK (@scaleway/sdk), not
 * hand-written REST calls. `scwFetch` above survives only as a deliberate
 * escape hatch for the two things the SDK does not cover:
 *   - Cockpit log queries, which go to a Loki-compatible endpoint on a different
 *     host and have no SDK method,
 *   - anything Scaleway ships an API for before the SDK catches up.
 * Object Storage is a third exception but uses @aws-sdk/client-s3 instead, since
 * it is S3-protocol only.
 */

let _client = null;

/** Memoised SDK client, built from the same credentials `loadCredentials` resolves. */
export async function getClient() {
  if (_client) return _client;
  const creds = requireCredentials();
  const { createClient } = await loadScalewayClient();
  try {
    _client = createClient({
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
      defaultProjectId: creds.projectId,
      defaultOrganizationId: creds.organizationId,
      defaultRegion: creds.region || REGION,
      defaultZone: `${creds.region || REGION}-1`,
    });
  } catch (e) {
    // The SDK validates key formats up front; surface that clearly rather than
    // letting it look like a network failure later.
    throw new ScwError(`Identifiants Scaleway invalides : ${e.message}`, { type: "invalid_credentials" });
  }
  return _client;
}

const _apis = new Map();

/**
 * Get a memoised SDK API instance.
 *
 * @param {string} product  SDK namespace, e.g. "Container", "Jobs", "Secret"
 * @param {string} version  e.g. "v1", "v1alpha2", "v1beta1"
 * @param {string} [cls]    API class name. Defaults to "API"; a few products use
 *                          a different one (Cockpit exposes GlobalAPI/RegionalAPI).
 *
 * Product/version choices that matter:
 *   - Container **v1**. v1beta1 was formally deprecated on 2026-07-09; the SDK
 *     exposes both, so there is no reason to stay on the deprecated one.
 *   - Jobs **v1alpha2** (newer than v1alpha1, also exported).
 *   - Billing **v2beta1** - v2 only has budgets; consumption lives in v2beta1.
 */
export async function api(product, version, cls = "API") {
  const key = `${product}.${version}.${cls}`;
  if (_apis.has(key)) return _apis.get(key);

  const client = await getClient();
  const sdk = await loadScalewaySdk();

  const ns = sdk[product];
  if (!ns) throw new ScwError(`Produit SDK inconnu : "${product}"`, { type: "sdk_shape" });
  const versioned = ns[version];
  if (!versioned) {
    throw new ScwError(`Version SDK inconnue : ${product}.${version} (disponibles : ${Object.keys(ns).join(", ")})`, {
      type: "sdk_shape",
    });
  }
  const Ctor = versioned[cls];
  if (typeof Ctor !== "function") {
    const ctors = Object.keys(versioned).filter((k) => /API$/.test(k));
    throw new ScwError(`Classe SDK introuvable : ${product}.${version}.${cls} (disponibles : ${ctors.join(", ")})`, {
      type: "sdk_shape",
    });
  }

  const instance = new Ctor(client);
  _apis.set(key, instance);
  return instance;
}

/**
 * Run an SDK call, translating the SDK's typed errors into our `ScwError` so
 * callers only ever handle one error type.
 *
 * The SDK does NOT retry on its own, so this also applies the same backoff
 * policy `scwFetch` used, keyed off the typed TooManyRequestsError.
 */
export async function sdkCall(fn, { retries = 3, label = "appel Scaleway" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
    try {
      return await fn();
    } catch (e) {
      const name = e?.constructor?.name || "";
      const status = e?.status ?? e?.statusCode;
      const retryable = name === "TooManyRequestsError" || (typeof status === "number" && status >= 500);
      lastErr = new ScwError(e?.message || `échec de ${label}`, {
        status,
        type: e?.type || name || undefined,
        details: e?.body ?? e?.details,
      });
      if (!retryable) throw lastErr;
    }
  }
  throw lastErr;
}

function scopeCacheFile(appName) {
  return path.join(os.tmpdir(), "baudrier", `scope-${appName}.json`);
}

/**
 * Write the session-scoped `/tmp` cache directly, for a caller that already
 * knows the Project id (e.g. `bootstrap-init.mjs` right after `createProject`)
 * and would otherwise pay for a second lookup the next time `resolveProjectId`
 * runs in this session. Best-effort: a write failure never throws, since a
 * failed cache write only costs the next call an extra lookup.
 * @param {string} appName
 * @param {string} projectId
 */
export function cacheProjectId(appName, projectId) {
  const cacheFile = scopeCacheFile(appName);
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile, JSON.stringify({ projectId }) + "\n", { mode: 0o600 });
  } catch {
    // best-effort - see doc comment above
  }
}

/**
 * Read the per-app entry for `appName` in BAUDRIER_SCW_PROJECTS_IDS, the map
 * a "Cas B" operator maintains when their key cannot list the organization's
 * Projects (README, CONTRACT.md §2). Format: "app-un:id1,app-deux:id2".
 * An entry names one app, so it wins over the global SCW_DEFAULT_PROJECT_ID.
 */
function projectIdFromEnvMap(appName) {
  const raw = process.env.BAUDRIER_SCW_PROJECTS_IDS;
  if (!raw) return undefined;
  for (const entry of raw.split(",")) {
    const sep = entry.indexOf(":");
    if (sep === -1) continue;
    const name = entry.slice(0, sep).trim();
    const id = entry.slice(sep + 1).trim();
    if (name && id && name === appName) return id;
  }
  return undefined;
}

/**
 * Resolve the Scaleway Project id for `appName` (CONTRACT.md §2), in order:
 *   1. the BAUDRIER_SCW_PROJECTS_IDS entry that matches `appName`
 *   2. SCW_DEFAULT_PROJECT_ID env
 *   3. the session cache file (one process's lookup feeds every later call in
 *      the same sandbox session, since CLAUDE_ENV_FILE does not reach a Bash
 *      tool call and cannot carry the id between processes)
 *   4. a live lookup: list the organization's Projects and match `appName`
 *      exactly, then write the cache file
 *
 * Throws a clear error naming the fixes when the lookup 403s or finds no
 * match: widen the key's IAM policy, add a BAUDRIER_SCW_PROJECTS_IDS entry,
 * or seed the session cache with the `cache-project` command below.
 * @param {{appName?: string}} [o]
 * @returns {Promise<string>}
 */
export async function resolveProjectId({ appName } = {}) {
  const name = appName || deriveAppName();

  const mapped = projectIdFromEnvMap(name);
  if (mapped) return mapped;

  const envProjectId = process.env.SCW_DEFAULT_PROJECT_ID;
  if (envProjectId) return envProjectId;

  const cacheFile = scopeCacheFile(name);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached?.projectId) return cached.projectId;
  } catch {
    // no cache yet, or unreadable - fall through to the live lookup
  }

  const creds = requireCredentials();
  const projects = await api("Account", "v3", "ProjectAPI");
  let list;
  try {
    list = await sdkCall(() => projects.listProjects({ organizationId: creds.organizationId, name }).all());
  } catch (e) {
    if (e?.status === 403) throw projectLookupError(name);
    throw e;
  }
  const hit = list.find((p) => p.name === name);
  if (!hit) throw projectLookupError(name);

  cacheProjectId(name, hit.id);
  return hit.id;
}

function projectLookupError(name) {
  return new ScwError(
    `Cannot find or list the Scaleway Project named "${name}". Three fixes are possible: ` +
      `(1) give the API key the permission to list Projects in the organization (IAM); ` +
      `(2) add "${name}:<project-id>" to BAUDRIER_SCW_PROJECTS_IDS in the cloud environment ` +
      `(Menu → Edit environment; format "app-un:id1,app-deux:id2"), then start a NEW session - ` +
      `a running session cannot reread modified env vars; ` +
      `(3) for this session only: ask the user for the Project id in the chat (it is an ` +
      `identifier, not a secret), then run ` +
      `\`node scripts/scaleway/_scw-auth.mjs cache-project <project-id>\` from the plugin root ` +
      `to seed the session cache, and still recommend fix 2 for future sessions.`,
    { type: "project_lookup_failed" },
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `fn()` returns a truthy value or the deadline passes.
 * @returns the truthy value
 */
export async function pollUntil(fn, { timeoutMs = 300_000, intervalMs = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new ScwError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`, {
    type: "timeout",
    details: last,
  });
}

// One CLI command, for the "Cas B" fallback in projectLookupError(): the user
// gives the Project id in the chat, this seeds the session cache so every
// later script call in the session resolves without an env-var edit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, projectId, appNameArg] = process.argv.slice(2);
  if (cmd !== "cache-project" || !projectId) {
    console.error("Usage: node scripts/scaleway/_scw-auth.mjs cache-project <project-id> [app-name]");
    process.exit(2);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    console.error(`Not a Scaleway Project id (a UUID is expected): ${projectId}`);
    process.exit(1);
  }
  const app = appNameArg || deriveAppName();
  cacheProjectId(app, projectId);
  let written = false;
  try {
    written = JSON.parse(fs.readFileSync(scopeCacheFile(app), "utf8"))?.projectId === projectId;
  } catch {
    // fall through - `written` stays false
  }
  if (!written) {
    console.error(`Could not write the session cache under ${path.join(os.tmpdir(), "baudrier")}.`);
    process.exit(1);
  }
  console.log(`Session cache set: Project ${projectId} for the app "${app}".`);
  console.log(
    `This lasts for the current session only. For future sessions, add "${app}:${projectId}" ` +
      `to BAUDRIER_SCW_PROJECTS_IDS in the cloud environment (Menu → Edit environment).`,
  );
}

/** Scaleway resource names: lowercase alphanumeric and dashes, max 63 chars. */
export function slugify(input, { maxLength = 63 } = {}) {
  const s = String(input)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "app").slice(0, maxLength).replace(/-$/, "");
}
