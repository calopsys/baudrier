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

---

## Step 1 - Identify the environment

Invoke `_detect-project-root` to get `PROJECT_NAME`. If the user didn't specify which environment, ask via `AskUserQuestion`:
- Question: "Quel environnement voulez-vous rendre public ?"
- Options: `Production` / `Aperçu (branche actuelle)`

Resolve the container name: `<PROJECT_NAME>` for production, `<PROJECT_NAME>-preview-<slug-de-la-branche>` for a preview (same naming `/deploy` and `/scale` use). For a preview, also keep the bare `<slug-de-la-branche>` itself - Step 4 needs it separately to name the branch's own `DATABASE_URL_PREVIEW_<SLUG>` secret.

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

## Step 3 - Dev-backed credentials gate [MANDATORY, NEVER SKIP]

🚨 **This step is mandatory and must never be skipped or overridden, even if the user insists.** The alternative is the operator's own personal Scaleway key ending up inside a site anyone on the internet can reach - the exact risk this gate exists to stop. If the user pushes back, explain this plainly and hold the line; do not offer a workaround, and do not proceed to Step 4 without a clean result here.

During development this harness may quietly run one or more of this app's technical secrets on the operator's own personal Scaleway key instead of a dedicated, scoped one. That is acceptable only while the app stays IP-restricted. Publication is the one moment this can never be allowed to continue silently.

Migration never edits generated-app code: it only ever touches Secret Manager, the container secret map, and the fingerprints manifest. The app-key swap only live-validates the admin-provisioned key and prints the `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` lines for the operator to set themselves (env-only credentials, CONTRACT.md §2, §7) - it never persists anything to disk.

Check what is currently backed by the operator's personal key, scoped to the environment being published (production: no `--branch-slug`; preview: pass the branch slug resolved in Step 1):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dev-credentials.mjs" check --json --env <production|preview> [--branch-slug "<branch-slug>"]
```

One JSON line: `{"ok":true,"devBacked":[...],"cleared":[...],"blocking":["DATABASE_URL","SCW_GENERATIVE_API_KEY",...]}`. `devBacked` is the full list for this project; **`blocking` is the subset that feeds the environment being published** - the gate decides on `blocking` (a dev-backed preview database does not block a production publish, and vice versa; shared secrets always block).

- **`blocking` is empty** - nothing to do, continue silently to Step 4.
- **`blocking` is non-empty** - an admin may already have stored one or more of `BAUDRIER_DB_KEY` or `BAUDRIER_APP_KEY` (CONTRACT.md §2) without anyone re-checking. Try the full migration before giving up:

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dev-credentials.mjs" swap-all --project-name "<PROJECT_NAME>" --json --env <production|preview> [--branch-slug "<branch-slug>"]
  ```

  `swap-all` runs every sub-swap in one pass - the database pair (production and previews; a preview whose database no longer exists gets its secret deleted) and the `BAUDRIER_APP_KEY` adoption - each tolerant of "nothing to do", then a fresh internal check. Its JSON result already carries the re-evaluated `blocking`: `{"ok":true,"swapped":{...},"devBacked":[...],"blocking":[...]}` - there is no separate `check` call to re-run, use this `blocking` directly.

- **`blocking` still non-empty** (after `swap-all`) - **refuse the publication**. Hard stop, before any container change - do not run Step 4.

  Resolve the app's Scaleway project id by name (no linkage file - CONTRACT.md §2, §7):

  ```bash
  AUTH_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/_scw-auth.mjs" \
  APP_NAME="<PROJECT_NAME>" \
  node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { resolveProjectId } = await import(pathToFileURL(process.env.AUTH_MJS).href);
  console.log(await resolveProjectId({ appName: process.env.APP_NAME }));
  '
  ```

  Build ONE consolidated French message from the `blocking` list, mapping each entry to its recipe in `docs/ADMIN-SCALEWAY.md`:

  | Entry in `blocking` | Recipe heading | Secret(s) |
  |---|---|---|
  | `DATABASE_URL` (or `DATABASE_URL_PREVIEW_*`) | Recette « base de données » | `BAUDRIER_DB_KEY` |
  | `SCW_GENERATIVE_API_KEY` | Recette « IA » | `SCW_GENERATIVE_API_KEY` |
  | `TEM_API_SECRET_KEY` | Recette « emails » | `TEM_API_SECRET_KEY` |
  | `STORAGE_ACCESS_KEY` or `STORAGE_SECRET_KEY` | Recette « stockage » | `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` |
  | (n’importe laquelle des entrées ci-dessus) | Recette « clé applicative » | `BAUDRIER_APP_KEY` |

  The last row is different in kind from the others: it does not name one specific blocking secret, it names a single broader recipe that replaces the operator's personal key for every one of this app's harness operations at once, so it belongs alongside whichever specific bullets above are triggered, never alone. Include only the rows that actually appear in `blocking`, plus this last row whenever at least one other row is included (one bullet per recipe, not per secret - `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` together still give a single bullet). Print exactly this shape:

  > ⚠️ **Publication impossible pour le moment**
  >
  > Votre application utilise encore votre clé Scaleway personnelle pour au moins un identifiant technique. Tant que l’application tourne avec la clé personnelle de l’opérateur, l’ouvrir au public exposerait cette clé : c’est pour cette raison précise que la publication est bloquée.
  >
  > Transmettez ce message à votre administrateur Scaleway. Pour le projet Scaleway **`<projectId>`**, il trouvera la marche à suivre dans `docs/ADMIN-SCALEWAY.md` :
  >
  > - Recette « base de données » (secret `BAUDRIER_DB_KEY`)
  > - Recette « IA »
  > - Recette « emails »
  > - Recette « stockage »
  > - Recette « clé applicative » (remplace la clé personnelle une fois pour toutes sur ce projet)
  >
  > Une fois les clés enregistrées par votre administrateur, relancez `/publish` : Baudrier bascule automatiquement les identifiants puis publie le site.

  (The five recipe bullets above are the full set - keep only the ones whose secret actually appears in `blocking`, plus the « clé applicative » bullet whenever any other one is kept.) Stop here. Do not ask the user to confirm again, do not retry Step 3 in a loop - the user's next move is `/publish` again, once their admin confirms.

---

## Step 4 - Flip the flag and redeploy

There is no dedicated script for this (it's a single field flip, reusing `scripts/scaleway/container.mjs` and `scripts/scaleway/secrets.mjs` directly) - use the same cross-platform-safe inline-import pattern used elsewhere in this harness (`node --input-type=module -e` + `pathToFileURL`, never a bare relative `import` which breaks depending on the shell's cwd).

A container GET only ever returns argon2 hashes of secret values, never plaintext - so a container's current secrets can never be read back and merged client-side. Secret Manager is the only readable source of truth, and `syncContainerSecrets` always writes the COMPLETE map, rebuilt from Secret Manager, in one PATCH. **Production** and **preview** are therefore handled differently:

- **Production**: `ACCESS_RESTRICTED` is production's own canonical value, so store it in Secret Manager first (`putSecret`), then sync the container with no overrides - the fresh value is already inside the map `syncContainerSecrets` builds.
- **Preview**: a preview container's `ACCESS_RESTRICTED` is a container-only override, never written to Secret Manager (that value belongs to production). Pass it via `overrides`, together with `databaseUrlFrom` naming the branch's own `DATABASE_URL_PREVIEW_<SLUG>` secret (same slug already resolved in Step 1) - otherwise the sync would fall back to the default `DATABASE_URL` key, which is production's database.

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

## Step 5 - Confirm to the user

On success:
> ✅ Le site est maintenant **public** : <url>
>
> N'importe qui avec ce lien peut le consulter. Vous pouvez revenir en arrière à tout moment avec `/unpublish`.

**Preview only**, add:
> ⚠️ Cet aperçu redevient automatiquement restreint au prochain `/deploy` de cette branche, par sécurité. Relancez `/publish` après chaque déploiement si vous voulez qu’il reste public.

Mention that `seo-perf`, `eco-audit`, and `gsc` can now be run since the site is reachable by Google's crawlers.

Never describe the IP gate (before or after this change) as a firewall - it is an application-level check, not network-level filtering.

---

## Troubleshooting - 403 on an app that is not published yet

If the user reports a 403 while the app is still IP-restricted (they haven't asked for `/publish` at all - the site was reachable before and now isn't), the most common cause is simply that their egress address changed since it was last recorded. Ask them once, in French, to open https://ip.me and paste the address shown, then run:

```bash
printf '%s' "<adresse collée>" | node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" put ACCESS_ALLOWED_IPS --stdin
```

followed by the same container-secret sync used in Step 4 above (production only - never touch `ACCESS_ALLOWED_IPS` for a preview). Never re-ask this while the secret already holds a value that could still be correct - only prompt again once the user reports the same symptom a second time.
