#!/usr/bin/env node
// download-storage.mjs - Download every object from the project's Scaleway
// Object Storage bucket, for /save-project.
//
// Usage:
//   node download-storage.mjs --project <name> --out-dir <dir> [--project-dir <path>]
//
// Source of truth for STORAGE_BUCKET / STORAGE_REGION / STORAGE_ENDPOINT /
// STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY: this app's own Scaleway Project
// Secret Manager (CONTRACT.md §2 - one Project per app, so a secret's name
// IS the env var name). Falls back to the project's local .env/.env.local
// when Secret Manager isn't reachable (no SCW_ACCESS_KEY/SCW_SECRET_KEY
// configured on this machine).
//
// Object Storage has no bearer-token REST API for listing/downloading
// objects (see scripts/scaleway/object-storage.mjs's header - S3-only), and
// this harness may not add an npm dependency of its own (CONTRACT.md §3).
// The generated app already depends on @aws-sdk/client-s3 to talk to its own
// bucket though (CONTRACT.md's stack table), so this script borrows that SDK
// from the project's own node_modules via createRequire - the same
// technique scripts/delete-project/execute-deletions.mjs uses to empty a
// bucket before deleting it.
//
// Exits 0 on success, 1 on error. Final stdout line is a JSON status report.
//
// IMPORTANT - loud failure: if the project HAS storage configured but zero
// objects were downloaded, this reports status:"error". A snapshot that
// silently contains no files is worse than one that fails visibly.

import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REGION } from "../scaleway/_scw-auth.mjs";
import { getSecret, secretExists } from "../scaleway/secrets.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const PROJECT = arg("--project");
const OUT = arg("--out-dir");
const PROJECT_DIR = arg("--project-dir") || process.cwd();

if (!PROJECT || !OUT) {
  console.error("Usage: node download-storage.mjs --project <name> --out-dir <dir> [--project-dir <path>]");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

function fail(reason, extra = {}) {
  console.log(JSON.stringify({ status: "error", reason, ...extra }));
  process.exit(1);
}

// ── Resolve STORAGE_* settings: Secret Manager first, local .env fallback ──
async function resolveStorageEnv() {
  try {
    if (await secretExists("STORAGE_BUCKET")) {
      const [bucket, region, endpoint, accessKey, secretKey] = await Promise.all([
        getSecret("STORAGE_BUCKET"),
        secretExists("STORAGE_REGION").then((ok) => (ok ? getSecret("STORAGE_REGION") : REGION)),
        secretExists("STORAGE_ENDPOINT").then((ok) => (ok ? getSecret("STORAGE_ENDPOINT") : null)),
        getSecret("STORAGE_ACCESS_KEY").catch(() => null),
        getSecret("STORAGE_SECRET_KEY").catch(() => null),
      ]);
      if (bucket && accessKey && secretKey) {
        return { bucket, region, endpoint: endpoint || `https://s3.${region}.scw.cloud`, accessKey, secretKey, source: "secret-manager" };
      }
    }
  } catch {
    // Secret Manager unreachable (no SCW_ACCESS_KEY/SCW_SECRET_KEY on this
    // machine) - fall through to the local .env below.
  }

  const wanted = ["STORAGE_BUCKET", "STORAGE_REGION", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"];
  const found = {};
  for (const file of [".env.local", ".env"]) {
    const p = join(PROJECT_DIR, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || !wanted.includes(m[1]) || found[m[1]]) continue;
      found[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (found.STORAGE_BUCKET && found.STORAGE_ACCESS_KEY && found.STORAGE_SECRET_KEY) {
    const region = found.STORAGE_REGION || REGION;
    return {
      bucket: found.STORAGE_BUCKET,
      region,
      endpoint: found.STORAGE_ENDPOINT || `https://s3.${region}.scw.cloud`,
      accessKey: found.STORAGE_ACCESS_KEY,
      secretKey: found.STORAGE_SECRET_KEY,
      source: "local-.env",
    };
  }
  return null;
}

async function resolveS3Client() {
  const pkgJson = resolve(PROJECT_DIR, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const req = createRequire(pkgJson);
    const mod = await import(pathToFileURL(req.resolve("@aws-sdk/client-s3")).href);
    const S3 = mod.default?.S3Client ? mod.default : mod;
    return S3.S3Client ? S3 : null;
  } catch {
    return null;
  }
}

async function download(env) {
  const S3 = await resolveS3Client();
  if (!S3) return null;

  const client = new S3.S3Client({
    region: "auto",
    endpoint: env.endpoint,
    credentials: { accessKeyId: env.accessKey, secretAccessKey: env.secretKey },
  });

  // Paginated listing (1000 keys/page max) - handles buckets with well over
  // 1000 objects.
  const objects = [];
  let token;
  do {
    const r = await client.send(new S3.ListObjectsV2Command({ Bucket: env.bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) objects.push({ key: o.Key, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  const bucketDir = join(OUT, env.bucket);
  mkdirSync(bucketDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  let bytes = 0;
  const errors = [];
  const CONCURRENCY = 8;
  let idx = 0;

  async function worker() {
    while (idx < objects.length) {
      const o = objects[idx++];
      const dest = join(bucketDir, o.key);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        if (existsSync(dest) && statSync(dest).size === o.size) {
          // already fetched (resume)
        } else {
          const res = await client.send(new S3.GetObjectCommand({ Bucket: env.bucket, Key: o.key }));
          const body = await res.Body.transformToByteArray();
          writeFileSync(dest, Buffer.from(body));
        }
        // Read the counter AFTER the await: `x += await ...` loses updates
        // under concurrency (classic read-modify-write race).
        const size = statSync(dest).size;
        downloaded++;
        bytes += size;
      } catch (e) {
        failed++;
        errors.push({ key: o.key, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return { bucket: env.bucket, objectCount: objects.length, downloaded, failed, bytes, errors };
}

// ── Run ──────────────────────────────────────────────────────────────────
const env = await resolveStorageEnv();
if (!env) {
  console.log(
    JSON.stringify({
      status: "skipped",
      reason: "no Object Storage configured (STORAGE_BUCKET absent from Secret Manager and from the local .env)",
      configured: false,
      totalObjects: 0,
      totalBytes: 0,
    }),
  );
  process.exit(0);
}

let result;
try {
  result = await download(env);
} catch (e) {
  fail(`storage configured (bucket "${env.bucket}") but the download failed: ${e.message}`, { configured: true });
}
if (!result) {
  fail(`storage configured (bucket "${env.bucket}") but @aws-sdk/client-s3 is not installed in ${PROJECT_DIR}/node_modules`, {
    configured: true,
  });
}

writeFileSync(resolve(OUT, "_summary.json"), JSON.stringify({ ...result, source: env.source }, null, 2));

// Loud failure: storage exists for this project but we got nothing.
if (result.objectCount > 0 && result.downloaded === 0) {
  fail(`storage configured (bucket "${env.bucket}") but 0 of ${result.objectCount} object(s) downloaded - the snapshot would contain no file`, {
    configured: true,
    errors: result.errors.length,
  });
}

console.log(
  JSON.stringify({
    status: "ok",
    configured: true,
    source: env.source,
    bucketsScanned: 1,
    totalObjects: result.downloaded,
    totalBytes: result.bytes,
    errors: result.errors.length,
  }),
);
