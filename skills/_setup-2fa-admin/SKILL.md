---
name: _setup-2fa-admin
description: Internal. Sets up 2FA (TOTP) on a baudrier admin-credentials login - mandatory for the single admin. TOTP code after the password, trusted-device cookie (24h), backup codes, idle auto-logout. The TOTP secret + backup codes are written to Scaleway Secret Manager (never the chat). Invoked by /add-2fa when the project is in admin mode. Not meant to be invoked directly by users.
argument-hint: ""
user-invocable: false
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Setup 2FA - Admin mode

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Sets up 2FA on a baudrier **admin** login. The deterministic core (install, generation of the secret + codes, writing the code, Secret Manager storage, env push) lives in `scripts/setup-2fa.mjs`. This skill handles the pre-flight (Scaleway credentials), the invocation, mounting the auto-logout, and the summary.

**Input variables** (passed by `add-2fa`): `PROJECT_NAME`, `WEB_DIR`, `AUTH_APP`.

---

## Step 1 - Prerequisites

The 2FA secret + the codes are stored in Scaleway Secret Manager, in the app's own Project - the same credentials the harness already uses for provisioning (`SCW_ACCESS_KEY` / `SCW_SECRET_KEY` / `SCW_DEFAULT_PROJECT_ID`). No unlock step is needed: if those credentials are missing, `scripts/setup-2fa.mjs` fails fast during preflight with a clear error, and falls back to a gitignored file if Secret Manager itself is unreachable (non-blocking).

---

## Step 2 - Run the install

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-2fa.mjs" \
  --name "<PROJECT_NAME>" \
  --issuer "<PROJECT_NAME capitalized>" \
  --web-dir "<WEB_DIR>"
```

8 sub-steps (preflight, install otpauth + qrcode, TOTP secret, backup codes, writing the code, **storage in Scaleway Secret Manager** + scan QR, push of the environment variables, `pnpm tsc --noEmit` sanity check). Ends with a handoff banner + JSON:
`{"success":true,"storedIn":"secretmanager|file","secretName":"<NAME>_2FA","qrPath":"…/.2fa-setup/qrcode.png","tscOk":true,"warnings":[]}`

Relay it in plain language (`↳ Generating your secret…`, `↳ Storing your keys securely…`).

`tscOk` reports the `pnpm tsc --noEmit` result. `success:true` with `tscOk:false` means the work
is NOT done: read the tsc output printed above the JSON, then fix the errors, or, if they are
pre-existing and unrelated to `/add-2fa`, say so plainly to the user. Do not summarise success
before this check. Relay any relevant entries from `warnings` to the user in plain language.

**On success**: capture `storedIn`, `secretName`, `qrPath`. Move on to Step 3.

**On failure**: read the error above the banner (`❌ Failed at: <step>`, maps 1:1 to a function in `setup-2fa.mjs`). Causes: preflight (no admin auth / 2FA already present), install (pnpm/network), env push. If `src/lib/rate-limit.ts` was missing (a project that ran `/add-auth` outside of bootstrap), the script **creates a minimal one automatically** while writing the code: no more broken build. `tscCheck` failed → the project does not compile - read the tsc output; the code is all written, so continue manually from there.

---

## Step 3 - Mount the auto-logout (contextual edit)

The script created `src/components/dashboard/idle-timeout.tsx` but did not mount it. In `<WEB_DIR>/src/app/admin/(protected)/layout.tsx`:
1. `import { IdleTimeout } from "~/components/dashboard/idle-timeout";`
2. Mount `<IdleTimeout />` right before `{children}` (adapt to the actual wrapper; `<><IdleTimeout />{children}</>` if the layout returns `<>{children}</>`).

Verify: `cd <WEB_DIR> && pnpm tsc --noEmit` then `pnpm lint`.

---

## Step 4 - Update CLAUDE.md

Invoke `_update-claude-md`:
- `env-vars`: `- \`ADMIN_TOTP_SECRET\` - TOTP secret for admin 2FA` ; `- \`ADMIN_2FA_BACKUP_HASHES\` - hashed backup codes (JSON)`
- `custom` heading `## Two-factor authentication (2FA)`, body:
  ```
  Admin login = password + 2FA (TOTP code).
  - `loginAction` (`src/app/admin/signin/actions.ts`) = single entry point (password + 2nd factor + trust cookie + signed proof → signIn). NextAuth `authorize` validates the proof (`verifyLoginProof`).
  - TOTP: `src/lib/auth-2fa.ts`, secret `ADMIN_TOTP_SECRET`. Codes: `src/lib/auth-backup-codes.ts`, hashed `ADMIN_2FA_BACKUP_HASHES`.
  - Trusted device: 24h cookie. Idle logout: `IdleTimeout` (30 min). Session 8h.
  - Secret + codes in plain text: in Scaleway Secret Manager (secret `<PROJECT>_2FA`, app's own Project). To regenerate: delete `src/lib/auth-2fa.ts` then re-run `/add-2fa`.
  ```

---

## Step 5 - Final summary (tailored to the app)

> ## ✅ Two-factor authentication enabled
>
> Logging in as admin will now require **your password + a 6-digit code** from **<AUTH_APP>**.
>
> **To do now (one time):**
> 1. Your TOTP key and your 8 backup codes are stored encrypted in Scaleway Secret Manager (secret **`<secretName>`**, in your project), never displayed in the chat.
> 2. In **<AUTH_APP>**, add the entry: either by **scanning** the QR (`<qrPath>`), or by pasting the **key** from Secret Manager (Scaleway console → Secret Manager → `<secretName>`).
> 3. Keep the **backup codes** handy (they are already in Secret Manager) in case you lose your phone.
> 4. Once enrolled, **delete the `.2fa-setup/` folder** (it only contains the scan QR; already ignored by git). Tell me "delete the 2FA folder" and I'll do it.
>
> After that: password + code from <AUTH_APP>. For 24h on this browser, only the password will be asked again; auto-logout after 30 min of inactivity.

**If `storedIn = "file"`** (Secret Manager unreachable at install time): replace point 1 with *"open `<folder>/secrets.txt`, save the key + the codes in your password manager, then delete the `.2fa-setup/` folder"*.

⚠️ Never re-display the secret or the codes in the chat - they are in Secret Manager (or the file).
