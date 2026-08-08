---
name: start
description: First-time onboarding for Baudrier on Claude Code web. Verifies the session is a Claude Code web sandbox, checks the harness's own dependencies, repo access, git identity, Scaleway environment variables and permissions, network reachability, and Docker, then guides toward the first /bootstrap. Use when someone installs the plugin for the first time, or opens a fresh Claude Code web session.
compatibility: "Agent Skills standard (Claude Code). Runs only on Claude Code web (claude.ai/code): Node.js, git, pnpm and Docker are preinstalled by the cloud environment's own Setup script."
---

# Start - First-time use

You are welcoming a new Baudrier user. Your role is to verify that everything is in place, install what is missing, and guide them toward their first project.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

This harness runs **entirely on Scaleway** (CONTRACT.md §1): a single hosting provider, a single secrets store, no separate key vault to set up. The machine running Claude Code builds the container image itself (`docker build`, CONTRACT.md §5) - no GitHub Actions anywhere in the pipeline, so there is nothing to check for that. Scaleway credentials are **environment variables only** (CONTRACT.md §2, §7): `scw` has no login of its own to run and is not part of the toolchain at all, and neither is `gh` - repo access is native git auth, checked with `git ls-remote origin`. Baudrier runs **only on Claude Code web** (claude.ai/code, CONTRACT.md §1, §7): an ephemeral, root, no-persistent-home VM, with Node, git, pnpm and Docker preinstalled by the cloud environment's own Setup script (`scripts/setup-clis-web.sh`). `/start` therefore deals with exactly nine things: the environment itself, the harness's own dependencies, repo access, git identity, Scaleway credentials and rights, network reachability, Docker, identity verification (KYC), and the handoff to `/bootstrap`.

---

## Step 1 - Welcome + environment guard

Display the welcome message, then silently check the environment:

```bash
echo "claude_code_remote=${CLAUDE_CODE_REMOTE:-}"
```

**If `claude_code_remote` is not `true` or `1`**, stop immediately - do not run anything else in this skill. Say, in French, then wait:

> Baudrier fonctionne **uniquement sur Claude Code web** (claude.ai/code). Ouvrez le chapitre Installation du README pour créer votre environnement cloud « Baudrier », puis relancez `/start` depuis cet environnement.

**If `claude_code_remote` is `true` or `1`**, continue.

> **Bienvenue sur Baudrier !**
>
> Ce plugin vous permet de créer des applications web complètes en quelques minutes. Vous décrivez ce que vous voulez, je construis.
>
> Je vais d’abord vérifier votre environnement et installer ce qui manque.

---

## Step 2 - Dependencies (blocking)

```bash
node "${CLAUDE_SKILL_DIR}/../../tools/bootstrap-deps.mjs" --json
```

`ok: true` → say nothing, continue silently. `ok: false` → the environment's Setup script normally already ran this once while the environment was being built, so a failure here means an actual repair is needed. Re-run the Setup script yourself, inside this session, as a repair pass (it is idempotent):

```bash
bash "${CLAUDE_SKILL_DIR}/../../scripts/setup-clis-web.sh"
```

then retry the `bootstrap-deps.mjs --json` check once. If it still reports `ok: false`, show the `error` field reworded in plain French and stop - every later step needs these libraries.

⚠️ **Claude-only note - the `health` field.** `health: "broken"` is a specific, non-obvious failure: the packages downloaded fine but are unusable. Scaleway has been publishing packages whose compiled output is missing from the tarball, which is exactly why versions here are pinned to an exact release rather than a range (CONTRACT.md §3). The diagnostic tool is `tools/check-deps-health.mjs`; it names the offending package. Never relax a pin to "fix" this without running it. To the user, say only:

> Une des librairies téléchargées est défectueuse côté éditeur. Ce n’est pas votre installation. Je regarde ce qui se passe.

---

## Step 3 - Repo access

```bash
git ls-remote origin
```

This is the whole gate - **never** `gh auth login`, **never** `gh auth status`, no `gh` command at all (`gh` is not part of the toolchain here, CONTRACT.md §7). A working session already has git access to the repo it was opened on; a failure here almost always means GitHub was never connected to claude.ai/code, or the wrong repo is open - point the user at the chapter Installation du README.

- **Succeeds** → say nothing, continue to Step 4.
- **Fails** → relay the raw git error in plain French and point the user at the README chapter above - this is a GitHub-to-Claude-Code-web connection Baudrier does not manage or fix for them.

---

## Step 4 - Identité git

Git refuses to create a commit until it knows who is committing, and it fails with a message a non-technical user cannot act on (`Identité d'auteur inconnue - Veuillez me dire qui vous êtes`). Every commit this harness makes for them hits it: `/bootstrap`'s first commit, every `add-*` skill that commits its scaffolding, and `/deploy`'s push. Configure it here, once, rather than letting it surface mid-deploy.

This runs **after** Step 3 because it derives the values from the `origin` remote's own owner (parsed straight from the git remote URL - `gh` is no longer part of the toolchain, CONTRACT.md §7).

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-git-identity.mjs" --json
```

| `status` | What to do |
|---|---|
| `already-set` | say nothing, continue - an existing identity is never overwritten |
| `suggested` | show `suggested.name` / `suggested.email`, ask for a single confirmation, then write |
| `needs-input` | ask the user for their name and e-mail, then write |
| `no-git` | should be impossible on the Baudrier cloud environment; treat it as a Step 1 environment problem |

When `suggested`, ask exactly one question and offer the correction in the same breath:

> Pour signer vos enregistrements de code, je vais utiliser **`<name>`** et l’adresse **`<email>`**.
>
> Cette adresse est une adresse de redirection fournie par GitHub : vos contributions restent bien rattachées à votre compte, mais votre véritable adresse personnelle n’apparaît jamais dans l’historique public de votre projet.
>
> Ça vous va, ou vous préférez un autre nom ou une autre adresse ?

Then write what they confirmed or corrected:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-git-identity.mjs" --name "<NAME>" --email "<EMAIL>" --json
```

`status: "written"` → confirm in one line. `write-failed` → show `reason` in plain French (the most likely cause is a mistyped e-mail, which the script refuses rather than storing) and ask again.

⚠️ Write to the **global** scope (the script's default). Never pass `--local` here.

---

## Step 5 - Scaleway credentials and rights

Scaleway credentials are **environment variables only, never collected in chat** (CONTRACT.md §2, §7): `scw` has no login of its own to run, and they live in the cloud environment's own env-var dialog.

**Presence check:**

```bash
node -e 'for (const k of ["SCW_ACCESS_KEY","SCW_SECRET_KEY","SCW_DEFAULT_ORGANIZATION_ID","SCW_DEFAULT_REGION"]) console.log(k + "=" + (process.env[k] ? "set" : "MISSING"))'
```

If any line says `MISSING`, **stop here** - do not ask the user to paste anything into the chat. Say, in French:

> ⚠️ Il manque au moins une variable Scaleway dans cet environnement. Ouvrez le tableau de bord Claude Code, modifiez l’environnement cloud « Baudrier », et complétez les variables `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_ORGANIZATION_ID`, `SCW_DEFAULT_REGION` (le détail exact est dans le chapitre Installation du README). Une fois enregistré, **démarrez une NOUVELLE conversation** : celle-ci ne peut pas relire les variables d’un environnement modifié pendant qu’elle tournait déjà.

If all four are present, validate them live with one real API call:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" scaleway
```

- `ok: true` → confirm to the user: `✅ Scaleway est connecté (identifiants vérifiés par un appel réel à l’API).`
- `ok: false` → show `reason` in plain French and offer to retry once the fix is confirmed (a common cause: a value copy-pasted with a trailing space or missing character).

**Rights check.** An organization member might not hold the one right `/bootstrap` depends on to create each app's own dedicated Scaleway Project - the harness detects this once, here, rather than fail confusingly the first time `/bootstrap` runs:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-scw-permissions.mjs"
```

One JSON line, e.g. `{"ok":true,"probes":{"projects":{"status":403,...},"iam":{...}},"likelyMissing":["ProjectManager"],"certainty":"denial-only","blocking":false}`. This is a **read-only** probe: a clean result does not *guarantee* create rights, but a denial is a certain "missing" signal.

- **`likelyMissing` empty** → say nothing about it, continue straight to Step 6.
- **`likelyMissing` non-empty** → show a **non-blocking** warning with two paths:

  > ⚠️ Votre clé Scaleway fonctionne, mais elle n’a pas le droit de lister/créer des Projets au niveau de l’organisation (permission « ProjectManager »). Deux façons de continuer :
  >
  > **Cas A** - Vous êtes administrateur de l’organisation : recréez une clé avec cette permission au niveau de l’organisation (chapitre Installation du README), puis remplacez `SCW_SECRET_KEY` dans l’environnement cloud. **Démarrez ensuite une NOUVELLE conversation.**
  > **Cas B** - Vous êtes membre de l’organisation : listez vos applications et leurs Projets Scaleway dans la variable `BAUDRIER_SCW_PROJECTS_IDS` de l’environnement cloud, sous la forme `app-un:id1,app-deux:id2` - Baudrier ciblera ces Projets sans jamais tenter d’en lister ou d’en créer un autre, et un seul environnement cloud sert toutes vos applications. Pour une seule application, la variable `SCW_DEFAULT_PROJECT_ID` fonctionne aussi.
  >
  > Dans les deux cas, une **nouvelle conversation** est nécessaire après la modification.

  Explain Cas B further, non-blocking, in French:

  > Pas besoin d’attendre. Baudrier fonctionne normalement avec votre clé actuelle : pour créer une base de données, un bucket, une clé IA ou une clé email, il n’a besoin d’aucun aller-retour avec votre administrateur pendant le développement. Il utilise automatiquement, en interne, votre propre clé Scaleway le temps que la vraie clé technique soit créée - votre application reste restreinte au VPN pendant ce temps, donc ce n’est pas un problème.
  >
  > Votre administrateur est sollicité à exactement deux moments : la création de chaque nouveau projet Scaleway, et la fourniture des vraies clés techniques quand vous voulez rendre un site public (`/publish`). Pour le premier point, chaque nouvelle application (`/bootstrap`) vous demandera l’identifiant d’un projet Scaleway existant : celui que votre administrateur aura préparé pour cette application, ou votre propre projet par défaut si vous voulez d’abord faire un essai seul. Ajoutez cet identifiant à la liste `BAUDRIER_SCW_PROJECTS_IDS` de l’environnement cloud (« Edit environment », puis nouvelle conversation), ou donnez-le moi directement dans la conversation : il servira alors pour la session en cours. `/publish` bloque justement tant que les vraies clés techniques ne sont pas encore en place, et je vous prépare alors une liste unique, prête à transmettre.

  If the user wants to prepare their administrator right away, give them this short forwardable message (French, no adoption step, no organization-wide key):

  > Pour que je puisse travailler avec Baudrier, pouvez-vous m’accorder les permissions de service listées dans CONTRACT.md §1 (`SecretManagerFullAccess`, `ContainersFullAccess`, `ContainerRegistryFullAccess`, `ServerlessSQLDatabaseFullAccess`, `ServerlessJobsFullAccess`, `ObjectStorageFullAccess`, `DomainsDNSFullAccess`, `TransactionalEmailFullAccess`, `GenerativeApisFullAccess`, `BillingReadOnly`, `ObservabilityFullAccess`) - **sans** « ProjectManager » ni « IAMManager » ? Le guide détaillé est ici : `docs/ADMIN-SCALEWAY.md`. Ensuite, vous n’aurez plus rien à faire pendant tout le développement : un projet Scaleway par nouvelle application (`/bootstrap`), puis une seule liste groupée de clés techniques le jour où je voudrai rendre un site public (`/publish`).

  If the user wants the `poc` behavior explicitly (rather than relying on `BAUDRIER_SCW_PROJECTS_IDS` or `SCW_DEFAULT_PROJECT_ID` alone), tell them to add `BAUDRIER_SCW_MODE=poc` to the cloud environment's variables themselves - there is no persistence script to run here, it is a plain environment variable (`full` by default, CONTRACT.md §1, §2), read fresh on every run.

⚠️ **Never block Step 5 on this.** Whichever path the user takes, or skips, Step 5 already concluded above once the live validation succeeded - this subsection only adds a warning and, optionally, a message to forward.

Continue straight to Step 6 either way.

---

## Step 6 - Network reachability of the Scaleway API

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.scaleway.com/account/v3/projects
```

`400` or `401` **proves the domain is reachable** (Scaleway returns a `400` validation error for this call without an `organization_id` - not a network failure; only a `401`/`403` would point at the key itself, already handled above). An empty result or `000` means the environment's network access blocks `api.scaleway.com` - tell the user to switch the environment's network access to **Full** (the recommended setting, see the chapter Installation du README; a hardened Custom allowlist is possible but every missing domain breaks a step), then start a new session.

---

## Step 7 - Docker and tool audit

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/ensure-dockerd.mjs"
```

This only reports whether the daemon currently answers (`{"running":true|false}`) - it never starts it here. `running: false` is normal and **non-blocking**: `/bootstrap` and `/deploy` both start the daemon lazily themselves, the first time they actually need it (a fresh sandbox session never has `dockerd` running at boot, CONTRACT.md §1, §7). Do not try to start it yourself in this step.

Cross-check every tool the environment's Setup script was supposed to install:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/audit-clis.mjs" --json
```

Each entry has a `status`: `ready`, `outdated`, `missing`, or `timeout` (treat a timeout as **not** verified, never as ready). If anything besides Docker's own `daemonRunning` (already handled above) is not `ready`, the environment's Setup script did not fully succeed at build time. Say, in French:

> ⚠️ Votre environnement cloud « Baudrier » n’a pas installé tous les outils correctement. Le plus fiable est de le reconstruire : dans le tableau de bord Claude Code, ouvrez l’environnement « Baudrier » et relancez sa construction (le script de configuration, `setup-clis-web.sh`, est rejoué automatiquement). Relancez `/start` une fois la reconstruction terminée.

Do not try to patch a broken tool one by one - rebuilding the cloud environment re-runs `setup-clis-web.sh` cleanly, which is the one sanctioned repair path for this class of failure.

---

## Step 8 - Identity verification (KYC)

Explain this even though it is optional - a non-technical user will otherwise be baffled the day their app silently stops sending emails.

> **Une dernière chose, optionnelle mais utile : la vérification d’identité Scaleway.**
>
> Sans vérification, votre compte Scaleway est limité :
> - **500 emails/mois** et **2 domaines** pour l’envoi d’emails (après vérification : 5 000 emails/mois et 5 domaines)
> - **100 secrets** dans le coffre-fort de secrets (après : 250)
> - **25 espaces de conteneurs** (après : 50)
> - **60 Go de RAM** pour vos conteneurs au total (après : 150 Go)
>
> Ces plafonds sont larges pour démarrer, mais si votre app envoie beaucoup d’emails ou si vous avez plusieurs projets, mieux vaut vérifier votre identité maintenant (pièce d’identité, ~2 minutes) pour ne jamais avoir de mauvaise surprise (typiquement : les emails qui s’arrêtent silencieusement une fois le plafond atteint).
>
> Voulez-vous le faire maintenant, ou plus tard depuis la console Scaleway ?

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs" --json "https://console.scaleway.com/organization/settings"
```

Same rule as Step 5: if `opened: false`, show the address rather than assuming a browser opened.

This is informational only - never block `/start` on the answer. If the user says later/no, move on without repeating the pitch on future runs (do not re-ask if the same account already went through this Step and answered).

---

## Step 9 - Overview and conclusion

> **Tout est prêt !** Vous pouvez lancer votre premier projet avec :
>
> `/bootstrap` - Décrivez ce que vous voulez créer, je m’occupe du reste.
>
> 💡 **Astuce** : si vous voulez comprendre comment tout fonctionne avant de vous lancer (la stack technique, les différentes commandes du plugin, le déploiement, etc.), lancez `/prof` - un mode pédagogique qui explique tout en langage clair.

> **C’est prêt ! ✨** À vous de jouer.
