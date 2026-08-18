---
name: _preflight
description: Internal preflight for Baudrier on Claude Code web. Verifies the environment, installs missing dependencies, and checks Scaleway credentials and rights before /bootstrap runs.
user-invocable: false
compatibility: "Agent Skills standard (Claude Code). Runs only on Claude Code web (claude.ai/code): Node.js, git, pnpm and Docker are preinstalled by the cloud environment's own Setup script."
---

# Preflight - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

This harness runs entirely on Scaleway (CONTRACT.md §1). It uses one hosting provider and one secrets store. Scaleway credentials are environment variables only (CONTRACT.md §2, §7). Baudrier runs only on Claude Code web (claude.ai/code, CONTRACT.md §1, §7). Claude Code web provides an ephemeral, root, no-persistent-home VM. The cloud environment's own Setup script (`setup-clis-web.sh`) preinstalls the toolchain. `_preflight` therefore deals with exactly three things: the environment guard, the harness's own dependencies, and Scaleway credentials and rights.

---

## Step 1 - Environment guard

Silently check the environment:

```bash
echo "claude_code_remote=${CLAUDE_CODE_REMOTE:-}"
```

**If `claude_code_remote` is not `true` or `1`**, stop immediately - do not run anything else in this skill. Say, in French, then wait:

> Baudrier fonctionne uniquement sur Claude Code web (claude.ai/code).

**If `claude_code_remote` is `true` or `1`**, continue silently to Step 2.

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

## Step 3 - Scaleway credentials and rights

Scaleway credentials are **environment variables only, never collected in chat** (CONTRACT.md §2, §7): `scw` has no login of its own to run, and they live in the cloud environment's own env-var dialog.

**Presence check:**

```bash
node -e 'for (const k of ["SCW_ACCESS_KEY","SCW_SECRET_KEY","SCW_DEFAULT_ORGANIZATION_ID","SCW_DEFAULT_REGION","SCW_DEFAULT_PROJECT_ID","SCW_DEFAULT_APPLICATION_ID"]) console.log(k + "=" + (process.env[k] ? "set" : "MISSING"))'
```

If `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_ORGANIZATION_ID`, or `SCW_DEFAULT_REGION` says `MISSING`, **stop here** - do not ask the user to paste anything into the chat. Say, in French:

> ⚠️ Il manque au moins une variable Scaleway dans cet environnement. Ouvrez le tableau de bord Claude Code, modifiez l’environnement cloud « Baudrier », et complétez les variables `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_ORGANIZATION_ID`, `SCW_DEFAULT_REGION` (le détail exact est dans le chapitre Installation du README). Une fois enregistré, **démarrez une NOUVELLE conversation** : celle-ci ne peut pas relire les variables d’un environnement modifié pendant qu’elle tournait déjà.

`SCW_DEFAULT_PROJECT_ID` and `SCW_DEFAULT_APPLICATION_ID` reporting `MISSING` here are not
fatal by themselves. The credential shape is not known yet at this point, and each variable
is mandatory only in one shape. The Rights check below resolves the shape and, in Cas B,
treats both variables as mandatory. Remember whether `SCW_DEFAULT_PROJECT_ID` and
`SCW_DEFAULT_APPLICATION_ID` reported `MISSING` here - the Rights check needs both facts.

If the four mandatory variables are present, validate them live with one real API call:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" scaleway
```

- `ok: true` → confirm to the user: `✅ Scaleway est connecté (identifiants vérifiés par un appel réel à l’API).`
- `ok: false` → show `reason` in plain French and offer to retry once the fix is confirmed (a common cause: a value copy-pasted with a trailing space or missing character).

**Rights check.** An organization member might not hold the one right `/bootstrap` depends on to create each app's own dedicated Scaleway Project - the harness detects this once, here, rather than fail confusingly the first time `/bootstrap` runs:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-scw-permissions.mjs"
```

One JSON line, e.g. `{"ok":true,"probes":{"projects":{"status":403,...},"iam":{...}},"likelyMissing":["ProjectManager"],"certainty":"denial-only","blocking":false,"orgReach":false,"canMint":false,"conclusive":true,"shape":"project"}`. This is a **read-only** probe: a clean result does not *guarantee* create rights, but a denial is a certain "missing" signal. `shape` is `"project"` for Cas B, `"org"` for Cas A, and `"unknown"` when `conclusive` is `false` - an inconclusive probe must never be read as Cas B (`operatorKeyAsAppCredential()` fails closed the same way).

Key this decision on `shape` alone, so the three branches below are disjoint and exhaustive. Read `likelyMissing` only inside the `"org"` branch.

- **`shape` is `"unknown"`** → show a **non-blocking** warning, in French, and continue. Do not read `likelyMissing` in this branch:

  > ⚠️ Impossible de vérifier avec certitude la portée de votre clé Scaleway pour le moment. Cela ne signifie pas que vous êtes en Cas B : la vérification a simplement échoué autrement que par un refus net. Baudrier continue ; réessayez la vérification plus tard si des opérations liées à la base de données échouent.

- **`shape` is `"project"` (Cas B)** → both `SCW_DEFAULT_PROJECT_ID` and `SCW_DEFAULT_APPLICATION_ID` are mandatory.

  - **`SCW_DEFAULT_PROJECT_ID` or `SCW_DEFAULT_APPLICATION_ID` reported `MISSING` in the presence check** → **stop here** - do not hand control back to `/bootstrap`. Write one French message that names the missing variable or variables, built from the wording below.

    When `SCW_DEFAULT_APPLICATION_ID` is missing, include this wording:

    > ⚠️ Votre clé Scaleway est limitée à un seul Projet. C’est le fonctionnement normal du Cas B, pas une erreur.
    >
    > Pour créer l’accès à la base de données, Baudrier a besoin de l’identifiant de l’application IAM qui porte cette clé. Cet identifiant n’est pas un secret.
    >
    > Dans la console Scaleway : IAM → Clés API → repérez la ligne de votre `SCW_ACCESS_KEY` → ouvrez l’application qui porte cette clé → copiez son identifiant. Si vous n’avez pas accès à la console, votre administrateur peut aussi vous communiquer cet identifiant.

    When `SCW_DEFAULT_PROJECT_ID` is missing, include this wording:

    > Une clé limitée à un seul Projet ne peut pas lister les Projets de l’organisation. Demandez à votre administrateur l’identifiant du Projet réservé à cette application, puis renseignez-le.

    When both variables are missing, include both pieces of wording, one after the other.

    Close the message with, in French:

    > Ajoutez la ou les variables manquantes dans l’environnement cloud « Baudrier », puis **démarrez une NOUVELLE conversation** : celle-ci ne peut pas relire les variables d’un environnement modifié pendant qu’elle tournait déjà.

  - **Both present** → show only the existing non-blocking Cas B explanation, in French:

    > En Cas B, votre clé Scaleway reste limitée à ce seul Projet. Elle sert directement toutes les opérations de Baudrier sur cette application, du développement jusqu’à la publication (`/publish`), sans étape intermédiaire ni clé technique séparée à fournir plus tard.
    >
    > Un environnement cloud sert alors une seule application. Pour une deuxième application, préparez un second environnement cloud, avec sa propre clé Scaleway et son propre `SCW_DEFAULT_PROJECT_ID`.

- **`shape` is `"org"` (Cas A)** → never stops here. Read `canMint` first, then `likelyMissing`:

  - **`canMint` is `false`** (the deadlock shape) → show a **non-blocking** warning, in French:

    > ⚠️ Votre clé Scaleway porte un droit sur toute l’organisation, mais elle ne peut pas créer de clés IAM déléguées : il lui manque la permission « IAMManager ». Elle ne correspond alors ni au Cas A ni au Cas B, et Baudrier refuse de deviner.
    >
    > Deux solutions : ajoutez la permission `IAMManager` à cette clé, ou demandez à votre administrateur une clé limitée à un seul Projet, sans aucun droit d’organisation (`docs/ADMIN-SCALEWAY.md`).

  - **`canMint` is `true` and `likelyMissing` empty** → say nothing about it, continue silently.

  - **`canMint` is `true` and `likelyMissing` contains `ProjectManager`** → show a **non-blocking** warning with two paths:

    > ⚠️ Votre clé Scaleway fonctionne, mais elle n’a pas le droit de lister/créer des Projets au niveau de l’organisation (permission « ProjectManager »). Deux façons de continuer :
    >
    > **Cas A** - Vous êtes administrateur de l’organisation : recréez une clé avec cette permission au niveau de l’organisation (chapitre Installation du README), puis remplacez `SCW_SECRET_KEY` dans l’environnement cloud. **Démarrez ensuite une NOUVELLE conversation.**
    > **Cas B** - Vous êtes membre de l’organisation : demandez à votre administrateur un Projet Scaleway dédié à cette application, puis indiquez son identifiant dans la variable `SCW_DEFAULT_PROJECT_ID` de l’environnement cloud. Baudrier cible ce Projet directement, sans jamais tenter d’en lister ou d’en créer un autre.
    >
    > Dans les deux cas, une **nouvelle conversation** est nécessaire après la modification.

    Explain Cas B further, non-blocking, in French:

    > En Cas B, votre clé Scaleway reste limitée à ce seul Projet. Elle sert directement toutes les opérations de Baudrier sur cette application, du développement jusqu’à la publication (`/publish`), sans étape intermédiaire ni clé technique séparée à fournir plus tard.
    >
    > Un environnement cloud sert alors une seule application. Pour une deuxième application, préparez un second environnement cloud, avec sa propre clé Scaleway et son propre `SCW_DEFAULT_PROJECT_ID`.

    If the user wants to prepare their administrator right away, give them this short forwardable message (French, no adoption step, no organization-wide key):

    > Pour que je puisse travailler avec Baudrier, pouvez-vous créer un Projet Scaleway dédié à cette application et m’accorder, sur ce Projet, les permissions de service listées dans CONTRACT.md §1 (`SecretManagerFullAccess`, `ContainersFullAccess`, `ContainerRegistryFullAccess`, `ServerlessSQLDatabaseFullAccess`, `ServerlessJobsFullAccess`, `ObjectStorageFullAccess`, `DomainsDNSFullAccess`, `TransactionalEmailFullAccess`, `GenerativeApisFullAccess`, `ObservabilityFullAccess`) - **sans** « ProjectManager » ni « IAMManager » ? Le guide détaillé est ici : `docs/ADMIN-SCALEWAY.md`. Donnez-moi ensuite l’identifiant de ce Projet, pour la variable `SCW_DEFAULT_PROJECT_ID`, et l’identifiant de l’application IAM qui porte la clé, pour la variable `SCW_DEFAULT_APPLICATION_ID`.

  - **`canMint` is `true` and `likelyMissing` holds only `BillingReadOnly`** → show one **non-blocking** line, in French. Do not tell the user to recreate the key:

    > ⚠️ Votre clé Scaleway fonctionne normalement. Seule exception : la commande `/costs` ne peut pas afficher le montant dépensé. Ce montant reste visible dans la console Scaleway.

⚠️ **The Rights check stops for one reason only:** `shape` is `"project"` (Cas B) and a mandatory variable, `SCW_DEFAULT_PROJECT_ID` or `SCW_DEFAULT_APPLICATION_ID`, is absent. No permission warning stops the Rights check.

This is the last preflight check. Hand control back to `/bootstrap`, which continues with its own next step.
