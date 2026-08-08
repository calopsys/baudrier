---
name: delete-project
description: "Supprime définitivement l'infrastructure Scaleway JETABLE d'un projet Baudrier : namespace de containers + containers, namespace de registre + images, définitions Serverless Jobs, secrets Secret Manager, application(s) IAM + clés API, domaine TEM, les enregistrements DNS ajoutés pour l'app, et le dépôt GitHub. Ne supprime JAMAIS la ou les bases Serverless SQL Database, ni le/les bucket(s) Object Storage (ni leur contenu), ni le Project Scaleway lui-même - ces trois choses sont TOUJOURS laissées en place, avec un rapport final qui donne leurs noms exacts et les liens de la console Scaleway pour une suppression manuelle si l'utilisateur la veut vraiment. Affiche d'abord un GROS avertissement (qui précise dès le départ que la base et le stockage ne sont jamais touchés) et demande une double confirmation (action irréversible pour ce qui EST supprimé). Fait ensuite un inventaire COMPLET, y compris un scan des variables d'environnement pour détecter des services tiers hors stack Baudrier (OpenAI, Mapbox, Sentry, etc.). Utiliser quand l'utilisateur dit \"supprime le projet X\", \"nettoie complètement X\", \"/delete-project X\", ou veut décommissionner un projet."
argument-hint: "<nom-du-projet>"
allowed-tools: Bash Read AskUserQuestion TodoWrite
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# Delete Project - Décommissionnement complet

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Tu supprimes l'infrastructure Scaleway **jetable** d'un projet Baudrier - jamais ses données. L'utilisateur est **non-technique** : aucune commande à taper, aucun jargon brut, un chemin de dossier à ouvrir soi-même plutôt qu'un `rm -rf`.

**Règle absolue, non négociable, à connaître avant de lire le reste de cette skill** : cette skill ne supprime **jamais** une base de données Serverless SQL, **jamais** un bucket Object Storage (ni le vide de son contenu), et **jamais** le Project Scaleway lui-même (le supprimer ferait disparaître la base et le bucket avec lui - voir l'encadré ci-dessous pour pourquoi). C'est une exigence directe de l'utilisateur du harness, appliquée au niveau du script lui-même (`scripts/delete-project/execute-deletions.mjs` n'importe même pas les fonctions qui pourraient le faire) - pas seulement une case à cocher dans le dialogue. Si l'utilisateur insiste pour supprimer sa base ou son bucket via cette skill, explique-lui que ce n'est techniquement pas possible ici et oriente-le vers la console Scaleway (liens fournis en fin de run).

**Pourquoi le Project Scaleway lui-même n'est jamais supprimé** : Scaleway refuse de toute façon de supprimer un Project qui contient encore des ressources - tant que la base et le bucket restent dedans (ce qui est désormais systématique), une tentative échouerait d'elle-même. Mais on ne s'appuie **jamais** sur ce refus API comme seule protection : le script ne tente même pas l'appel. Double sécurité, pas une seule.

**Ce qui a changé depuis l'ancienne version de cette skill** : la stack tient sur **un seul Scaleway Project par app** (voir CONTRACT.md), ce qui simplifie beaucoup l'inventaire (presque tout se retrouve sans ambiguïté, scopé par `project_id`). Deux catégories restent nommées, pas scopées par Project : les applications IAM (rattachées à l'Organisation) et les enregistrements DNS (domaine externe de l'utilisateur) - la skill garde donc un garde-fou de correspondance de noms (`scripts/_match.mjs`) pour elles.

La skill s'appuie sur 2 scripts qui font le gros du travail :

- **`scripts/delete-project/discover-resources.mjs`** : Phase 1 (inventaire). Résout le Scaleway Project de l'app puis scanne tout ce qu'il contient, en parallèle - y compris la base et le bucket, mais **uniquement pour pouvoir les citer dans le rapport final**, jamais pour les supprimer. Retourne 1 JSON structuré. Purement en lecture.
- **`scripts/delete-project/execute-deletions.mjs`** : Phase 3 (exécution). Prend l'inventaire + le périmètre choisi par l'utilisateur, supprime en parallèle l'infrastructure jetable uniquement. Base de données, stockage et Project Scaleway ne font partie d'aucun périmètre possible - le script les rapporte sous `refused` si on essaie quand même de les y mettre. Retourne un rapport `{deleted, failed, skipped, refused}`.

Ton rôle = orchestrer les confirmations, valider le périmètre, présenter clairement, ne jamais recoder à la main ce que les scripts gèrent déjà, et **toujours** terminer par le rappel explicite (en français, bien visible) de ce qui a été volontairement laissé en place.

---

## Phase 0 - Identifier le projet + GROS AVERTISSEMENT + double confirmation

### 0.1 Identifier le projet

Si l'utilisateur n'a pas donné le nom (`/delete-project <nom>` ou *"supprime cool-trattoria"*), demande-le **avant** d'afficher l'avertissement - sinon l'avertissement sera générique.

Si le nom est ambigu ("art", "site", "blog"), confirme : *"Tu veux bien supprimer exactement le projet `X` ? Je vais chercher son Project Scaleway dédié (un Project par app)."*

### 0.2 Afficher l'avertissement (obligatoire, jamais escamotable)

```
╔══════════════════════════════════════════════════════════════╗
║  ⚠️  ⚠️  ⚠️   ATTENTION - ACTION IRRÉVERSIBLE   ⚠️  ⚠️  ⚠️    ║
╚══════════════════════════════════════════════════════════════╝

Je m'apprête à supprimer DÉFINITIVEMENT l'infrastructure technique
jetable du projet `<NOM_DU_PROJET>` :

 • Le site déployé et son URL personnalisée
 • Les images de build stockées (registre)
 • Les tâches automatisées (migration, agents planifiés...)
 • Les accès techniques créés pour cette app (clés API, IAM)
 • Les identifiants stockés (Secret Manager)
 • Le domaine d'envoi d'emails et les entrées DNS ajoutées
 • Le dépôt GitHub

🟢  Ce que je NE supprime JAMAIS, quoi qu'il arrive :
 • La base de données et TOUTES ses données (clients, commandes,
   réservations, comptes utilisateurs...)
 • Le stockage de fichiers (bucket) et TOUT son contenu
   (photos, documents, avatars)
 • Le Project Scaleway lui-même (il contient la base et le bucket)
   → Ils resteront en place, et donc toujours facturés, jusqu'à ce que
     TOI tu décides de les supprimer manuellement dans la console
     Scaleway. Je te donnerai les liens exacts à la fin.

🔴  Pour ce qui EST supprimé ci-dessus : c'est IRRÉVERSIBLE, rien ne
    peut être récupéré après coup.
🔴  Si le projet contient de vraies données (dans le code, les secrets,
    le stockage), fais d'abord une sauvegarde manuelle - la base et le
    bucket, eux, resteront de toute façon en place.
```

### 0.3 Proposer une sauvegarde avant de continuer (filet de sécurité)

**Même avant la double confirmation**, propose explicitement à l'utilisateur de faire un instantané du projet. Affiche :

> 💡 **Une suggestion avant de continuer** : as-tu une sauvegarde complète du projet ? Sinon, je peux en faire une maintenant - ça créera un zip avec : le code + l'historique Git, les variables d'environnement, le contenu du stockage de fichiers, la mémoire Claude, les configs. Tu auras un filet de sécurité si tu changes d'avis ou as besoin de récupérer quelque chose plus tard.
>
> ⚠️ Une chose importante à savoir : cette sauvegarde **ne contient pas les données de la base** (voir DOC.md de `/save-project` pour pourquoi) - seulement le code, les identifiants et les fichiers stockés. Cela dit, ce n'est pas grave dans ton cas précis : je ne supprime **jamais** ta base de données ni ton bucket de stockage (voir l'avertissement ci-dessus) - ils resteront intacts après cette opération, quoi qu'il arrive.

Utilise `AskUserQuestion` :
- Question : "Faire une sauvegarde du projet juste avant de le supprimer ?"
- Options :
  - `Oui, fais l'instantané maintenant (recommandé)`
  - `Non, j'ai déjà une sauvegarde récente`
  - `Non, je veux supprimer sans sauvegarde`

→ Si **"Oui, fais l'instantané maintenant"** : lance **directement** le script d'instantané (sans quitter la skill `/delete-project`). Voir le bloc ci-dessous. Une fois l'instantané terminé avec succès, continue avec 0.4.
→ Si **"Non, déjà sauvegardé"** ou **"Non, sans sauvegarde"** : continue directement avec 0.4.

#### Si un instantané est demandé : lancer directement

Pas besoin de redemander le projet (on l'a déjà) ni le dossier de sortie (le défaut convient). Lance :

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/save-project/build-snapshot.mjs" \
  --project "<NOM_DU_PROJET>" \
  --project-dir "<chemin-détecté-du-projet>"
```

Pendant l'exécution, relaie les logs `[étape] statut` du script (stderr) à l'utilisateur (un `↳ ...` par étape terminée).

À la fin, le script écrit `{status, zipPath, zipSize, ...}` sur stdout. Récupère-le, affiche le récap :

> ✅ **Sauvegarde créée** : `<zipPath>` (`<zipSize>`)
>
> Le zip contient **des secrets en clair** : à traiter comme un document confidentiel. On peut maintenant continuer avec la suppression.

**Si la sauvegarde échoue** (script en exit 1 ou `status: "error"`) : **arrête la skill `/delete-project`** et préviens l'utilisateur. On ne supprime jamais sans sauvegarde réussie quand l'utilisateur l'a explicitement demandée. Affiche l'erreur et propose : (a) relancer `/save-project` manuellement pour diagnostiquer, (b) relancer `/delete-project` ensuite en disant qu'il a déjà la sauvegarde, (c) annuler.

### 0.4 Double confirmation (Q1 via `AskUserQuestion`, Q2 en texte libre)

**Question 1** : "Tu confirmes vouloir **supprimer définitivement** l'infrastructure technique jetable du projet `<NOM_DU_PROJET>` (site, images, tâches, accès techniques, domaine email, entrées DNS, dépôt GitHub) et acceptes que cette suppression soit irréversible ? Pour rappel : ta base de données et ton stockage de fichiers ne seront **jamais** touchés par cette opération."
- Options : `Oui, je confirme` / `Non, juste le mettre en veille` / `Non, annuler`

→ Si **"le mettre en veille"** : explique brièvement que ce n'est pas ce que fait cette skill - le harness n'a pas de mode "pause" pour un Project Scaleway (ce n'est pas comme suspendre un service unique). La seule vraie mise en veille possible est de restreindre l'accès public (`/unpublish`, déjà actif par défaut) : le site continue de coûter (base de données, éventuel stockage), mais n'est plus atteignable publiquement. Propose ça comme alternative puis **arrête la skill**.
→ Si **"annuler"** : arrête la skill.
→ Si **"Oui"** : continue avec Q2.

**Question 2** (confirmation en texte libre, **PAS** `AskUserQuestion`).
Pose-la comme un simple message de chat. N'utilise pas `AskUserQuestion` : ça demande ≥2 options prédéfinies et ne peut pas être un champ libre, un appel à une seule option échoue à la validation avec `too_small: options expected array to have >=2 items`. Envoie :
> "Confirmation finale : réponds avec le nom exact `<NOM_DU_PROJET>` (rien d'autre) pour confirmer la suppression."

Compare ensuite la réponse de l'utilisateur à `<NOM_DU_PROJET>` **exactement** (sensible à la casse, espaces de début/fin retirés). Si ça correspond, continue. Sinon, refuse et arrête.

**Sous aucun prétexte tu ne dois passer au scan ou à l'exécution avant ces deux confirmations explicites.** Même si l'utilisateur a écrit "supprime tout sans redemander", la double vérification est volontaire.

---

## Phase 1 - Inventaire (1 appel de script)

```bash
# Chemin obtenu via os.tmpdir(), normalisé avec des slashs, pour que la
# redirection bash, node et l'outil Read pointent vers le MÊME fichier.
# Ne jamais coder en dur /tmp/... ici.
INV="$(node -p "require('os').tmpdir().replaceAll(String.fromCharCode(92),'/')+'/delete-project-inventory.json'")"
node "${CLAUDE_SKILL_DIR}/../../scripts/delete-project/discover-resources.mjs" \
  --project "<NOM_DU_PROJET>" \
  --project-dir "<chemin-détecté-du-projet>" > "$INV"
echo "INVENTORY_FILE=$INV"
cat "$INV"
```

Le script résout d'abord le Scaleway Project de l'app (par son nom - le nom de l’app est celui du dépôt - avec `SCW_DEFAULT_PROJECT_ID` en cas de forçage), puis scanne en parallèle : le namespace de containers + les containers + leurs domaines personnalisés, le namespace de registre + le nombre d'images, les définitions Serverless Jobs (migration, agents, tâches planifiées), les secrets Secret Manager, les applications IAM qui appartiennent à ce projet, le domaine TEM, les enregistrements DNS ajoutés dans le domaine externe de l'utilisateur, les dossiers de mémoire Claude, le dépôt GitHub, le dossier local, et les variables d'environnement → détection de services tiers (Sentry, PostHog, Mapbox, OpenAI, etc.) hors stack Baudrier.

Il scanne **aussi** la ou les bases Serverless SQL Database (production **et** preview) et le bucket Object Storage (via le secret `STORAGE_BUCKET`) - mais **uniquement pour les citer dans le rapport final** (nom exact + lien console), jamais pour les proposer à la suppression. Chacune de ces deux entrées porte `neverDeleted: true` et un `consoleUrl` dans le JSON, précisément pour que tu ne puisses pas les oublier au moment du récap.

Le JSON résultant a cette forme (résumée) :

```json
{
  "project": "cool-trattoria",
  "scwProject": { "found": true, "id": "...", "name": "cool-trattoria", "neverDeleted": true, "consoleUrl": "https://console.scaleway.com/project/settings?project=..." },
  "container":  { "found": true, "namespaceCount": 1, "containerCount": 2, "namespaces": [...] },
  "registry":   { "found": true, "namespaces": [{ "imageCount": 14, ... }] },
  "jobs":       { "found": true, "definitions": [...] },
  "database":   { "found": true, "neverDeleted": true, "consoleUrl": "https://console.scaleway.com/serverless-sql-databases/databases?project=...", "databases": [{ "name": "cool-trattoria", "status": "ready" }] },
  "secrets":    { "found": true, "count": 12, "names": [...] },
  "storage":    { "found": true, "neverDeleted": true, "consoleUrl": "https://console.scaleway.com/object-storage/buckets?project=...", "bucket": "cool-trattoria", "exists": true },
  "iam":        { "found": true, "applications": [{ "name": "cool-trattoria-db", "keyCount": 1, "matchedBy": "exact" }], "excluded": [] },
  "tem":        { "found": false },
  "dns":        { "found": true, "zones": [{ "zone": "cool-trattoria.fr", "records": [...] }] },
  "memory":     { "found": true, "dirs": [...] },
  "github":     { "exists": true, "url": "..." },
  "localDir":   { "exists": true, "path": "..." },
  "envVars":    { "thirdPartyDetected": [...], "unknownUnclassified": [] }
}
```

Si `scwProject.found` est `false`, il n'y a plus (ou pas) de Project Scaleway pour ce nom - dis-le clairement à l'utilisateur et saute directement à la Phase 4 pour le dépôt GitHub / le dossier local / la mémoire, qui peuvent exister indépendamment.

L'`iam.excluded` liste les applications IAM dont le nom correspond mais qui ont été rattachées à un projet frère plus précis (ex. `street-cool-db` en supprimant `street`) - **jamais supprimées**, à faire figurer en section 2.4.

Le bloc affiche directement le JSON de l'inventaire (et son chemin absolu via `INVENTORY_FILE=…`). Lis le JSON depuis cette sortie. La Phase 3 recalcule le même chemin `$INV` avec la ligne identique, donc le fichier fait le pont entre les deux phases sans que tu aies à coder un chemin en dur. Passe à la Phase 2.

---

## Phase 2 - Présenter l'inventaire + valider le périmètre

Affiche un récap clair en sections distinctes, ton non-technique. **La section 2.0 passe en premier, toujours, avant même l'infrastructure supprimable** - c'est le message le plus important de tout le récap.

### 2.0 Section "🟣 Jamais supprimé : tes données" (toujours en premier)

Que `database.found` et `storage.found` soient vrais ou non, affiche cette section avant toute autre. Si l'un des deux (ou les deux) est `found: true`, liste-le nommément :

> 🟣 **Ce qui reste en place, quoi qu'il arrive :**
>
> - **Base de données** : `<database.databases[].name>` (base de données <production/preview>) - jamais supprimée par cette skill.
> - **Stockage de fichiers** : bucket `<storage.bucket>` - jamais supprimé ni vidé par cette skill.
> - **Le Project Scaleway `<scwProject.name>`** lui-même reste donc actif (il contient la base et/ou le bucket ci-dessus), et continue d'être facturé en conséquence.
>
> Les liens de la console Scaleway pour les gérer toi-même (les consulter, en faire un export, ou les supprimer manuellement si tu es sûr) te seront redonnés dans le récap final.

Si `database.found` et `storage.found` sont tous les deux `false` (aucune base, aucun bucket configurés pour ce projet), dis-le simplement : *"Ce projet n'a ni base de données ni stockage de fichiers configurés - rien à préserver de ce côté, mais je ne les supprimerais de toute façon jamais si c'était le cas."*

### 2.1 Section "🔵 Infrastructure jetable (je peux la supprimer automatiquement)"

Tableau markdown listant chaque catégorie où `found === true`, **hors `database` et `storage`** (jamais dans cette section - voir 2.0). Pour chaque ligne : ressource (en langage clair), identifiant, action prévue.

Traduction en langage clair des catégories techniques :
- `container` → "Le site déployé (container) et son adresse personnalisée"
- `registry` → "Les images de build stockées (X images)"
- `jobs` → "Les tâches automatisées (migration de base, agents planifiés...)"
- `secrets` → "Les identifiants techniques stockés (X secrets)"
- `iam` → "Les accès techniques créés pour cette app"
- `tem` → "Le domaine d'envoi d'emails"
- `dns` → "Les entrées DNS ajoutées dans ton nom de domaine"
- `memory` → "La mémoire de travail de l'assistant sur ce projet"

### 2.2 Section "🟠 Services tiers détectés (à supprimer toi-même)"

Pour chaque entrée de `envVars.thirdPartyDetected` : nom du service avec son label (langage clair), comment il a été détecté (variable d'env), URL à ouvrir, instructions courtes. Si la liste est vide, dis-le clairement : *"Aucun service tiers détecté en dehors de la stack Baudrier."*

Si `envVars.unknownUnclassified` n'est pas vide, mentionne-le aussi : ce sont des variables que le harness ne reconnaît pas et qui ne correspondent à aucun service tiers connu - probablement quelque chose que l'utilisateur a ajouté lui-même, à vérifier avec lui.

### 2.3 Section "🟡 Comptes manuels (jamais automatisables)"

Inclure si applicable :
- Toujours : suppression du dépôt GitHub si `github.exists` (automatisée en Phase 3, mais mentionnée ici pour la vue d'ensemble)
- Suppression du dossier local si `localDir.exists` (à faire soi-même via l'explorateur de fichiers)

### 2.4 Section "⚪ Autres éléments volontairement non touchés"

- Chaque entrée `iam.excluded` (application rattachée à un projet frère) - avec sa raison en langage clair
- Le domaine externe lui-même (seuls les enregistrements DNS ajoutés par l'app sont supprimés, jamais le reste de la zone - d'autres services de l'utilisateur peuvent y vivre)

### 2.5 Question de périmètre obligatoire

Utilise `AskUserQuestion`. **La base de données et le stockage ne sont jamais des options ici** - il n'y a rien à "garder" pour eux puisqu'ils ne sont jamais dans le périmètre supprimable :

> "Je supprime **tout** ce qui est listé sous 🔵 (l'infrastructure jetable), ou tu veux **garder** certaines ressources ? (Pour rappel : la base de données et le stockage de fichiers ne sont de toute façon jamais supprimés, quel que soit ton choix ici.)"

Options (multi-sélection via `multiSelect: true`) :
- `Tout supprimer` (sélectionne toutes les catégories de 🔵)
- `Garder les entrées DNS` (exclut `dns`)
- `Garder le dossier local` (déjà exclu par défaut, le sandbox bloque sa suppression)

**Ne continue pas tant que le périmètre n'est pas explicitement validé.** Les confirmations de la Phase 0 portent sur le **principe**. La Phase 2 confirme l'**inventaire exact**.

---

## Phase 3 - Exécution (1 appel de script)

Construis le tableau JSON `scope` à partir des choix de la Phase 2.5. Catégories possibles (jetable uniquement - `database`, `storage` et `project` n'existent **pas** comme catégories de périmètre, le script les refuse explicitement s'il les reçoit) :

```
["container","registry","jobs","secrets","iam","tem","dns","memory","github"]
```

Si l'utilisateur a choisi "Tout supprimer", passe `["all"]`. Sinon retire les catégories à garder.

```bash
# Mêmes chemins temporaires portables que la Phase 1 (recalculés à l'identique).
INV="$(node -p "require('os').tmpdir().replaceAll(String.fromCharCode(92),'/')+'/delete-project-inventory.json'")"
REPORT="$(node -p "require('os').tmpdir().replaceAll(String.fromCharCode(92),'/')+'/delete-project-report.json'")"
node "${CLAUDE_SKILL_DIR}/../../scripts/delete-project/execute-deletions.mjs" \
  --inventory "$INV" \
  --scope '["all"]' > "$REPORT"
cat "$REPORT"
rm -f "$INV" "$REPORT"
```

Crée une todo list avec une entrée par catégorie du périmètre. Marque "in_progress" avant le run et "completed" après (un seul run de script ⇒ tu les marques en moins de 2 secondes).

Le script exécute **en parallèle** : container, registry, jobs, secrets, iam, tem, dns, memory, github. C'est tout - il n'y a pas d'étape séquentielle "database" ni "project", elles n'existent pas dans ce script (voir le garde-fou décrit en tête de fichier).

Le JSON résultant :

```json
{
  "project": "cool-trattoria",
  "deleted": { "container": { "status": "deleted", "results": [...] }, ... },
  "failed":  { "<catégorie>": { "status": "failed", "error": "..." } },
  "skipped": { "<catégorie>": { "status": "skipped", "reason": "..." } },
  "refused": {}
}
```

`report.refused` ne sera normalement jamais rempli avec ce script (tu ne demandes jamais `database`/`storage`/`project` dans `--scope`) - c'est un filet de sécurité pour un appel malformé, pas un chemin normal. S'il est non vide, traite-le exactement comme les entrées jamais supprimées de la Phase 4.1.

---

## Phase 4 - Rapport final

Affiche un récap à l'utilisateur, langage clair, structure suivante. **La section 4.0 (le handoff) est la plus importante de toute la skill - ne l'omets jamais, ne la raccourcis jamais, et ne dis jamais au client que "le projet est entièrement supprimé" si elle est non vide.**

### 4.0 "🟣 Ce qui a été DÉLIBÉRÉMENT laissé en place" (toujours affiché, jamais en petit)

Si `database.found` ou `storage.found` (depuis l'inventaire de la Phase 1) est vrai, affiche ce bloc bien visible, en français, **avant** le reste du rapport :

```
╔══════════════════════════════════════════════════════════════╗
║   🟣  IMPORTANT - CE QUI N'A PAS ÉTÉ SUPPRIMÉ, VOLONTAIREMENT  ║
╚══════════════════════════════════════════════════════════════╝

Je n'ai supprimé ni ta base de données, ni ton stockage de fichiers, ni le
Project Scaleway qui les contient. C'est une règle stricte de cet outil :
je ne détruis jamais tes données moi-même.

 • Base(s) de données : <nom(s) exact(s), ex. "cool-trattoria",
   "cool-trattoria-preview-feature-x">
   → Console : <database.consoleUrl>

 • Stockage de fichiers (bucket) : <nom exact du bucket>
   → Console : <storage.consoleUrl>

 • Project Scaleway : <scwProject.name> (id : <scwProject.id>)
   → Console : <scwProject.consoleUrl>
   (Il reste actif tant que la base et/ou le bucket ci-dessus existent -
   Scaleway ne permet de toute façon pas de supprimer un Project non vide.)

Si tu veux vraiment tout supprimer, y compris tes données, c'est à TOI de
le faire, manuellement, dans la console Scaleway aux liens ci-dessus.
Je ne peux pas le faire à ta place, et je ne le ferai jamais automatiquement.
```

Remplis chaque `<...>` avec les valeurs réelles de l'inventaire (Phase 1). Si `database.found` est `false` et `storage.found` est `false`, remplace ce bloc par une simple ligne : *"Ce projet n'avait ni base de données ni stockage de fichiers configurés - rien à te signaler de ce côté."* - mais ne saute jamais cette section silencieusement, dis toujours explicitement où en est la base/le stockage.

### 4.1 "✅ Supprimé automatiquement"
Tableau des entrées de `report.deleted` traduites en langage accessible.

### 4.2 "🔴 À vérifier" (si `report.failed` n'est pas vide)

Pour chaque catégorie en échec, explique honnêtement ce qui n'a pas marché et ce que ça veut dire concrètement. Propose de relancer la Phase 3 avec un périmètre restreint à cette seule catégorie.

### 4.3 "🟡 À faire toi-même"

Liste ordonnée avec des instructions claires :

1. **Base de données et stockage, si tu veux vraiment t'en débarrasser** : voir le bloc 4.0 ci-dessus - liens console + noms exacts.

2. **Supprimer le dossier local** (si `localDir.exists`)
   - Chemin : `<localDir.path>`
   - Action : ouvre ton explorateur de fichiers → clic droit → Supprimer
   - Note : *"J'aurais aimé le faire automatiquement, mais mon bac à sable m'empêche de supprimer des dossiers sur ta machine, pour ta sécurité."*

3. **Services tiers détectés** (pour chaque entrée de `envVars.thirdPartyDetected`) :
   - Nom du service avec label
   - URL exacte (depuis `actionUrl`)
   - Instructions précises (depuis `instructions`)

### 4.4 Mot de fin

Si la base et/ou le stockage existaient (donc laissés en place) :
> "Voilà, l'infrastructure technique jetable est nettoyée. **Ta base de données et/ou ton stockage de fichiers existent toujours** (voir le rappel ci-dessus) - c'est volontaire, je ne les supprime jamais moi-même. Il te reste aussi X actions manuelles ci-dessus pour finir le ménage si tu le souhaites. Pas d'urgence - tu peux les faire à ton rythme, ou ne rien faire du tout. Si tu veux, je reste là pour te guider pas à pas."

Sinon (aucune base, aucun stockage détectés) :
> "Voilà, l'infrastructure technique jetable est nettoyée. Il te reste X actions manuelles ci-dessus pour finir le ménage. Pas d'urgence - tu peux les faire à ton rythme. Si tu veux, je reste là pour te guider pas à pas."

---

## Règle de communication non-technique

- Les termes techniques toujours accompagnés d'un langage clair :
  - "Container (le site déployé)"
  - "Serverless SQL Database (la base de données)"
  - "Object Storage (le stockage de fichiers)"
  - "IAM (les accès techniques créés pour cette app)"
- Pour les actions manuelles, toujours donner : **où cliquer / quoi ouvrir + pourquoi**. Jamais une commande shell pour l'utilisateur.
- Pour les rapports, tableaux markdown avec sections distinctes (✅ / 🔴 / 🟡 / ⚪).

---

## Pièges connus (cas particuliers)

### Un seul Project Scaleway par app - le pivot de toute la skill
Toute la découverte (containers, registre, jobs, bases, secrets, IAM excepté) se fait en listant les ressources par `project_id`, jamais par correspondance de nom. C'est pour ça que cette version est **beaucoup plus fiable** que l'ancienne : il n'y a quasiment plus de risque de confondre "street" et "street-cool". Les deux seules exceptions (IAM, DNS) gardent le garde-fou `_match.mjs` par défense en profondeur - le coût est nul et le risque de mal faire est total.

### La base de données, le bucket et le Project Scaleway ne sont jamais supprimés
Ce n'est pas une case à décocher dans le dialogue : `execute-deletions.mjs` n'importe même pas les fonctions `deleteDatabase` / `deleteBucket`, et n'appelle jamais l'API de suppression d'un Project. Si un `--scope` malformé contient quand même `"database"`, `"storage"` ou `"project"`, le script les place dans `report.refused` avec une explication, sans jamais les exécuter. Vois Phase 4.0 pour comment présenter ça à l'utilisateur : toujours nommément, jamais discrètement.

### IAM : ne jamais laisser une clé orpheline
Les applications IAM et leurs clés API comptent dans les plafonds de l'Organisation (50 clés API, 100 applications) et ne font PAS partie du Project Scaleway (elles sont au niveau Organisation) - supprimer le Project ne les supprime pas. La skill les retrouve par nom (`<projet>-db`, `harness-db-<projet>-preview-<branche>`, et le nom exact déterministe `baudrier-agents-<id-du-project>` pour les agents/Jobs), supprime leurs clés API puis leur politique puis l'application elle-même.

### DNS : seulement les enregistrements ajoutés, jamais la zone entière
Le domaine externe de l'utilisateur peut porter d'autres enregistrements sans rapport avec cette app (email personnel, autre sous-domaine). La skill ne supprime que les enregistrements précis qu'elle a identifiés comme ajoutés par l'app (le CNAME du domaine personnalisé, les enregistrements de vérification TEM) - jamais la zone ni le reste de son contenu.

### Sauvegardes de la base - ne jamais présenter ça comme un filet de sécurité garanti
Scaleway indique dans sa documentation générale effectuer des sauvegardes automatiques des bases de données, mais le harness n'a pas vérifié précisément la fréquence ni la durée de rétention exactes pour Serverless SQL Database - **ne répète jamais un chiffre non vérifié** (ex. "7 jours") comme s'il s'agissait d'un fait garanti. De toute façon, cette question est hors sujet pour `/delete-project` : la skill ne supprime jamais la base, donc ses éventuelles sauvegardes automatiques ne sont jamais en jeu ici. Si l'utilisateur choisit plus tard de supprimer sa base manuellement dans la console, c'est à ce moment-là qu'il doit vérifier lui-même, sur la documentation Scaleway ou dans la console, ce qu'il en est de la rétention.

### Services tiers détectés
Le scan des variables d'environnement (Phase 1) est **prudent** : toute variable non répertoriée est signalée. Mieux vaut un faux positif (l'utilisateur dit "oh non, celle-là c'est normal") qu'un faux négatif (un service tiers continue de facturer). La liste de référence vit dans `templates/delete-project/known-env-vars.json` (stack connue) et `templates/delete-project/third-party-services.json` (services tiers reconnus par motif de nom de variable). Pour ajouter une nouvelle variable standard, édite `known-env-vars.json`.

### Noms ambigus
La correspondance IAM se fait par mot entier, pas par sous-chaîne : supprimer `art` ne correspond pas à `smart-app`. Quand plusieurs projets partagent un préfixe (`street` et `street-cool`), toute application IAM qui correspond aussi à un **projet frère plus précis** (connu via la liste des Projects Scaleway de l'Organisation) est automatiquement déplacée dans `iam.excluded` et jamais touchée. **La revue de la Phase 2 reste le dernier filet de sécurité** : lis les noms attentivement avant de valider le périmètre, et dans le doute, demande à l'utilisateur.

### Sandbox et suppression de dossiers
Le classificateur du sandbox bloque généralement la suppression de dossiers arbitraires sur la machine de l'utilisateur, même avec son autorisation explicite. **N'essaie pas de contourner ça** - donne le chemin à l'utilisateur dans le rapport final pour qu'il le supprime lui-même via son explorateur de fichiers.
