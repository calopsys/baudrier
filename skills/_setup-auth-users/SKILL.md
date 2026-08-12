---
name: _setup-auth-users
description: Internal helper - sets up NextAuth in user-credentials mode (DB-backed email+password auth with signup, signin, account page with delete, and optional forgot/reset password if email is configured). Invoked by add-auth when the user chose the "system for users" option. Credentials-only, no OAuth add-ons. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Setup Auth - User-credentials mode

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Installs NextAuth in **users mode**: real accounts in the DB, signup/signin/account with delete, shadcn UI pages. If email is configured, it also adds forgot-password and reset-password.

The deterministic code (install deps, patch schema + migration generation, generation of `auth.ts` / `password.ts` / tRPC router / API route / UI pages, patches to `trpc.ts` to add `rateLimitedProcedure` + `protectedProcedure` if missing) lives in `scripts/setup-auth-users.mjs`. This SKILL only handles launching the script, the optional integration of the UserMenu into the layout (contextual, non-scriptable patch), CLAUDE.md, and the final summary.

**Input variables** (passed by `add-auth`): `WEB_DIR`, `IS_MONOREPO`, `PROJECT_NAME`.

⚠️ **Fresh install only** - the script refuses if `src/server/auth.ts` already exists. The "add users on top of an existing admin" case is driven by Claude from `add-auth` Step 0, NOT by this skill.

---

## Step 1 - Launch the script

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-auth-users.mjs" \
  --name "<PROJECT_NAME>" \
  --web-dir "<WEB_DIR>"
```

The script runs 16 sub-steps: preflight (refuses if `auth.ts` exists), email detection (via `_check-deps email`), install `next-auth@beta` + `@auth/drizzle-adapter`, AUTH_SECRET generation, schema patch (imports `pgTable/text/integer/primaryKey/index` + `AdapterAccount` type, append 4 NextAuth tables + optional `password_reset_tokens` if email), `drizzle-kit generate` (writes the SQL migration, no DB connection - applied by the next `/deploy`), write `password.ts`, write `auth.ts` (marker `// baudrier:auth-modes users`, `Session.user.id` non-nullable via module augmentation), creation of `rate-limit.ts` + `rateLimitedProcedure` if missing (standalone case), adding `protectedProcedure` to `trpc.ts` if missing, write tRPC router (variant chosen based on `emailOk`: `auth-router.ts` or `auth-router-with-reset.ts`, the latter sending via Scaleway Transactional Email), register `authRouter` in `root.ts`, write API route with rate limiting, write pages (signin/signup/dashboard/account + forgot-password/reset-password if email), push AUTH_SECRET, `pnpm tsc --noEmit` sanity check.

### During execution

The script prints live:
- `▸ <step>` then `✅ <result>` / `⚠️ <warning>` (notably if `rate-limit.ts` is created in standalone)
- At the end, a structured **handoff banner** (16/16 sub-steps expected)
- On the last line on success, a parseable JSON object:
  ```json
  {"success":true,"authMode":"users","emailReset":bool,"emailProvider":"tem|none","envVars":["AUTH_SECRET"],"tscOk":true,"warnings":[]}
  ```

`tscOk` reports the `pnpm tsc --noEmit` result. `success:true` with `tscOk:false` means the work
is NOT done: read the tsc output printed above the JSON, then fix the errors, or, if they are
pre-existing and unrelated to `/add-auth`, say so plainly to the user. Do not summarise success
before this check. Relay any relevant entries from `warnings` to the user in plain language.

### On success

Capture `emailReset` and `emailProvider` from the JSON for the summary. Move on to Step 2.

### On failure

1. Read the error just above the handoff banner.
2. Identify the failed step (`❌ Failed at: <step>`). Open `setup-auth-users.mjs` and look at the matching function.
3. Diagnose:
   - `preflight` failed → `auth.ts` exists (re-config) → go back to the Step 0 menu of `add-auth`. Or a collision on a UI file / `password.ts` (delete manually if you want).
   - `installDeps` failed → pnpm/network error → manual retry: `cd <WEB_DIR> && pnpm add next-auth@beta @auth/drizzle-adapter`.
   - `patchSchema` failed → T3 reorganized the schema, or `schema.ts` still uses `pgTableCreator` instead of the plain `pgTable` convention (CONTRACT.md §4) → fix manually and rerun.
   - `generateMigration` failed → `schema.ts` doesn't compile for drizzle-kit (the step opens no DB connection, so `DATABASE_URL` is never the cause) → fix the schema then `cd <WEB_DIR> && npx drizzle-kit generate` by hand.
   - `writeAuthRouter` / `writeAuthTs` / other `write*` failed → filesystem permission (rare).
   - `pushEnvVars` failed → all the code is in place, only AUTH_SECRET didn't land → rerun manually with the value visible in the logs.
   - `tscCheck` failed → the project does not compile → read the tsc output; the code is all written, so continue manually from there.
4. Continue manually.

---

## Step 2 - Integrate a UserMenu into the layout (best-effort, contextual)

The script generates 4 functional auth pages (`/signin`, `/signup`, `/dashboard`, `/account`) but CANNOT infer where in the layout to show a user menu (avatar + dashboard link / sign out) - the structure of the `<header>` or `<nav>` varies from project to project.

Read `<WEB_DIR>/src/app/layout.tsx`. Look for a `<header>`, `<nav>`, or a dedicated `Header.tsx` component. If you find a clear spot:

1. **Read the existing code** to understand the style (server vs client component, Tailwind classes used, structure).
2. **Add** a block in the top-right corner that shows, based on `useSession()`:
   - **Logged out**: 2 discreet `<LinkButton>` - "Sign in" (`/signin`) + "Create an account" (`/signup`).
   - **Logged in**: a shadcn `<DropdownMenu>` with avatar/initials, and 2 items: "My account" (`/account`) + "Sign out" (triggers `signOut` + redirect `/`).
3. **Check the build**: `cd <WEB_DIR> && pnpm tsc --noEmit`.

If the layout has no `<header>` or if the structure is not obvious, do NOT force the integration. Just mention in the final summary that the `/signin` and `/signup` pages exist and are accessible directly by URL - the user can ask later *"add a sign-in menu to my header"* once they have a layout in place.

---

## Step 3 - Update CLAUDE.md

Invoke `_update-claude-md` with:

- `stack`: `- **Auth**: NextAuth v5 (users mode - email+pwd accounts hashed with scrypt in DB, credentials-only)`
- `conventions`:
  - `- Auth users: \`await auth()\` from \`~/server/auth\` for the session. \`protectedProcedure\` in tRPC for routes that require a logged-in user. \`session.user.id\` is guaranteed non-null thanks to the module augmentation in \`auth.ts\`.`
  - `- Passwords: scrypt with N=32768 (the cost is embedded in each hash, so old hashes keep verifying). Do not raise N without raising the container memory via /scale: each in-flight hash needs 128*N*r bytes, and the default container has 512 MB for 8 concurrent requests.`
- `custom`:
  - heading: `## User authentication`
  - body:
    ```
    User accounts are stored in the DB (table `user`), with the password as a scrypt hash in `password_hash`.

    Pages: `/signin`, `/signup`, `/dashboard` (post-signin landing), `/account` (account deletion).
    {{IF_EMAIL_OK}}Forgot password pages: `/forgot-password` + `/reset-password` (scrypt-hashed tokens in table `password_reset_token`, 1h expiry, single use).{{/IF_EMAIL_OK}}

    tRPC `auth` router: `signup`, `deleteAccount`{{IF_EMAIL_OK}}, `requestPasswordReset`, `resetPassword`{{/IF_EMAIL_OK}}. All rate-limited by IP.

    To add a user directly (troubleshooting): `printf '%s' "<password>" | node "<plugin>/scripts/hash-password.mjs"` (output = `salt:hash`), then `INSERT INTO "user" (id, email, password_hash, name) VALUES (gen_random_uuid()::text, '<email>', '<salt:hash>', '<name>')`.
    ```
- `env-vars`:
  - `- \`AUTH_SECRET\` - NextAuth session secret`

(Substitute `{{IF_EMAIL_OK}}...{{/IF_EMAIL_OK}}` based on `emailReset` from the Step 1 JSON - if `false`, remove the segments between the markers; if `true`, keep the content without the markers.)

---

## Step 4 - Summary to the user

Show (adapting based on `emailReset`):

> ## ✅ User authentication is in place
>
> Your users can now create an account and sign in.
>
> **Ready-to-use pages**:
> - `/signup` - Sign up (email + password + optional name)
> - `/signin` - Sign in
> - `/dashboard` - Home page after sign-in
> - `/account` - Account management (sign out + delete)
> {{IF_EMAIL_OK}}- `/forgot-password` - Request a reset by email
> - `/reset-password` - Set a new password via the link received by email{{/IF_EMAIL_OK}}
>
> **Security**:
> - Passwords hashed with scrypt (never stored in plain text).
> - Rate limiting on signin, signup{{IF_EMAIL_OK}}, and the reset password flows{{/IF_EMAIL_OK}}.
> - Anti-enumeration on signup / forgot-password (impossible to discover whether an email already exists).
>
> **On the code side**:
> - To protect a server page: `const session = await auth(); if (!session?.user) redirect("/signin")`.
> - For a tRPC route that requires a logged-in user: use `protectedProcedure` instead of `publicProcedure`.
>
> {{IF_NOT_EMAIL_OK}}**The "forgot password" flow is disabled** because no email service is configured. If you want to enable it, tell me *"set up emails"* (runs `/add-email`) then *"enable forgot password"* - I'll update the routes and create the pages.{{/IF_NOT_EMAIL_OK}}
>
> {{IF_USER_MENU_NOT_INTEGRATED}}**Note**: the sign-in menu is not yet visible in your site's header (your layout's structure didn't allow it automatically). When you're ready, tell me *"add a sign-in menu to my header"*.{{/IF_USER_MENU_NOT_INTEGRATED}}

If the script reported any warnings (e.g. `rate-limit.ts` created in standalone), mention them here.

This harness is credentials-only (no OAuth providers) - there is no follow-up offer to make once the summary is shown.
