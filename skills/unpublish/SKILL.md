---
name: unpublish
description: Restore the VPN IP gate on the app, making it reachable only from the office VPN again (sets ACCESS_RESTRICTED to true on the Serverless Container and redeploys). Undoes /publish. Also warns that seo-perf, eco-audit, and gsc stop working while restricted, since they rely on Google fetching the public site. Use when the user says "unpublish", "restrict access again", "make it private", "/unpublish".
argument-hint: "[production|preview]"
allowed-tools: Bash AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use scw, gh."
---

# Unpublish

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You restore the app's IP allowlist gate, so it only answers requests coming from the office VPN again. This undoes `/publish`.

---

## Step 1 - Identify the environment

Invoke `_detect-project-root` to get `PROJECT_NAME`. If the user didn't specify which environment, ask via `AskUserQuestion`:
- Question: "Quel environnement voulez-vous rendre privé (VPN uniquement) ?"
- Options: `Production` / `Aperçu (branche actuelle)`

Resolve the container name: `<PROJECT_NAME>` for production, `<PROJECT_NAME>-preview-<slug-de-la-branche>` for a preview. For a preview, also keep the bare `<slug-de-la-branche>` itself - Step 3 needs it separately to name the branch's own `DATABASE_URL_PREVIEW_<SLUG>` secret.

---

## Step 2 - Warn and confirm

This is less risky than `/publish` (it restricts access rather than opening it), but still changes who can reach the site - confirm before acting:

> Je vais restreindre l'accès de **<environnement>** au VPN du bureau uniquement. Le site ne sera plus visible publiquement.
>
> ⚠️ Tant que c'est restreint, `seo-perf`, `eco-audit` et `gsc` ne peuvent plus fonctionner : ils ont besoin que Google puisse charger le site, ce qui devient impossible.
>
> Confirmez-vous ?

Use `AskUserQuestion` with options `Oui, restreindre` / `Non, annuler`.

---

## Step 3 - Flip the flag and redeploy

Same inline-import pattern as `/publish` (no dedicated script - this is a single field flip on `scripts/scaleway/container.mjs`/`scripts/scaleway/secrets.mjs`), with the opposite value. A container GET only ever returns argon2 hashes of secret values, never plaintext, so `syncContainerSecrets` always writes the COMPLETE map rebuilt from Secret Manager - production stores `ACCESS_RESTRICTED` in Secret Manager first, a preview passes it as a container-only `overrides` entry plus `databaseUrlFrom` for the branch's own database (same reasoning as `/publish`, see its Step 4):

```bash
CONTAINER_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" \
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
PROJECT_NAME="<PROJECT_NAME>" \
CONTAINER_NAME="<resolved container name from Step 1>" \
TARGET="<production|preview>" \
BRANCH_SLUG="<slug-de-la-branche, preview only, empty for production>" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { ensureNamespace, findContainerByName, syncContainerSecrets } =
  await import(pathToFileURL(process.env.CONTAINER_MJS).href);
const { putSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
const ns = await ensureNamespace(process.env.PROJECT_NAME);
const container = await findContainerByName(ns.id, process.env.CONTAINER_NAME);
if (!container) {
  console.log(JSON.stringify({ ok: false, error: "container_not_found", name: process.env.CONTAINER_NAME }));
  process.exit(1);
}
let ready;
if (process.env.TARGET === "preview") {
  const dbSecret = `DATABASE_URL_PREVIEW_${process.env.BRANCH_SLUG.toUpperCase().replaceAll("-", "_")}`;
  ready = await syncContainerSecrets(container.id, {
    // APP_URL override: the map is built from Secret Manager, whose APP_URL
    // is production's - the preview must keep its own domain.
    overrides: { ACCESS_RESTRICTED: "true", APP_URL: `https://${container.domain_name}` },
    databaseUrlFrom: dbSecret,
  });
} else {
  await putSecret("ACCESS_RESTRICTED", "true");
  ready = await syncContainerSecrets(container.id, {});
}
console.log(JSON.stringify({ ok: true, status: ready.status, url: ready.domain_name ? `https://${ready.domain_name}` : null }));
'
```

- **If `container_not_found`**: tell the user to run `/deploy` first - there's nothing to restrict yet.
- **If it throws**: relay the error plainly.

---

## Step 4 - Confirm to the user

On success:
> ✅ L'accès à **<environnement>** est de nouveau restreint au VPN.
>
> Le site n'est plus visible publiquement. Vous pouvez le republier à tout moment avec `/publish`.

Remind the user that `seo-perf`, `eco-audit`, and `gsc` won't work correctly until the app is published again - they should expect those tools to report the restricted state rather than a spurious failure (per the app's own `proxy.ts`, which is IP-restriction aware).
