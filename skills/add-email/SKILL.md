---
name: add-email
description: Add transactional email support (Scaleway Transactional Email - TEM) to an existing T3 project. TEM is the only email provider in this harness (see CONTRACT.md); there is no provider choice to make. Can be called by /bootstrap or standalone.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Email - Scaleway Transactional Email (TEM)

Adds transactional email support to the current project, backed by **Scaleway Transactional Email (TEM)** - the only email provider in this harness. There is no third-party provider choice anymore: everything goes through the Scaleway Project's own credentials, no separate vendor API key to create or store.

The deterministic core (TEM domain setup, `mail.ts` + contact tRPC router scaffolding, `root.ts` patching, env var push) is handled by `scripts/setup-email.mjs`. This SKILL takes care of: prereqs validation, re-config detection, post-install steps (contact page, RGPD update), and the final summary.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Une différence importante avec d'autres services d'emailing

Scaleway TEM **n'a pas d'adresse de test partagée** (contrairement à d'autres services qui laissent envoyer immédiatement depuis une adresse générique). Pour envoyer le moindre email, il faut d'abord **vérifier un domaine** (ajout d'enregistrements DNS SPF/DKIM/DMARC/MX, vérification qui peut prendre jusqu'à **48h**). C'est pourquoi cette skill demande l'adresse d'expédition **dès le départ**, et non comme option facultative de fin de parcours.

---

## Step 0 - Preflight: email already configured on THIS project?

**First of all**, invoke `_check-deps email` to detect the project state:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" email)
email_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.ok)")
```

### If `email_ok = true` then re-configuration mode

TEM is already set up on this project. Do NOT run `setup-email.mjs` (it refuses to overwrite an existing `mail.ts` + `contact.ts`).

Show a menu:

> ## 📬 L'envoi d'emails est déjà configuré
>
> Que voulez-vous faire ?
>
> 1. **Changer l'adresse d'expédition** (par exemple passer à `contact@monsite.fr`)
> 2. **Changer l'adresse qui reçoit les messages** du formulaire de contact
> 3. **Créer la page `/contact`** si elle n'existe pas encore
> 4. **Republier les enregistrements DNS** (si la vérification du domaine semble bloquée)
> 5. **Tout recommencer** (si la config est cassée - supprimez d'abord `TEM_SENDER_EMAIL`/`TEM_SENDER_NAME` de `.env` ET les fichiers `src/server/mail.ts` + `src/server/api/routers/contact.ts`)
> 6. **Autre chose** - dites-moi ce que vous voulez

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (change sender) | Ask for the new sender email. Extract its domain. If it's a new domain, run **Step 2** (TEM domain setup) for that domain. Then write `TEM_SENDER_EMAIL`/`TEM_SENDER_NAME` via `putSecret()` (see Step 3 below) and mirror to `.env`. |
| 2 (change recipient) | Invoke `_create-contact-page` in "update recipient only" mode - run just its Step 2 (`CONTACT_RECIPIENT_EMAIL`) and skip creation if it already exists. |
| 3 (create contact page) | Invoke `_create-contact-page` directly. |
| 4 (republish DNS) | Re-run `node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/tem.mjs" records <domain-id>` then `dns.mjs upsert-records` then `tem.mjs check <domain-id>`. Domain id and status are in the JSON line printed by the original `setup-email.mjs` run, or look it up again via `tem.mjs ensure-domain <domain>` (idempotent - returns the existing domain). |
| 5 (start over) | Delete `TEM_SENDER_EMAIL`/`TEM_SENDER_NAME` from `.env`, delete the corresponding secrets (`node scripts/scaleway/secrets.mjs delete TEM_SENDER_EMAIL` and `... delete TEM_SENDER_NAME`), delete `src/server/mail.ts` + `src/server/api/routers/contact.ts`. Then go back to the normal **Step 1**. |
| 6 (other) | Ask for clarification. Do not run the install flow by default. |

**At the end**, jump straight to **Step 6** (summary).

### If `email_ok = false` then fresh install, continue to Step 1

---

## Step 1 - Detect project + ask for the sending address

Invoke `_detect-project-root` to get `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`. Abort if `IS_NEXTJS=no`.

Ask the user:

> ## 📬 Depuis quelle adresse voulez-vous envoyer vos emails ?
>
> Scaleway TEM (le service d'envoi d'emails utilisé par ce projet) exige de vérifier le nom de domaine avant de pouvoir envoyer quoi que ce soit - pas d'adresse de test générique disponible.
>
> Donnez-moi l'adresse que vous voulez utiliser, par exemple `contact@monsite.fr`. Le domaine (`monsite.fr`) sera vérifié automatiquement.
>
> Si vous n'avez pas encore de domaine, lancez d'abord `/add-domain`, ou donnez-moi une adresse sur un domaine que vous possédez déjà.

Store the answer as `SENDER_EMAIL`. Validate it looks like an email (contains `@` and a `.` after it); if not, ask again. Extract `DOMAIN` (the part after `@`).

Also ask (or infer from `PROJECT_NAME`) the **display name**:

> Quel nom afficher comme expéditeur (par exemple le nom de votre entreprise) ? Par défaut : `<PROJECT_NAME>`.

Store as `SENDER_NAME` (default = `PROJECT_NAME`).

Before configuring the domain, show this note:

> ℹ️ **Vérification d’identité Scaleway**
>
> Sans vérification d’identité, votre compte Scaleway envoie au maximum 500 emails par mois, sur 2 domaines. Après vérification, ces plafonds passent à 5 000 emails par mois et 5 domaines. Le plafond arrête l’envoi sans avertissement. Vérifiez votre identité depuis la console Scaleway avant d’envoyer un vrai volume d’emails.

---

## Step 2 - Run setup-email.mjs

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-email.mjs" \
  --name "<PROJECT_NAME>" \
  --sender-email "<SENDER_EMAIL>" \
  --sender-name "<SENDER_NAME>" \
  --web-dir "<WEB_DIR>"
```

The script chains 6 sub-steps: preflight, TEM domain setup (create/find the domain, fetch its SPF/DKIM/DMARC/MX records, publish them via Scaleway DNS if the domain is delegated there, trigger a verification check), write `mail.ts`, write the contact tRPC router, register `contactRouter` in `root.ts`, push env vars.

### During execution

The script prints live:
- `▸ <step>` when it starts each sub-step
- `✅ <result>` at the end of each one
- `⚠️ <warning>` for non-blocking warnings (rateLimitedProcedure missing, DNS not auto-published, the 500 emails/month + 2 domains cap on a fresh account, etc.)
- At the end, a structured **handoff banner** (includes the DNS records to publish if they couldn't be published automatically)
- On the last line on success, a parseable JSON object: `{"success":true,"senderEmail":"...","senderName":"...","domain":"...","temDomainId":"...","temDomainStatus":"...","dnsAutoPublished":true|false,"envVars":["TEM_SENDER_EMAIL","TEM_SENDER_NAME"]}`

Let the output through live (no `> /tmp/...`, no capture).

### On failure

1. **Read the detailed error**: just above the handoff banner.
2. **Identify the failed step** in the banner (`❌ Failed at: <step>`). The name maps 1:1 to a function in the script - open `setup-email.mjs` and read the function to understand.
3. **Diagnose**:
   - `preflight` then usually an already existing file (`mail.ts` or `contact.ts`) or no Next.js / no tRPC. Handle specifically.
   - `configureDomain` then likely a Scaleway credentials problem (a missing or expired `SCW_*` variable) - the error message from `_scw-auth.mjs` tells the user exactly what to do; have them check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation. This step is otherwise resilient: DNS-not-delegated is a warning, not a hard failure - continue past it and hand the user the manual DNS records from the handoff banner.
   - `writeMailTs` / `writeContactRouter` then FS permission (rare).
   - `registerRouter` then T3 may have reorganized `root.ts`. Patch manually: add `import { contactRouter } from "~/server/api/routers/contact";` + `contact: contactRouter,` in the `createTRPCRouter({...})`.
   - `pushEnvVars` then the code and the TEM domain are in place, only the env vars/secrets didn't land. Retry: `printf '%s' "<email>" | node scripts/scaleway/secrets.mjs put TEM_SENDER_EMAIL --stdin` and same for `TEM_SENDER_NAME`, plus append both to `.env`.
4. **Continue** the remaining steps manually, drawing on the script's functions.

---

## Step 3 - If DNS could not be published automatically

If the JSON line has `"dnsAutoPublished": false`, the domain is not delegated to Scaleway DNS (or its zone doesn't exist there). Show the exact records from the script's handoff banner and explain:

> ## ⚠️ Enregistrements DNS à ajouter manuellement
>
> Le domaine `<domain>` n'est pas encore géré par les DNS Scaleway. Ajoutez ces enregistrements chez votre fournisseur DNS actuel :
>
> | Type | Nom | Valeur |
> |---|---|---|
> | ... | ... | ... |
>
> Vous pouvez aussi lancer `/add-domain` pour transférer la gestion DNS de ce domaine vers Scaleway - je pourrai alors publier ces enregistrements automatiquement.

---

## Step 4 - Update CLAUDE.md

Invoke `_update-claude-md` with:

- `stack`: `- **Email**: Scaleway Transactional Email (TEM) - envoi via \`sendMail()\` dans \`<WEB_DIR>/src/server/mail.ts\``
- `env-vars`:
  - `- \`TEM_SENDER_EMAIL\` - adresse d'expédition vérifiée`
  - `- \`TEM_SENDER_NAME\` - nom affiché comme expéditeur`
  - `- \`CONTACT_RECIPIENT_EMAIL\` - destinataire du formulaire de contact (optionnel, retombe sur \`TEM_SENDER_EMAIL\`)`
- `conventions`:
  - `- Email : toujours utiliser \`escapeHtml()\` depuis \`~/server/mail\` sur les données utilisateur avant de les insérer dans le HTML d'un email.`
  - `- TEM impose un sujet d'au moins 10 caractères et 3 destinataires maximum par email - \`sendMail()\` lève une erreur explicite en français si ces limites sont dépassées, pour éviter un 400 incompréhensible.`

---

## Step 5 - RGPD: privacy policy

Add the provider to the project's RGPD subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add scaleway-tem
```

The helper is idempotent. If the page `politique-de-confidentialite/page.tsx` exists, it updates automatically. If the command errors because `scaleway-tem` is not (yet) a known subprocessor key in that script, this is non-fatal - note it as a follow-up and move on; Scaleway (fr-par, EU) requires no outside-EU transfer mechanism regardless.

---

## Step 6 - Propose the contact page

The tRPC back-end is created by the script (the `contact.send` procedure with honeypot + rate limiting + HTML escaping). What is missing is the front-end page.

Propose to the user:

> ## 📨 Et une page de contact fonctionnelle tout de suite ?
>
> Le moteur d'envoi d'emails côté serveur est en place. Si vous voulez, je peux créer maintenant **une page `/contact` fonctionnelle** - un formulaire Nom / Email / Message, un bouton Envoyer, et toutes les protections anti-spam.
>
> Ça prend 30 secondes.

### If accepted

Invoke `_create-contact-page`. That skill automatically detects the TEM setup via `_check-deps email` and adapts what it creates.

### If declined

Skip - mention at Step 7 that they can ask *"crée-moi une page de contact"* later.

---

## Step 7 - Final summary

> ✅ L'envoi d'emails est configuré (`sendMail()` dans `<WEB_DIR>/src/server/mail.ts`), depuis `<SENDER_NAME> <SENDER_EMAIL>`.

If `dnsAutoPublished = true`, add:
> Les enregistrements DNS ont été publiés automatiquement.

If `dnsAutoPublished = false`, add:
> ⚠️ **Action manuelle requise** : ajoutez les enregistrements DNS listés plus haut chez votre fournisseur DNS actuel (ou lancez `/add-domain` pour transférer la gestion DNS vers Scaleway).

Always add:
> ⏳ La vérification du domaine par Scaleway peut prendre **jusqu'à 48h**. Tant qu'elle n'est pas terminée, l'envoi d'emails échouera.
>
> 📉 Rappel : les plafonds d’envoi indiqués plus haut s’appliquent tant que votre identité Scaleway n’est pas vérifiée.

Then, as applicable:
- *Le moteur d'envoi est prêt (la procédure tRPC `contact.send`, avec honeypot, échappement HTML et limitation de débit)*
- If the contact page was created: *Votre page `/contact` est prête, vous pouvez la tester dès maintenant*
- Otherwise: *Quand vous voudrez une page de contact, dites-moi "crée-moi une page de contact"*

If any warnings were raised by the script, mention them here as well.
