---
name: save-project
description: "Crée une sauvegarde complète (zip horodaté) d'un projet Baudrier - code (git bundle), variables d'environnement (Secret Manager + .env local), fichiers du stockage Object Storage, mémoire Claude, et la liaison Scaleway (config/scaleway-link.json, résolue par nom). N'inclut PAS les données de la base de données (l'opérateur n'a aucun accès direct à la base - voir DOC.md) : le zip le dit explicitement plutôt que de le taire. Utile avant `/delete-project`, avant un gros refactor, en fin de mission, ou pour une archive hors-ligne. Le zip est enregistré dans le dossier Téléchargements par défaut (dans un dossier temporaire sur Claude Code web)."
argument-hint: "<nom-du-projet>"
allowed-tools: Bash Read Edit Write Glob AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# /save-project - Instantané complet d'un projet Baudrier

Tu crées un zip complet de tout ce qui définit un projet Baudrier, à un instant donné. Le zip sert de filet de sécurité avant une opération risquée (suppression, refactor, fin de mission) ou d'archive personnelle/client.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Step 1 - Préflight

### 1a. Déterminer le projet

Le nom du projet peut venir de :
- Un argument direct (`/save-project <nom>`)
- Le dossier courant (lire `package.json` à la racine de `process.cwd()`, champ `name`)
- Un dossier plus haut si on est dans un monorepo (`apps/web/package.json`)

Si le nom est ambigu (ex. un monorepo où le `package.json` racine a un nom différent de `apps/web/package.json`), montre les deux et demande lequel utiliser.

Si vraiment rien ne se détecte, demande à l'utilisateur :

> *"Quel dossier contient le projet à sauvegarder ? (chemin absolu ou relatif)"*

### 1b. Vérifier que c'est bien un projet Baudrier

Critères :
- `package.json` existe à la racine du projet
- Au moins un de : un Serverless Container Scaleway résolu par le nom du projet, `.git/`, présence de `next` dans les dépendances

Si rien ne correspond, signale-le mais propose de continuer quand même (ça pourrait être un projet non-Baudrier que l'utilisateur veut quand même sauvegarder).

### 1c. Présenter le plan à l'utilisateur

Affiche un récap concis :

> ## 📦 Instantané du projet **<nom>**
>
> Voici ce qui sera inclus dans le zip :
>
> | Élément | Statut | Notes |
> |---|---|---|
> | **Code + historique Git** | ✅ inclus | Git bundle complet, restaurable via `git clone` |
> | **Modifications en cours** | <✅ inclus / ➖ aucune> | Modifications non commitées capturées via `git diff HEAD` |
> | **Variables d'environnement** | <✅ incluses / ⚠️ Scaleway non configuré> | Depuis Secret Manager + copie du `.env` local |
> | **Base de données** | 🔴 **PAS incluse** | Voir la note ci-dessous |
> | **Stockage de fichiers** | <à confirmer> | Voir la question ci-dessous |
> | **Mémoire Claude** | ✅ incluse | Fichiers dans `~/.claude/projects/...` |
> | **Configuration Scaleway** | ✅ incluse | `config/scaleway-link.json` (liaison namespace/container résolue par nom - pas un secret) |
>
> 🔴 **Important - la base de données n'est PAS dans ce zip** : la machine de l'opérateur n'a jamais d'accès direct à la base (voir CONTRACT.md §4 - seule la Job de migration s'y connecte). Concrètement, ça veut dire qu'**aucune de tes données métier** (clients, commandes, contenus, comptes...) n'est dans cette sauvegarde - seulement le code, les identifiants techniques et les fichiers du stockage. Scaleway indique dans sa documentation générale effectuer des sauvegardes automatiques des bases de données, mais je n'ai pas pu vérifier précisément la fréquence ni la durée de rétention pour Serverless SQL Database - **ne compte pas dessus comme garantie**. Si tes données comptent, le seul export fiable est celui que tu déclenches toi-même (`pg_dump` depuis un poste ayant accès réseau à la base, ou un outil dans la console Scaleway).
>
> ⚠️ **Note importante** : le zip contiendra des **secrets en clair** dans les fichiers `.env`. À traiter comme un document confidentiel après création.

**Sur Claude Code web** : la session est temporaire et n’a pas de navigateur pour télécharger un fichier. Le zip est alors écrit dans un dossier temporaire de la session (pas le dossier Téléchargements), et disparaît avec la session - le script le signale explicitement. Dans ce cas, mieux vaut compter sur le dépôt Git (déjà une sauvegarde du code) et le versioning du bucket Object Storage (déjà 90 jours de rétention des versions précédentes, CLAUDE.md) plutôt que sur un zip qu’on ne peut pas récupérer.

### 1d. Question sur le stockage de fichiers

Si un secret `STORAGE_BUCKET` existe pour ce projet (vérifiable via `_pull-env-vars` ou en tentant la lecture), utilise **AskUserQuestion** :

> Question : "Inclure le contenu du stockage de fichiers (Object Storage) dans la sauvegarde ?"
> - Option 1 : **Oui - tout inclure (recommandé)** - peut prendre du temps s'il y a beaucoup de fichiers (vidéos, images)
> - Option 2 : **Non - ignorer le stockage** - instantané plus rapide, ne contient pas les fichiers uploadés

Si Option 2, passe `--skip-storage` au script.

### 1e. Question sur le chemin de sortie

Utilise **AskUserQuestion** :

> Question : "Où enregistrer le zip ?"
> - Option 1 : **Dossier Téléchargements (recommandé)** - emplacement standard, facile à retrouver
> - Option 2 : **Dans le dossier courant** - pratique si tu veux tout au même endroit
> - Option 3 : **Autre chemin** - l'utilisateur le précise explicitement

Si Option 3, demande le chemin en suivi (texte libre). Vérifie qu'il existe ou peut être créé.

### 1f. Confirmation finale

Avant de lancer, une dernière confirmation :

> Récap final :
> - Projet : `<nom>`
> - Source : `<chemin>`
> - Destination : `<chemin>/<nom>-snapshot-<TS>.zip`
> - Stockage : <inclus / ignoré>
> - Base de données : PAS incluse (voir la note ci-dessus)
>
> On lance la sauvegarde ?

Si oui, passe à l'étape 2. Sinon, annule proprement.

---

## Step 2 - Exécution

Lance le script embarqué :

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/save-project/build-snapshot.mjs" \
  --project "<nom>" \
  --project-dir "<chemin-absolu-du-projet>" \
  --out "<chemin-de-destination>" \
  [--skip-storage si l'utilisateur a dit non]
```

Pendant l'exécution, le script logge chaque étape sur stderr avec un préfixe `[étape] statut`. Relaie ces logs à l'utilisateur en temps réel via `↳ ...` (un par étape terminée).

À la fin, le script écrit un JSON `{status, zipPath, zipSize, timestamp, steps}` sur stdout. Récupère-le.

### Erreurs partielles

C'est normal que certaines étapes soient sautées (pas de stockage configuré, projet pas lié à Scaleway) - le script continue. Une étape en `error` ne bloque pas la suivante. Une seule étape est vraiment fatale = le zip lui-même échoue.

---

## Step 3 - Rapport à l'utilisateur

Affiche un récap clair :

> ## ✅ Instantané terminé
>
> **Fichier** : `<zipPath>`
> **Taille** : `<zipSize>`
>
> ### Contenu
>
> | Étape | Statut | Notes |
> |---|---|---|
> | Code + historique | ✅ ok | <bundleBytes en MB>, modifications non commitées : <oui/non> |
> | Variables d'env | ✅ ok | <secretsWritten> secrets, <localFilesCopied> fichier(s) .env local copié(s) |
> | Base de données | 🔴 pas incluse | Voir `db/NOTE.md` dans le zip |
> | Stockage | <✅ ok / ➖ ignoré> | <totalObjects> fichiers (<totalSize>) |
> | Mémoire Claude | ✅ ok | <matchedDirs> dossier(s) mémoire copié(s) |
> | Configuration | ✅ ok | `config/scaleway-link.json` inclus |
>
> ### ⚠️ Sécurité du zip
>
> Ce fichier contient **des secrets en clair**. Avant toute chose :
> - Pas de partage par email non chiffré ou sur un canal public
> - Si tu le mets sur un service cloud (Dropbox, iCloud...), assure-toi que c'est ton compte personnel, pas un compte partagé
> - Supprime-le dès que tu n'en as plus besoin
>
> ### Pour restaurer
>
> Le `MANIFEST.md` à l'intérieur du zip explique la procédure. En bref : `git clone code/repo.bundle`, puis recréer la base / le stockage depuis les fichiers fournis. Tu peux toujours rouvrir Claude Code dans le dossier extrait et demander à te faire guider pour la restauration.

Si une étape a `status: "error"`, mentionne-la honnêtement avec le message d'erreur - pas besoin de la cacher.

Si l'étape `git-bundle` est sautée (pas un dépôt git), insiste : **sans git bundle, le code source n'est pas dans la sauvegarde**. Demande à l'utilisateur s'il veut quand même garder ce zip ou tout annuler.

**Rappelle systématiquement**, même si l'utilisateur ne pose pas la question, que la base de données n'est pas dans le zip - donc qu'aucune donnée métier (clients, commandes, contenus...) n'y figure. Ne présente **jamais** les sauvegardes automatiques de Scaleway comme un filet de sécurité garanti (leur fréquence/rétention exactes ne sont pas vérifiées ici) - dis plutôt clairement que si l'utilisateur veut un vrai filet de sécurité pour ses données, c'est à lui de déclencher un export. Ne jamais sous-entendre que la sauvegarde est "complète" sans cette précision.

---

## Erreurs courantes à gérer

- **Python non installé** : la dernière étape (le zip) échoue. Rare (souvent déjà présent comme dépendance), mais possible. Propose d'installer Python ou de zipper à la main depuis le dossier `WORK_DIR` que le script indique en cas d'erreur.
- **Aucun secret DATABASE_URL** : le projet n'a peut-être pas de base Scaleway, ou la variable a un nom différent. C'est normal, `db/NOTE.md` le documente clairement dans le zip.
- **Scaleway non configuré (`SCW_ACCESS_KEY`/`SCW_SECRET_KEY` absents)** : l'étape variables d'env se limite à la copie du `.env` local, on continue. Mentionne-le dans le rapport.
- **Le script plante entièrement (exit 1)** : le `WORK_DIR` est laissé tel quel pour du débogage. Le chemin est dans le JSON de sortie. Donne-le à l'utilisateur pour qu'il puisse aller vérifier / supprimer manuellement.

---

## Ce qu'il ne faut PAS faire

- ❌ Ne jamais lancer `/save-project` automatiquement depuis une autre skill sans confirmation explicite (le zip a un coût en temps et en disque)
- ❌ Ne jamais laisser croire que la sauvegarde est complète alors que la base de données n'y est pas - le dire explicitement à chaque fois
- ❌ Ne pas proposer de `/restore-project` automatique - ça n'existe pas et c'est volontaire (trop dangereux). La restauration est manuelle et assistée.
- ❌ Ne pas faire de `git push` ou `commit` automatique - on travaille en lecture seule sur le projet
