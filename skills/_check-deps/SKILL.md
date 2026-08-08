---
name: _check-deps
description: Internal helper to check project dependencies (DB, email, etc.) with robust heuristics that don't fall for T3 bootstrap placeholders or localhost defaults. Delegates to bundled scripts/check-deps.mjs. Returns JSON. Triggered by add-auth and any skill that needs to verify a real cloud dependency is wired up. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# Check Deps - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Check if a project has real cloud dependencies wired up (not just T3 defaults / placeholders). Delegates to a bundled Node script - never reimplement the checks inline.

## Env files read

The script merges all Next.js-style env files found at the cwd, with Next.js precedence (later overrides earlier) :

1. `.env`
2. `.env.development`
3. `.env.development.local`
4. `.env.local`

So a var set in **any** of these is detected - critical since some projects put `DATABASE_URL` in `.env.local` only.

The `scaleway` check is the one exception : `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` are **operator machine** credentials (CONTRACT.md §2), never read from these app-level `.env` files - resolution goes through the same `scripts/scaleway/_scw-auth.mjs#loadCredentials()` every `scripts/scaleway/*.mjs` module uses (process env, then the `scw` CLI config file).

## Invocation

From the project root :

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" <check1> [<check2> ...]
```

Output : JSON on stdout. Exit code is always 0 - parse the JSON to get per-check `ok` + `reason`.

## Supported checks

### `db` - real Scaleway Serverless SQL Database wired up

`ok: true` if and only if :
1. `DATABASE_URL` is present in `.env`
2. Its value matches NONE of the disqualifying patterns (case-insensitive) :
   - `@localhost:` (points to local)
   - `@127.0.0.1:` (same)
   - `placeholder` (the word, wherever it is)
   - `//postgres:postgres@` (typical T3/Docker default pair)
   - `YOUR_DB` (marker from `.env.example`)
   - `^file:` (local SQLite, not a cloud DB)
3. The host (the part between `@` and the next `/` or `:`) matches the Scaleway Serverless SQL Database shape : `*.pg.sdb.<region>.scw.cloud` (CONTRACT.md §4)
4. A `drizzle.config.ts` or `.js` exists at the root, in `apps/web/`, or in `packages/db/`

Fields returned : `{ ok, reason, host?, drizzleConfig? }`.

### `email` - Scaleway TEM configured

`ok: true` if `TEM_SENDER_EMAIL` is present in `.env`, is not a placeholder, and looks like a valid email address.

Fields returned : `{ ok, reason, provider?: "tem", sender?, senderName?: string|null }`.

### `auth` - NextAuth / auth lib installed & configured

`ok: true` if :
1. An auth file exists at one of these locations (at the root level OR prefixed by `apps/web/`) : `src/server/auth.ts`, `src/server/auth/index.ts`, `src/server/auth.config.ts`, `src/lib/auth.ts`, `src/lib/auth/index.ts`, `src/auth.ts`, `src/auth/index.ts`, `src/app/auth.ts`, `auth.ts`, `auth.config.ts`
2. A secret is present in the env : `AUTH_SECRET` OR `NEXTAUTH_SECRET`, and non-placeholder

The check also tries to **infer the mode** from the env : presence of `ADMIN_PASSWORD_HASH_DEV` or `_PROD` → `admin-credentials`, otherwise `user-credentials`.

Fields returned : `{ ok, reason, authFile?, secretVar?, mode?: "admin-credentials"|"user-credentials" }`.

### `scaleway` - operator Scaleway credentials configured AND valid

`ok: true` if and only if :
1. `SCW_ACCESS_KEY` and `SCW_SECRET_KEY` resolve via `loadCredentials()` (env var or `scw` CLI config file)
2. A real, live API call (a project-scoped Secret Manager list) succeeds with those credentials

This is the harness's documented gate before any Scaleway provider operation. Use it before any `scripts/scaleway/*.mjs` call whose failure would be confusing without this check first.

Fields returned : `{ ok, reason, source?, secretCount? }`.

### `container` - project linked to a Scaleway Serverless Container

`ok: true` if a Serverless Container named after this app exists in this app's Scaleway Project. There is no linkage file to read : the harness resolves the Project by name (app name = repo name; `SCW_DEFAULT_PROJECT_ID` overrides), then finds the namespace and the container inside it, also by name.

`push-env-vars.mjs` resolves the container the same way, by name, to know which container to push `secret_environment_variables` to.

Fields returned : `{ ok, reason, namespaceId?, productionContainerId?, previewBranches?: string[] }`.

### `github-repo` - project pushed to a GitHub remote

`ok: true` if `.git/config` contains a remote pointing to `github.com` (HTTPS or SSH). Parses the owner and the repo name.

Fields returned : `{ ok, reason, owner?, repo?, nameWithOwner? }`.

### `storage` - Scaleway Object Storage configured

`ok: true` if `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, and `STORAGE_SECRET_KEY` are all present and non-placeholders (CONTRACT.md §2 var names).

Also checks `STORAGE_REGION` : this harness only ever targets `fr-par`, so anything else (or an absent value) surfaces a `regionWarning` (string). `ok` stays `true` so as not to break existing setups - it is up to the consuming skill to surface the warning if relevant.

Fields returned : `{ ok, reason, bucket?, endpoint?: string|null, region?: string|null, publicUrl?: string|null, regionWarning?: string|null }`.

### `analytics` - Matomo configured

`ok: true` if `NEXT_PUBLIC_MATOMO_URL` is a valid URL and `NEXT_PUBLIC_MATOMO_SITE_ID` is a non-placeholder numeric id.

Fields returned : `{ ok, reason, matomoUrl?, siteId? }`.

### `dark-mode` - next-themes installed AND wired up

`ok: true` if `next-themes` is a dependency AND a `ThemeProvider` is mounted in a root layout (`src/app/layout.tsx`, `app/layout.tsx`, or the `apps/web/` equivalents). Also best-effort detects the Tailwind v4 `@custom-variant dark` in `globals.css`.

Fields returned : `{ ok, reason, packageJson?, layoutFile?, cssFile?, darkVariantConfigured? }`.

## Typical usage

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" db email)
# Parse with node -e (jq is not installed on the target machine)
db_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).db.ok)")
email_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.ok)")
```

## Rules

- **Always** use this helper when a skill's next step depends on a dependency being real (never `grep DATABASE_URL .env` inline - T3 placeholders systematically cause false positives).
- If a check returns `ok: false`, relay the `reason` to the user in plain language (translate from technical to non-tech - ex: *"DATABASE_URL points to localhost"* → *"your database points to your own computer, you need one reachable from the internet"*). Then offer to invoke the corresponding `add-*` skill via a natural-language prompt.
- Exit code is always 0 - the script never fails just because a check is negative. Only a truly malformed invocation (unknown flag, no checks given) exits non-zero.

## Extending

To add a new check, add a function in `scripts/check-deps.mjs` and wire it into the `dispatchers` table. Document the new check here in the "Supported checks" section. Keep heuristics encapsulated - never require callers to reimplement them.
