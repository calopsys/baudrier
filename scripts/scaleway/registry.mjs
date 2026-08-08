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

import { REGION, api, sdkCall, requireCredentials, slugify } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";

/* ----------------------------------------------------------------- helpers */

async function registryApi() {
  return api("Registry", "v1");
}

/* ------------------------------------------------------------------ namespaces */

/**
 * Find-or-create a Container Registry namespace by (slugified) name.
 * @returns {Promise<{id:string, name:string, endpoint:string}>}
 */
export async function ensureRegistryNamespace(name, opts = {}) {
  const region = opts.region || REGION;
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const slug = slugify(name);
  const registry = await registryApi();

  const existing = await sdkCall(() => registry.listNamespaces({ region, name: slug, projectId }).all());
  const hit = existing.find((n) => n.name === slug);
  if (hit) return { id: hit.id, name: hit.name, endpoint: hit.endpoint };

  const created = await sdkCall(() =>
    registry.createNamespace({
      region,
      name: slug,
      projectId,
      description: opts.description ?? "",
      isPublic: opts.isPublic ?? false,
    }),
  );
  return { id: created.id, name: created.name, endpoint: created.endpoint };
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
