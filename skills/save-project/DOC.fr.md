# /save-project

Crée une **sauvegarde complète** d'un projet Baudrier sous forme de zip horodaté. Utile avant `/delete-project`, avant un gros refactor, en fin de mission, ou pour une archive perso.

## Quand l'utiliser

- Avant de lancer **`/delete-project`** sur un projet : ceinture + bretelles, juste au cas où.
- Avant un **gros refactor** : un point de retour clair si ça part en vrille.
- En **fin de mission** : livrer un dump complet au client, ou garder pour soi comme archive.
- **Avant une expérimentation risquée** : changement de DB, refonte d'auth, grosse montée de version...
- Comme **archive périodique** : un instantané stocké hors-ligne, déconnecté des services cloud.

## Comment ça se passe

1. **Préflight** : l'assistant détecte le projet (depuis le dossier courant ou l'argument), vérifie que ça ressemble à un projet Baudrier, et présente un récap de ce qui sera inclus - avec une note explicite indiquant que la base de données n'en fait pas partie.

2. **Questions** :
   - **Inclure le stockage de fichiers ?** Si le projet a un bucket Object Storage (fichiers, images, vidéos uploadées), on te demande si tu les veux dans le zip. Les gros buckets prennent plus de temps.
   - **Où sauvegarder le zip ?** Par défaut le dossier Téléchargements, sinon le dossier courant ou un chemin de ton choix.

3. **Exécution** :
   - **Git bundle** complet (tout l'historique) + modifications non commitées capturées en patch
   - **Variables d'environnement** : tout ce qui est actuellement dans Scaleway Secret Manager, plus une copie du `.env`/`.env.local` local
   - **Base de données** : une note expliquant pourquoi il n'y a pas de dump des données, pas un dump (voir ci-dessous)
   - **Téléchargement du stockage** (si choisi) : tous les fichiers du bucket
   - **Mémoire/transcripts Claude Code** du projet
   - **Liaison Scaleway** : `config/scaleway-link.json` (pas un secret, juste les identifiants de namespace/conteneur résolus en direct par leur nom)

4. **Zip final** : tout est compressé en `<projet>-snapshot-<TS>.zip` avec un `MANIFEST.md` à la racine qui décrit le contenu et la procédure de restauration.

## Ce que ça crée pour toi

```
<projet>-snapshot-YYYYMMDD-HHMMSS/
├── MANIFEST.md           ← date, contenu, procédure de restauration
├── code/                 ← git bundle + package.json + working-changes.patch
├── env/                  ← secret-manager.env + copie du .env/.env.local
├── db/                   ← NOTE.md - pourquoi il n'y a pas de dump des données ici
├── storage/              ← contenu Object Storage (si inclus)
├── memory/               ← mémoire/transcripts Claude Code du projet
└── config/               ← scaleway-link.json
```

## Une remarque pour Claude Code web

Une session web est temporaire et n’a pas de navigateur pour télécharger un fichier. Sur le web, le zip est écrit dans un dossier temporaire de la session plutôt que dans le dossier Téléchargements, et il disparaît avec la session - la skill le dit clairement. Compte plutôt sur le dépôt Git (déjà une sauvegarde du code) et le versioning propre au bucket Object Storage (90 jours de rétention des versions précédentes).

## Prérequis

- Le projet doit avoir un dossier local sur la machine (au minimum un `package.json`).
- Identifiants Scaleway (`SCW_ACCESS_KEY`/`SCW_SECRET_KEY`) configurés si tu veux la section Secret Manager et le téléchargement du stockage - la skill saute ce qui n'est pas disponible, sans planter.
- Python est utilisé pour le zip final (une dépendance par défaut courante, pas installée spécifiquement pour ça).

## Astuces

{{callout:warning|La base de données n'est PAS dans cette sauvegarde - aucune donnée métier dans ce zip}}
La machine de l'opérateur ne se connecte jamais directement à la base (voir CONTRACT.md §4) et il n'existe pas d'API pour déclencher une sauvegarde à la demande depuis ici. Concrètement : aucune de tes données métier (clients, commandes, contenus, comptes...) ne se trouve dans ce zip - seulement le code, les identifiants et les fichiers stockés. Scaleway indique dans sa documentation générale effectuer des sauvegardes automatiques des bases de données, mais la fréquence et la durée de rétention exactes pour Serverless SQL Database n'ont pas été vérifiées ici - ne compte pas dessus comme un filet de sécurité garanti. Si tes données comptent, le seul export fiable est celui que tu déclenches toi-même (`pg_dump` depuis un poste ayant accès réseau à la base, ou un outil de la console Scaleway).
{{/callout}}

{{callout:warning|Le zip contient des secrets en clair}}
Les fichiers dans `env/` contiennent des clés API en clair. À traiter comme un document confidentiel : pas de partage email non chiffré, pas de stockage public, suppression dès que ce n'est plus utile.
{{/callout}}

{{callout:info|Pas de restauration automatique}}
La skill ne propose pas de `/restore-project`. C'est volontaire : restaurer un environnement complet est une opération sensible qui mérite des yeux humains à chaque étape. Le `MANIFEST.md` à l'intérieur du zip décrit la procédure, et tu peux toujours rouvrir Claude Code dans le dossier extrait pour te faire guider.
{{/callout}}

{{callout:tip|Le filet de sécurité avant /delete-project}}
Le réflexe : avant de supprimer définitivement un projet avec `/delete-project`, lance d'abord `/save-project` (la skill te le propose aussi automatiquement à ce moment-là).
{{/callout}}

## Sites vitrines

Sur un site vitrine, le résumé dit clairement : **code + secrets, pas de base ni de stockage** - rien ne manque, un site vitrine n’a tout simplement ni l’un ni l’autre.
