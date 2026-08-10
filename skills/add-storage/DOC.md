# /add-storage

Adds **file storage** (images, PDFs, videos, documents) to your app, via Scaleway Object Storage.

## When to use it

- Your users need to be able to **upload** files (profile photo, product photos, documents, exports)
- You want to store images and display them publicly (for example a site that sells products with galleries)
- You want to offer **private downloads** (reports, invoices, secure contracts)

## How it works

1. **Check**: if storage is already in place on the project, Baudrier offers you a menu to switch bucket, regenerate the keys, update the public URL, etc.

2. **Content question**: Baudrier asks you **what your users will upload**:
   - Profile photos / avatars
   - Product photos
   - PDF documents, contracts, invoices
   - CSV / Excel / report exports
   - Mixed / other

   Depending on your answer, it silently decides: **public** bucket (direct URL) or **private** bucket (temporary signed URLs, secure).

3. **Bucket creation**: a bucket `<project>-assets` is created in your Scaleway project, region `fr-par` (Paris), together with a dedicated, non-expiring access key just for this app. **Versioning is turned on automatically** - see "Your files are protected" below.

4. **Scaffolding**:
   - The S3-compatible SDK (`@aws-sdk/client-s3`) is installed
   - A file `src/server/storage.ts` is created with ready-to-use helpers: `uploadObject`, `deleteObject`, `listObjectVersions`, `restoreObjectVersion`, and depending on the public/private mode, either `getPublicUrl`, or `getSignedUploadUrl` + `getSignedDownloadUrl`

5. **Variables saved**: `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (and `STORAGE_PUBLIC_URL` if public) are saved to your local `.env` and to Scaleway (Secret Manager + your live app). Nothing to copy-paste, nothing to create by hand - Baudrier mints the keys for you.

6. **User interface (optional)**: Baudrier offers to build the UI adapted to your case (upload field + preview + gallery + personal file list + access security).

## What it creates for you

- A **storage bucket** in your name (`<project>-assets`) on Scaleway, in France
- A dedicated, non-expiring access key for this app only
- The variables `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (and `STORAGE_PUBLIC_URL` if public bucket)
- `src/server/storage.ts` with the ready-to-use helpers
- If you want: the user interface (upload component, gallery, file list, etc.)

## Your files are protected

The bucket is created with **versioning turned on** - this is the only backup that exists for the files your users upload (photos, documents, exports...), so it's on by default, not an option to toggle.

What that means in practice:
- Deleting a file in the app **does not erase it right away**. A previous version stays recoverable behind the scenes.
- If a file gets accidentally deleted or overwritten, it can be restored - Baudrier can do this for you if you ask.
- This protection has a time limit: **old versions are automatically cleaned up after about 90 days** to control storage costs. Past that window, an old version is gone for good.
- Keeping old versions around uses a bit more storage space than a non-versioned bucket would, so there's a small extra cost - the tradeoff for having an undo button on your data.
- The bucket itself can never be deleted by Baudrier, under any circumstance - only a human can do that, directly in the Scaleway console.

## Prerequisites

- The project must be in Next.js (typically initialized by `/bootstrap`)
- The four `SCW_*` variables must be set in your Baudrier cloud environment

## Tips

{{callout:tip|Pay only for what you store}}
There's no separate "storage product" to enable and no credit card gate to get through first - a bucket can be created right away. New accounts also get a generous free trial. Downloading files is included at no extra charge.
{{/callout}}

{{callout:info|Public vs Private: the right intuition}}
**Public** = anyone with the URL can download the file (profile photos, product photos, editorial content, not confidential). **Private** = each download goes through a temporary URL signed by your server (invoices, contracts, personal reports). If you are unsure, Baudrier chooses "private" by default (safer).
{{/callout}}

{{callout:warning|User data security}}
In private mode, access control is crucial: your code must verify that the user requesting a file is actually entitled to it before generating the signed URL. If Baudrier builds the UI for you, these checks are included (ownership verification, session verification). If you write your own code, do not remove these checks.
{{/callout}}
