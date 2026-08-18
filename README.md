# Baudrier

Baudrier est un plugin Claude Code conçu pour fonctionner sur **Claude Code web** (claude.ai/code). Vous décrivez votre application web en français courant. Baudrier la construit et la déploie sur **Scaleway**, pour que votre infrastructure et vos données restent en France/UE.

Aucune installation locale n’est nécessaire. Un navigateur, un compte GitHub et un compte Scaleway suffisent.

Baudrier est un fork de [Hypervibe Harness](https://github.com/flavien-ia/hypervibe-harness) de Flavien Chervet, réorienté vers une stack 100 % Scaleway et souveraine. Voir [Attribution](#attribution) pour l’historique du fork.

Les applications générées sont exclusivement en français et sont déployées **restreintes à votre IP par défaut** ; une skill dédiée (`/publish`) les ouvre ensuite au public quand vous êtes prêt.

`/bootstrap` construit deux types de projets : une **application web** complète (comptes, formulaires, données), ou un **site vitrine** statique (quelques pages de présentation, sans compte ni base de données), servi par Caddy et toujours actif. Vous choisissez au tout début, en un mot ou en répondant à une question.

## État du projet

La conversion est terminée : toutes les skills de ce plugin ciblent désormais
Scaleway. Les skills qui provisionnaient les fournisseurs abandonnés (Vercel,
Neon, Cloudflare, Render, Bitwarden, Resend/Brevo, Stripe, OAuth Google/GitHub,
i18n) ont été **supprimées**, et toutes les skills restantes ou nouvellement
ajoutées (base de données, auth, stockage, email, domaine, cron, agents,
déploiement, instantanés de projet, etc.) ciblent Scaleway. La colonne « Ce
que ça fait » des tableaux ci-dessous reflète le comportement réel actuel de
chaque skill.

Voir [CHANGELOG.md](CHANGELOG.md) pour l’historique détaillé du fork.

Quelques propriétés opérationnelles à connaître avant de vous fier à cet outil :

- Les apps sont déployées **restreintes à votre IP par
  défaut** ; `/publish` les ouvre au public, et `/unpublish` rétablit la
  restriction.
- Les Serverless Containers **passent à zéro instance** en cas d’inactivité
  pour éviter de payer du calcul inutilisé : le premier visiteur après une
  période d’inactivité attend donc un démarrage à froid.
- Le harness **ne supprime jamais les bases de données ni les buckets Object
  Storage**, même via `/delete-project` ou `/clean`. C’est une propriété de
  sécurité délibérée, pas un oubli.
- Les buckets Object Storage ont le **versioning activé**, qui constitue
  actuellement le seul mécanisme de sauvegarde des fichiers.

## Installation

Baudrier fonctionne sur **Claude Code web** (claude.ai/code). Aucune installation locale n’est nécessaire.

### Ce dont vous avez besoin

- **Un compte GitHub.** Baudrier y sauvegarde le code de votre application.
- **Un compte Scaleway.** Cet hébergeur français fait tourner vos applications.
- **Un abonnement Claude payant** (Pro, Max, Team ou Enterprise). Le plan gratuit de Claude ne donne pas accès à Claude Code.
- **Environ 15 minutes.**

### Mise en place, une seule fois

Ces quatre étapes ne se font qu’une fois. Elles préparent l’environnement partagé par toutes vos futures applications.

#### Étape 1 - Créer vos comptes

Créez votre compte Claude : https://claude.ai et commandez un abonnement Max minimum.

Créez votre compte GitHub : https://github.com/signup et votre compte Scaleway https://console.scaleway.com.

#### Étape 2 - Connecter claude.ai/code à GitHub

Sur https://claude.ai/code, connectez votre compte GitHub. Rendez-vous ensuite sur https://github.com/apps/claude puis autorisez Claude à effectuer des modifications sur votre compte.

#### Étape 3 - Créer une clé d’API Scaleway

Rendez-vous sur https://console.scaleway.com/iam/api-keys et créez une nouvelle clé d’API.

**Cas A - Vous êtes l’administrateur de l’organisation Scaleway.** Créez la clé à l’échelle de l’organisation entière, pas d’un seul projet, avec les permissions `ProjectManager` **et** `IAMManager`. Les deux sont nécessaires : `/bootstrap` crée un Projet Scaleway séparé pour chaque application (`ProjectManager`), puis fabrique une clé technique dédiée par service - base de données, stockage, email, IA (`IAMManager`). Votre clé d’environnement, elle, n’entre jamais dans l’application qui tourne. Ajoutez `BillingReadOnly` pour que `/costs` affiche le montant dépensé, ainsi que les permissions de service listées dans [CONTRACT.md](CONTRACT.md) §1. Si vous êtes propriétaire du compte Scaleway, vous avez déjà tous ces droits.

Une clé qui porte `ProjectManager` sans `IAMManager` est refusée : elle ne peut ni fabriquer les clés techniques, ni servir d’identifiant à l’application. Une clé limitée à un seul Projet relève du Cas B ci-dessous.

**Cas B - Vous êtes membre de l’organisation, pas administrateur.** Demandez à votre administrateur de suivre [docs/ADMIN-SCALEWAY.md](docs/ADMIN-SCALEWAY.md). Il prépare un Projet Scaleway et une application IAM dédiés à cette application précise, puis vous transmet une clé d’accès, une clé secrète, l’identifiant du Projet et l’identifiant de l’application IAM. Cette clé fait tourner votre application autant qu’elle la construit, avant `/publish` comme après : gardez ces quatre valeurs - la clé d’accès, la clé secrète, l’identifiant du Projet et l’identifiant de l’application IAM - dans un environnement cloud dédié à cette seule application. **Un environnement cloud « Cas B » sert exactement une application** ; pour une deuxième application, recommencez cette étape avec votre administrateur et créez un second environnement cloud.

Notez la **clé d’accès** et la **clé secrète**. La clé secrète ne s’affiche qu’une fois, à la création.

#### Étape 4 - Créer l’environnement cloud « Baudrier »

De retour sur https://claude.ai/code, créez un nouvel environnement cloud et nommez-le **Baudrier**. Remplissez trois blocs, exactement comme indiqué ci-dessous.

**1. Accès réseau : Complet**

Choisissez **Complet**. C’est le réglage recommandé. La construction d’une application touche beaucoup de domaines difficiles à prévoir à l’avance (dépôts de paquets Alpine et npm, registres Docker, polices, API Scaleway, et d’autres au fil des fonctionnalités), et chaque domaine oublié casse une étape avec une erreur difficile à comprendre.

**2. Variables d’environnement**

```
SCW_ACCESS_KEY=<votre clé d’accès Scaleway>
SCW_SECRET_KEY=<votre clé secrète Scaleway>
SCW_DEFAULT_ORGANIZATION_ID=<l’identifiant de votre organisation Scaleway>
SCW_DEFAULT_REGION=fr-par
```

Si vous suivez le **Cas B**, ajoutez aussi `SCW_DEFAULT_PROJECT_ID=<l’identifiant de projet transmis par votre administrateur>`. Cette variable est obligatoire dans ce cas : votre clé est limitée à un seul Projet et ne peut pas lister ceux de l’organisation. Ajoutez aussi `SCW_DEFAULT_APPLICATION_ID=<l’identifiant de l’application IAM transmis par votre administrateur>`. Cette variable est elle aussi obligatoire en Cas B : sans elle, Baudrier s’arrête dès le départ, car la base de données a besoin de cet identifiant. Elle n’est pas secrète : c’est l’identifiant de l’application IAM qui porte votre clé. En Cas A, elle est ignorée.

Ces valeurs sont visibles par toute personne qui utilise cet environnement cloud. Sur un environnement personnel, cela veut dire vous seul(e). Claude Code ne propose aucun autre coffre-fort de secrets pour cet usage : c’est le mécanisme prévu.

**3. Script de configuration**

Ouvrez [scripts/setup-clis-web.sh](scripts/setup-clis-web.sh) et copiez tout son contenu dans le champ « Setup script » de l’environnement.

Ce script installe le plugin Baudrier lui-même. Contrairement à un plugin ordinaire, il ne s’installe pas seul dans un environnement web (limitation connue de Claude Code). Le script s’en charge une seule fois, au moment où l’environnement se construit, pas au début de chaque conversation.

Toute modification de ce script force une reconstruction de l’environnement, qui réinstalle le plugin à partir de zéro. C’est voulu : c’est le seul moyen de forcer une mise à jour du plugin avant l’expiration naturelle du cache (environ 7 jours). Si une nouvelle version de Baudrier sort et que vous voulez la récupérer tout de suite, rouvrez ce fichier, ajoutez un espace ou un commentaire, et resauvegardez le script.

### Créer une application

Une fois l’environnement « Baudrier » en place, chaque nouvelle application se crée en deux étapes :

1. Créez un dépôt GitHub vide pour votre application. Choisissez un nom en kebab-case (des mots en minuscules séparés par des tirets, par exemple `site-vitrine-kine`) : ce nom devient le nom de votre application. Ouvrez ensuite une conversation Claude Code web sur ce dépôt, avec l’environnement **Baudrier**.
2. Tapez `/bootstrap`. Décrivez en français ce que vous voulez, Baudrier s’occupe du reste.

Le dépôt GitHub doit rester vide avant cette étape, car Baudrier construit l’application directement dedans.

### En cas de problème

| Symptôme | Cause probable | Solution |
|---|---|---|
| L’application répond 403 alors qu’elle n’est pas encore publiée | C’est le comportement normal : elle est restreinte à votre IP, et votre IP a changé | Ouvrez https://ip.me, copiez l’adresse affichée, donnez-la à Claude. Baudrier met à jour `ACCESS_ALLOWED_IPS`. |
| Une variable Scaleway manque, ou le plugin n’est pas installé | L’environnement n’a pas encore le bon réglage, ou vous êtes dans une conversation ouverte avant la correction | Corrigez l’environnement (variables ou script), puis **ouvrez une nouvelle conversation**. Une conversation en cours ne peut pas rafraîchir sa propre liste de commandes. |
| `/bootstrap` signale une erreur 403 sur la liste des projets | En Cas A, la clé n’a pas la permission `ProjectManager` à l’échelle de l’organisation. En Cas B, la variable `SCW_DEFAULT_PROJECT_ID` manque : une clé limitée à un seul Projet ne peut pas lister ceux de l’organisation | En Cas A, recréez la clé avec `ProjectManager` et `IAMManager` (étape 3 ci-dessus), puis mettez à jour `SCW_ACCESS_KEY` et `SCW_SECRET_KEY`. En Cas B, ajoutez `SCW_DEFAULT_PROJECT_ID` à l’environnement |
| Baudrier annonce qu’il manque la permission `IAMManager` à votre clé | La clé porte un droit sur toute l’organisation (par exemple `ProjectManager` ou `BillingReadOnly`) mais pas `IAMManager`. Elle ne correspond alors ni au Cas A ni au Cas B, et Baudrier refuse de deviner | Choisissez une forme. Cas A : ajoutez `IAMManager` à la clé. Cas B : demandez à votre administrateur une clé limitée au seul Projet, sans aucun droit d’organisation ([docs/ADMIN-SCALEWAY.md](docs/ADMIN-SCALEWAY.md)) |
| Le réseau bloque un domaine dont vous ne comprenez pas le rôle | L’environnement est en accès réseau **Custom** et un domaine manque à la liste | Passez l’accès réseau en **Complet** (le réglage recommandé, étape 4), puis ouvrez une nouvelle conversation |
| Baudrier s’arrête dès le départ et demande `SCW_DEFAULT_APPLICATION_ID` | La clé est limitée à un seul Projet (Cas B), et la base de données a besoin de l’identifiant de l’application IAM qui porte cette clé | Ajoutez la variable à l’environnement cloud, à partir de la valeur donnée par la console Scaleway (IAM, Clés API, la ligne de votre `SCW_ACCESS_KEY`, puis l’application qui porte la clé) ou par votre administrateur, puis ouvrez une nouvelle conversation |

**Après tout changement de l’environnement cloud, démarrez une NOUVELLE conversation.** Une conversation en cours ne voit pas le changement.

## Par où commencer

| Vous voulez une explication d’abord ? | Vous voulez construire tout de suite ? |
|---|---|
| `/prof` - explique comment Baudrier fonctionne | `/bootstrap` - vérifie vos prérequis, puis démarre l’architecture de l’application |

## Comment ça marche

Décrivez ce que vous voulez construire. Claude analyse votre description et déduit les addons nécessaires (base de données, auth, stockage, etc.), puis vous présente le plan pour validation avant de construire.

```
/bootstrap Mon site vitrine
/bootstrap Mon outil de gestion de leads avec comptes utilisateurs
```

### Trois façons de définir votre projet

Quand vous lancez `/bootstrap`, vous choisissez comment décrire votre app :

- **A - Construire un cahier des charges ensemble** (`/spec`) : Claude vous guide étape par étape à travers 5 blocs (projet, pages, design, fonctionnalités, contraintes) et produit un `cahier-des-charges.md`
- **B - Fournir un cahier des charges existant** : donnez à Claude un fichier `.md`, il le lit et en déduit l’infrastructure
- **C - Description courte uniquement** : Claude pose les questions d’infrastructure en une fois et construit une app simple

## Toutes les skills

Les tableaux ci-dessous sont établis en lisant chaque `skills/*/SKILL.md` présent dans ce dépôt (hors helpers internes préfixés `_`), ils reflètent donc ce qui existe réellement.

### Skills de workflow

| Skill | Ce que ça fait |
|---|---|
| `/bootstrap` | Créer un nouveau projet T3 de zéro |
| `/spec` | Construire un cahier des charges détaillé, étape par étape |
| `/prof` | Explique comment tout fonctionne simplement (mode pédagogique) |
| `/seo` | Audit SEO et corrections (métadonnées, sitemap, OG, structure, URLs/slugs, accessibilité, lisibilité, profondeur sémantique, fraîcheur du contenu) |
| `/seo-perf` | Mesure la performance réelle via l’API PageSpeed Insights et propose des correctifs classés par impact mesuré ; auto-invoquée en fin de `/seo` |
| `/geo` | Audit et optimisation pour les moteurs IA (ChatGPT, Claude, Perplexity, Google AI Overviews) - llms.txt, politique crawlers IA, schema FAQPage, signaux de citabilité, E-E-A-T. Complémentaire à `/seo` |
| `/gsc` | Connecte le site à Google Search Console, vérifie le DNS, soumet le sitemap, puis audite la couverture d’indexation, les requêtes principales et les pages à faible CTR |
| `/blogpost` | Rédige et publie un article de blog depuis la conversation, avec un aperçu obligatoire (branche `revue`) avant la mise en ligne - **site vitrine uniquement** |
| `/eco-audit` | Audit d’écoresponsabilité d’un site déployé (score EcoIndex A-G, estimation gCO2e/eau par visite), propose des correctifs, remesure après déploiement |
| `/security` | Audit de sécurité (secrets, auth, headers, dépendances, RGPD) |
| `/rgpd-audit` | Audit de conformité RGPD - détecte les services tiers utilisés, met à jour le registre des sous-traitants, génère ou rafraîchit la page de politique de confidentialité |
| `/clean` | Trouve les fichiers inutilisés, le code mort, les env vars et tables DB orphelines - revue + suppression sur une branche |
| `/rotate-secret` | Renouvelle une clé secrète partout où elle vit. En Cas B, la clé Scaleway elle-même est renouvelée par votre administrateur, et Baudrier vous donne le message à lui transmettre |
| `/save-project` | Crée une sauvegarde complète et horodatée d’un projet (code, base de données, env vars, stockage de fichiers, configs) |
| `/delete-project` | Décommissionne proprement un projet et son infrastructure cloud, avec double confirmation avant toute suppression |

### Skills de déploiement & exploitation

| Skill | Ce que ça fait |
|---|---|
| `/deploy` | Construit l’image du conteneur, la pousse vers Scaleway Container Registry, exécute les migrations, et la déploie sur Scaleway Serverless Containers - production ou preview |
| `/publish` | Rend l’app accessible publiquement en retirant la restriction par IP |
| `/unpublish` | Rétablit la restriction par IP |
| `/scale` | Affiche ou modifie la taille de calcul d’un conteneur déployé (S/M/L/XL) et son min-scale (scale-to-zero ou toujours actif) |
| `/costs` | Affiche la consommation Scaleway réelle du projet (par service et au total), ainsi que la consommation TEM. En Cas B, le montant dépensé reste indisponible - il exige un droit sur toute l’organisation, que la clé ne porte pas - et seule la consommation TEM s’affiche |

### Skills addon

Chaque addon peut être activé pendant `/bootstrap` ou utilisé seul sur un projet existant.

| Skill | Ce que ça ajoute |
|---|---|
| `/add-db` | Base de données PostgreSQL + Drizzle ORM |
| `/add-auth` | Authentification - interface admin uniquement OU comptes utilisateurs (email+mot de passe avec inscription, page compte, suppression) |
| `/add-2fa` | Authentification à deux facteurs (TOTP) en complément de `/add-auth` |
| `/add-role` | Système de rôles utilisateurs (membre, éditeur, modérateur...) |
| `/add-email` | Envoi d’emails transactionnels |
| `/add-analytics` | Analytics du site sans cookies (Matomo), avec un contrôle d’opt-out toujours disponible - aucune bannière de consentement nécessaire |
| `/add-storage` | Stockage de fichiers/images |
| `/add-domain` | Connecter un nom de domaine personnalisé (guidé) |
| `/add-map` | Carte interactive vectorielle (MapLibre + OpenFreeMap, gratuit sans clé API, UE). Single pin, multi-pin, itinéraire ou map-first |
| `/add-dark-mode` | Mode sombre (clair / sombre / système) avec sélecteur prêt à l’emploi |
| `/add-blog` | Installe un blog (collections de contenu Astro, RSS, sitemap, JSON-LD, tags, prev/next) - **site vitrine uniquement** |
| `/add-pwa` | Transforme l’app en PWA installable (manifest, service worker, icônes, invite d’installation) |
| `/add-push-notification` | Notifications Web Push (dépend de `/add-pwa`) |
| `/add-notification-center` | Centre de notifications in-app (cloche, badge non-lu, panneau déroulant) |
| `/add-cron` | Tâche planifiée |
| `/add-automation` | Automatisation en arrière-plan - oriente vers la bonne solution (cron, workflow, agent, ou routine personnelle) selon le besoin |
| `/add-workflow` | Enchaînement fini d’étapes déclenché par un événement, tournant dans l’app, avec des étapes assistées par IA |
| `/add-agent` | Agent IA autonome (Claude + outils + mémoire optionnelle + garde-fou budgétaire + historique complet d’exécution) |
| `/add-agent-dashboard` | Dashboard de monitoring des agents (coût, exécutions, détail tour par tour, lancer à la demande) |
| `/add-routine` | Mission IA récurrente personnelle sur votre propre compte Claude (sans infrastructure applicative) |

Pour utiliser un addon seul, demandez simplement à Claude Code :
> « Ajoute l’authentification à mon projet » → utilise `/add-auth`
> « Je veux connecter mon nom de domaine » → utilise `/add-domain`

### Helpers internes

Le plugin embarque aussi des skills internes préfixées `_`, invoquées automatiquement par les skills publiques ci-dessus (jamais par l’utilisateur directement). Elles gèrent les préoccupations partagées : push des env vars, détection de dépendances, génération de secrets, hash de mots de passe, sous-branches de setup auth, etc. Vous n’avez jamais besoin de les invoquer vous-même.

## Stack technique

Les projets créés avec ce plugin utilisent :

- **Next.js** (App Router) avec TypeScript
- **tRPC** pour les routes API typées
- **Drizzle ORM** pour l’accès à la base de données
- **Tailwind CSS v4** pour le style
- **shadcn/ui** pour les composants UI
- **GitHub** pour le contrôle de version

Hébergement et services (Scaleway, région `fr-par` sauf mention contraire), provisionnés par la skill addon correspondante lorsqu’elle est activée :

- **Scaleway Serverless Containers** pour l’hébergement, image poussée vers **Scaleway Container Registry**
- **Scaleway Serverless SQL Database** (PostgreSQL 16) via **Drizzle ORM** / `node-postgres` (quand l’addon DB est activé)
- **Scaleway Object Storage** (compatible S3) pour le stockage de fichiers (quand l’addon storage est activé)
- **Scaleway Domains & DNS** pour les domaines personnalisés (quand l’addon domaine est activé)
- **Scaleway Transactional Email (TEM)** pour l’email transactionnel (quand l’addon email est activé)
- **Scaleway Serverless Jobs** pour la planification et les agents IA (quand les addons cron/automation/agent sont activés)
- **Scaleway Generative APIs** pour le LLM et les embeddings (quand l’addon agent est activé)
- **Scaleway Secret Manager** pour les secrets
- **Matomo** pour les analytics (quand l’addon analytics est activé)

## Ce que le bootstrap configure automatiquement

Chaque projet reçoit, quel que soit le mode :

- Scaffold T3 (Next.js + TypeScript + Tailwind + tRPC)
- Bibliothèque de composants shadcn/ui
- SEO de base (métadonnées, robots.txt, sitemap.ts, placeholder OG, HTML sémantique)
- Repo GitHub privé
- Page 404 personnalisée
- Mentions légales + page de politique de confidentialité data-driven, alimentée par un registre central des sous-traitants (`src/lib/subprocessors.json`) qui se met à jour automatiquement à chaque ajout de service via les skills `/add-*`
- CLAUDE.md avec toutes les conventions du projet
- Restriction par IP à votre adresse (jusqu’à l’exécution de `/publish`)

## Attribution

Baudrier est un dérivé de [Hypervibe Harness](https://github.com/flavien-ia/hypervibe-harness) de **Flavien Chervet** (Hyper Wisdom), sous licence Apache-2.0. Des modifications substantielles ont été apportées pour retirer Vercel, Cloudflare, Neon, Render, Resend, Brevo, Bitwarden, Stripe, OAuth Google/GitHub, l’i18n et la réception d’emails, et pour réorienter le plugin vers une architecture 100 % Scaleway et souveraine. Voir [NOTICE](NOTICE) pour la notice d’attribution complète.

## Licence

Sous [licence Apache 2.0](LICENSE). Le code source est libre d’utilisation, de modification et de redistribution selon les termes de cette licence.

### Marque

**Hypervibe** et **Certifié Hypervibe** sont des marques de Hyper Wisdom. La licence Apache couvre le code, pas le nom : elle ne confère aucun droit d’usage de ces marques (cf. section 6 de la licence Apache). Ce fork n’utilise pas le nom Hypervibe et ne laisse entendre aucune affiliation avec Hyper Wisdom, ni certification par cette dernière.
