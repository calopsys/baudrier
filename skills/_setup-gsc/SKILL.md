---
name: _setup-gsc
description: Internal helper to connect Google Search Console via a service account stored in Scaleway Secret Manager (no MCP, no Python, no restart). Guides the one-time-per-project creation of a Google service account, stores its JSON key in Secret Manager (secret GSC_SERVICE_ACCOUNT, this project's own Scaleway Project), and grants it owner access on the GSC property. Triggered by /gsc when GSC is not yet configured. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash Read
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Setup GSC (via Scaleway Secret Manager) - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You connect Google Search Console to the project via a **Google service account** whose JSON key is stored in **Scaleway Secret Manager** (secret `GSC_SERVICE_ACCOUNT`). Like every other secret, it lives in this project's own Scaleway Secret Manager Project (CONTRACT.md §2), not a shared one. Then `/gsc` reads the data via the REST API with a token forged on the fly (`gsc-token.mjs`).

This is a **one-time setup per project**: once done, all future `/gsc` runs on this project reuse the same secret. A new project needs its own service account, but reusing the same Google Cloud project across runs of this skill is fine - only the Secret Manager storage step repeats. Scope `webmasters` (read + write) means Claude is autonomous (adding a property, DNS verification, sitemap).

> Scripts: `SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs"`, `GSCTOKEN="${CLAUDE_SKILL_DIR}/../../scripts/gsc/gsc-token.mjs"`, `OPENURL="${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs"`.

---

## Step 1 - Is Scaleway configured?

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" scaleway
```
- `ok: true` → continue to Step 2.
- `ok: false` → the operator's Scaleway credentials (`SCW_ACCESS_KEY` / `SCW_SECRET_KEY`) are missing or invalid: tell the user to check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation, then retry.

---

## Step 2 - Announce the plan

> Pour connecter Google Search Console, on crée un *compte technique* Google pour ce projet (~7 minutes). Ensuite, je gère tout automatiquement. Si vous avez déjà un compte technique d’un autre projet, vous pouvez réutiliser sa clé JSON directement à l’étape 3. Les étapes :
>
> 1. Vous créez un compte de service dans la Google Cloud Console
> 2. Vous téléchargez sa clé (un fichier JSON)
> 3. Vous ouvrez ce fichier dans un éditeur de texte et m’en collez le contenu complet → je le stocke dans le coffre de secrets Scaleway
> 4. Vous autorisez ce compte technique sur votre Search Console (3 clics)
>
> Pas de redémarrage, pas d'installation lourde. On y va ?

If they refuse → suggest an on-page audit via `/seo` (without GSC) and stop cleanly.

---

## Step 3 - Create the service account (manual, browser)

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs" "https://console.cloud.google.com/"
```

> Connectez-vous avec **le compte Google qui a accès à votre Search Console**.
>
> 1. En haut, sélectionnez/créez un projet (menu projet → **NOUVEAU PROJET** → nom ex. "Claude Code Access" → **CRÉER**)
> 2. Menu de gauche → **APIs et services** → **Bibliothèque** → activez **DEUX** API (cherchez chacune → **ACTIVER**) : **"Search Console API"** ET **"Site Verification API"** (la 2ᵉ permet d'ajouter + vérifier une propriété automatiquement)
> 3. **APIs et services** → **Identifiants** → **+ CRÉER DES IDENTIFIANTS** → **Compte de service**
> 4. **Nom du compte de service** : `claude-code-gsc` → **CRÉER ET CONTINUER** → rôles vides (passer) → **OK**
> 5. Cliquez sur le compte de service créé → onglet **CLÉS** → **AJOUTER UNE CLÉ** → **Créer une clé** → **JSON** → **CRÉER**
> 6. Un fichier `.json` se télécharge (souvent dans `~/Downloads/`)

Ask the user to paste the content:

> Ouvrez ce fichier `.json` dans un éditeur de texte, sélectionnez tout son contenu, et collez-le-moi directement dans le chat.

---

## Step 4 - Store the key in Secret Manager (and read the SA email)

Once the user pastes the JSON, write it verbatim to a fixed path under this session's own `/tmp` (CONTRACT.md §7 - the one cache path that survives across Bash calls within a Claude Code web session):

```bash
cat > /tmp/gsc-service-account.json <<'EOF'
<pasted JSON content, verbatim>
EOF
```

Then extract the service account email (not secret - used in Step 5):

```bash
SA_EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).client_email)" /tmp/gsc-service-account.json)
echo "$SA_EMAIL"
```
If this fails (`client_email` missing) → the user probably pasted an **OAuth client** JSON instead of a **service account** key (common mistake): send them back to Step 3 point 3 (be sure to choose **Service account**), and ask them to paste the correct JSON again.

Then store the raw file content as a Secret Manager **string** secret (Secret Manager has no "file" secret type, unlike the vault this harness used to read from) - use the same pattern used elsewhere in this harness (`node --input-type=module -e` + `pathToFileURL`, never a bare relative `import`):

```bash
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
SA_PATH=/tmp/gsc-service-account.json \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const { putSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
const raw = readFileSync(process.env.SA_PATH, "utf8");
try { JSON.parse(raw); } catch { console.log(JSON.stringify({ ok: false, error: "invalid_json" })); process.exit(5); }
const res = await putSecret("GSC_SERVICE_ACCOUNT", raw);
console.log(JSON.stringify({ ok: true, ...res }));
'
```
- `ok: true` → run `rm -f /tmp/gsc-service-account.json` (the key is now in Secret Manager, so no clear-text copy must stay in the sandbox). Advise the user to also **delete the downloaded JSON file**.
- exit 5 (`invalid_json`) → wrong file, ask again.
- any other error → relay it plainly (likely missing/invalid Scaleway credentials).

---

## Step 5 - Authorize the technical account on Search Console (manual, browser)

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs" "https://search.google.com/search-console"
```

> Dernière étape (1 min) - j'accorde au compte technique l'accès à votre Search Console :
>
> 1. Si votre propriété n'existe pas encore : **Ajouter une propriété** → format **Domaine** → votre domaine racine (je m'occupe de la vérification DNS ensuite).
> 2. Sélectionnez votre propriété → **Paramètres** (roue crantée, bas du menu de gauche) → **Utilisateurs et autorisations**
> 3. **AJOUTER UN UTILISATEUR** → email : `<SA_EMAIL>` → autorisation **Propriétaire** → **Ajouter**
>
> Dites-moi *"c'est fait"*.

Warning: To track several sites, you need to add `<SA_EMAIL>` as an owner on **each** property (Google does not propagate between properties).

---

## Step 6 - Verify (no restart)

Forge a token + list the visible properties:

```bash
TOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/gsc/gsc-token.mjs" --readonly 2>/dev/null); RC=$?
[ $RC -eq 0 ] && curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOK" "https://www.googleapis.com/webmasters/v3/sites"
```
- token OK + HTTP 200 → done, GSC configured. Hand control back to `/gsc` (which continues with its audit).
- exit 4 → the secret is not in Secret Manager: go back to Step 4.
- exit 1 → relay the error plainly (missing Scaleway credentials, invalid JSON, Google token exchange failure).
- HTTP 403 → the SA does not (yet) have access: Step 5 not finished or on the wrong property.

---

## Artifacts

- Scaleway Secret Manager (this project's own Project): secret `GSC_SERVICE_ACCOUNT` (full SA JSON, stored as a string).
- Google: project + service account created; SA added as owner on the GSC property/properties.
- **No** MCP in `.claude.json`, **no** Python package, **no** restart.

All future `/gsc` runs skip this setup and read the secret directly.
