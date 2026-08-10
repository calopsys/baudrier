# /add-storage

Ajoute le **stockage de fichiers** (images, PDFs, vidéos, documents) à votre app, via Scaleway Object Storage.

## Quand l'utiliser

- Vos utilisateurs doivent pouvoir **uploader** des fichiers (photo de profil, photos de produits, documents, exports)
- Vous voulez stocker des images et les afficher publiquement (par exemple un site qui vend des produits avec galeries)
- Vous voulez offrir des **téléchargements privés** (rapports, factures, contrats sécurisés)

## Comment ça se passe

1. **Vérification** : si le stockage est déjà en place sur le projet, Baudrier vous propose un menu pour changer de bucket, régénérer les clés, mettre à jour l'URL publique, etc.

2. **Question contenu** : Baudrier vous demande **ce que vos utilisateurs vont uploader** :
   - Photos de profil / avatars
   - Photos de produits
   - Documents PDF, contrats, factures
   - Exports CSV / Excel / rapports
   - Mixé / autre

   Selon votre réponse, elle décide en silence : bucket **public** (URL directe) ou bucket **privé** (URLs signées temporaires, sécurisées).

3. **Création du bucket** : un bucket `<projet>-assets` est créé dans votre projet Scaleway, région `fr-par` (Paris), avec une clé d'accès dédiée et sans expiration, rien que pour cette app. **Le versioning est activé automatiquement** - voir "Vos fichiers sont protégés" ci-dessous.

4. **Scaffolding** :
   - Le SDK S3-compatible (`@aws-sdk/client-s3`) est installé
   - Un fichier `src/server/storage.ts` est créé avec des helpers prêts à l'emploi : `uploadObject`, `deleteObject`, `listObjectVersions`, `restoreObjectVersion`, et selon le mode public/privé, soit `getPublicUrl`, soit `getSignedUploadUrl` + `getSignedDownloadUrl`

5. **Variables enregistrées** : `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (et `STORAGE_PUBLIC_URL` si public) sont enregistrées dans votre `.env` local et côté Scaleway (Secret Manager + votre app en ligne). Rien à copier-coller, rien à créer à la main - Baudrier génère les clés pour vous.

6. **Interface utilisateur (optionnel)** : Baudrier vous propose de construire l'UI adaptée à votre cas (champ upload + aperçu + galerie + liste personnelle de fichiers + sécurité des accès).

## Ce que ça crée pour vous

- Un **bucket de stockage** à votre nom (`<projet>-assets`) chez Scaleway, en France
- Une clé d'accès dédiée et sans expiration, rien que pour cette app
- Les variables `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (et `STORAGE_PUBLIC_URL` si bucket public)
- `src/server/storage.ts` avec les helpers prêts à l'emploi
- Si vous le voulez : l'interface utilisateur (composant d'upload, galerie, liste de fichiers, etc.)

## Vos fichiers sont protégés

Le bucket est créé avec le **versioning activé** - c'est l'unique sauvegarde qui existe pour les fichiers uploadés par vos utilisateurs (photos, documents, exports...), donc ce n'est pas une option à cocher, c'est actif par défaut.

Concrètement :
- Supprimer un fichier dans l'app **ne l'efface pas tout de suite**. Une version précédente reste récupérable en coulisses.
- Si un fichier est supprimé ou écrasé par erreur, il peut être restauré - Baudrier peut le faire pour vous si vous le demandez.
- Cette protection a une limite dans le temps : **les anciennes versions sont automatiquement nettoyées au bout d'environ 90 jours** pour maîtriser les coûts de stockage. Au-delà, une ancienne version est perdue définitivement.
- Conserver les anciennes versions utilise un peu plus d'espace de stockage qu'un bucket sans versioning, donc il y a un léger coût supplémentaire - c'est la contrepartie d'avoir un bouton "annuler" sur vos données.
- Le bucket lui-même ne peut jamais être supprimé par Baudrier, en aucune circonstance - seul un humain peut le faire, directement dans la console Scaleway.

## Prérequis

- Le projet doit être en Next.js (typiquement initialisé par `/bootstrap`)
- Les quatre variables `SCW_*` doivent être renseignées dans votre environnement cloud « Baudrier »

## Astuces

{{callout:tip|Vous ne payez que ce que vous stockez}}
Pas de "produit à activer" séparé, ni de carte bancaire à renseigner avant de commencer - un bucket peut être créé tout de suite. Les nouveaux comptes bénéficient en plus d'un essai gratuit généreux. Le téléchargement des fichiers est inclus, sans frais supplémentaire.
{{/callout}}

{{callout:info|Public vs Privé : la bonne intuition}}
**Public** = n'importe qui avec l'URL peut télécharger le fichier (photos de profil, photos de produits, contenu éditorial, pas confidentiel). **Privé** = chaque téléchargement passe par une URL temporaire signée par votre serveur (factures, contrats, rapports nominatifs). Si vous hésitez, Baudrier choisit "privé" par défaut (plus sûr).
{{/callout}}

{{callout:warning|Sécurité des données utilisateur}}
En privé, le contrôle d'accès est crucial : votre code doit vérifier que l'utilisateur qui demande un fichier en a bien le droit avant de générer l'URL signée. Si Baudrier construit l'UI pour vous, ces vérifications sont incluses (vérification de propriété, vérification de session). Si vous écrivez votre propre code, ne supprimez pas ces checks.
{{/callout}}
