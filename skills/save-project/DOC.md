# /save-project

Creates a **complete backup** of a Baudrier project as a timestamped zip. Useful before `/delete-project`, before a big refactor, at the end of a mission, or for a personal archive.

## When to use it

- Before running **`/delete-project`** on a project: belt and braces, just in case.
- Before a **big refactor**: a clear point to return to if it goes sideways.
- At the **end of a mission**: deliver a complete dump to the client, or keep it as your own archive.
- **Before a risky experiment**: changing the DB, reworking auth, a major dependency upgrade...
- As a **periodic archive**: a snapshot stored offline, disconnected from the cloud services.

## How it goes

1. **Preflight**: the assistant detects the project (from the current folder or the argument), checks it looks like a Baudrier project, and presents a recap of what will be included - with an explicit note that the database is not part of it.

2. **Questions**:
   - **Include file storage?** If the project has an Object Storage bucket (uploaded files, images, videos), you're asked whether to include it. Large buckets take longer.
   - **Where to save the zip?** Defaults to your Downloads folder, otherwise the current folder or a path of your choosing.

3. **Execution**:
   - **Complete git bundle** (the whole history) + uncommitted working changes captured as a patch
   - **Environment variables**: everything currently in Scaleway Secret Manager, plus a copy of the local `.env`/`.env.local`
   - **Database**: a note explaining why there is no data dump, not a dump (see below)
   - **Object Storage download** (if chosen): every file in the bucket
   - **Claude Code memory/transcripts** for the project
   - **Scaleway linkage**: `config/scaleway-link.json` (not a secret, just the namespace/container ids resolved live by name)

4. **Final zip**: everything is compressed into `<project>-snapshot-<TS>.zip` with a `MANIFEST.md` at the root describing the content and the restore procedure.

## What it creates for you

```
<project>-snapshot-YYYYMMDD-HHMMSS/
├── MANIFEST.md           ← date, content, restore procedure
├── code/                 ← git bundle + package.json + working-changes.patch
├── env/                  ← secret-manager.env + copy of .env/.env.local
├── db/                   ← NOTE.md - why there is no data dump here
├── storage/              ← Object Storage content (if included)
├── memory/               ← Claude Code memory/transcripts for the project
└── config/               ← scaleway-link.json
```

## A note for Claude Code web

A web session is temporary and has no browser to download a file through. On web, the zip is written to a session-scoped temp folder instead of your Downloads folder, and it disappears with the session - the skill says so plainly. Rely instead on the Git repo (already a backup of the code) and the Object Storage bucket's own versioning (90 days of previous-version retention).

## Prerequisites

- The project must have a local folder on the machine (at minimum a `package.json`).
- Scaleway credentials (`SCW_ACCESS_KEY`/`SCW_SECRET_KEY`) configured if you want the Secret Manager section and the storage download - the skill skips what isn't available, without crashing.
- Python is used for the final zip (a common default dependency, not installed specifically for this).

## Tips

{{callout:warning|The database is NOT in this backup - no business data is in this zip}}
The operator's machine never connects to the database directly (see CONTRACT.md §4) and there is no on-demand backup API to call from here. Concretely: none of your business data (customers, orders, content, accounts...) is in this zip - only code, credentials, and stored files. Scaleway's general documentation states it performs automatic database backups, but the exact frequency and retention window for Serverless SQL Database specifically has not been verified here - do not treat it as a guaranteed safety net. If your data matters, the only export you can rely on is one you trigger yourself (a `pg_dump` from a machine with network access to the database, or a tool from inside the Scaleway console).
{{/callout}}

{{callout:warning|The zip contains plaintext secrets}}
The `env/` files contain API keys in plaintext. Treat it as a confidential document: no unencrypted email sharing, no public storage, delete it as soon as it's no longer useful.
{{/callout}}

{{callout:info|No automatic restoration}}
The skill does not offer a `/restore-project`. This is intentional: restoring a complete environment is a sensitive operation that deserves human eyes at every step. The `MANIFEST.md` inside the zip describes the procedure, and you can always reopen Claude Code in the extracted folder to be guided.
{{/callout}}

{{callout:tip|The safety net before /delete-project}}
The reflex: before permanently deleting a project with `/delete-project`, run `/save-project` first (the skill offers to do this for you automatically at that point too).
{{/callout}}

## Landing sites (site vitrine)

On a landing site, the summary says plainly: **code + secrets, no database or storage** - nothing is missing, a landing site simply doesn't have either.
