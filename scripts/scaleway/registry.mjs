#!/usr/bin/env node
// registry.mjs - Scaleway Container Registry: namespaces, images, tags.
//
// API: Container Registry v1 (stable, not beta), via the official @scaleway/sdk
// (see CONTRACT.md §3 - this module is a thin adapter, not a REST client).
//
// Container Registry has NO built-in retention policy - every image tag
// pushed by CI stays forever and keeps costing storage until something
// deletes it. pruneTags() below is that "something"; CONTRACT.md §1 says to
// call it explicitly after every successful deploy.
//
// Namespace names are unique across ALL of Scaleway, not just this Project or
// this organization (live-verified 2026-08: an unrelated org already owned an
// app's plain slug). ensureRegistryNamespace() therefore creates a namespace
// as `<slug>-<8 hex>` by default, and findRegistryNamespace() discovers it
// again later by a name-prefix match within the app's own Project - CONTRACT.md
// §2 assumes one Scaleway Project per app, so nothing needs a persisted
// linkage file for this.

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { REGION, ScwError, api, sdkCall, requireCredentials, slugify } from "./_scw-auth.mjs";

/* ----------------------------------------------------------------- helpers */

async function registryApi() {
  return api("Registry", "v1");
}

/** Is `e` a create-time "name already taken" failure, as opposed to any other error? */
function isNameConflict(e) {
  return (e?.status === 400 || e?.status === 409) && /already\s*exist/i.test(e?.message || "");
}

/* ------------------------------------------------------------------ namespaces */

/**
 * Find an existing registry namespace for `baseName` within the Project.
 *
 * Matches the bare slug or the slug plus the 8-hex-char suffix
 * `ensureRegistryNamespace` mints by default - a random suffix breaks a
 * plain find-or-create, so discovery falls back to a prefix match, which
 * also picks up a pre-existing bare-slug namespace from before this scheme.
 *
 * @param {string} baseName
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.region]
 * @returns {Promise<{id:string, name:string, endpoint:string}|null>}
 */
export async function findRegistryNamespace(baseName, opts = {}) {
  const region = opts.region || REGION;
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const slug = slugify(baseName);
  const registry = await registryApi();

  const existing = await sdkCall(() => registry.listNamespaces({ region, projectId }).all());
  const pattern = new RegExp(`^${slug}(-[0-9a-f]{8})?$`);
  const matches = existing.filter((n) => pattern.test(n.name));
  if (matches.length === 0) return null;

  // More than one match should not happen (one Project per app) - prefer the
  // exact slug over a suffixed one, else take the first.
  const hit = matches.find((n) => n.name === slug) || matches[0];
  return { id: hit.id, name: hit.name, endpoint: hit.endpoint };
}

/**
 * Resolve a Container Registry namespace by name, with three modes:
 *   - `opts.exact === true`: find-or-create exactly `slugify(name)` (no
 *     suffix). A create-time name conflict still throws `registry_name_taken`.
 *   - `opts.createIfMissing === false`: resolve only, via
 *     `findRegistryNamespace` - throws `registry_namespace_not_found` when
 *     absent instead of creating one.
 *   - default: `findRegistryNamespace(name)` first; if found, return it; else
 *     create `<slug>-<8 hex>` (global uniqueness, see file header). A
 *     create-time conflict on that suffixed name retries once with a fresh
 *     suffix before giving up as `registry_name_taken`.
 * @returns {Promise<{id:string, name:string, endpoint:string}>}
 */
export async function ensureRegistryNamespace(name, opts = {}) {
  const region = opts.region || REGION;
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const registry = await registryApi();
  const description = opts.description ?? "";
  const isPublic = opts.isPublic ?? false;

  async function create(candidateName) {
    const created = await sdkCall(() =>
      registry.createNamespace({ region, name: candidateName, projectId, description, isPublic }),
    );
    return { id: created.id, name: created.name, endpoint: created.endpoint };
  }

  if (opts.exact) {
    const slug = slugify(name);
    const existing = await sdkCall(() => registry.listNamespaces({ region, name: slug, projectId }).all());
    const hit = existing.find((n) => n.name === slug);
    if (hit) return { id: hit.id, name: hit.name, endpoint: hit.endpoint };

    try {
      return await create(slug);
    } catch (e) {
      if (!isNameConflict(e)) throw e;
      throw new ScwError(
        `Registry namespace "${slug}" is already taken on Scaleway. Registry namespace names are unique across ` +
          "ALL of Scaleway - all organizations, not just this Project (live-verified 2026-08). " +
          "Pass --registry-namespace <other-name> to force a different name.",
        { type: "registry_name_taken", details: { tried: [slug] } },
      );
    }
  }

  if (opts.createIfMissing === false) {
    const found = await findRegistryNamespace(name, { projectId, region });
    if (found) return found;
    throw new ScwError(
      `Registry namespace not found for "${name}" (slug "${slugify(name)}") in project ${projectId}.`,
      { type: "registry_namespace_not_found" },
    );
  }

  const found = await findRegistryNamespace(name, { projectId, region });
  if (found) return found;

  const slug = slugify(name);
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = `${slug}-${randomBytes(4).toString("hex")}`;
    tried.push(candidate);
    try {
      return await create(candidate);
    } catch (e) {
      if (!isNameConflict(e)) throw e;
    }
  }
  throw new ScwError(
    `Every candidate registry namespace name was already taken on Scaleway (tried: ${tried.join(", ")}). ` +
      "Registry namespace names are unique across ALL of Scaleway - all organizations, not just this Project " +
      "(live-verified 2026-08). Pass --registry-namespace <other-name> to force a specific one.",
    { type: "registry_name_taken", details: { tried } },
  );
}

/**
 * @returns {Promise<object[]>} every image in the namespace
 */
export async function listImages(namespaceId, opts = {}) {
  const region = opts.region || REGION;
  const registry = await registryApi();
  return sdkCall(() => registry.listImages({ region, namespaceId }).all());
}

/**
 * @returns {Promise<object[]>} every tag on the image, unsorted
 */
export async function listTags(imageId, opts = {}) {
  const region = opts.region || REGION;
  const registry = await registryApi();
  return sdkCall(() => registry.listTags({ region, imageId }).all());
}

/**
 * Keeps only the `keep` most-recently-created tags on `imageId` and deletes
 * the rest.
 *
 * This is the harness's only defence against Container Registry's lack of a
 * retention policy - without it, storage cost grows without bound as CI
 * pushes a new tag on every commit.
 *
 * Tag.createdAt comes back from the SDK already unmarshalled into a `Date`
 * instance (see @scaleway/sdk-registry's `unmarshalDate` helper), not an
 * ISO string, so sorting subtracts `Date`s directly rather than
 * re-parsing `created_at` strings the way the old raw-REST client did.
 *
 * @param {string} imageId
 * @param {object} o
 * @param {number} [o.keep=10] number of most recent tags (by createdAt) to retain
 * @returns {Promise<{deleted:string[]}>} the tag names that were deleted
 */
export async function pruneTags(imageId, { keep = 10, region } = {}) {
  const r = region || REGION;
  const registry = await registryApi();
  const tags = await listTags(imageId, { region: r });
  const sorted = [...tags].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const toDelete = sorted.slice(keep);

  const deleted = [];
  for (const tag of toDelete) {
    await sdkCall(() => registry.deleteTag({ region: r, tagId: tag.id }));
    deleted.push(tag.name);
  }
  return { deleted };
}

/* ------------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , cmd, ...rest] = process.argv;

  const usage = () => {
    console.log("⚠️ usage: registry.mjs <ensure-namespace|list-images|list-tags|prune-tags> <args...>");
    console.log(JSON.stringify({ ok: false, error: "unknown or missing command" }));
    process.exitCode = 1;
  };

  (async () => {
    try {
      switch (cmd) {
        case "ensure-namespace": {
          console.log(`▸ ensuring registry namespace "${rest[0]}"`);
          const result = await ensureRegistryNamespace(rest[0]);
          console.log("✅ namespace ready");
          console.log(JSON.stringify(result));
          break;
        }
        case "list-images": {
          console.log(`▸ listing images in namespace ${rest[0]}`);
          const result = await listImages(rest[0]);
          console.log(`✅ found ${result.length} image(s)`);
          console.log(JSON.stringify({ images: result }));
          break;
        }
        case "list-tags": {
          console.log(`▸ listing tags for image ${rest[0]}`);
          const result = await listTags(rest[0]);
          console.log(`✅ found ${result.length} tag(s)`);
          console.log(JSON.stringify({ tags: result }));
          break;
        }
        case "prune-tags": {
          const keep = rest[1] ? Number(rest[1]) : 10;
          console.log(`▸ pruning tags for image ${rest[0]}, keeping ${keep}`);
          const result = await pruneTags(rest[0], { keep });
          console.log(`✅ deleted ${result.deleted.length} tag(s)`);
          console.log(JSON.stringify(result));
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
