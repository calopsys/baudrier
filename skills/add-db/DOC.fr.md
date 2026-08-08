# /add-db

Ajoute une **base de données** à votre projet pour y stocker des informations qui restent dans le temps. Baudrier provisionne une base PostgreSQL hébergée en France, la branche à votre code et la garde sauvegardée automatiquement.

## Quand l'utiliser

- Quand votre app a besoin de stocker des informations : utilisateurs, commandes, articles, fiches clients, réservations, contenu éditorial, etc.
- Souvent appelée automatiquement par `/bootstrap` au moment de la création du projet. Vous pouvez aussi la lancer plus tard si vous voulez ajouter la persistance à un projet déjà existant.

## Comment ça se passe

1. **Vérification** : Baudrier regarde si une base de données est déjà branchée à ce projet.
   - Si oui, un petit menu vous propose : appliquer un changement de schéma, ou repartir sur une base toute neuve. Pas de risque de doublon.
   - Sinon, on enchaîne.
2. **Création de la base** : une base de données Scaleway Serverless SQL (PostgreSQL 16) est créée dans votre projet, en région `fr-par` (Paris).
3. **Clé d'accès dédiée** : une clé d'accès privée est créée rien que pour cette app - elle n'est jamais partagée avec un autre projet, et elle n'expire jamais (votre app ne tombera donc jamais en panne parce qu'une clé a expiré discrètement).
4. **Configuration de Drizzle ORM** : Baudrier configure Drizzle (l'outil qui sert d'intermédiaire entre votre code et la base) pour parler à votre base.
5. **Sauvegarde de la connexion** : la chaîne de connexion est enregistrée de façon sécurisée côté Scaleway (Secret Manager). Elle n'est jamais écrite dans un fichier sur cet ordinateur, ni affichée dans la conversation - vous n'avez rien à copier ni à perdre.
6. **Sauvegardes automatiques** : incluses dès le premier jour, rien à activer. Un instantané est pris chaque jour et conservé 7 jours.

## Ce que ça crée pour vous

- Une **base de données Scaleway Serverless SQL** dans votre projet, prête à recevoir des données
- Le **fichier de schéma Drizzle** (`src/server/db/schema.ts`) où vous (ou Baudrier) définirez vos tables
- La connexion configurée dans `src/server/db/index.ts`
- La commande pratique `pnpm db:generate` (prépare un changement de schéma en toute sécurité, sans toucher à la base réelle)
- Les **sauvegardes automatiques** actives dès le départ, aucune configuration nécessaire

## Une différence importante avec la plupart des outils de base de données

Cet ordinateur ne parle jamais directement à votre base de données - même pas pour prévisualiser un changement. Quand vous (ou Baudrier) modifiez ce que votre app stocke comme données, le changement est d'abord écrit dans un fichier ; il ne devient réel qu'à la prochaine publication (`/deploy`), via un processus dédié et sécurisé. C'est un choix de sécurité délibéré : il élimine toute une catégorie d'erreurs du type "quelqu'un a lancé une commande risquée sur la production par accident".

## Prérequis

- Le projet doit être un projet Next.js (typiquement initialisé par `/bootstrap`)
- Votre compte Scaleway doit être connecté (`/start` s'en occupe, une seule fois)

## Astuces

{{callout:tip|Inclus, aucun plan à choisir}}
Il n'y a pas de choix entre un plan gratuit et un plan payant à faire ici : la base se met en veille automatiquement quand personne ne l'utilise et remonte en puissance automatiquement selon le trafic. Rien à dimensionner à l'avance.
{{/callout}}

{{callout:info|Les sauvegardes, c'est offert}}
Vous n'avez pas à configurer les sauvegardes manuellement : un instantané quotidien avec 7 jours de rétention est inclus sans frais supplémentaire dès la création de la base. Il n'y a pas encore de bouton pour déclencher une sauvegarde à la demande - celle du jour est le filet de sécurité.
{{/callout}}

{{callout:warning|Données en France}}
La base est créée en région `fr-par` (Paris) pour respecter le RGPD côté résidence des données. Vous n'avez rien à faire pour ça.
{{/callout}}

{{callout:warning|Baudrier ne supprime jamais une base de données}}
Supprimer une base de données n'est jamais une action que Baudrier effectue de lui-même, même si on le lui demande - c'est techniquement bloqué. Si vous voulez vraiment supprimer une base, c'est une action manuelle et volontaire que vous effectuez vous-même dans la console Scaleway. C'est voulu : sans sauvegarde à la demande juste avant une suppression, une suppression accidentelle serait irrécupérable au-delà du dernier instantané quotidien.
{{/callout}}
