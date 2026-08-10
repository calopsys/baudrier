# Aider un collaborateur qui utilise Baudrier sans droits d’organisation

Ce guide s’adresse à l’administrateur d’une organisation Scaleway. Un collaborateur sans
droits d’administrateur veut utiliser Baudrier pour une application. Ce guide décrit la
seule action que vous devez faire pour lui.

> Vous êtes vous-même l’utilisateur de Baudrier, et pas un administrateur ? Ce guide n’est
> pas pour vous : demandez-le à votre administrateur, ou lisez plutôt le chapitre
> [Installation](../README.md#installation) du README.

## Comment ça marche

Un collaborateur sans droits d’organisation (« Cas B » dans le README) ne peut pas créer de
Projet Scaleway ni de clé d’application lui-même. Vous créez donc, une seule fois par
application, un Projet et une clé qui lui appartient entièrement.

Cette clé est différente d’une clé d’administrateur : **elle fait tourner l’application,
autant qu’elle la construit.** Avant `/publish` comme après, Baudrier l’utilise pour la base
de données, le stockage de fichiers, l’envoi d’emails et l’intelligence artificielle. C’est
pourquoi elle doit rester strictement limitée au Projet de cette application, et à rien
d’autre : une fuite de cette clé n’expose alors qu’une seule application, jamais votre
organisation entière.

Un environnement cloud « Baudrier » sert exactement une application. Pour une deuxième
application, répétez la recette ci-dessous avec un nouveau Projet et une nouvelle clé.

## Recette unique

Votre collaborateur vous transmet le nom qu’il a choisi pour son application, par exemple
`mon-app`.

1. Dans la console Scaleway, créez un **Projet** portant ce nom.
2. Allez dans **IAM → Applications → Créer une application**, nom suggéré : `<nom>-app`.
3. Créez une politique attachée à cette application, avec **une seule règle**, à l’échelle
   **de ce Projet** (pas de l’organisation), portant ces permissions :

   `SecretManagerFullAccess`, `ContainersFullAccess`, `ContainerRegistryFullAccess`,
   `ServerlessSQLDatabaseFullAccess`, `ServerlessJobsFullAccess`, `ObjectStorageFullAccess`,
   `DomainsDNSFullAccess`, `TransactionalEmailFullAccess`, `GenerativeApisFullAccess`,
   `ObservabilityFullAccess`.

   ⚠️ **N’accordez ni `ProjectManager`, ni `IAMManager`, ni `BillingReadOnly`.** Les deux
   premières donnent un contrôle sur toute l’organisation. La troisième donne accès aux
   chiffres de dépense de l’organisation entière. Cette clé tourne dans l’application
   elle-même une fois publiée : ces trois permissions n’ont rien à y faire là.

   Baudrier vérifie ce point à chaque usage de la clé et refuse toute clé qui porte l’une de
   ces permissions. Une conséquence est visible pour votre collaborateur : la commande
   `/costs` n’affiche pas le montant dépensé, faute de `BillingReadOnly`. Elle affiche
   toujours la consommation d’emails. C’est le comportement prévu : n’ajoutez pas cette
   permission pour corriger cet affichage. Le montant reste consultable dans la console
   Scaleway, rubrique Facturation.
4. Générez une clé API pour cette application, **sans date d’expiration**. Vous obtenez une
   paire clé d’accès / clé secrète. La clé secrète ne s’affiche qu’une fois, à la création.
5. Transmettez à votre collaborateur, par un canal de confiance : la **clé d’accès**, la
   **clé secrète**, l’**identifiant du Projet** créé à l’étape 1 et l’**identifiant de
   l’organisation**. Il les colle dans les variables d’environnement de son environnement
   cloud « Baudrier » (`SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`,
   `SCW_DEFAULT_ORGANIZATION_ID`), puis démarre une nouvelle conversation.

Baudrier ne vous sollicite plus après cette étape. Il n’y a plus de seconde demande au
moment de `/publish` : cette commande ne fait plus que retirer la restriction d’IP, elle ne
change jamais de clé.

## Renouveler la clé

Si vous devez renouveler cette clé (fuite suspectée, départ du collaborateur) : générez une
nouvelle clé API sur la même application, transmettez la nouvelle paire à votre
collaborateur, puis supprimez l’ancienne clé une fois qu’il confirme avoir mis à jour son
environnement cloud et redéployé son application.

Votre collaborateur ne peut pas faire ce renouvellement lui-même. La commande
`/rotate-secret` détecte cette forme de clé, s’arrête, et lui donne le message à vous
transmettre.
