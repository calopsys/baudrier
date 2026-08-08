# Aider un collaborateur qui utilise Baudrier sans droits d’organisation

Ce guide s’adresse à l’administrateur d’une organisation Scaleway. Il décrit comment
répondre aux demandes que Baudrier envoie quand un collaborateur utilise sa propre clé
Scaleway, sans les permissions « ProjectManager » et « IAMManager ».

> Vous êtes vous-même l’utilisateur de Baudrier, et pas un administrateur ? Ce guide n’est
> pas pour vous : demandez-le à votre administrateur, ou lisez plutôt le chapitre
> [Installation](../README.md#installation) du README.

## Comment ça marche

Pendant le développement, le Baudrier de votre collaborateur travaille seul, avec sa propre
clé Scaleway. Il n’a besoin de vous à aucun moment pour créer une base de données, un
bucket, une clé IA ou une clé email : Baudrier utilise automatiquement sa clé personnelle en
attendant la vraie clé technique. Ce n’est pas un problème tant que l’application reste
restreinte au VPN, ce qui est le cas par défaut.

Vous êtes sollicité à exactement deux moments :

1. **Un nouveau projet Scaleway**, à chaque commande `/bootstrap`. C’est une action
   réservée à un administrateur par nature : rien côté collaborateur ne peut la remplacer.
2. **Les vraies clés techniques**, une seule fois, groupées. Quand votre collaborateur veut
   rendre son site public (`/publish`), Baudrier refuse tant que l’application tourne
   encore avec sa clé personnelle. Il reçoit alors une liste unique, en français, de tout
   ce qui reste à créer, et vous la transmet telle quelle.

Vous faites les actions demandées dans la console Scaleway, vous stockez le résultat dans le
coffre-fort de secrets (Secret Manager), puis votre collaborateur relance simplement la
commande interrompue : Baudrier trouve le secret, bascule son application dessus, et
continue.

Vous ne transmettez jamais à votre collaborateur une clé donnant des droits sur toute
l’organisation. Chaque secret que vous créez est limité à un seul projet, avec une seule
permission précise.

## Mise en place initiale

Avant toute demande, accordez à votre collaborateur (son utilisateur, ou son groupe) une
politique portant les permissions de service listées dans CONTRACT.md §1 :

- `SecretManagerFullAccess`
- `ContainersFullAccess`
- `ContainerRegistryFullAccess`
- `ServerlessSQLDatabaseFullAccess`
- `ServerlessJobsFullAccess`
- `ObjectStorageFullAccess`
- `DomainsDNSFullAccess`
- `TransactionalEmailFullAccess`
- `GenerativeApisFullAccess`
- `BillingReadOnly`
- `ObservabilityFullAccess`

Le plus simple est une portée « organisation » pour l’ensemble de la règle : elle couvre
automatiquement chaque nouveau projet que Baudrier crée, sans que vous ayez à revenir
modifier la politique à chaque nouvelle demande. Une portée « projet » fonctionne aussi, à
une condition : vous devez étendre la politique au nouveau projet à chaque recette
« projet » ci-dessous.

⚠️ **N’accordez pas les permissions « ProjectManager » ni « IAMManager ».** Ce sont
exactement les deux permissions que ce guide contourne. Les accorder directement
reviendrait à donner à votre collaborateur un contrôle large sur toute l’organisation.

## Recette « projet »

Votre collaborateur vous transmet un nom de projet, par exemple `mon-app`.

1. Dans la console Scaleway, créez un projet portant **exactement** ce nom.
2. Si votre politique (mise en place initiale) est à l’échelle du projet plutôt que de
   l’organisation, ajoutez ce nouveau projet à la politique.
3. Transmettez à votre collaborateur uniquement l’**identifiant du projet** créé. C’est la
   seule information dont il a besoin ; il relance sa commande avec cet identifiant.

## Recette « base de données » (`BAUDRIER_DB_KEY`)

Votre collaborateur vous transmet le nom du projet concerné.

1. Allez dans **IAM → Applications → Créer une application**, nom suggéré :
   `<projet>-db`.
2. Créez une politique attachée à cette application, avec **une seule règle**, portant
   `ServerlessSQLDatabaseReadWrite`, à l’échelle **du projet de l’application** (pas de
   l’organisation).
3. Générez une clé API pour cette application, **sans date d’expiration**.
4. Dans **Secret Manager**, région **`fr-par`**, **dans le projet de l’application**, créez
   un secret nommé exactement :

   ```
   BAUDRIER_DB_KEY
   ```

   Avec pour contenu un objet JSON portant ces deux champs :

   ```json
   {
     "application_id": "...",
     "secret_key": "..."
   }
   ```

   `application_id` est l’identifiant de l’application IAM créée à l’étape 1 (il devient le
   nom d’utilisateur de connexion à la base de données). `secret_key` est la clé secrète
   générée à l’étape 3.

Une seule paire suffit par projet : elle couvre à la fois la base de données de production
et chacune des bases de prévisualisation créées pour les branches de travail, puisque la
politique porte sur le projet entier plutôt que sur une base précise.

## Recette « IA » (`SCW_GENERATIVE_API_KEY`)

Votre collaborateur vous transmet le nom du projet concerné.

1. Allez dans **IAM → Applications → Créer une application**, nom suggéré :
   `baudrier-agents-<identifiant du projet>`.
2. Créez une politique attachée à cette application, avec **une seule règle**, portant
   `GenerativeApisModelAccess`, à l’échelle du projet.
3. Générez une clé API pour cette application, sans date d’expiration.
4. Dans **Secret Manager**, région `fr-par`, dans le projet de l’application, créez un
   secret nommé exactement `SCW_GENERATIVE_API_KEY`, contenu en texte brut : uniquement la
   **clé secrète** générée à l’étape 3 (pas de JSON, pas la clé d’accès).

## Recette « emails » (`TEM_API_SECRET_KEY`)

Même application que la recette « IA » ci-dessus (`baudrier-agents-<identifiant du
projet>`) : réutilisez-la si elle existe déjà, sinon créez-la comme décrit là-bas.

1. Ajoutez (ou créez) une règle sur la politique de cette application, portant
   `TransactionalEmailEmailApiCreate`, à l’échelle du projet.
2. Générez une clé API pour cette application, sans date d’expiration.
3. Dans Secret Manager, région `fr-par`, dans le projet de l’application, créez un secret
   nommé exactement `TEM_API_SECRET_KEY`, contenu en texte brut : uniquement la clé
   secrète.

## Recette « stockage » (`STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`)

Votre collaborateur vous transmet le nom du projet concerné.

1. Allez dans **IAM → Applications → Créer une application**, nom suggéré :
   `<projet>-storage`.
2. Créez une politique attachée à cette application, avec **une seule règle**, à l’échelle
   du projet, portant ces permissions :
   `ObjectStorageBucketsRead`, `ObjectStorageBucketsWrite`, `ObjectStorageObjectsRead`,
   `ObjectStorageObjectsWrite`, `ObjectStorageObjectsDelete`,
   `ObjectStorageBucketPolicyFullAccess`.
3. Générez une clé API pour cette application, sans date d’expiration. Vous obtenez une
   paire clé d’accès / clé secrète.
4. Dans Secret Manager, région `fr-par`, dans le projet de l’application, créez **deux**
   secrets en texte brut : `STORAGE_ACCESS_KEY` (la clé d’accès) et `STORAGE_SECRET_KEY`
   (la clé secrète).

## Recette « clé applicative » (`BAUDRIER_APP_KEY`)

Votre collaborateur vous transmet le nom du projet concerné. Cette recette remplace
complètement, pour ce projet précis, sa clé Scaleway personnelle par une clé propre à
l’application : c’est l’étape qui fait passer une application du mode PoC au mode délégué.

1. Allez dans **IAM → Applications → Créer une application**, nom suggéré :
   `<projet>-app`.
2. Créez une politique attachée à cette application, avec **une seule règle**, à l’échelle
   **du projet de l’application** (pas de l’organisation), portant ces permissions :
   `SecretManagerFullAccess`, `ContainersFullAccess`, `ContainerRegistryFullAccess`,
   `ServerlessSQLDatabaseFullAccess`, `ServerlessJobsFullAccess`, `ObjectStorageFullAccess`,
   `DomainsDNSFullAccess`, `TransactionalEmailFullAccess`, `GenerativeApisFullAccess`,
   `ObservabilityFullAccess`.

   ⚠️ **N’accordez jamais `ProjectManager` ni `IAMManager` à cette application.** Ce sont des
   permissions d’organisation entière ; cette clé doit rester strictement limitée au projet
   de l’application.
3. Générez une clé API pour cette application, sans date d’expiration. Vous obtenez une
   paire clé d’accès / clé secrète.
4. Dans **Secret Manager**, région `fr-par`, **dans le projet de l’application**, créez un
   secret nommé exactement :

   ```
   BAUDRIER_APP_KEY
   ```

   Avec pour contenu un objet JSON portant ces deux champs :

   ```json
   {
     "access_key": "...",
     "secret_key": "..."
   }
   ```

Une fois ce secret enregistré, dites à votre collaborateur que c’est fait : au prochain
`/publish`, Baudrier retrouve cette clé, en vérifie la validité par un appel réel, puis
l’adopte dans le fichier de configuration de l’application. Sa propre clé Scaleway
personnelle cesse alors d’être utilisée pour cette application.

## Recette « rotation »

Votre collaborateur vous demande de renouveler une clé existante sur une application déjà
créée (par exemple après une fuite suspectée, ou un départ de collaborateur).

1. Sur l’application concernée, générez une **nouvelle** clé API, sans date d’expiration.
2. Mettez à jour le ou les secrets correspondants dans Secret Manager avec la nouvelle
   valeur :
   - Pour `BAUDRIER_DB_KEY` : une nouvelle version avec la nouvelle paire
     `application_id`/`secret_key` (`application_id` reste le même, seul `secret_key`
     change).
   - Pour les autres secrets (`SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`,
     `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`) : une nouvelle version avec la nouvelle
     valeur.
3. Supprimez l’**ancienne** clé API sur l’application.
4. Dites à votre collaborateur que c’est fait : il relance sa commande de renouvellement,
   qui se termine normalement.

## Le verrou de publication

Baudrier refuse de rendre un site public tant que l’une de ses clés techniques tourne
encore sur la clé personnelle du collaborateur. Une fois le site public, cette clé
personnelle serait exposée à tout internet : c’est précisément pour éviter cela que la
publication est bloquée.

Le message que votre collaborateur vous transmet à ce moment liste, pour le projet
concerné, chaque recette encore manquante ci-dessus (base de données, IA, emails,
stockage). Une fois les secrets correspondants enregistrés dans Secret Manager, la
commande `/publish` bascule automatiquement l’application sur les vraies clés techniques,
puis publie le site.

## Ce que fait Baudrier ensuite

Dans chaque cas ci-dessus, dès que le secret est en place, votre collaborateur n’a rien de
plus à faire que relancer la commande qui avait été interrompue. Baudrier retrouve le
secret que vous avez créé, l’utilise pour terminer l’action, et la suite du travail reprend
normalement.
