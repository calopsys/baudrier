---
name: add-storage
description: Add Scaleway Object Storage (S3-compatible) file/image storage to an existing T3 project. Asks upfront what will be stored to infer public/private + propose UI build at the end.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Storage - Scaleway Object Storage

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Adds a Scaleway Object Storage bucket (S3-compatible, region `fr-par`) and an S3 upload utility, then proposes to build the user-facing layer (upload field, gallery, download link, etc.) adapted to what the user wants to store.

---

## Step 0 - Preflight: storage already configured?

**First of all**, invoke `_check-deps storage` to detect whether Object Storage is already in place:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" storage)
storage_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).storage.ok)")
storage_bucket=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).storage.bucket || '(not set)')")
storage_public_url=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).storage.publicUrl || '')")
```

### If `storage_ok = true` then re-configuration mode

Storage is already in place (bucket: `$storage_bucket`). Do NOT recreate the S3 client, nor rewrite the upload utility. Show the menu:

> ## 📦 File storage is already in place on your project (bucket: **$storage_bucket**)
>
> What do you want to do?
>
> 1. **Switch bucket** (e.g. go from a private bucket to a public bucket with a public URL) - I create the new bucket and switch `STORAGE_BUCKET`
> 2. **Regenerate the storage access keys** (security rotation, or if you fear a leak)
> 3. **Change the public URL** (`STORAGE_PUBLIC_URL`) after connecting a custom domain to the bucket
> 4. **Start over from scratch** (only useful if the storage config is broken)
> 5. **Something else** - tell me what you want

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (switch bucket) | Ask for the new bucket name + public/private. Create it (Step 4 below). Push `STORAGE_BUCKET=<new>` (and `STORAGE_PUBLIC_URL` if public) via `_push-env-vars`. Remind that the files in the old bucket are not migrated automatically. |
| 2 (key rotation) | Create a brand-new IAM API key for the app's dedicated Object Storage Application (`node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" create-key <app-id> <project-id> "storage key rotation" --reveal` - `--reveal` is required here because the new secret must be captured and pushed on), then delete the old one (`iam.mjs delete-key <old-access-key>`) once the new one is pushed. Push `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` via `_push-env-vars`. |
| 3 (update public URL) | Ask for the new public URL (e.g. `https://assets.mydomain.com`). Push `STORAGE_PUBLIC_URL=<url>` via `_push-env-vars`. Remind that on the Scaleway side, this requires a bucket website / custom domain to have been connected (see Scaleway's Object Storage custom-domain docs) - Baudrier doesn't automate that part yet. |
| 4 (start over) | Confirm, then treat it like a fresh Step 4 onward: a new bucket is created, new IAM access is minted, `src/server/storage.ts` is rewritten. |
| 5 (something else) | Ask for clarification. Do not run the full flow by default. |

**At the end**, jump directly to the **final summary**.

### If `storage_ok = false` (not configured yet)

Continue normally to Step 1. This is the initial installation flow.

---

## Step 1 - Check prerequisites

Invoke the `_detect-project-root` internal skill to get `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`. Abort if `IS_NEXTJS=no`.

Object Storage credentials go through the same Scaleway IAM path as everything else in this harness - there is no separate provider account to connect and no separate token to collect, unlike the storage provider this skill used to target. If the operator's Scaleway credentials aren't configured, the very first `scripts/scaleway/*.mjs` call below fails with a message about the missing variable; tell the user to check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation.

## Step 2 - Context: what will be stored?

Before touching the code, understand what the user wants to store. This determines:
- The bucket visibility (public or private) → inferred by Claude
- The generated code (direct URLs vs signed URLs)
- The UI proposed at the end

Ask in natural language:

> Before configuring storage, tell me what your users will be able to add on your site:
>
> A few examples:
> - profile photos
> - product photos
> - PDF documents (contracts, invoices, quotes...)
> - Excel files or reports
> - something else?
>
> You can list several. If you do not know yet, say so, we will configure the essentials and you can enrich it later.

**Internal inference** (DO NOT show to the user) - Claude classifies based on the answers:

| Type provided by the user | Technical visibility | DB tracking | Typical UI to propose |
|---|---|---|---|
| profile photos / avatars | Public (direct URL) | `avatarUrl` field on user | "add a photo" field + preview |
| product photos | Public | table with a list of images per product | multi upload + admin mini-gallery |
| PDF documents, contracts, invoices | **Private** (signed URLs) | table with owner + access check | upload + personal downloadable list |
| generated CSV / Excel / reports exports | **Private** (signed URLs, short expiry) | optional (single-use link) | "Export" button + download link |
| mixed public + private | **Private by default** + signed URLs everywhere (safer) | mandatory | depends on the types |
| to be defined | **Private** by default (safer) | optional | generic upload |

Store `<storage_context>` = `{types, visibility, db_tracking}` for the following Steps.

## Step 3 - Inform about pricing

Unlike some storage providers, Scaleway Object Storage has no manual "enable this product" step and no separate account to connect - a bucket can be created directly. Inform the user:

> A few things worth knowing about file storage costs:
> - New Scaleway accounts get a free trial (hundreds of GB, 90 days) - after that, storage is billed per GB stored per month, plus a small per-request cost. Downloading files (egress) is included, no extra charge.
> - There's no fixed monthly minimum - you only pay for what's actually stored.
> - Exact current rates: see the Object Storage section of the Scaleway console.

## Step 4 - Create the bucket and dedicated access

**Always in `fr-par`** (Paris) - this harness only ever targets that region (CONTRACT.md constants).

1. First, ask which credential shape the environment holds:
   ```bash
   shape_result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/app-credentials.mjs" shape)
   credential_shape=$(echo "$shape_result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).shape)")
   ```
   `credentialShape()` (CONTRACT.md §1, §2 `app-credentials.mjs`) returns `"org"` when the environment's key is an organization administrator (Cas A), `"project"` when it is an IAM application scoped to this Project alone (Cas B), or `"unknown"`. Ask it before acting - never guess the shape from a failed call.

   **Cas A - `credential_shape = "org"`**: create a dedicated IAM Application + policy + non-expiring API key for this app's storage access (same pattern as `/add-db`'s database credentials - a leaked or rotated key must never silently break the app, so no expiry):
   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" ensure-app "<PROJECT_NAME>-storage"
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" ensure-policy "<app-id>" "<project-id>" "ObjectStorageBucketsRead,ObjectStorageBucketsWrite,ObjectStorageObjectsRead,ObjectStorageObjectsWrite,ObjectStorageObjectsDelete,ObjectStorageBucketPolicyFullAccess"
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" create-key "<app-id>" "<project-id>" "Object Storage for <PROJECT_NAME> (no expiry)" --reveal
   ```
   `--reveal` is required on `create-key` here: the secret is only ever returned once, and Step 4.2-4.3 and Step 6 below need the real value - capture it into a shell variable and use it right away, never log it separately.
   This deliberately excludes `ObjectStorageBucketsDelete` and the various `*FullAccess` sets - the app's own running key can create/read/write/delete objects and manage this bucket's policy, but cannot delete the bucket itself. Bucket deletion is an operator action (via the Scaleway console or `object-storage.mjs delete`), not something the app does to itself.

   **Cas B - `credential_shape = "project"`**: mint nothing. Turn the environment's own key into the app's storage credential instead - `operatorKeyAsAppCredential()` has no CLI flag of its own (CONTRACT.md §1, §2 `app-credentials.mjs`: it is a function other scripts import, not a command a secret should pass through), so call it directly:
   ```bash
   node --input-type=module -e "
     import { operatorKeyAsAppCredential } from '${CLAUDE_SKILL_DIR}/../../scripts/scaleway/app-credentials.mjs';
     const cred = await operatorKeyAsAppCredential({ purpose: 'object-storage' });
     console.log(JSON.stringify(cred));
   "
   ```
   `operatorKeyAsAppCredential({ purpose: "object-storage" })` is the only sanctioned way to do this - this skill never reads `SCW_SECRET_KEY` itself, and it refuses to run against an organization key. Object Storage resolves its Project from the key itself, not from a separate id, so in Cas B this pair is not merely acceptable: it is the only pair that reaches this app's own Project. Capture `accessKey`/`secretKey` from the printed JSON and use them right away, same as in Cas A - never log them separately.

   Tell the user once, in plain French, before continuing (do not repeat this warning later in this skill):
   > ℹ️ Votre clé Scaleway a les droits administrateur sur ce projet. L’application utilisera cette même clé pour accéder au stockage. Concrètement : toute personne qui accède à l’application en ligne accède à tout ce que contient ce projet Scaleway (base de données, stockage, emails...). Gardez l’accès à l’application restreint tant que vous n’acceptez pas ce risque.

2. Create the bucket using the key from step 1 above (minted in Cas A, reused in Cas B):
   ```bash
   STORAGE_ACCESS_KEY=<access-key> STORAGE_SECRET_KEY=<secret-key> \
     node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/object-storage.mjs" ensure "<PROJECT_NAME>-assets"
   ```
   Bucket names are unique across the **entire** Scaleway platform (not just your account) - if the name is taken, the script surfaces a clear "already exists" error. Retry with a more specific name (e.g. append a short suffix).

   This command does more than create the bucket: `ensureBucket()` also turns bucket **versioning** `Enabled` and puts a **lifecycle rule** in place that expires noncurrent object versions after a fixed retention window (currently 90 days - see `object-storage.mjs`'s `DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS`). This is not optional and is not a separate step: it is this harness's only backup mechanism for the app's uploaded files (there is no other backup product behind Object Storage), so `ensureBucket()` hard-fails rather than reporting success if versioning cannot be confirmed. See Step 5 below for what this means for the generated app's code.

   **Never delete this bucket.** `object-storage.mjs`'s `deleteBucket()` refuses by default (see `scripts/scaleway/_destructive-guard.mjs`) - it is not something this skill, `/delete-project`, or Claude acting alone can do. Bucket deletion is a manual action a human takes in the Scaleway console.

3. **If `<storage_context>.visibility = "public"`**: apply a public-read bucket policy so uploaded files are reachable by direct URL:
   ```bash
   STORAGE_ACCESS_KEY=<access-key> STORAGE_SECRET_KEY=<secret-key> \
     node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/object-storage.mjs" set-public "<PROJECT_NAME>-assets"
   ```
   The public URL is `https://<PROJECT_NAME>-assets.s3.fr-par.scw.cloud/<key>` - store the base (`https://<PROJECT_NAME>-assets.s3.fr-par.scw.cloud`) as `STORAGE_PUBLIC_URL`.

   **If `<storage_context>.visibility = "private"`**: skip this - do NOT apply a public policy. All downloads go through signed URLs generated server-side (the Step 5 code does this).

## Step 5 - Install S3 client and create upload utility

```bash
pnpm add @aws-sdk/client-s3
```

(If visibility = private, also add `pnpm add @aws-sdk/s3-request-presigner` for the signed URLs.)

Create `<WEB_DIR>/src/server/storage.ts` with the S3-compatible client and the appropriate helpers:

```ts
import {
  S3Client,
  ListObjectVersionsCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "~/env.js";

// Scaleway Object Storage (S3-compatible), region fr-par. forcePathStyle is
// always on: a bucket name containing a dot would break the wildcard TLS
// certificate under virtual-hosted-style addressing (Scaleway's own docs -
// use dashes in bucket names, but keep path-style as a defensive default).
export const s3 = new S3Client({
  endpoint: env.STORAGE_ENDPOINT,
  region: env.STORAGE_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY,
    secretAccessKey: env.STORAGE_SECRET_KEY,
  },
});

// The bucket has versioning enabled (provisioned that way by the harness -
// see /add-storage). Deleting a key here does NOT destroy the file: it
// inserts a "delete marker" as the new current version, and every prior
// version stays in the bucket, byte for byte, until the automatic lifecycle
// rule expires it. This IS the app's backup/undo mechanism for uploaded
// files - there is no separate backup product behind Object Storage.
//
// deleteObject() therefore never passes a VersionId. Passing a VersionId to
// DeleteObjectCommand targets one specific version and destroys it
// PERMANENTLY, bypassing the delete-marker safety net entirely - never do
// that from application code. If you ever need to remove a specific old
// version on purpose (e.g. for a legal takedown), that is a manual, deliberate
// action in the Scaleway console, not something this app's code should do to
// itself.

/**
 * List every version of an object (current, previous, and delete markers),
 * most recent first. This is the app-side restore path: find the VersionId
 * you want to bring back, then pass it to restoreObjectVersion().
 */
export async function listObjectVersions(key: string) {
  const res = await s3.send(
    new ListObjectVersionsCommand({ Bucket: env.STORAGE_BUCKET, Prefix: key }),
  );
  return (res.Versions ?? [])
    .filter((v) => v.Key === key)
    .map((v) => ({
      versionId: v.VersionId!,
      isLatest: v.IsLatest ?? false,
      lastModified: v.LastModified,
      size: v.Size,
    }));
}

/**
 * Restore a previous version of an object by copying it back onto the
 * current key. This does not delete or alter the version being restored
 * from, or any version created since - it simply adds one more version on
 * top, so the action itself stays undoable too.
 */
export async function restoreObjectVersion(key: string, versionId: string) {
  await s3.send(
    new CopyObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: key,
      CopySource: `${env.STORAGE_BUCKET}/${encodeURIComponent(key)}?versionId=${versionId}`,
    }),
  );
}
```

- `uploadObject(key, body, contentType)` - upload from the server (common to both modes), via `PutObjectCommand`
- `deleteObject(key)` - deletion (common), via `DeleteObjectCommand`, **never** with a `VersionId` (see the comment above the code block - that would permanently destroy a specific backup version instead of leaving a recoverable delete marker)
- `listObjectVersions(key)` - lists every version of an object via `ListObjectVersionsCommand`, most recent first - this is the actual restore path for the bucket's version history
- `restoreObjectVersion(key, versionId)` - copies a previous version back onto the current key via `CopyObjectCommand` - this is how the app (or an admin screen) undoes an accidental overwrite or deletion
- **If public**: `getPublicUrl(key)` - returns `\`${env.STORAGE_PUBLIC_URL}/${key}\`` directly
- **If private**: `getSignedUploadUrl(key, contentType, expiresIn=3600)` - for direct uploads from the browser, AND `getSignedDownloadUrl(key, expiresIn=3600)` - for temporary downloads, both via `getSignedUrl()` from `@aws-sdk/s3-request-presigner`

**Tell the user, in plain language, as part of the Step 9 summary** (do not skip this - it is the only backup of their files):
- Deleting a file in the app doesn't erase it immediately - Scaleway keeps every previous version, so accidental deletions and overwrites are recoverable.
- That recovery window is not unlimited: **old versions are automatically removed after about 90 days** (a fixed time window, not a fixed count of versions - Scaleway's Object Storage does not support "always keep exactly the last N versions", only "remove versions older than N days", so the harness uses the closest equivalent it can configure). Anything deleted or overwritten more than ~90 days ago is gone for good.
- Keeping old versions uses storage space, so it has a small ongoing cost on top of the current files - this is normal and is the tradeoff for having a safety net.

Do **not** offer or generate any "run code on upload" / bucket-notification feature (an S3 trigger, a webhook fired on `PutObject`, etc.) - Scaleway Object Storage does not support bucket event notifications (`PutBucketNotification`/`GetBucketNotification` are listed "in development", not shipped, as of the research done for this skill). If the user asks for "do X automatically when a file is uploaded", the honest answer is: trigger that action from the tRPC upload procedure itself (right after the `uploadObject()` call succeeds), not from a storage-side event - there is no storage-side event to hook into.

## Step 6 - Push env vars

Invoke `_push-env-vars` with:
- `STORAGE_ENDPOINT=https://s3.fr-par.scw.cloud`
- `STORAGE_REGION=fr-par`
- `STORAGE_BUCKET=<PROJECT_NAME>-assets`
- `STORAGE_ACCESS_KEY=<access key from Step 4>`
- `STORAGE_SECRET_KEY=<secret key from Step 4>`
- **If public**: also add `STORAGE_PUBLIC_URL=<the base URL from Step 4>`

Unlike `/add-db`'s `DATABASE_URL`, there is no restriction on where these credentials may live - `_push-env-vars` writing them to the local `.env` (for `pnpm dev`) as well as Secret Manager and the container is the correct, standard behavior here.

## Step 7 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `stack`: `- **Storage**: Scaleway Object Storage ([public|private] depending on context, region fr-par, util in \`<WEB_DIR>/src/server/storage.ts\`)`
- `conventions`:
  - `- Storage: when deleting a record (or a field) that references an uploaded file, **always** also delete the corresponding object via \`deleteObject(key)\` (from \`~/server/storage\`) in the same operation. Never delete only the database row: that leaves orphaned files in the bucket (storage cost that grows + data that survives its deletion, a GDPR problem). Same for a file replacement: delete the old object after uploading the new one. For a multiple deletion (e.g. deleting a product with 5 photos), delete all the associated keys.`
  - `- Storage: no bucket event notifications exist on this stack - any "do X when a file is uploaded" logic must live in the upload tRPC procedure itself, right after \`uploadObject()\` succeeds.`
  - `- Storage: the bucket has versioning enabled - \`deleteObject(key)\` never destroys data immediately, it inserts a delete marker. Never pass a \`VersionId\` to \`DeleteObjectCommand\` from app code (that permanently destroys one specific version). To recover a deleted or overwritten file, use \`listObjectVersions(key)\` then \`restoreObjectVersion(key, versionId)\` from \`~/server/storage\`. Noncurrent versions are expired automatically after ~90 days (Scaleway only supports time-based expiration, not "keep the last N versions"), so recovery is not possible past that window.`
- `env-vars`:
  - `- \`STORAGE_ENDPOINT\` - Object Storage S3-compatible endpoint (\`https://s3.fr-par.scw.cloud\`)`
  - `- \`STORAGE_REGION\` - always \`fr-par\``
  - `- \`STORAGE_BUCKET\` - bucket name`
  - `- \`STORAGE_ACCESS_KEY\` - IAM access key, dedicated to this app's storage`
  - `- \`STORAGE_SECRET_KEY\` - IAM secret key, dedicated to this app's storage`
  - **If public**: `- \`STORAGE_PUBLIC_URL\` - public base URL of the bucket to serve files directly`
- `custom`:
  - heading: `## Object Storage - context`
  - body: content based on `<storage_context>` from Step 2. Format:
    ```
    Bucket: <PROJECT_NAME>-assets ([public | private with signed URLs], region **fr-par** - France)

    Important: bucket names are globally unique across all of Scaleway, and a bucket name containing a dot breaks HTTPS access (path-style addressing is used defensively in storage.ts to guard against this).

    No bucket event notifications on this platform - any "on upload" logic lives in the tRPC upload procedure.

    Versioning: enabled on this bucket - it is the app's only backup of its files. Deletions/overwrites are recoverable for ~90 days via listObjectVersions/restoreObjectVersion (src/server/storage.ts). Never delete the bucket itself (blocked by a harness-level guard) and never call deleteObject with a VersionId.

    Types of files stored:
    - <type 1 provided by the user>
    - <type 2>
    ...

    DB tracking: [yes (table to create) | no (just a url field)]

    UI: [in place | to build - see CLAUDE.md "To do" if skipped]
    ```

## Step 8 - Propose to build the user-facing layer

Storage is wired up on the server side ✅. But for your users to actually be able to add and view files, you now need the UI. Adapt the proposal to `<storage_context>` from Step 2 - describe to the user **what they will get** (in plain language), not how it is built.

**Examples of proposals by type** (Claude adapts to the actual types provided):

| Type | Proposal to the user (no jargon) |
|---|---|
| profile photos | "a field to add a profile photo (with preview before confirming) and the display of the photo throughout the app" |
| product photos | "an admin page to add / remove photos on each product, with the display of the galleries on the visitor side" |
| PDF documents / contracts | "a place to add a document, and a personal page where each user finds their own files and can download them (secure: no one else can access them)" |
| CSV/Excel exports | "an 'Export' button that generates the file and offers the download (link valid for a few minutes)" |

User prompt format (to adapt):

> Storage is in place on the server side ✅. For your users to actually be able to add and view their `<type provided>`, the visible part is missing - typically:
> - <bullet 1 adapted to the type>
> - <bullet 2>
> - …
>
> I can build all of this for you now, or do you prefer to do it yourself later?

**If yes**:
- Read `<storage_context>` (and the "Object Storage - context" section of the CLAUDE.md)
- Check whether add-db is in place - if so and `db_tracking = true`, create the appropriate table (e.g. `documents` with `owner_id`, `storage_key`, `name`, `mime_type`, `size`, `created_at`)
- This product is French-only by design (CONTRACT.md §1) - there is no i18n framework to wire into. Write every displayed string (`"Choisir un fichier"`, `"Glissez-déposez ici"`, `"Envoi en cours…"`, `"Erreur lors de l'envoi"`, `"Supprimer"`, etc.) hard-coded in French directly in the component, matching the rest of the project's copy.
- Build the UI components with the project's style (read `globals.css` + available shadcn components in `~/components/ui/`):
  - **Upload component**: drag-drop or file picker, preview for images, progress bar, size/type validation
  - **tRPC procedure**: for private uploads, return a signed URL for direct upload; for public ones, upload via the server then return the public URL
  - **Display**: Next.js `<Image>` for public images, `<a>` link or download button for private ones (with on-the-fly signed URL generation)
  - **Deletion (CRITICAL)**: if the UI allows **deleting** a file (a "Delete" button on a photo, removing a product, replacing an avatar…), the deletion tRPC procedure **must call `deleteObject(key)`**, not just remove the database row. Pattern: delete the object first (or in parallel), then the DB record; in case of a storage failure, log without blocking the DB deletion (but never skip the `deleteObject` call). For a cascade deletion (e.g. deleting a product = deleting its N photos), iterate `deleteObject` over all the keys. For a file **replacement**: upload the new one, update the reference, then `deleteObject` on the old key. Goal: zero orphaned object in the bucket (cost + GDPR). `deleteObject(key)` never passes a `VersionId` (see `storage.ts`'s header comment) - the bucket's versioning means this deletion is recoverable via `listObjectVersions`/`restoreObjectVersion` for about 90 days, it is not the last line of defense the way a bucket-less setup would be.
  - **Security (private)**: auth check in the tRPC procedure (the user must be the owner or have the rights)
- Update the "## Object Storage - context" section of the CLAUDE.md with "UI: in place ✅"

**If no / later**:
- Mention it explicitly in the Step 10 Summary as a remaining manual action
- Do not mark "UI: in place" in the CLAUDE.md

## GDPR - Privacy policy

Add Scaleway Object Storage to the project's GDPR subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add scaleway-object-storage
```

The helper is idempotent. If the `politique-de-confidentialite/page.tsx` page exists (created by `/bootstrap`), it updates automatically. Otherwise, only the registry is created - `/rgpd-audit` can generate the page later.

## Step 9 - Summary

Present to the user:

> ✅ **File storage configured (Scaleway Object Storage).**
>
> **Bucket**: `<PROJECT_NAME>-assets` ([public - direct URL available | private - access via signed URLs])
> **Region**: France (`fr-par`)

If UI built in Step 8:
> - 🎨 The interface to add and view your `<types>` is in place. You can test it on the relevant pages.

If UI skipped:
> - 🎨 **User interface not created** - when you are ready to add it, tell me *"add the upload feature"* and I will build the pages with the right design (the context is already noted in `CLAUDE.md` → "Object Storage - context").
