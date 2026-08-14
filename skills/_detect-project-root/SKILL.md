---
name: _detect-project-root
description: Internal helper to detect the basic structure of the current project (project name, monorepo vs single app, web directory path, Next.js detection, stack type). Returns a minimal set of 5 variables that most add-* skills need at the very beginning of their execution. Idempotent and fast. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# Detect Project Root - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You detect the basic structure of the current project and return a minimal set of variables that the caller can reuse. You work silently, without bothering the user unless the project cannot be detected.

---

## What this helper returns

A 5-variable snapshot:

| Variable | Possible values | Used by |
|---|---|---|
| `PROJECT_NAME` | `my-app`, `mon-app`, etc. | Everything: Scaleway resource naming (Serverless Container/namespace, Object Storage bucket, Serverless Job, IAM application - all go through `slugify(PROJECT_NAME)`, see `scripts/scaleway/_scw-auth.mjs#slugify`), monorepo packages, etc. |
| `WEB_DIR` | `.` (single app) or `apps/web` (monorepo) | Most `add-*` skills (any skill that edits files inside the Next.js app) - e.g. add-db, add-cron, add-auth |
| `IS_MONOREPO` | `yes` / `no` | add-automation, add-db, and any skill that branches on monorepo layout |
| `IS_NEXTJS` | `yes` / `no` | All add-* skills (to refuse if the project is not Next.js). Kept exactly as-is for the 22 existing callers that read it |
| `PROJECT_TYPE` | `landing` / `application` / `unknown` | The shared refusal gate (project-scoped skills that only support applications), and the supported skills that branch on the stack (save-project, costs, delete-project, add-domain, add-analytics, add-dark-mode, seo, seo-perf, geo, rotate-secret) |

**This is intentionally minimal.** Specific checks like `HAS_DB`, `HAS_AUTH`, `HAS_TEM` remain inline in the skills that need them - they are contextual and shouldn't pollute every skill's context.

---

## Step 1 - Detect monorepo vs single app

```bash
test -d apps/web && echo "monorepo" || echo "single"
```

Set `IS_MONOREPO` accordingly:
- `monorepo` → `IS_MONOREPO=yes`, `WEB_DIR=apps/web`
- `single` → `IS_MONOREPO=no`, `WEB_DIR=.`

## Step 2 - Read the project name

For **single app** (`WEB_DIR=.`):
```bash
node -e "process.stdout.write(require('./package.json').name)"
```

For **monorepo** (`WEB_DIR=apps/web`):
- Try the root `package.json` first (Bootstrap's convention is that the root package has the "real" project name):
  ```bash
  node -e "process.stdout.write(require('./package.json').name)"
  ```
- If the root name contains `-monorepo` suffix (e.g. `mon-app-monorepo`), strip it to get the logical project name.
- Fallback: read `apps/web/package.json` if root is missing.

Set `PROJECT_NAME`.

## Step 3 - Verify Next.js

```bash
node -e "const p=require('./WEB_DIR/package.json'); process.stdout.write(p.dependencies?.next || p.devDependencies?.next || 'none')"
```

Replace `WEB_DIR` with the detected value. If the output is `none`, set `IS_NEXTJS=no`. Otherwise `IS_NEXTJS=yes`.

## Step 4 - Detect the stack

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/_stack.mjs"
```

Parse the one JSON line on stdout, e.g. `{"stack":"landing"}`. Set `PROJECT_TYPE` from its `stack` field (`landing` / `application` / `unknown`).

## Step 5 - Sanity check

If `PROJECT_NAME` is empty or `PROJECT_TYPE=unknown`:

Tell the user:
> I cannot detect a project in the current folder. Check that:
> - You are at the root of the project (or in `apps/web` / another T3 folder)
> - A `package.json` exists and lists `next` (application web) or `astro` (site vitrine) as a dependency
>
> If this is a new project, run `/bootstrap` first.

Then return an error state to the caller (so it can abort).

## Step 6 - Return the snapshot

Report to the caller in this exact format so it can parse the values:

```
PROJECT_NAME=<value>
WEB_DIR=<value>
IS_MONOREPO=<yes|no>
IS_NEXTJS=<yes|no>
PROJECT_TYPE=<landing|application|unknown>
```

Example success output:
```
PROJECT_NAME=mon-app
WEB_DIR=apps/web
IS_MONOREPO=yes
IS_NEXTJS=yes
PROJECT_TYPE=application
```

The caller reads these 5 lines and uses them throughout its own execution without having to redetect anything.

---

## When to invoke this helper

Every `add-*` skill should call this in Step 1 (or wherever it currently does `test -f package.json`), **replacing** the ad-hoc detection code. The invocation is a single line:

> Invoke `_detect-project-root` to get PROJECT_NAME, WEB_DIR, IS_MONOREPO, IS_NEXTJS, PROJECT_TYPE.

The helper is **idempotent** - calling it multiple times in the same session is fine (it just re-reads the filesystem).

## What this helper does NOT detect

These checks remain inline in the skills that need them, because they are contextual and used by only 1-2 skills each:

- `HAS_REAL_DB` - **mandatory robust check** (used by `add-auth` and any skill that needs a real cloud DB): (1) `DATABASE_URL` present in `.env`, AND (2) its value does not point to local and is not a placeholder - reject if the value matches `@localhost:` / `@127\.0\.0\.1:` / `placeholder` / `//postgres:postgres@` / `YOUR_DB` (bootstrapped T3 projects ship a default like `postgresql://postgres:password@localhost:5432/test` that passes Zod validation but is not wired up), AND its host matches the Scaleway Serverless SQL Database shape `*.pg.sdb.<region>.scw.cloud` (CONTRACT.md §4), AND (3) a `drizzle.config.ts`/`.js` exists (root, `apps/web/`, or `packages/db/`). NEVER rely on `grep DATABASE_URL .env` alone - guaranteed false positives. This exact heuristic lives in `scripts/check-deps.mjs`'s `db` check - prefer calling `_check-deps` over reimplementing it.
- `HAS_AUTH` - check `src/server/auth.ts` → used by several skills that need to know if auth is already installed (e.g. `add-2fa`, `add-role`, `add-agent-dashboard`)
- `HAS_TEM` - check `TEM_SENDER_EMAIL` presence (Scaleway TEM, see `_check-deps`'s `email` check) → used by `add-email` and `_create-contact-page`
- `CONTAINER_LINKED` - check whether a Serverless Container named after this app already exists → only used by `deploy`, `add-domain`, `_push-env-vars`. There is no linkage file: the harness resolves this app's Scaleway Project by name (app name = repo name; `SCW_DEFAULT_PROJECT_ID` overrides), then the namespace and the container inside it, also by name. `scripts/check-deps.mjs`'s `container` check and `scripts/push-env-vars.mjs` (to resolve which container's `secret_environment_variables` to update) both do this same by-name lookup.

Do not try to add these to `_detect-project-root`. The helper stays minimal.
