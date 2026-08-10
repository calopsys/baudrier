---
name: add-domain
description: "Connect an external custom domain to a Scaleway Serverless Container app. Target architecture: external registrar (unmanaged by this harness) -> Scaleway DNS (delegated zone) -> Scaleway Serverless Containers (hosting, custom domain + automatic TLS). Verifies delegation to ns0/ns1.dom.scw.cloud before touching anything, and waits for DNS propagation before attaching the domain (a hard requirement - see CONTRACT.md)."
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Domain - Connect a domain name

You guide the user to connect a domain name to their app, deployed on a Scaleway Serverless Container. Target architecture: **external domain (bought anywhere) -> Scaleway DNS (delegated zone) -> Scaleway Serverless Containers (hosting)**.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Ce que cette skill fait, et ne fait pas

- **Domaines externes uniquement.** Ce projet **n'achète et ne gère aucun registrar** - il n'automatise ni Hostinger, ni OVH, ni Namecheap, ni aucun autre. Vous devez déjà posséder le nom de domaine, où que vous l'ayez acheté.
- Cette skill vérifie que la zone DNS existe côté Scaleway et que les serveurs de noms (nameservers) du domaine pointent déjà vers `ns0.dom.scw.cloud` / `ns1.dom.scw.cloud`. **Si ce n'est pas le cas, elle s'arrête** et vous transmet les informations exactes à donner à votre équipe technique ou à votre registrar - elle n'essaie jamais d'automatiser le changement de nameservers.
- Une fois le domaine délégué, elle configure un enregistrement CNAME pointant vers votre container, **attend que ce CNAME soit visible sur internet**, puis seulement alors attache le domaine au container pour déclencher le certificat HTTPS automatique.
- **Aucune réception d'email sur ce domaine.** Scaleway n'a pas d'équivalent à un service de redirection d'emails - voir la section dédiée plus bas.

---

## Step 0 - Preflight: Scaleway credentials

This skill (and the `dns.mjs` / `container.mjs` modules it uses) needs Scaleway operator credentials. If they are missing, `scripts/scaleway/_scw-auth.mjs` throws a clear error naming the missing `SCW_*` variable(s) - relay that message verbatim, then tell the user to check the four `SCW_*` variables in the cloud environment dialog and start a new conversation.

---

## Step 1 - Check prerequisites

Invoke `_detect-project-root` to retrieve `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`. Abort if `IS_NEXTJS=no`.

Check that the project is deployed on a Scaleway Serverless Container. The production container's namespace and name both derive from `PROJECT_NAME` (same resolution `/deploy` and `/scale` use - never invent a different naming scheme):

```bash
NS_ID=$(node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" ensure-namespace "<PROJECT_NAME>" | tail -1 | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" find "$NS_ID" "<PROJECT_NAME>"
```

If no container is found, tell the user to deploy first (`/deploy`, or `/bootstrap` if the app does not exist yet). Store the container's `id` as `<container-id>` for the steps below.

---

## Step 2 - Ask for the domain name

> ## 🌐 Quel est le nom de domaine à connecter ?
>
> Ce projet ne vend pas de nom de domaine et n'automatise aucun registrar (OVH, Hostinger, Namecheap, etc.). Il vous faut donc **déjà posséder** le domaine, acheté où vous voulez.
>
> Donnez-moi le domaine exact, par exemple `monsite.fr`.

Store `<domain>`.

---

## Step 3 - Verify DNS delegation to Scaleway

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dns.mjs" delegated <domain>
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dns.mjs" zone-exists <domain>
```

### If both are true (delegated AND a Scaleway DNS zone exists)

Move to **Step 4**.

### If the zone exists but delegation hasn't propagated yet, or neither is true

**STOP. Do not attempt to change the domain's nameservers yourself** - this harness never automates a registrar. Hand off clearly:

> ## ⚠️ Ce domaine n'est pas encore délégué à Scaleway
>
> Pour que je puisse gérer le DNS de `<domain>`, il faut d'abord :
>
> 1. **Créer la zone DNS** dans la console Scaleway (Domaines et DNS → Ajouter un domaine externe → `<domain>`), si ce n'est pas déjà fait.
> 2. **Chez votre registrar** (là où vous avez acheté `<domain>`), remplacer les serveurs de noms (nameservers) par :
>    - `ns0.dom.scw.cloud`
>    - `ns1.dom.scw.cloud`
>
> C'est une opération que seul le titulaire du compte chez le registrar peut faire - transmettez ces deux informations à la personne ou l'équipe technique qui gère ce domaine.
>
> La propagation peut prendre de quelques minutes à 24-48h. Dites-moi **"c'est fait"** quand le changement est en place et je reprends.

Wait for confirmation, then re-run the checks above. Do not proceed past this step until `isDelegatedToScaleway(domain)` is `true` AND the zone exists.

---

## Step 4 - Get the container's endpoint and set the CNAME

Retrieve the container's default endpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" get "<container-id>"
```

(field `domain_name` in the response - the container's own `*.functions.fnc.fr-par.scw.cloud`-style hostname).

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dns.mjs" upsert-records <domain> --json '[{"name":"www","type":"CNAME","data":"<container-endpoint>"}]'
```

Adjust `name` to `""` (apex) or a subdomain depending on what the user wants exposed; CNAME at the zone apex is not valid DNS, so if the user wants the bare domain (`monsite.fr` with no `www`), use an `ALIAS`/flattened record if `dns.mjs` supports it for this zone, otherwise recommend `www.<domain>` and redirect the apex, and say so explicitly to the user rather than silently picking one.

---

## Step 5 - ⚠️ CRITICAL: wait for DNS propagation BEFORE attaching the domain

**This ordering is not optional.** Scaleway's custom-domain TLS issuance uses an HTTP-01 challenge with a **hard 3-minute window**. If the CNAME has not propagated by the time the challenge runs, the domain lands in an **unrecoverable `error` state**, serving neither HTTP nor HTTPS - the only fix at that point is to delete the domain (`deleteCustomDomain`) and start over from Step 4. Never call `addCustomDomain` before confirming propagation.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dns.mjs" wait-propagation "<name>.<domain>" --type CNAME --expect "<container-endpoint>" --timeout 180000
```

This polls public resolvers (1.1.1.1, 8.8.8.8) for up to 3 minutes by default, matching the HTTP-01 window.

- **If it resolves in time** → move to Step 6 immediately (don't wait longer than necessary; every second here eats into the same 3-minute HTTP-01 budget once `addCustomDomain` is called).
- **If it times out** → do NOT call `addCustomDomain`. Explain to the user:

  > ⏳ Le DNS de `<name>.<domain>` n'est pas encore visible sur internet après 3 minutes d'attente. C'est normal si le changement vient d'être fait - la propagation peut prendre plus de temps selon votre fournisseur DNS précédent (jusqu'à 24-48h dans de rares cas).
  >
  > Dites-moi **"réessaie"** dans quelques minutes et je revérifie avant de continuer - je n'attache jamais un domaine tant que le DNS n'est pas confirmé, car ça peut le mettre dans un état bloqué et non réparable.

  Retry with backoff (a few minutes between attempts) rather than looping tightly; if the user asks to retry immediately, re-run the same `wait-propagation` call.

---

## Step 6 - Attach the domain to the container

Only reached once Step 5 confirmed propagation. `container.mjs`'s CLI does not expose a domain-attach subcommand, so call `addCustomDomain(containerId, hostname)` directly via a one-off `node -e` import (its module API is fixed by `CONTRACT.md` §3 - do not change `container.mjs` itself):

```bash
node -e "
import('${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs').then(({ addCustomDomain }) =>
  addCustomDomain(process.argv[1], process.argv[2])
).then((d) => console.log(JSON.stringify(d)));
" "<container-id>" "<name>.<domain>"
```

Then poll until the domain is live:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" list-domains "<container-id>"
```

Report status to the user. TLS issuance typically completes within a few minutes once the domain is attached with DNS already in place.

**If the domain lands in `error` status**: do not retry `addCustomDomain` on the same hostname - per `container.mjs`'s own docs this state has no retry mechanism. Delete it (`deleteCustomDomain`) and restart from Step 4, double-checking DNS propagation more carefully this time (e.g. wait longer, or check with `dns.mjs list-records <domain>` that no stale record still points elsewhere).

---

## Step 7 - Update the project

### 1. Update the environment variable

```bash
node -e "
import('${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs').then(({ putSecret }) => putSecret('APP_URL', process.argv[1]));
" "https://<name>.<domain>"
```

Also update the local `.env`: replace/add `APP_URL=https://<name>.<domain>`.

### 2. Eliminate the old `*.functions.fnc.fr-par.scw.cloud` URLs from the code

**This step is critical for SEO.** If the container's default Scaleway URL remains in the code (sitemaps, metadata, JSON-LD, Open Graph), search engines index the wrong URL and ranking is diluted.

1. **Search**:
   ```bash
   grep -r "functions.fnc" <WEB_DIR>/src/ --include="*.ts" --include="*.tsx" -l
   ```
2. **Replace** each occurrence with `process.env.APP_URL ?? "http://localhost:3000"` (runtime code) or `https://<name>.<domain>` (static content, legal pages).
3. **Priority files**: `<WEB_DIR>/src/app/sitemap.ts` (`baseUrl`), `<WEB_DIR>/src/app/layout.tsx` (`metadataBase`, JSON-LD, Open Graph), `<WEB_DIR>/src/app/robots.ts`, legal pages.
4. **Check nothing remains**:
   ```bash
   grep -r "functions.fnc" <WEB_DIR>/src/ --include="*.ts" --include="*.tsx"
   ```

### 3. Update CLAUDE.md

Invoke `_update-claude-md` with:
- `custom`:
  - heading: `## Domaine personnalisé`
  - body:
    ```
    Le domaine de production est `<name>.<domain>`.
    Architecture : domaine externe (registrar non géré par ce projet) -> Scaleway DNS (zone déléguée) -> Scaleway Serverless Containers (hébergement).
    Certificat HTTPS géré automatiquement par Scaleway (défi HTTP-01, renouvellement automatique).
    IMPORTANT : le proxy Next.js exempte toujours `/.well-known/acme-challenge/*` du filtrage IP - voir la section "Sécurité" - car c'est ce qui permet l'émission et le renouvellement du certificat TLS. Ne jamais retirer cette exemption.
    ```

### 4. Important reminder about the IP allowlist

The app is IP-restricted by default (CONTRACT.md §6). Its `proxy.ts` always exempts `/.well-known/acme-challenge/*` from that filter - this is precisely what lets TLS issuance and renewal keep working even while the app is otherwise locked down. Tell the user explicitly:

> ⚠️ Votre app est protégée par une liste d'adresses IP autorisées. Le chemin `/.well-known/acme-challenge/*` reste volontairement ouvert - c'est ce qui permet à Scaleway de renouveler automatiquement le certificat HTTPS de `<name>.<domain>`. Si quelqu'un modifie un jour le fichier `proxy.ts` du projet, il ne faut surtout pas retirer cette exception, sous peine de casser le renouvellement du certificat (le site deviendrait inaccessible en HTTPS après expiration).

---

## Step 8 - No email reception on this domain

Be upfront about this - do not silently omit it:

> ## 📪 Pas de réception d'emails sur ce domaine
>
> Scaleway ne propose **aucun équivalent** à un service de redirection d'emails entrants (recevoir sur `contact@<domain>` et rediriger vers votre boîte perso). Le MX fourni par Scaleway TEM (transactional email) sert uniquement à l'**envoi**, pas à la réception - un email envoyé à `contact@<domain>` n'arrivera nulle part.
>
> Si vous voulez **envoyer** depuis `<domain>` (par exemple `contact@<domain>`), lancez `/add-email` - c'est un service séparé.
>
> Pour **recevoir** des emails sur ce domaine, il faut une vraie boîte mail chez un fournisseur tiers (Google Workspace, un hébergeur mail classique, etc.) - ce projet ne l'automatise pas.

---

## Step 9 - Org-wide domain cap

Scaleway limits a single Organization to **10 external domains**. If `addCustomDomain` or the initial zone check fails with a quota-looking error, surface this explicitly rather than a raw API error:

> ⚠️ Il semble que votre Organisation Scaleway ait atteint la limite de **10 domaines externes**. Supprimez un domaine inutilisé dans la console Scaleway (Domaines et DNS) avant d'en ajouter un nouveau.

---

## Step 10 - Commit & propose a deploy

If files were modified (URL replacements, CLAUDE.md update):

```bash
git add -A && git commit -m "fix(seo): replace default container URL with custom domain <name>.<domain>"
git push
```

The domain attachment itself already took effect immediately in Step 6 and does not require a redeploy. Committing and pushing does **not** by itself build or deploy anything (builds are dispatch-only, CONTRACT.md §5) - the URL replacements only reach the live site once deployed. Propose `/deploy` to the user for when they want that live; do not run it automatically.

---

## Step 11 - Confirm

> ✅ **Domaine connecté !** Votre app est maintenant accessible sur **https://<name>.<domain>**
>
> **Architecture mise en place :**
> - Domaine externe (registrar non géré par ce projet) → Scaleway DNS → Scaleway Serverless Containers

Always add:
> - Le certificat HTTPS est géré et renouvelé automatiquement par Scaleway.
> - Cette skill ne configure que l'**envoi**, pas la réception d'emails sur ce domaine (voir Step 8). Pour l'envoi, lancez `/add-email`.
> - Rappel : 10 domaines externes maximum par Organisation Scaleway.
