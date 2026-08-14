---
name: publish
description: Make the app publicly reachable on the internet by disabling the VPN IP gate (sets ACCESS_RESTRICTED to false on the Serverless Container and redeploys). Required before seo-perf, eco-audit, or gsc can work, since those rely on Google actually fetching the public site. ALWAYS warns clearly and asks for confirmation first, since this removes the app's only access restriction. Use when the user says "publish", "make it public", "open access to everyone", "/publish".
argument-hint: "[production|preview]"
allowed-tools: Bash AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use scw, gh."
---

# Publish

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You remove the app's IP allowlist gate so **anyone on the internet** can reach it. This is a meaningful, security-relevant change - never apply it silently.

Every app ships IP-restricted by default (only the office VPN can reach it, via an application-level check in `proxy.ts` - a soft boundary, not a network firewall). `/publish` flips that off.

En Cas B, l’application tourne avec la clé Scaleway propre à l’environnement cloud, par conception. Il n’y a donc rien à basculer avant la publication.

---

## Step 1 - Identify the environment

Invoke `_detect-project-root` to get `PROJECT_NAME`. If the user didn't specify which environment, ask via `AskUserQuestion`:
- Question: "Quel environnement voulez-vous rendre public ?"
- Options: `Production` / `Aperçu (branche actuelle)`

Resolve the target: production is the container named `<PROJECT_NAME>`; a preview's name is computed inside the snippet below by `previewContainerName` (the canonical `<PROJECT_NAME>-preview-<slug>` shape, bounded to Scaleway's 34-char container name limit - never assemble it by hand). For a preview, keep the bare `<slug-de-la-branche>` itself - it names the branch's own `DATABASE_URL_PREVIEW_<SLUG>` secret and feeds the snippet.

---

## Step 2 - Warn clearly and confirm [MANDATORY, NEVER SKIP]

🚨 **Display this warning, in French, before doing anything.** Do not paraphrase it away or shorten it into a single line - the user must understand exactly what changes.

> ⚠️ **Rendre le site public**
>
> En publiant, votre site devient accessible à **n'importe qui sur internet**, plus seulement depuis le VPN du bureau. Ce n'est pas juste une visibilité "publique-mais-discrète" : n'importe qui avec le lien peut consulter le site.
>
> C'est aussi une étape **nécessaire** pour que certains outils fonctionnent : `seo-perf`, `eco-audit` et `gsc` ont besoin que Google puisse réellement charger le site - tant qu'il est restreint au VPN, ces analyses échouent (ou seraient faussées).
>
> Confirmez-vous la publication ?

Use `AskUserQuestion` with options `Oui, publier` / `Non, annuler`. **Do not proceed without an explicit "Oui".**

---

## Step 3 - Flip the flag and redeploy

There is no dedicated script for this (it's a single field flip, reusing `scripts/scaleway/container.mjs` and `scripts/scaleway/secrets.mjs` directly) - use the same cross-platform-safe inline-import pattern used elsewhere in this harness (`node --input-type=module -e` + `pathToFileURL`, never a bare relative `import` which breaks depending on the shell's cwd).

A container GET only ever returns argon2 hashes of secret values, never plaintext - so a container's current secrets can never be read back and merged client-side. Secret Manager is the only readable source of truth, and `syncContainerSecrets` always writes the COMPLETE map, rebuilt from Secret Manager, in one PATCH. **Production** and **preview** are therefore handled differently:

- **Production**: `ACCESS_RESTRICTED` is production's own canonical value, so store it in Secret Manager first (`putSecret`), then sync the container with no overrides - the fresh value is already inside the map `syncContainerSecrets` builds.
- **Preview**: a preview container's `ACCESS_RESTRICTED` is a container-only override, never written to Secret Manager (that value belongs to production). Pass it via `overrides`, together with `databaseUrlFrom` naming the branch's own `DATABASE_URL_PREVIEW_<SLUG>` secret (same slug already resolved in Step 1) - otherwise the sync would fall back to the default `DATABASE_URL` key, which is production's database.

```bash
CONTAINER_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" \
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
PROJECT_NAME="<PROJECT_NAME>" \
TARGET="<production|preview>" \
BRANCH_SLUG="<slug-de-la-branche, preview only, empty for production>" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { ensureNamespace, findContainerByName, previewContainerName, syncContainerSecrets } =
  await import(pathToFileURL(process.env.CONTAINER_MJS).href);
const { putSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
const ns = await ensureNamespace(process.env.PROJECT_NAME);
const containerName = process.env.TARGET === "preview"
  ? previewContainerName(process.env.PROJECT_NAME, process.env.BRANCH_SLUG)
  : process.env.PROJECT_NAME;
const container = await findContainerByName(ns.id, containerName);
if (!container) {
  console.log(JSON.stringify({ ok: false, error: "container_not_found", name: containerName }));
  process.exit(1);
}
let ready;
if (process.env.TARGET === "preview") {
  const dbSecret = `DATABASE_URL_PREVIEW_${process.env.BRANCH_SLUG.toUpperCase().replaceAll("-", "_")}`;
  ready = await syncContainerSecrets(container.id, {
    // APP_URL override: the map is built from Secret Manager, whose APP_URL
    // is production's - the preview must keep its own domain.
    overrides: { ACCESS_RESTRICTED: "false", APP_URL: `https://${container.domain_name}` },
    databaseUrlFrom: dbSecret,
  });
} else {
  await putSecret("ACCESS_RESTRICTED", "false");
  ready = await syncContainerSecrets(container.id, {});
}
console.log(JSON.stringify({ ok: true, status: ready.status, url: ready.domain_name ? `https://${ready.domain_name}` : null }));
'
```

`syncContainerSecrets` rebuilds and writes the complete secret map, then waits for the container to become ready - no separate deploy call or wait is needed. Wait for the printed JSON line.

- **If `container_not_found`**: the container doesn't exist yet for this environment - tell the user to run `/deploy` first.
- **If it throws**: relay the error plainly; do not retry silently more than once.
- **Preview only**: after confirming success, tell the user (in French) that this publication does not survive the next `/deploy` of this branch - a preview container is always put back to restricted at deploy time, by design (fails closed). If they want the preview to stay public, they must run `/publish` again after each `/deploy`.

---

## Step 4 - Confirm to the user

On success:
> ✅ Le site est maintenant **public** : <url>
>
> N'importe qui avec ce lien peut le consulter. Vous pouvez revenir en arrière à tout moment avec `/unpublish`.

**Preview only**, add:
> ⚠️ Cet aperçu redevient automatiquement restreint au prochain `/deploy` de cette branche, par sécurité. Relancez `/publish` après chaque déploiement si vous voulez qu’il reste public.

Mention that `seo-perf`, `eco-audit`, and `gsc` can now be run since the site is reachable by Google's crawlers.

Never describe the IP gate (before or after this change) as a firewall - it is an application-level check, not network-level filtering.

Note for Claude: this command works identically for a vitrine. The container restart triggered by the secret sync makes it re-read `ACCESS_RESTRICTED`, whether the gate is implemented in Next.js (`proxy.ts`) or in the vitrine's Caddyfile.

---

## Troubleshooting - 403 on an app that is not published yet

If the user reports a 403 while the app is still IP-restricted (they haven't asked for `/publish` at all - the site was reachable before and now isn't), the most common cause is simply that their egress address changed since it was last recorded. Ask them once, in French, to open https://ip.me and paste the address shown, then run:

```bash
printf '%s' "<adresse collée>" | node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" put ACCESS_ALLOWED_IPS --stdin
```

followed by the same container-secret sync used in Step 3 above (production only - never touch `ACCESS_ALLOWED_IPS` for a preview). Never re-ask this while the secret already holds a value that could still be correct - only prompt again once the user reports the same symptom a second time.
