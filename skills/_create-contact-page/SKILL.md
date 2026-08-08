---
name: _create-contact-page
description: Internal helper - creates a functional /contact page with a secured form (honeypot anti-spam, rate limiting delegated to the tRPC procedure, HTML injection protection). Detects the email setup (Scaleway TEM) and shadcn/ui + react-hook-form deps. Invoked by /add-email or any future skill that needs to add a contact UI. Not meant to be called directly by users.
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Create Contact Page - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Creates a functional `/contact` page with a secured form (invisible honeypot anti-spam, server-side rate limiting, HTML escaping on every user field). Invoked by `/add-email` after the user has accepted the offer to create it.

**Expected prerequisites** (normally guaranteed by the calling skill):
- The tRPC procedure `contact.send` exists (created by `add-email`, backed by Scaleway TEM)
- The `mail.ts` utility exports `sendMail` + an `escapeHtml` helper
- shadcn/ui is installed (via `/bootstrap`)

---

## Step 1 - Detect the project context

Invoke `_detect-project-root` to retrieve `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO`, `IS_NEXTJS`.

Invoke `_check-deps email`:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" email)
email_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.ok)")
```

**If `email_ok !== "true"`** -> abort: the contact page depends on a functional email backend (Scaleway TEM). Inform the calling skill and create nothing.

Also retrieve the current sender email from the local env (useful for Step 2):

```bash
CURRENT_SENDER=$(grep -E "^TEM_SENDER_EMAIL=" .env 2>/dev/null | head -1 | sed -E "s/^TEM_SENDER_EMAIL=//" | tr -d '"' | tr -d "'")
```

### Determine a functional default for receiving

The goal: a default that **actually works** for receiving the emails. `CURRENT_SENDER` is a domain verified with TEM (`/add-email`'s `ensureDomain`/`checkDomain` flow), so it is a reasonable default to propose - unless it looks like a no-reply address (e.g. starts with `noreply@`/`no-reply@`), in which case ask directly instead of guessing.

---

## Step 2 - Ask for the receiving email address

Propose `$CURRENT_SENDER` as the default if it is defined and does not look like a no-reply address.

Ask the user (plain language, no jargon):

> ## 📬 Which address do you want to receive the form messages at?
>
> When someone fills out your contact form, their message is sent to you by email. Tell me where you want to receive them:
>
> - **By default**: at `<DEFAULT_RECIPIENT>` (the sending address you just configured)
> - **Another address**: give me another address (e.g. your personal Gmail `me@gmail.com`)
>
> Tell me *"leave the default"* or type the address you want.

### Depending on the answer

Whatever the choice, **always store** `CONTACT_RECIPIENT_EMAIL` (we do not rely on the tRPC procedure fallback for the nominal case - the fallback remains only a safety belt):

**If "leave the default"** -> `RECIPIENT = $DEFAULT_RECIPIENT`.

**If the user gives a different address** -> `RECIPIENT = <provided address>`. Quickly validate that it looks like an email (contains `@` and at least one `.` after it). If invalid, ask again.

Then in both cases, store it as a project-specific secret (Scaleway Secret Manager, this app's own Project) and mirror it to the local `.env`:

```bash
node -e "
import('${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs').then(({ putSecret }) => putSecret('CONTACT_RECIPIENT_EMAIL', process.argv[1]));
" "$RECIPIENT"
```

The tRPC procedure `contact.send` reads `process.env.CONTACT_RECIPIENT_EMAIL` (populated in the container via `secret_environment_variables` at deploy time, see CONTRACT.md §1).

---

## Step 3 - Install the missing deps

### 3.a - react-hook-form + zod

Check in `<WEB_DIR>/package.json`:

```bash
grep -qE '"(react-hook-form|@hookform/resolvers|zod)"' "<WEB_DIR>/package.json"
```

If any of the three is missing, install:

```bash
cd <WEB_DIR> && pnpm add react-hook-form @hookform/resolvers zod
```

### 3.b - Required shadcn/ui components

The page needs: `card`, `input`, `textarea`, `button`, `label`, `alert`. Check that each is present in `<WEB_DIR>/src/components/ui/`:

```bash
for c in card input textarea button label alert; do
  [ -f "<WEB_DIR>/src/components/ui/$c.tsx" ] || MISSING="$MISSING $c"
done
```

If `MISSING` is non-empty, install:

```bash
cd <WEB_DIR> && pnpm dlx shadcn@latest add$MISSING
```

---

## Step 4 - Copy the template

The template (hardcoded French copy - the app is French-only) lives at `templates/contact-page/plain.tsx` at the plugin root.

```bash
PLUGIN_ROOT="${CLAUDE_SKILL_DIR}/../.."
DEST="<WEB_DIR>/src/app/contact/page.tsx"
mkdir -p "$(dirname "$DEST")"
cp "$PLUGIN_ROOT/templates/contact-page/plain.tsx" "$DEST"
```

---

## Step 5 - Return to the calling skill

Do not display a clean summary (the calling skill produces its own final summary). Just confirm the path of the created page:

```
CONTACT_PAGE_CREATED: <DEST>
```

The calling skill will integrate this info into its user-facing summary.
