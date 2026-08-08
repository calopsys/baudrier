---
name: add-db
description: Add a Scaleway Serverless SQL Database (PostgreSQL 16) to an existing T3 project. Provisions the database, creates dedicated IAM access, and configures Drizzle ORM. In a monorepo, creates a shared packages/db package.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add DB - Scaleway Serverless SQL Database

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Adds a Scaleway Serverless SQL Database (PostgreSQL 16, region `fr-par`) with Drizzle ORM to the current project. Can be called by `/bootstrap` or standalone on an existing project.

The deterministic core (provisioning, dedicated IAM access, driver swap) is handled by `scripts/setup-db.mjs`. This SKILL takes care of the entry-side decisions (re-config detection, monorepo case) and the exit-side communication (CLAUDE.md update, summary).

**Hard rule, never work around it**: the operator's machine (this machine) never connects to the database, and no REAL connection string ever exists on it. The local `.env` file carries a syntactically valid placeholder, `postgresql://placeholder:placeholder@localhost:5432/placeholder` - it satisfies T3's `src/env.js` Zod validation and lets `drizzle.config.ts` import that module, but it connects to nothing. **This placeholder is required, not a leftover**: deleting it breaks `pnpm db:generate` (which loads `drizzle.config.ts`, which imports `src/env.js`, which validates `DATABASE_URL` at import time). Never delete it and never replace it with a real value by hand. No step in this skill runs `drizzle-kit push`, `drizzle-kit studio`, `drizzle-kit migrate`, or a seed script - all of those open a real connection. The real `DATABASE_URL` lives only in Scaleway Secret Manager and the containers it is synced into. Schema changes are written to disk with `drizzle-kit generate` (no connection - it only diffs the schema against the SQL files already on disk) and applied for real by the migration Serverless Job that `/deploy` launches. If you ever find yourself about to run a drizzle command with a real `DATABASE_URL` set locally, stop - that is the bug this rule exists to prevent.

**Hard rule, never work around it**: this skill (and this harness generally) **cannot delete a database**. `scripts/scaleway/sdb.mjs`'s `deleteDatabase()` refuses by default - it is guarded by `scripts/scaleway/_destructive-guard.mjs` and only proceeds if a human has set a resource-specific `BAUDRIER_ALLOW_DESTRUCTIVE` environment variable in their own shell, which nothing in this skill (or Claude acting on the user's behalf) ever does. Database deletion is a **manual action a human takes in the Scaleway console**. If a user asks Claude to delete a database, the honest answer is that Claude cannot do it - point them at the console, never attempt a workaround (raw API call, a different script, editing the guard). Why this matters: Serverless SQL Database has automatic daily backups but **no on-demand backup API** (see "Automatic backups" below) - a mistaken deletion is not something a fresh backup could be taken to protect against right before it happens.

---

## Step 0 - Preflight: DB already configured?

**First of all**, invoke `_check-deps db` to detect whether a real cloud DB is already wired up:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" db)
db_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).db.ok)")
db_host=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).db.host || '')")
```

### If `db_ok = true` then re-configuration mode

A real cloud DB is already wired up (host: `$db_host`). Do NOT run `setup-db.mjs` (it would provision a second database, orphaning the first). Do NOT rewrite `drizzle.config.ts`. Show a menu:

> ## 🗄️ A database is already in place (host: `$db_host`)
>
> What do you want to do?
>
> 1. **Apply a schema change** (you edited `schema.ts` and need it applied) - I generate the migration file locally (no risk, no connection) and the actual apply happens on your next `/deploy`
> 2. **Migrate to a new database** (e.g. start from a clean database) - ⚠️ **destructive**: all current data is lost. I provision a brand-new database + credentials and switch `DATABASE_URL`; the old database is left in place (delete it yourself later if you want)
> 3. **Something else** - tell me what you want

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (apply schema change) | `cd <WEB_DIR> && npx drizzle-kit generate` (writes a new SQL file under `drizzle/`, no connection opened). Show the generated file name. Remind the user their next `/deploy` will apply it via the migration Job - nothing touches the database right now. |
| 2 (migrate to a new database) | Confirm with the user "do you confirm losing the current data?" then re-run `setup-db.mjs --name <project-name>` (it provisions a new database + a new dedicated IAM Application/key and overwrites the `DATABASE_URL` secret in Secret Manager). Mention that the old database and its IAM Application are left in place - the user (or a follow-up `/clean`) can delete them manually via the Scaleway console if they want to free up resources. |
| 3 (something else) | Ask for details. Don't run the full flow by default. |

**At the end**, jump straight to the **final summary** (Step 6 below).

### If `db_ok = false` (not configured yet)

Continue normally to Step 1.

---

## Step 1 - Project context detection

Invoke the `_detect-project-root` internal skill to get `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO`, and `IS_NEXTJS`.

- If `IS_NEXTJS=no` then abort. This skill requires a Next.js project.
- If `IS_MONOREPO=yes` then **do not run the script** (it refuses `--monorepo` in v1). Go to Step 2 (manual monorepo mode).
- If `IS_MONOREPO=no` then go straight to Step 3.

### Scaleway access

Everything goes through the Scaleway API with the operator's `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` (never asked here - `/start` configures them once, and `scripts/scaleway/_scw-auth.mjs` resolves them automatically). If they are missing, `setup-db.mjs` fails immediately at its preflight step with a message pointing to `/start` - no separate check is needed in this skill.

---

## Step 2 - Monorepo mode (manual, outside the script)

`setup-db.mjs` does not yet handle the monorepo case (which requires creating a shared `packages/db/` package, moving the schema/client/config). Proceed manually, calling the same building blocks the script uses:

1. Create the shared `packages/db` package:
   ```bash
   mkdir -p packages/db/src
   ```

2. Create `packages/db/package.json`:
   ```json
   {
     "name": "@<project-name>/db",
     "private": true,
     "main": "./src/index.ts",
     "types": "./src/index.ts"
   }
   ```

3. Install the driver in the package:
   ```bash
   cd packages/db
   pnpm add pg drizzle-orm
   pnpm add -D drizzle-kit @types/pg
   ```

4. Move the schema, the client, and the Drizzle config into `packages/db/src/`. Write `packages/db/src/index.ts` following `templates/db/index.ts` (pg + `drizzle-orm/node-postgres`, `ssl: true`, no `rejectUnauthorized: false`). All apps (`apps/web`, `apps/worker`) must import from `@<project-name>/db`.

5. Update `apps/web` (and other apps) to import the DB from the shared package instead of local files.

6. Provision the database and dedicated IAM access via the same primitives `setup-db.mjs` uses:
   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/sdb.mjs" ensure "<project-name>"
   # note the returned id, endpoint, port
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/sdb.mjs" wait "<database-id>"
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" ensure-app "<project-name>-db"
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" ensure-policy "<app-id>" "<project-id>" "ServerlessSQLDatabaseReadWrite"
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/iam.mjs" create-key "<app-id>" "<project-id>" "DATABASE_URL for <project-name> (no expiry)" --reveal
   # --reveal is required here: the freshly minted secretKey is only ever
   # returned once and is needed immediately below to build the connection
   # string - capture it into a shell variable and use it right away, never
   # echo it again or log it separately.
   # deliberately no --expires flag anywhere above - see CONTRACT.md §4
   node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/sdb.mjs" connection-string --endpoint "<endpoint>" --port "<port>" --db-name "<project-name>" --application-id "<app-id>" --secret-key "<secret-key>"
   ```

   **If `ensure-app`, `ensure-policy`, or `create-key` fails with `"type":"permission_denied"`** (the operator's key lacks `IAMManager`): do **not** retry the manual `iam.mjs` commands, and do not relay a request to an administrator here - that no longer happens at this stage. Instead abandon the manual `sdb.mjs`/`iam.mjs` sequence and run the deterministic script:
   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/setup-db.mjs" --name "<project-name>" --web-dir "packages/db"
   ```
   It tries the delegated `BAUDRIER_DB_KEY` pair first, then falls back to the operator's own personal Scaleway key, silently, recording the fallback in the `BAUDRIER_DEV_FINGERPRINTS` manifest secret so `/publish` can find and swap it later. It provisions the database and stores `DATABASE_URL` in Secret Manager on its own - skip straight to step 8 below once it succeeds. No administrator action is needed at this point: the admin is only asked once, later, when the user runs `/publish` (CONTRACT.md §1), which refuses to proceed while any secret is still dev-backed and prints one consolidated request covering every addon at once.

7. Store the resulting connection string directly in Secret Manager - **never** via `_push-env-vars` (that helper also writes a local `.env`, which is exactly what must never happen for `DATABASE_URL`). `secrets.mjs put` no longer accepts the value as an argv positional (it would sit in plaintext in the process list and shell history) - pipe it in instead:
   ```bash
   printf '%s' "<connection-string>" | node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" put DATABASE_URL --stdin
   ```

8. `cd packages/db && npx drizzle-kit generate` (writes the initial migration SQL, no connection). The actual apply happens on the next `/deploy`.

9. Jump straight to Step 4 (Update CLAUDE.md), passing `IS_MONOREPO=yes` to `_update-claude-md`.

---

## Step 3 - Run setup-db.mjs

Run the script from the `WEB_DIR`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-db.mjs" \
  --name "<PROJECT_NAME>" \
  --web-dir "<WEB_DIR>"
```

The script chains 6 sub-steps: preflight, provision the database (and wait until ready), create a dedicated IAM Application + policy + non-expiring API key, build `DATABASE_URL` and store it in Secret Manager, install the `pg` driver, swap the Drizzle client to `drizzle-orm/node-postgres`.

### During execution

The script displays in real time:
- `▸ <step>` when it starts each sub-step
- `✅ <result>` at the end of each one
- `⚠️ <warning>` for non-blocking warnings
- At the end (success OR failure), a structured **handoff banner**
- As the last line on success, a parseable JSON object: `{"success":true,"databaseId":"...","endpoint":"...","applicationId":"...","databaseName":"..."}`

Let the output stream through live (no `> /tmp/...`, no capture). The user wants to see the progress.

### If success

Mark the step ✅, capture `databaseId` and `endpoint` from the final JSON, and go to Step 4.

### If failure

1. **Read the detailed error**: just above the handoff banner.
2. **Identify the failed step** in the banner (`❌ Failed at: <step>`). The name maps 1:1 onto a function in the script - open `setup-db.mjs` and read the function to understand.
3. **Diagnose**:
   - `preflight` failed then usually missing Scaleway credentials (route to `/start`) or no Next.js / no Drizzle in the project (go back to Step 1).
   - `ensureDatabase` failed then a Scaleway API error provisioning the Serverless SQL Database (quota, transient API issue - the error message is shown as-is).
   - `ensureIamAccess` failed then an IAM error creating the Application/policy/key - check the operator's Scaleway credentials have IAM rights.
   - `storeSecret` failed then the database AND the IAM key exist, but the Secret Manager write failed (region mismatch, API error). The connection string was never persisted anywhere - retry the step by hand using `printf '%s' "<uri>" | node scripts/scaleway/secrets.mjs put DATABASE_URL --stdin` with a freshly rebuilt connection string (you'll need to mint a new IAM key, since the old one's secret was only ever held in memory - see `scripts/scaleway/iam.mjs create-key --reveal`).
   - `installDriver` failed then a pnpm error (network, registry). Retry by hand: `cd <WEB_DIR> && pnpm add pg && pnpm add -D @types/pg`.
   - `swapDriver` failed then T3 may have moved `src/server/db/index.ts`. Patch the file manually, following `templates/db/index.ts`.
4. **Continue** the remaining steps manually, taking inspiration from the script's functions.

---

## The `tryDb` resilience helper

`setup-db.mjs` also writes `src/server/db/safe.ts`, exporting `tryDb(fn, fallback)`: it runs `fn`, and on any error logs one `console.warn` line (never the connection string) and returns `fallback` instead of throwing. Stored data is an optimisation, not a dependency - route through `tryDb` any read whose value can be recomputed or safely defaulted (a list that can render empty, a counter, a recommendation). A genuine hard dependency (an auth lookup, a payment record) can stay a direct call, but it must render a clear error to the user, never crash the whole page.

---

## Step 4 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `stack`: `- **Database**: Scaleway Serverless SQL Database (PostgreSQL 16, region fr-par)`
- `commands`:
  - `- \`pnpm db:generate\` - After editing the schema, generate the migration SQL file locally (safe: no database connection). Applying it to the real database happens automatically on the next \`/deploy\`.`
- `env-vars`: `- \`DATABASE_URL\` - Scaleway Serverless SQL connection string (IAM-authenticated, stored in Secret Manager only - never in a local .env, never logged)`
- `conventions`:
  - `- Data: Optimistic UI - the interface updates reactively right away, the database syncs in the background. Never block the UI waiting for the server response.`
  - `- Migrations: never run \`drizzle-kit push\`, \`drizzle-kit studio\`, or \`drizzle-kit migrate\` locally - there is no DATABASE_URL on this machine and there never should be. After editing \`schema.ts\`, run \`pnpm db:generate\`, commit the generated SQL file, then \`/deploy\` - the migration Serverless Job applies it.`
  - `- Serverless SQL constraints: session \`SET\`/\`search_path\` leak across the shared connection pool - wrap any statement that relies on them in a transaction. 1 MB max SQL statement size. No temp tables. No \`CREATE DATABASE\` / \`CREATE ROLE\` via SQL. PostgreSQL version is pinned to 16 and Scaleway-controlled (no manual upgrade).`
  - If `IS_MONOREPO=yes`, also add: `- DB: import from \`@<PROJECT_NAME>/db\`, never a relative cross-app path.`

The helper is idempotent - re-running `/add-db` won't duplicate existing lines.

---

## Automatic backups (nothing to configure)

**Verified** against Scaleway's own documentation (https://www.scaleway.com/en/docs/serverless-sql-databases/how-to/manage-backups/, "How to manage backups for Serverless SQL Databases"), which states verbatim: *"Serverless SQL Databases are automatically backed up every day at the same time. Backups are stored for 7 days."* So: Scaleway Serverless SQL Database backs itself up automatically - a daily snapshot, 7-day retention, at no extra cost. There is no on/off switch and no separate API to call: unlike the database provider this skill used to target, there is no backup-activation step at all here. Mention this in the Step 6 summary; do not offer an "enable backups" action because none exists.

**On-demand backup CREATION does not exist** - if the user asks for a fresh backup right before a risky operation (e.g. before choice 2 in the Step 0 menu), be upfront that there is no API or console button to trigger one on demand; the daily snapshot is the only one that will ever exist for a given day.

**On-demand RESTORE does exist**, from an already-taken backup, but only through the Scaleway console (not through this skill or any script in this harness): the same documentation page describes restoring a database to a previous state, creating a new database from a specific backup, or exporting a backup as a `.pg_dump` file. If a user needs this, tell them plainly that it's a manual action in the console (link: https://console.scaleway.com) - do not attempt to script or automate it.

---

## RGPD - Privacy policy

Add Scaleway Serverless SQL Database to the project's RGPD subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add scaleway-sdb
```

The helper is idempotent. If the `politique-de-confidentialite/page.tsx` page exists (created by `/bootstrap`), it updates automatically from the registry. If the page doesn't exist (pre-bootstrap project), only the registry is created - `/rgpd-audit` can generate the page retroactively.

---

## Step 5 - Nothing runs against the database from here

Before the summary: double-check that nothing you (or a prior step) did in this run opened a connection. If `check-deps db` was re-run after provisioning and you're tempted to "just verify it works" with a quick `psql` or `drizzle-kit studio` - don't. The only verification that matters is the migration Job succeeding on the next `/deploy`; that's the sole place a connection is allowed to happen (CONTRACT.md §1, §4).

---

## Step 6 - Summary

Tell the user:
- The database is provisioned and connected (region: France - `fr-par`)
- It autoscales between **0 and 5 vCPU**: it sleeps and costs nothing when idle, and 5 vCPU caps what a traffic spike can cost. `/scale` can change both bounds later (up to Scaleway's maximum of 15).
- Drizzle ORM is wired onto `pg` (`drizzle-orm/node-postgres`)
- The connection string is stored securely (Scaleway Secret Manager) - never on this computer, never in a file you could accidentally commit
- Commands: `pnpm db:generate` after changing the schema (safe, no connection); the change goes live on the next deploy
- **Automatic backups**: *"✅ Automatic daily backups, 7-day retention, included at no extra cost - nothing to configure."*

If any warnings were raised by the script, mention them here.
