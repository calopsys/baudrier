---
name: rotate-secret
description: Replace a secret (Scaleway IAM key, generated token, or external credential) safely in an existing project. Lists the rotatable secrets, mints or generates the new value, stores it in Scaleway Secret Manager, and redeploys the container so the change actually takes effect (Serverless Containers cannot reference Secret Manager directly). Use when a secret has leaked, when an operator leaves, after suspected compromise, or for periodic rotation.
argument-hint: "[secret name (optional)]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use scw, gh."
---

# Rotate Secret - Renew a key/secret safely

You replace ONE sensitive value (Scaleway-minted IAM key, self-generated token, or external credential) with a new one, everywhere it lives, and make sure the running app actually picks it up.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## The mechanic this skill exists to enforce

Per CONTRACT.md: **Scaleway Serverless Containers cannot reference Secret Manager directly** (an open Scaleway feature request). The harness copies secret values into the container's own `secret_environment_variables` at deploy time. This means **storing a new value in Secret Manager alone does nothing to the running app** - the container keeps using the old value until it is redeployed. Skipping that step would give a dangerous false sense of security: the secret "looks" rotated but the leaked/old value is still live in production.

`scripts/rotate-secret.mjs` therefore **always redeploys the container as part of rotation** (a PATCH that touches `secret_environment_variables` triggers a fresh deploy of the same image automatically - see `scripts/scaleway/container.mjs`). You never need to separately tell the user to run `/deploy` for a per-app secret - the rotation script already did the equivalent. If the project has no container deployed yet, say so plainly instead of implying the rotation is "live".

**Serverless Jobs are the opposite**: they CAN reference Secret Manager natively, so a Job (the migration Job, an autonomous agent) automatically picks up a rotated value on its **next run**, with no redeploy step at all. When rotating `SCW_GENERATIVE_API_KEY` or `TEM_API_SECRET_KEY` (used by the agent Job, see `templates/agent/mail.ts`), mention this asymmetry to the user so they understand why there's no "redeploy" language for that part.

---

## Step 0 - Sanity check

Invoke `_detect-project-root` to get `PROJECT_NAME` and `PROJECT_TYPE`. If this doesn't look like a baudrier project (no `CLAUDE.md`, no Next.js or Astro `package.json` - `PROJECT_TYPE=unknown`), abort with a clear message (*"This command is used inside an existing project, not at the root."*).

Before any rotation runs, check the credential shape:

```bash
APP_CREDENTIALS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/app-credentials.mjs" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { credentialShape } = await import(pathToFileURL(process.env.APP_CREDENTIALS_MJS).href);
console.log(await credentialShape());
'
```

If the result is `"project"` (Cas B), **stop here** - do not run Step 1 or any later step. A Cas B operator holds no per-app IAM key of their own to rotate: the environment key already serves every connection permanently. Say, in French:

> ⚠️ **Renouvellement impossible depuis Baudrier**
>
> Votre installation utilise une clé Scaleway unique, propre à ce projet (Cas B). Cette clé sert l’application en permanence : il n’existe pas de clé IAM séparée que ce script puisse renouveler à votre place.
>
> Transmettez ce message à votre administrateur Scaleway :
>
> « Merci d’émettre une nouvelle clé pour l’application IAM de ce projet Scaleway. »
>
> Une fois la nouvelle clé reçue, faites ceci :
> 1. Remplacez `SCW_ACCESS_KEY` et `SCW_SECRET_KEY` dans les variables de l’environnement cloud.
> 2. Enregistrez la nouvelle valeur dans Secret Manager.
> 3. Relancez un déploiement pour que le conteneur charge la nouvelle valeur.
>
> Démarrez ensuite une **nouvelle conversation** : celle-ci ne peut pas relire des variables d’environnement modifiées après son démarrage.

If the result is `"org"` (Cas A) or `"unknown"`, continue silently to Step 1 - the existing `needs_admin` handling below already covers Cas A.

## Step 1 - Identify the secret to renew

### 1.a - If the user passed an argument

If `$ARGUMENTS` is not empty, match it case-insensitively against the known keys (accept partial names - *"database"* matches `DATABASE_URL`, *"storage"* matches `STORAGE_ACCESS_KEY`). If there is a single match → `SECRET_KEY` captured. If ambiguous → offer a menu. If zero matches → treat as if no argument was passed.

### 1.b - If no argument (or ambiguous)

List the rotatable secrets for this project:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/list-rotatable-secrets.mjs"
```

This queries this project's Scaleway Secret Manager directly (never a local `.env` - `DATABASE_URL` in particular is never written to disk, see CONTRACT.md §4) and shows a categorized menu. Capture the user's choice as `SECRET_KEY` (or `SECRET_KEY` + `PAIR_KEY` if the item covers a pair like `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` or the VAPID keys).

**For a site vitrine (`PROJECT_TYPE=landing`)**: the database and auth categories (`DATABASE_URL`, `AUTH_SECRET`) are simply absent from this menu - a landing never had them provisioned in the first place (no `/add-db`, no `/add-auth` for that stack), so there is nothing missing to explain, the same way `list-rotatable-secrets.mjs` only ever lists what actually exists.

If the script reports it could not reach Secret Manager (no credentials), tell the user to check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation.

## Step 2 - Ask which environment (per-app secrets only)

For any per-app secret (`DATABASE_URL`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, `AUTH_SECRET`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`), ask via `AskUserQuestion` which environment to rotate - **always ask, never infer**, same rule as `/deploy` (CONTRACT.md §5):
- Question: "Quel environnement voulez-vous renouveler ?"
- Options: `Production` / `Aperçu (branche actuelle)`

Capture `TARGET` (`production`/`preview`) and, if preview, `BRANCH`.

External keys (`MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`) skip this step entirely - they live in this app's own Scaleway Project like every other secret, but are never copied into any container or Job and are read live by local operator tooling. Rotating any of them needs no redeploy.

## Step 3 - Rotate, by category

**IAM-backed keys and `needs_admin`** (Categories C, D, E below - anything that goes through `rotate-secret.mjs rotate-database-url` or `rotate-iam`): the operator's key can only rotate a key on an application it can also mint keys for. When it lacks `IAMManager`, per-request delegation applies (CONTRACT.md §1): the script fails with `"type":"needs_admin"`. Relay the script's French message to the user as-is - it already points at `docs/ADMIN-SCALEWAY.md`, section « Renouveler la clé » - and wait. The admin mints a new key on the named application, updates the corresponding secret (or secret pair), and deletes the old key by hand. Once the user confirms this is done, re-run the exact same rotation command - it completes normally, because the new value is already the one Secret Manager holds.

### Category A - Auto-generated (`AUTH_SECRET`, `CRON_SECRET`)

No external dashboard, no IAM key - a fresh random value, generated locally.

```bash
NEW_VALUE=$(node "${CLAUDE_SKILL_DIR}/../../scripts/generate-secret.mjs" --format base64url)   # AUTH_SECRET
NEW_VALUE=$(node "${CLAUDE_SKILL_DIR}/../../scripts/generate-secret.mjs" --format hex)          # CRON_SECRET
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" push --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>] "<SECRET_KEY>=$NEW_VALUE"
```

Tell the user: *"Cette clé est interne au projet, je l'ai régénérée pour vous - rien à faire de votre côté."*

### Category B - VAPID keypair (Web Push)

Generated with the `web-push` package that lives in the **project's own** `node_modules` (run with cwd at the project root):

```bash
cd "<WEB_DIR>"
VAPID_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/generate-vapid-keys.mjs")
# VAPID_JSON = {"publicKey":"...","privateKey":"..."}
```

Extract `publicKey`/`privateKey`, then:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" push --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>] "VAPID_PUBLIC_KEY=<publicKey>" "VAPID_PRIVATE_KEY=<privateKey>"
```

⚠️ Rotating VAPID keys **invalidates every existing push subscription** - users who had enabled notifications will need to re-subscribe (the browser silently drops the old subscription once the public key no longer matches). Warn the user before proceeding.

### Category C - `DATABASE_URL`

Special case: the value is a full `postgres://` URL built from the (unchanged) IAM Application, a **freshly minted** API key, and the (unchanged) database endpoint. One command does the whole thing - mint, store, redeploy, revoke the old key:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" rotate-database-url --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>]
```

If the operator's key lacks `IAMManager`, this fails with `"type":"needs_admin"` - see the note above `## Step 3`. Once the admin has updated `BAUDRIER_DB_KEY` (the pair, region `fr-par`, in this app's own Project), re-run the exact same `rotate-database-url` command: it reads the new pair from `BAUDRIER_DB_KEY` in-process and completes.

⚠️ **Important**: rotating cuts active database connections briefly. The container redeploy that follows takes over with the new credentials, but production has a short outage (typically under a minute) while the new instance starts. Warn the user:

> *⚠️ Votre site sera brièvement indisponible (moins d'une minute) le temps que le redéploiement prenne effet. Je lance le renouvellement maintenant.*

### Category D - `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" rotate-iam \
  --key STORAGE_ACCESS_KEY --pair-key STORAGE_SECRET_KEY \
  --app "<PROJECT_NAME>-storage" --perm ObjectStorageFullAccess \
  --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>]
```

**Coordination note**: `<PROJECT_NAME>-storage` is the IAM Application naming convention this skill uses. If whoever owns `/add-storage`'s provisioning script named the Application differently, `ensureApplication` (find-or-create) will create a **second**, separate Application instead of reusing the original one - rotation still works (a fresh, correctly-scoped key is minted and pushed), but the original Application's now-orphaned key is not revoked (this script only revokes keys on the Application it itself resolves). Flag this to whoever owns storage provisioning if you notice a mismatch.

### Category E - `SCW_GENERATIVE_API_KEY` / `TEM_API_SECRET_KEY` (agent keys)

Both live on the same IAM Application, `baudrier-agents-<SCW_DEFAULT_PROJECT_ID>` (matches `scripts/setup-agent.mjs` exactly):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" rotate-iam \
  --key SCW_GENERATIVE_API_KEY --app "baudrier-agents-<SCW_DEFAULT_PROJECT_ID>" --perm GenerativeApisModelAccess \
  --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>]

node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" rotate-iam \
  --key TEM_API_SECRET_KEY --app "baudrier-agents-<SCW_DEFAULT_PROJECT_ID>" --perm TransactionalEmailEmailApiCreate \
  --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>]
```

If the project has no autonomous agent (`/add-agent` was never run), skip this category - it won't appear in Step 1's menu since `list-rotatable-secrets.mjs` only lists what actually exists in Secret Manager.

Tell the user: *"Votre agent autonome utilisera automatiquement la nouvelle clé à sa prochaine exécution planifiée - pas besoin de redéployer votre site pour cette partie."* (Only mention the container redeploy too if `rotate-iam`'s output shows `container redeployed` - some projects also use Generative APIs directly from the main app, in which case both happen.)

### Category F - External keys (`MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`)

These are issued by an external dashboard, not by Scaleway, but stored in this app's own Scaleway Project like every other secret (CONTRACT.md §2). Repo access itself is native git auth, never a stored credential - there is no `GITHUB_TOKEN` secret in this harness to rotate (CONTRACT.md §2, §5, §7).

| Key | Where to regenerate |
|---|---|
| `MATOMO_TOKEN` | Matomo instance → *Administration → Personal → Security → Auth tokens* - revoke the old one, create a new one |
| `PAGESPEED_API_KEY` | https://console.cloud.google.com/apis/credentials - regenerate the API key |
| `GSC_SERVICE_ACCOUNT` | Google Cloud Console → *IAM & Admin → Service Accounts* → the service account used for Search Console → *Keys* tab → create a new JSON key, then delete the old one. The new key's full JSON content is the value (same shape `_setup-gsc` originally stored) |

Show the instructions, wait for the user's reply, capture `NEW_VALUE` (never display it back), then:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rotate-secret.mjs" push --no-sync "<SECRET_KEY>=<NEW_VALUE>"
```

`--no-sync` is required here: these are never container secrets, so there is nothing to redeploy. No `--project-id` either: the value goes into this app's own Project, the default target.

## Step 4 - Report the result

Every `rotate-secret.mjs` invocation ends with a JSON line - read `sync.synced`:
- `true` → *"✅ Votre clé **<SECRET_KEY>** est renouvelée et déjà active sur votre site (redéploiement effectué)."*
- `false` with `reason: "not_deployed"` → *"✅ Votre clé est renouvelée. Votre site n'est pas encore déployé, donc rien à redéployer pour l'instant - la nouvelle valeur sera utilisée dès votre premier `/deploy`."*
- `false` with `reason: "--no-sync"` → external key, no redeploy applicable, say so.

For an `iam-pair`/`iam-single`/`database-url` rotation, also relay `revokedOldKeys` (e.g. *"L'ancienne clé a été révoquée - elle ne fonctionne plus."*).

## Step 5 - If the old value leaked publicly, extra advice

If the user triggered this command because a key leaked (public GitHub commit, screenshot, email sent by mistake), add:

> 💡 Quelques précautions supplémentaires :
>
> 1. **Vérifiez l'historique Git** si la fuite vient d'un commit : la valeur reste dans l'historique même après suppression du fichier. Si votre dépôt est public, considérez-la compromise définitivement et purgez l'historique (`git filter-repo`) - dites-moi *"nettoie l'historique git pour cette clé"* et je vous guide.
> 2. **Surveillez les logs** (Scaleway Cockpit, ou le tableau de bord du service concerné pour une clé externe) sur les **24-48h** suivantes pour repérer un usage suspect.
> 3. Si la clé a été utilisée en dehors de votre propre installation, contactez le support du fournisseur concerné.

## Step 6 - CLAUDE.md (optional)

If the project has a `CLAUDE.md` and the rotation follows a leak or an operator offboarding, add a line in a "## Rotations" section (created if absent):

```
- **YYYY-MM-DD** : <SECRET_KEY> renouvelée (raison : fuite / départ / périodique)
```

---

## Natural-language override

- *"renouvelle aussi ma clé Object Storage"* (during another command): resume at Step 1 for that key.
- *"j'ai changé d'avis, annule"* before the push: do nothing, do not push, say OK.
- *"renouvelle TOUTES mes clés"*: iterate over every category one by one, warning before the `DATABASE_URL` and VAPID steps since those have user-visible side effects (brief outage, push-subscription invalidation).
