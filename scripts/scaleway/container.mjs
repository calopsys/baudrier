#!/usr/bin/env node
// container.mjs - Scaleway Serverless Containers: namespaces, containers,
// deploys, and custom domains.
//
// API: Serverless Containers v1, via the official @scaleway/sdk (see
// CONTRACT.md §3 - this module is a thin adapter, not a REST client).
//
// This module used to target v1beta1 deliberately (its field vocabulary is
// what SCALE_PRESETS and every caller in scripts/ and skills/ was written
// against). v1beta1 is now FORMALLY deprecated (scaleway-sdk-go commit
// 87e66e9, 2026-07-09, "chore(serverless): deprecate `v1beta1` Serverless
// Containers API" - every v1beta1 method annotated `// Deprecated:`,
// integrators pointed at v1), so this module now targets v1. That move
// renames nearly every field it touches:
//   cpu_limit           -> mvcpuLimit                    (same unit: mvCPU)
//   memory_limit (MB)   -> memoryLimitBytes (bytes)       (see MB constant below -
//                                                          confirmed unit from
//                                                          @scaleway/sdk-container's
//                                                          v1 types.gen.d.ts:
//                                                          "Memory limit of the
//                                                          container in bytes.")
//   max_concurrency     -> scalingOption.concurrentRequestsThreshold
//   http_option (enum)  -> httpsConnectionsOnly (bool)    (lossy - see toSdkFields)
//   health_check        -> livenessProbe / startupProbe
//   domain_name         -> publicEndpoint                 (see bareHost() below -
//                                                          v1beta1's field was a bare
//                                                          hostname; v1's is described
//                                                          as "the default endpoint",
//                                                          which reads as a full URL,
//                                                          so this module strips a
//                                                          leading scheme rather than
//                                                          assume either shape)
//   registry_image      -> image
//   secret_environment_variables: SecretHashedValue[] ({key,hashedValue})
//                       -> a map on write. On READ, live-verified: this API
//                          version returns each value as an ARGON2 HASH, never
//                          plaintext, e.g.
//                          {"key":"ACCESS_ALLOWED_IPS","value":"$argon2id$v=19$m=65536,t=1,p=64$H1X/8Dyn..."}.
//                          Also live-verified: the read shape is an ARRAY of
//                          {key,value} pairs, not the Record<string,string>
//                          the SDK's own field doc implies - see
//                          secretEnvEntries() below, which normalizes both
//                          shapes so a future API revision that switches
//                          between them does not silently reintroduce
//                          index-keyed ("0","1",...) corruption.
//
// CONSEQUENCE FOR THE WHOLE MODULE: because a GET can never return a usable
// secret value, Secret Manager - not a container's own state - is the only
// readable source of truth for a container's secret env. A container is a
// WRITE-ONLY projection of Secret Manager. buildContainerSecretMap() and
// syncContainerSecrets() (below) are the canonical way to keep that
// projection current; see their doc comments and setContainerSecrets()'s for
// why a partial write is destructive on this API (writes REPLACE the whole
// map - omitted keys are DELETED, not preserved).
//
// CONTRACT.md §3 freezes this module's exported function names, parameters
// AND return shapes (~80 call sites depend on them, most outside this
// module's own control). So every function below translates the v1 SDK's
// camelCase/renamed/rescaled objects back into the exact snake_case shape
// (`domain_name`, `cpu_limit`, `memory_limit`, `max_concurrency`,
// `min_scale`, `max_scale`, `status`, `error_message`, ...) that
// scripts/deploy.mjs, scripts/scale.mjs, scripts/bootstrap-init.mjs,
// scripts/rotate-secret.mjs and the skills/{publish,unpublish,seo-perf,gsc,
// eco-audit} one-off `node -e` snippets already read off returned container
// objects - see toLegacyContainer() below. The modern camelCase fields are
// kept alongside (not deleted), so nothing forward-compatible breaks either.

import { REGION, ScwError, api, sdkCall, requireCredentials, slugify } from "./_scw-auth.mjs";
import { getSecret, listSecrets } from "./secrets.mjs";
import { pathToFileURL } from "node:url";

// v1's memoryLimitBytes and localStorageLimitBytes are, per the SDK's own
// field docs, literally in bytes. SCALE_PRESETS and every caller's
// memoryLimit/localStorageLimit are in MB (CONTRACT.md §1's
// DEFAULT_MEMORY_LIMIT = 512 // MB) - binary MB (1024*1024), matching how
// Scaleway's console and docs size containers ("512 MiB" is quoted as
// "512 MB" throughout Scaleway's own UI). Getting this constant wrong by a
// factor of ~1000 (bytes vs KB) or ~5% (MB vs MiB) silently creates a
// container with the wrong memory - see the unit test in this module's
// migration report.
const MB = 1024 * 1024;

/** Container status values that mean "the deploy permanently failed". */
const CONTAINER_ERROR_STATUS = "error";

/**
 * Resource presets named in CONTRACT.md §3. `S` is the default scale for
 * every app unless the caller overrides individual fields.
 *   cpuLimit       mvCPU               -> v1 mvcpuLimit, unchanged unit
 *   memoryLimit    MB                  -> v1 memoryLimitBytes = memoryLimit * MB
 *   maxConcurrency concurrent requests -> v1 scalingOption.concurrentRequestsThreshold
 *
 * These numbers themselves are UNCHANGED from before the v1 migration - only
 * the units they get translated into at the SDK boundary changed. See
 * toSdkContainerFields() for the translation.
 */
export const SCALE_PRESETS = Object.freeze({
  S: Object.freeze({ cpuLimit: 250, memoryLimit: 512, maxConcurrency: 8 }),
  M: Object.freeze({ cpuLimit: 500, memoryLimit: 1024, maxConcurrency: 20 }),
  L: Object.freeze({ cpuLimit: 1000, memoryLimit: 2048, maxConcurrency: 40 }),
  XL: Object.freeze({ cpuLimit: 2000, memoryLimit: 4096, maxConcurrency: 80 }),
});

/* ----------------------------------------------------------------- helpers */

async function containerApi() {
  return api("Container", "v1");
}

/** Strip a leading http(s):// scheme, if present - see the header comment on domain_name/publicEndpoint. */
function bareHost(endpoint) {
  if (!endpoint) return endpoint;
  return String(endpoint).replace(/^https?:\/\//, "");
}

/**
 * Translate our camelCase vocabulary (createContainer's params, and
 * updateContainer's patch) into the v1 SDK's request field names/units.
 * Unrecognised keys pass through unchanged, same philosophy as the old
 * FIELD_MAP - e.g. a caller already using a raw v1 SDK field name (like
 * `minScale`, which did not rename) still works.
 */
function toSdkContainerFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    switch (key) {
      case "registryImage":
        out.image = value;
        break;
      case "cpuLimit":
        out.mvcpuLimit = value;
        break;
      case "memoryLimit":
        out.memoryLimitBytes = Math.round(value * MB);
        break;
      case "localStorageLimit":
        out.localStorageLimitBytes = Math.round(value * MB);
        break;
      case "maxConcurrency":
        // scalingOption is a one-of (concurrentRequestsThreshold vs cpu/memory
        // usage thresholds) - this harness only ever scales on concurrency.
        out.scalingOption = { concurrentRequestsThreshold: value };
        break;
      case "httpOption":
        // v1beta1 http_option ("redirected"|"enabled") -> v1
        // httpsConnectionsOnly (bool). No caller in this repo passes
        // httpOption today (verified against every createContainer/
        // updateContainer call site) - this mapping is defensive, not
        // load-bearing. "enabled" (serve both HTTP and HTTPS) -> false;
        // anything else (the caller wants HTTPS-only) -> true.
        out.httpsConnectionsOnly = value !== "enabled";
        break;
      case "healthCheck":
        // v1beta1 health_check -> v1 livenessProbe. No caller passes
        // healthCheck today either (same verification) - defensive mapping.
        out.livenessProbe = value;
        break;
      case "scale":
      case "region":
        // Handled by the caller (preset lookup / path selection), not a
        // request field itself.
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

/**
 * Normalize a v1 container's secretEnvironmentVariables into `[key, value]`
 * pairs, regardless of whether the API returned an array of `{key,value}`
 * pairs or a plain `Record<string,string>` - both shapes have been observed
 * live on GET (see this file's header comment). Object.entries() on an array
 * of objects silently produces index keys ("0","1",...) instead of the real
 * keys, which is the exact corruption a previous revision of this module
 * shipped - always go through this function instead of Object.entries()
 * directly on this field.
 */
function secretEnvEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(({ key, value }) => [key, value]);
  return Object.entries(raw);
}

/**
 * Translate an SDK Container (camelCase, v1 field names) back into the
 * snake_case shape this module's callers already depend on. See this file's
 * header comment for the full field-rename table and why this exists.
 *
 * secretEnvironmentVariables is exposed here as an array of `{key, value}`
 * (matching skills/{seo-perf,gsc,eco-audit}'s
 * `.find(e => e.key === "ACCESS_RESTRICTED")` shape). Every `value` in that
 * array is an ARGON2 HASH, never plaintext - live-verified, see this file's
 * header comment. A caller that needs the real value must read it from
 * Secret Manager (scripts/scaleway/secrets.mjs), never from a container GET.
 */
function toLegacyContainer(c) {
  if (!c) return c;
  return {
    ...c,
    namespace_id: c.namespaceId,
    error_message: c.errorMessage,
    environment_variables: c.environmentVariables,
    secret_environment_variables: c.secretEnvironmentVariables
      ? secretEnvEntries(c.secretEnvironmentVariables).map(([key, value]) => ({ key, value }))
      : c.secretEnvironmentVariables,
    min_scale: c.minScale,
    max_scale: c.maxScale,
    memory_limit: c.memoryLimitBytes !== undefined ? Math.round(c.memoryLimitBytes / MB) : undefined,
    cpu_limit: c.mvcpuLimit,
    local_storage_limit: c.localStorageLimitBytes !== undefined ? Math.round(c.localStorageLimitBytes / MB) : undefined,
    registry_image: c.image,
    domain_name: bareHost(c.publicEndpoint),
    max_concurrency: c.scalingOption?.concurrentRequestsThreshold,
  };
}

/* ------------------------------------------------------------------- namespaces */

/**
 * Find-or-create a container namespace by (slugified) name.
 * @returns {Promise<{id:string, name:string}>}
 */
export async function ensureNamespace(name, opts = {}) {
  const region = opts.region || REGION;
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const slug = slugify(name);
  const containers = await containerApi();

  const existing = await sdkCall(() => containers.listNamespaces({ region, name: slug, projectId }).all());
  const hit = existing.find((n) => n.name === slug);
  if (hit) return { id: hit.id, name: hit.name };

  const created = await sdkCall(() =>
    containers.createNamespace({ region, name: slug, projectId, description: opts.description ?? "" }),
  );
  return { id: created.id, name: created.name };
}

/* -------------------------------------------------------------------- containers */

/**
 * @returns {Promise<object|null>} the container, or null if no container in
 *   the namespace has this exact (slugified) name.
 */
export async function findContainerByName(namespaceId, name, opts = {}) {
  const region = opts.region || REGION;
  const slug = slugify(name);
  const containers = await containerApi();
  const list = await sdkCall(() => containers.listContainers({ region, namespaceId, name: slug }).all());
  const hit = list.find((c) => c.name === slug) || null;
  return toLegacyContainer(hit);
}

/**
 * Defaults per CONTRACT.md §1: port 8080, min_scale 0, max_scale 5,
 * scale preset "S" (250mvCPU/512MB/8 concurrent). privacy defaults to
 * "public" at the platform level - IP restriction is enforced in the app's
 * own Next.js middleware (a soft boundary), not by Scaleway.
 *
 * Creating a container with a `registryImage` deploys it immediately; no
 * separate deployContainer() call is required right after create(). Use
 * deployContainer() later to force a fresh deploy of the *current* config
 * (e.g. a new image landed under the same tag).
 *
 * @param {object} spec
 * @param {string} spec.namespaceId
 * @param {string} spec.name
 * @param {string} spec.registryImage
 * @param {"S"|"M"|"L"|"XL"} [spec.scale="S"]
 * @returns {Promise<object>} the created container
 */
export async function createContainer({
  namespaceId,
  name,
  registryImage,
  scale = "S",
  cpuLimit,
  memoryLimit,
  maxConcurrency,
  minScale = 0,
  maxScale = 5,
  port = 8080,
  privacy = "public",
  protocol,
  sandbox,
  httpOption,
  environmentVariables,
  secretEnvironmentVariables,
  healthCheck,
  description,
  region,
} = {}) {
  if (!namespaceId || !name || !registryImage) {
    throw new ScwError("createContainer requires namespaceId, name and registryImage", { type: "invalid_args" });
  }
  const preset = SCALE_PRESETS[scale] || SCALE_PRESETS.S;
  const r = region || REGION;
  const containers = await containerApi();

  const fields = toSdkContainerFields({
    registryImage,
    cpuLimit: cpuLimit ?? preset.cpuLimit,
    memoryLimit: memoryLimit ?? preset.memoryLimit,
    maxConcurrency: maxConcurrency ?? preset.maxConcurrency,
    minScale,
    maxScale,
    port,
    privacy,
    protocol,
    sandbox,
    httpOption,
    environmentVariables,
    secretEnvironmentVariables,
    healthCheck,
    description,
  });

  const created = await sdkCall(() =>
    containers.createContainer({ region: r, namespaceId, name: slugify(name), ...fields }),
  );
  return toLegacyContainer(created);
}

/**
 * Any field present in `patch` triggers a new deploy automatically -
 * Scaleway's own docs note that a follow-up deploy call "becomes
 * superfluous" once you've updated. `patch` accepts the same camelCase keys
 * as createContainer(); unrecognised keys pass through unchanged so raw SDK
 * field names work too.
 *
 * `secretEnvironmentVariables`, if present, goes through the same path as
 * setContainerSecrets() (see that function's and mergedSecrets()'s doc
 * comments): a write REPLACES the whole map, so an unknown key is always
 * DELETED, and a GET can never supply a real value to preserve (it returns
 * an argon2 hash). Passing `secretEnvironmentVariables` here therefore means
 * "this is the complete desired map, minus whatever hash-only leftovers get
 * dropped" - prefer syncContainerSecrets() for the container's app-facing
 * secrets, which builds that complete map from Secret Manager for you.
 *
 * @returns {Promise<object>} the updated container
 */
export async function updateContainer(containerId, patch = {}, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  const { secretEnvironmentVariables, ...rest } = patch;

  const fields = toSdkContainerFields(rest);
  if (secretEnvironmentVariables !== undefined) {
    fields.secretEnvironmentVariables = await mergedSecrets(containers, containerId, region, secretEnvironmentVariables);
  }

  const updated = await sdkCall(() => containers.updateContainer({ containerId, region, ...fields }));
  return toLegacyContainer(updated);
}

/**
 * Forces a redeploy of the container's *current* stored config without
 * changing it. Distinct from updateContainer(), which changes config and
 * deploys as a side effect.
 *
 * Maps to the SDK's `redeployContainer` - `deployContainer` does not exist
 * as a v1 method name (confirmed by enumerating
 * `Object.keys(containers).filter(k => typeof containers[k] === "function")`
 * - see this module's migration report).
 *
 * @returns {Promise<object>} the container
 */
export async function deployContainer(containerId, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  const redeployed = await sdkCall(() => containers.redeployContainer({ containerId, region }));
  return toLegacyContainer(redeployed);
}

/**
 */
export async function getContainer(containerId, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  const c = await sdkCall(() => containers.getContainer({ containerId, region }));
  return toLegacyContainer(c);
}

/**
 * Waits for the container to reach a final state, using the SDK's built-in
 * `waitForContainer` waiter instead of a hand-rolled poll loop. The waiter
 * stops as soon as `status` leaves the SDK's own CONTAINER_TRANSIENT_STATUSES
 * list (updating/deleting/locking/creating/upgrading) - "ready" and "error"
 * both count as final, so this never keeps polling a deploy that has
 * permanently failed, and never has to hard-code the full status enum the
 * way the old pollUntil-based version had to document ("ready" and "error"
 * are the only two values this function's own logic depends on).
 *
 * `timeoutMs` (this function's frozen parameter) is converted to the SDK's
 * `timeout`, which is in SECONDS, not ms - confirmed against
 * @scaleway/sdk-client's WaitForOptions type doc ("Timeout in seconds.").
 *
 * @returns {Promise<object>} the ready container
 */
export async function waitForContainerReady(containerId, { timeoutMs = 300_000, ...opts } = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));

  const c = await sdkCall(() => containers.waitForContainer({ containerId, region }, { timeout: timeoutSeconds }), {
    label: `container ${containerId} ready`,
  });

  if (c.status === CONTAINER_ERROR_STATUS) {
    throw new ScwError(`container ${containerId} failed to deploy: ${c.errorMessage || "unknown error"}`, {
      type: "container_error",
      details: c,
    });
  }
  return toLegacyContainer(c);
}

/**
 * Build the map this call will PATCH: read the container's current
 * secretEnvironmentVariables, DROP every entry whose value is an argon2 hash
 * (today that is every entry - see this file's header comment; the drop is a
 * safety net that guarantees a hash can never be written back as if it were
 * a real value), then apply `obj` on top (a key with value `null`/
 * `undefined` deletes that key).
 *
 * This is NOT a merge with the container's real state - a GET cannot supply
 * a real value to merge in, only a hash. The name is kept for continuity
 * with this module's history; see setContainerSecrets()'s doc comment for
 * the consequence this has for every caller.
 *
 * Exported only so this normalization can be unit-tested against a stub SDK
 * object without live credentials; not part of the frozen CONTRACT.md §3
 * surface.
 */
export async function mergedSecrets(containers, containerId, region, obj) {
  const current = await sdkCall(() => containers.getContainer({ containerId, region }));
  const merged = {};
  for (const [key, value] of secretEnvEntries(current.secretEnvironmentVariables)) {
    if (typeof value === "string" && value.startsWith("$argon2")) continue;
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) delete merged[key];
    else merged[key] = String(value);
  }
  return merged;
}

/**
 * *** WHY A CALLER MUST PASS THE COMPLETE DESIRED MAP ***
 *
 * Under v1beta1, `secret_environment_variables` was an array of `{key,
 * value}` and the API's own UpdateContainerRequest field doc explicitly
 * guaranteed a per-key MERGE: "secret environment variables that are not
 * specified in this field will be kept unchanged" (quoted from the
 * v1beta1 OpenAPI schema).
 *
 * Under v1, that guarantee is GONE, on both sides of the round trip -
 * live-verified, not merely undocumented:
 *   - WRITE replaces the whole map. Omitted keys are DELETED. Live damage
 *     from exactly this: a 3-key write silently deleted DATABASE_URL,
 *     because DATABASE_URL was not one of the 3 keys.
 *   - READ never returns a usable value to merge with in the first place -
 *     every value comes back as an argon2 hash (this file's header comment).
 *     A previous revision of this module treated the GET response as if it
 *     were plaintext and wrote it straight back on the next update; that
 *     turned ACCESS_ALLOWED_IPS into its own hash and locked every operator
 *     out with a 403.
 *
 * So this function's job changed: it no longer performs a real merge (there
 * is nothing plaintext left to merge with) - it drops every hash it reads
 * back (mergedSecrets()'s safety net) and PATCHes exactly `obj` plus
 * whatever, if anything, survived the drop. In practice that means: THE
 * CALLER MUST SUPPLY THE COMPLETE DESIRED MAP. Anything `obj` omits is
 * deleted from the container. Prefer syncContainerSecrets() below, which
 * builds that complete map from Secret Manager - the only remaining
 * readable source of truth for a container's secrets - instead of calling
 * this function with a partial map.
 *
 * @param {string} containerId
 * @param {Record<string, string|null|undefined>} obj the COMPLETE desired
 *   secret map; any key not present here is deleted from the container
 * @returns {Promise<object>} the updated container
 */
export async function setContainerSecrets(containerId, obj = {}, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  const merged = await mergedSecrets(containers, containerId, region, obj);
  const updated = await sdkCall(() =>
    containers.updateContainer({ containerId, region, secretEnvironmentVariables: merged }),
  );
  return toLegacyContainer(updated);
}

/**
 * Secret Manager entries that must NEVER be projected into a container's
 * secret_environment_variables:
 *   - `BAUDRIER_*`  harness-internal (BAUDRIER_DB_KEY, BAUDRIER_DEV_FINGERPRINTS)
 *   - `DATABASE_URL_PREVIEW_*`  per-branch; buildContainerSecretMap() maps
 *     the right one onto the container's own `DATABASE_URL` key explicitly,
 *     it must never also appear under its own Secret Manager name
 *   - `MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`  operator-side
 *     externals, read by the harness's own scripts, never shipped to the app
 */
export const CONTAINER_EXCLUDED_SECRETS = Object.freeze([
  /^BAUDRIER_/,
  /^DATABASE_URL_PREVIEW_/,
  "MATOMO_TOKEN",
  "PAGESPEED_API_KEY",
  "GSC_SERVICE_ACCOUNT",
]);

function isContainerExcludedSecret(name) {
  return CONTAINER_EXCLUDED_SECRETS.some((rule) => (typeof rule === "string" ? rule === name : rule.test(name)));
}

/**
 * Build the complete secret map a container should have, sourced entirely
 * from Secret Manager - the only readable source of truth (a container GET
 * returns argon2 hashes, never plaintext; see this file's header comment).
 *
 * Every Secret Manager entry in the project is included except
 * CONTAINER_EXCLUDED_SECRETS. `databaseUrlFrom` names the Secret Manager
 * entry to read INTO the map's `DATABASE_URL` key - "DATABASE_URL" itself
 * for production, or a preview branch's `DATABASE_URL_PREVIEW_<SLUG>` entry
 * (CONTRACT.md §2) for a preview container. `overrides` is applied last and
 * is for container-only values deliberately NOT persisted to Secret Manager
 * (e.g. a preview container's APP_URL or its ACCESS_RESTRICTED); an
 * override value of `null`/`undefined` removes that key from the result.
 * When the map has no `AUTH_URL`, this function derives one from the map's
 * own `APP_URL` (see the derivation below).
 *
 * @param {object} [opts]
 * @param {Record<string,string|null|undefined>} [opts.overrides]
 * @param {string} [opts.databaseUrlFrom="DATABASE_URL"]
 * @param {string} [opts.projectId]
 * @returns {Promise<Record<string,string>>}
 */
export async function buildContainerSecretMap({ overrides = {}, databaseUrlFrom = "DATABASE_URL", projectId } = {}) {
  const scope = projectId ? { projectId } : {};
  const all = await listSecrets(scope);
  const map = {};
  for (const { name } of all) {
    if (name === "DATABASE_URL") continue; // set explicitly below, from databaseUrlFrom
    if (isContainerExcludedSecret(name)) continue;
    map[name] = await getSecret(name, scope);
  }
  map.DATABASE_URL = await getSecret(databaseUrlFrom, scope);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete map[key];
    else map[key] = String(value);
  }

  // Auth.js derives its origin from the incoming request, but the container
  // sees 0.0.0.0:8080, never the public host. Derive AUTH_URL here from the
  // container's effective APP_URL - the Secret Manager value for production,
  // or the caller's override for a preview. An explicit AUTH_URL (Secret
  // Manager entry or override) wins; this only fills the gap. See
  // CONTRACT.md §2.
  if (!("AUTH_URL" in map) && map.APP_URL) map.AUTH_URL = map.APP_URL;

  return map;
}

/**
 * Canonical entry point for keeping a container's secrets in sync with
 * Secret Manager. Nothing outside this module should call
 * setContainerSecrets() directly for a container's app-facing secrets -
 * this is the only path that can, because it is the only one that builds
 * the COMPLETE map setContainerSecrets() requires (see that function's doc
 * comment for why a partial map is destructive on this API).
 *
 * Sequence (CONTRACT.md §1's wait-write-wait rhythm, applied to the secrets
 * write specifically - a separate wait-write-wait already has to happen
 * around any image/config write the caller does beforehand):
 *   buildContainerSecretMap -> waitForContainerReady -> setContainerSecrets
 *   (full map) -> waitForContainerReady
 *
 * @param {string} containerId
 * @param {object} [opts]
 * @param {Record<string,string|null|undefined>} [opts.overrides]
 * @param {string} [opts.databaseUrlFrom="DATABASE_URL"]
 * @param {string} [opts.projectId]
 * @param {number} [opts.timeoutMs=300000]
 * @returns {Promise<object>} the ready container, after the secrets write
 */
export async function syncContainerSecrets(
  containerId,
  { overrides, databaseUrlFrom, projectId, timeoutMs = 300_000 } = {},
) {
  const map = await buildContainerSecretMap({ overrides, databaseUrlFrom, projectId });
  await waitForContainerReady(containerId, { timeoutMs });
  await setContainerSecrets(containerId, map);
  return waitForContainerReady(containerId, { timeoutMs });
}

/**
 * CALLER MUST verify DNS propagation (the hostname's CNAME/A record already
 * resolving to the container) BEFORE calling this - see
 * dns.mjs#waitForPropagation(). TLS issuance uses an HTTP-01 challenge with
 * a hard 3-minute window; if the record has not propagated by then the
 * domain lands in a terminal "error" state with no retry mechanism - it has
 * to be deleted (deleteCustomDomain) and recreated from scratch.
 *
 * @returns {Promise<object>} the created domain
 */
export async function addCustomDomain(containerId, hostname, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  return sdkCall(() => containers.createDomain({ region, containerId, hostname }));
}

/**
 * @returns {Promise<object[]>}
 */
export async function listCustomDomains(containerId, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  return sdkCall(() => containers.listDomains({ region, containerId }).all());
}

/**
 */
export async function deleteCustomDomain(domainId, opts = {}) {
  const region = opts.region || REGION;
  const containers = await containerApi();
  return sdkCall(() => containers.deleteDomain({ region, domainId }));
}

/* ------------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , cmd, ...rest] = process.argv;

  const usage = () => {
    console.log("⚠️ usage: container.mjs <ensure-namespace|find|get|wait-ready|list-domains> <args...>");
    console.log(JSON.stringify({ ok: false, error: "unknown or missing command" }));
    process.exitCode = 1;
  };

  (async () => {
    try {
      switch (cmd) {
        case "ensure-namespace": {
          console.log(`▸ ensuring namespace "${rest[0]}"`);
          const result = await ensureNamespace(rest[0]);
          console.log("✅ namespace ready");
          console.log(JSON.stringify(result));
          break;
        }
        case "find": {
          console.log(`▸ looking up container "${rest[1]}" in namespace ${rest[0]}`);
          const result = await findContainerByName(rest[0], rest[1]);
          console.log(result ? "✅ found" : "⚠️ not found");
          console.log(JSON.stringify(result));
          break;
        }
        case "get": {
          console.log(`▸ fetching container ${rest[0]}`);
          const result = await getContainer(rest[0]);
          console.log("✅ fetched");
          console.log(JSON.stringify(result));
          break;
        }
        case "wait-ready": {
          console.log(`▸ waiting for container ${rest[0]} to become ready`);
          const result = await waitForContainerReady(rest[0], { timeoutMs: 60_000 });
          console.log("✅ ready");
          console.log(JSON.stringify(result));
          break;
        }
        case "list-domains": {
          console.log(`▸ listing domains for container ${rest[0]}`);
          const result = await listCustomDomains(rest[0]);
          console.log("✅ listed");
          console.log(JSON.stringify({ domains: result }));
          break;
        }
        default:
          usage();
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      console.log(JSON.stringify({ ok: false, error: e.message, type: e.type, details: e.details }));
      process.exitCode = 1;
    }
  })();
}
