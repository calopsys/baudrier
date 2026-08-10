#!/usr/bin/env node
// object-storage.mjs - Scaleway Object Storage (S3-compatible), region fr-par only.
//
// Object Storage has NO native Scaleway REST API the way every other product in
// this directory does - there is no bearer-token "/object-storage/v1/..." family
// to call via scwFetch(). Bucket and object operations go exclusively through the
// S3-compatible API. Per CONTRACT.md §3's "three documented exceptions" for raw
// scwFetch, this is the second one: Object Storage uses the official
// **@aws-sdk/client-s3**, loaded via `loadS3()` in ./_deps.mjs (never a bare
// `import "@aws-sdk/client-s3"` - see that file's header for why: the plugin
// directory has no node_modules, so dependencies are resolved from
// ${CLAUDE_PLUGIN_DATA} at runtime). This module used to hand-roll its own AWS
// Signature V4 signer; that is gone now that the SDK handles signing.
//
// Two Scaleway-specific quirks baked in here (see CONTRACT.md and the add-storage
// SKILL.md for the user-facing explanation):
//   - Bucket names containing a dot break the `*.s3.<region>.scw.cloud` wildcard
//     TLS certificate (it is not recursive over an extra subdomain level), so
//     EVERY client built here uses `forcePathStyle: true` (Host: s3.<region>.scw.cloud,
//     bucket in the path) instead of virtual-hosted style. Confirmed in Scaleway's
//     Object Storage FAQ. Bucket names created by ensureBucket() are also
//     slugified to dashes-only, so this never bites in practice, but path-style
//     is used unconditionally anyway for uniformity.
//   - Bucket event notifications (PutBucketNotification / GetBucketNotification)
//     are listed "in development" (i.e. NOT shipped) in Scaleway's own supported
//     Object Storage API calls table. This module does not implement them, and
//     nothing calling it should offer an upload-triggered event feature.
//
// Credentials: the same IAM access-key/secret-key pair used for the Scaleway REST
// API elsewhere in this directory is also valid as an S3 access key / secret key -
// unlike sdb.mjs, Object Storage does NOT use an IAM Application id as a separate
// "username". Pass the accessKey/secretKey returned by iam.mjs's createApiKey().
//
// Confirmed-supported S3 operations relied on by this module and by the generated
// app's @aws-sdk/client-s3 usage (from Scaleway's "Supported Object Storage API
// calls" reference, https://www.scaleway.com/en/docs/object-storage/api-cli/using-api-call-list/):
// CreateBucket, DeleteBucket, HeadBucket, PutBucketPolicy, PutBucketVersioning,
// GetBucketVersioning, PutBucketLifecycleConfiguration, GetBucketLifecycleConfiguration,
// ListObjectVersions, PutObject, GetObject, DeleteObject, DeleteObjects, HeadObject,
// CopyObject, and the full multipart-upload set (CreateMultipartUpload/UploadPart/
// CompleteMultipartUpload/AbortMultipartUpload) - all "supported", not "in
// development" or absent from that table.
//
// Versioning + lifecycle (backup story for this harness - see CONTRACT.md's
// hard user requirement and _destructive-guard.mjs's header for why this
// matters): every bucket ensureBucket() creates gets versioning turned
// Enabled and a lifecycle rule expiring noncurrent versions, because the
// version history is this harness's only backup of an app's uploaded files.
//
// IMPORTANT, verified against Scaleway's own lifecycle XML reference
// (https://www.scaleway.com/en/docs/object-storage/api-cli/lifecycle-rules-api/,
// "Available XML tokens" section): Scaleway's NoncurrentVersionExpiration only
// documents a NoncurrentDays child element. The S3 field this harness was
// asked to use - NewerNoncurrentVersions, which means "keep exactly the N
// most recent noncurrent versions" - does NOT appear anywhere in that XML
// token list (Rule, Filter, And, Prefix, Tag, Status, Transition, Day,
// StorageClass, Expiration, ID, ExpiredObjectDeleteMarker,
// NoncurrentVersionExpiration, NoncurrentVersionTransitions, NoncurrentDays -
// that's the exhaustive list Scaleway documents). Scaleway implements a
// documented subset of the S3 API and NewerNoncurrentVersions is not part of
// it, so a rule using that field would either be rejected or silently
// ignored - neither is acceptable for the harness's only backup mechanism.
// The @aws-sdk/client-s3 types happily let you set NewerNoncurrentVersions
// (it's generic S3 typing) - this module deliberately never sets it. The
// closest correct alternative implemented below (ensureBucketLifecycle) is
// therefore TIME-based, not COUNT-based: noncurrent versions expire after a
// fixed number of days (DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS), not
// after they fall outside "the 10 most recent". This is an honest
// approximation, not an exact match for a literal "keep 10 versions" rule -
// see skills/add-storage's documentation of this same limitation for the
// generated app's owner.

import { loadS3 } from "./_deps.mjs";
import { REGION, ScwError, slugify } from "./_scw-auth.mjs";
import { assertDestructiveAllowed } from "./_destructive-guard.mjs";
import { pathToFileURL } from "node:url";

/** @returns {string} https://s3.<region>.scw.cloud */
export function endpointFor(region = REGION) {
  return `https://s3.${region || REGION}.scw.cloud`;
}

// Time-based approximation of ">10 versions" - see the module header for why
// Scaleway cannot do count-based noncurrent-version expiration. 90 days is a
// deliberately generous default: this harness would rather bound storage
// cost loosely than risk expiring a version a user still needed (CONTRACT.md
// direct user requirement: never lose the app's only backup of its files).
export const DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;
const LIFECYCLE_RULE_ID = "baudrier-expire-noncurrent-versions";

/* --------------------------------------------------------------- S3 client */

// Cached per (region, accessKey) - cheap to build, but no reason to rebuild a
// client on every call. `loadS3()` itself is memoised in _deps.mjs, so this
// just avoids repeating the `new S3Client(...)` constructor cost.
const clientCache = new Map();

async function s3Module() {
  return loadS3();
}

async function s3Client({ accessKey, secretKey, region = REGION } = {}) {
  if (!accessKey || !secretKey) {
    throw new ScwError("object-storage: accessKey/secretKey required", { type: "invalid_argument" });
  }
  const r = region || REGION;
  const key = `${r}::${accessKey}`;
  if (clientCache.has(key)) return clientCache.get(key);

  const { S3Client } = await s3Module();
  const client = new S3Client({
    endpoint: endpointFor(r),
    region: r,
    // Bucket names containing a dot break the non-recursive
    // `*.s3.<region>.scw.cloud` wildcard certificate - see module header.
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  clientCache.set(key, client);
  return client;
}

/** Normalize an SDK-thrown error into this module's ScwError shape. */
function s3Error(op, slug, e) {
  const status = e?.$metadata?.httpStatusCode;
  return new ScwError(`${op} ${slug} -> ${status ?? e?.name ?? "error"}: ${e?.message || e}`, {
    status,
    type: `${op.toLowerCase().replace(/\s+/g, "_")}_failed`,
    details: e?.message,
  });
}

/**
 * Checks bucket existence via HeadBucket.
 * @returns {Promise<boolean>}
 */
export async function bucketExists(name, { accessKey, secretKey, region = REGION } = {}) {
  const slug = slugify(name);
  const { HeadBucketCommand } = await s3Module();
  const client = await s3Client({ accessKey, secretKey, region });
  try {
    await client.send(new HeadBucketCommand({ Bucket: slug }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false;
    throw s3Error("HeadBucket", slug, e);
  }
}

/**
 * Read a bucket's versioning status via GetBucketVersioning.
 * @returns {Promise<"Enabled"|"Suspended"|null>} null means "never enabled"
 *          (Scaleway/S3 has no explicit "Unversioned" status value - an
 *          absent Status field is how that state is represented on the wire).
 */
export async function getBucketVersioningStatus(name, { accessKey, secretKey, region = REGION } = {}) {
  const slug = slugify(name);
  const { GetBucketVersioningCommand } = await s3Module();
  const client = await s3Client({ accessKey, secretKey, region });
  try {
    const res = await client.send(new GetBucketVersioningCommand({ Bucket: slug }));
    return res.Status ?? null;
  } catch (e) {
    throw s3Error("GetBucketVersioning", slug, e);
  }
}

/**
 * Guarantee bucket versioning is Enabled (idempotent - a bucket already
 * Enabled is left alone). This is the harness's only backup mechanism for an
 * app's uploaded files (see CONTRACT.md, _destructive-guard.mjs header), so
 * this throws a hard ScwError - never just a warning - if versioning cannot
 * be confirmed Enabled afterwards.
 * @returns {Promise<{name:string, versioning:"Enabled"}>}
 */
export async function ensureBucketVersioning(name, { accessKey, secretKey, region = REGION } = {}) {
  const slug = slugify(name);
  const current = await getBucketVersioningStatus(slug, { accessKey, secretKey, region });

  if (current !== "Enabled") {
    const { PutBucketVersioningCommand } = await s3Module();
    const client = await s3Client({ accessKey, secretKey, region });
    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: slug,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
    } catch (e) {
      throw s3Error("PutBucketVersioning", slug, e);
    }
  }

  // Hard verification, not an assumption: re-read the status rather than
  // trusting the PUT's success. Versioning is the only backup this harness
  // has - "probably worked" is not good enough here.
  const confirmed = await getBucketVersioningStatus(slug, { accessKey, secretKey, region });
  if (confirmed !== "Enabled") {
    throw new ScwError(
      `Impossible de confirmer le versioning sur le bucket "${slug}" (statut lu: ${confirmed || "jamais activé"}). ` +
        `Le versioning est l'unique sauvegarde des fichiers de cette app : ensureBucket refuse de continuer sans lui.`,
      { type: "versioning_not_confirmed", details: { bucket: slug, status: confirmed } },
    );
  }
  return { name: slug, versioning: "Enabled" };
}

/**
 * Guarantee a lifecycle rule exists expiring noncurrent object versions
 * after `noncurrentVersionExpirationDays` days (time-based - see the module
 * header for why this is the closest available alternative to "keep only
 * the 10 most recent versions", which Scaleway's NoncurrentVersionExpiration
 * does not support). Idempotent: replaces any prior
 * baudrier-expire-noncurrent-versions rule with the same content, S3-style
 * (PutBucketLifecycleConfiguration always replaces the whole configuration).
 * @returns {Promise<{name:string, noncurrentVersionExpirationDays:number}>}
 */
export async function ensureBucketLifecycle(
  name,
  { accessKey, secretKey, region = REGION, noncurrentVersionExpirationDays = DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS } = {},
) {
  const slug = slugify(name);
  if (!Number.isInteger(noncurrentVersionExpirationDays) || noncurrentVersionExpirationDays < 1) {
    throw new ScwError(
      `noncurrentVersionExpirationDays doit être un entier >= 1 (reçu: ${noncurrentVersionExpirationDays})`,
      { type: "invalid_argument" },
    );
  }

  const { PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand } = await s3Module();
  const client = await s3Client({ accessKey, secretKey, region });

  // Deliberately NoncurrentDays only - see module header for why
  // NewerNoncurrentVersions (count-based) is never set here, even though the
  // SDK's types would let us.
  const rule = {
    ID: LIFECYCLE_RULE_ID,
    Filter: { Prefix: "" },
    Status: "Enabled",
    NoncurrentVersionExpiration: { NoncurrentDays: noncurrentVersionExpirationDays },
  };

  try {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: slug,
        LifecycleConfiguration: { Rules: [rule] },
      }),
    );
  } catch (e) {
    throw s3Error("PutBucketLifecycleConfiguration", slug, e);
  }

  // Hard verification, same reasoning as ensureBucketVersioning: read the
  // rule back rather than trusting the PUT's success.
  let confirmedRules;
  try {
    const res = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: slug }));
    confirmedRules = res.Rules || [];
  } catch (e) {
    throw s3Error("GetBucketLifecycleConfiguration", slug, e);
  }
  const found = confirmedRules.find((r) => r.ID === LIFECYCLE_RULE_ID);
  if (!found || !found.NoncurrentVersionExpiration) {
    throw new ScwError(
      `La règle de cycle de vie "${LIFECYCLE_RULE_ID}" n'a pas été confirmée sur le bucket "${slug}" après sa création.`,
      { type: "lifecycle_not_confirmed", details: { bucket: slug } },
    );
  }
  return { name: slug, noncurrentVersionExpirationDays };
}

/**
 * Find-or-create a bucket by name (idempotent), then guarantee versioning is
 * Enabled and a noncurrent-version-expiration lifecycle rule is in place.
 * Does not set any policy - call setPublicReadPolicy() separately for public
 * buckets.
 *
 * Success here means both versioning AND the lifecycle rule are confirmed in
 * place, not merely "the bucket exists" - see ensureBucketVersioning's and
 * ensureBucketLifecycle's own hard-failure behavior. This function does not
 * catch or downgrade their errors: if versioning cannot be enabled, that
 * propagates as a thrown ScwError, because it is this harness's only backup
 * mechanism (CONTRACT.md direct user requirement) and a bucket without it
 * must never be reported as a success.
 *
 * @returns {Promise<{name:string, region:string, endpoint:string, created:boolean, versioning:"Enabled", noncurrentVersionExpirationDays:number}>}
 */
export async function ensureBucket(name, { accessKey, secretKey, region = REGION, noncurrentVersionExpirationDays } = {}) {
  const slug = slugify(name);
  const exists = await bucketExists(slug, { accessKey, secretKey, region });

  if (!exists) {
    const { CreateBucketCommand } = await s3Module();
    const client = await s3Client({ accessKey, secretKey, region });
    try {
      await client.send(new CreateBucketCommand({ Bucket: slug }));
    } catch (e) {
      throw s3Error("CreateBucket", slug, e);
    }
  }

  const versioning = await ensureBucketVersioning(slug, { accessKey, secretKey, region });
  const lifecycle = await ensureBucketLifecycle(slug, { accessKey, secretKey, region, noncurrentVersionExpirationDays });

  return {
    name: slug,
    region,
    endpoint: endpointFor(region),
    created: !exists,
    versioning: versioning.versioning,
    noncurrentVersionExpirationDays: lifecycle.noncurrentVersionExpirationDays,
  };
}

/**
 * Bucket policy JSON granting anonymous `s3:GetObject` on every object in the
 * bucket. Matches Scaleway's documented bucket-policy schema exactly (their
 * `Principal` syntax and `2023-04-17` version differ from raw AWS ARNs - no
 * `arn:aws:s3:::` prefix, the bucket name is used as-is in `Resource`).
 */
export function buildPublicReadPolicy(bucketName) {
  return JSON.stringify({
    Version: "2023-04-17",
    Id: "public-read",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `${bucketName}/*`,
      },
    ],
  });
}

/**
 * Apply a bucket policy (PutBucketPolicy). Pass `buildPublicReadPolicy(bucket)`
 * to make a bucket's objects publicly readable, or any other Scaleway-flavored
 * bucket-policy JSON.
 */
export async function setBucketPolicy(name, policyJson, { accessKey, secretKey, region = REGION } = {}) {
  const slug = slugify(name);
  const { PutBucketPolicyCommand } = await s3Module();
  const client = await s3Client({ accessKey, secretKey, region });
  try {
    await client.send(new PutBucketPolicyCommand({ Bucket: slug, Policy: policyJson }));
  } catch (e) {
    throw s3Error("PutBucketPolicy", slug, e);
  }
}

/**
 * Deletes a bucket. Scaleway (like S3) refuses to delete a non-empty bucket -
 * that failure surfaces as a normal ScwError with the API's own message.
 * Idempotent: a 404 (already gone) is not an error.
 *
 * GUARDED - refuses by default. See _destructive-guard.mjs: once versioning
 * is enabled (which ensureBucket() guarantees), this bucket's version
 * history is the app's only backup of its uploaded files. This harness never
 * deletes a bucket on its own; a human must set
 * BAUDRIER_ALLOW_DESTRUCTIVE="bucket:<name>" in their own shell first.
 *
 * assertDestructiveAllowed() runs before any S3 call is made, by design -
 * see CONTRACT.md and this function's own guard test in the module's README.
 */
export async function deleteBucket(name, { accessKey, secretKey, region = REGION } = {}) {
  const slug = slugify(name);
  assertDestructiveAllowed("bucket", slug);
  const { DeleteBucketCommand } = await s3Module();
  const client = await s3Client({ accessKey, secretKey, region });
  try {
    await client.send(new DeleteBucketCommand({ Bucket: slug }));
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return; // idempotent - already gone
    throw s3Error("DeleteBucket", slug, e);
  }
}

/* ------------------------------------------------------------------------ CLI */

// The S3 protocol carries no Project field (module header): the client above
// is built from a key, a secret and a region only, so the Project a bucket
// command targets is decided entirely by which key it signs with. Falling
// back to the operator's own SCW_* key here would silently create or inspect
// a bucket in the operator's own default Project instead of this app's - and
// bucketExists() would then check that same wrong Project, so the mistake
// would never surface as an error. The CLI therefore refuses outright instead
// of guessing.
function requireStorageCredentials() {
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new ScwError(
      "Les commandes de bucket ont besoin de la paire de clés de stockage propre à cette " +
        "application, STORAGE_ACCESS_KEY et STORAGE_SECRET_KEY : le protocole S3 n’a pas de champ " +
        "Projet, c’est la clé qui détermine le Projet visé. Utiliser la clé de l’opérateur créerait " +
        "ou inspecterait un bucket dans le mauvais Projet. Définissez STORAGE_ACCESS_KEY et " +
        "STORAGE_SECRET_KEY avant de relancer cette commande.",
      { type: "missing_storage_credentials" },
    );
  }
  return { accessKey, secretKey };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "ensure": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node object-storage.mjs ensure <NAME>", { type: "usage" });
        const { accessKey, secretKey } = requireStorageCredentials();
        console.log(`▸ ensuring bucket "${name}"`);
        const bucket = await ensureBucket(name, { accessKey, secretKey });
        console.log(`✅ bucket ${bucket.name} (${bucket.created ? "created" : "already existed"})`);
        console.log(
          `✅ versioning ${bucket.versioning} · noncurrent versions expire after ${bucket.noncurrentVersionExpirationDays} days`,
        );
        console.log(JSON.stringify({ ok: true, bucket }));
        break;
      }
      case "set-public": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node object-storage.mjs set-public <NAME>", { type: "usage" });
        const { accessKey, secretKey } = requireStorageCredentials();
        console.log(`▸ applying public-read policy to "${name}"`);
        await setBucketPolicy(name, buildPublicReadPolicy(slugify(name)), { accessKey, secretKey });
        console.log(`✅ bucket ${name} is now publicly readable`);
        console.log(JSON.stringify({ ok: true, name }));
        break;
      }
      case "delete": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node object-storage.mjs delete <NAME>", { type: "usage" });
        const { accessKey, secretKey } = requireStorageCredentials();
        console.log(`▸ deleting bucket "${name}"`);
        await deleteBucket(name, { accessKey, secretKey });
        console.log(`✅ deleted (or already absent)`);
        console.log(JSON.stringify({ ok: true, name }));
        break;
      }
      default:
        console.log("usage: node object-storage.mjs <ensure|set-public|delete> <NAME>");
        console.log("  reads the STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY pair from env (required)");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, type: err.type, details: err.details }));
    process.exitCode = 1;
  });
}
