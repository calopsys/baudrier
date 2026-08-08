# Auto-héberger les tuiles de carte (OpenFreeMap / OpenMapTiles)

Ce guide explique comment remplacer le fournisseur de tuiles par défaut
(`tiles.openfreemap.org`) par une infrastructure que vous contrôlez, sur
Scaleway. Il est référencé depuis `src/components/site/map.tsx` (la constante
`TILE_STYLE_URL`) et depuis `skills/add-map/SKILL.md`.

## Le défaut est-il suffisant pour vous ?

Le défaut (OpenFreeMap, tuiles vectorielles servies depuis la Hongrie, UE) est
gratuit, sans clé API, sans cookie, et couvre la quasi-totalité des projets.
**Restez sur le défaut** si votre projet est un site vitrine, une carte de
points de vente, ou tout usage à trafic modéré : la charge légale est déjà
couverte (voir l’entrée `openfreemap` dans `src/lib/subprocessors.json`, base
légale « intérêt légitime »).

**Envisagez l’auto-hébergement** si l’un de ces cas s’applique :

- Trafic très élevé (des dizaines de milliers de chargements de carte par
  jour) : OpenFreeMap est un projet financé par des dons, maintenu par une
  seule personne, sans garantie de service (SLA). Un pic de trafic peut le
  ralentir pour tout le monde.
- Une politique interne qui exige un contrat de sous-traitance (DPA) formel
  pour chaque prestataire, ce qu’OpenFreeMap ne propose pas.
- Un besoin de personnalisation poussée du style ou des données (une carte
  hors-ligne, une zone géographique très spécifique, des couches propriétaires
  ajoutées aux tuiles).

Si aucun de ces cas ne s’applique, il n’y a pas de bonne raison de payer le
coût d’exploitation ci-dessous. Le défaut reste la recommandation.

## Option A - Extrait PMTiles sur Object Storage (le plus simple)

**Effort réaliste : une demi-journée pour un premier essai, puis quelques
heures tous les 3 à 6 mois pour rafraîchir les données.**

Le format [PMTiles](https://github.com/protomaps/PMTiles) empaquette toutes
les tuiles d’une zone dans un seul fichier. Le navigateur du visiteur lit
directement ce fichier par requêtes HTTP Range (morceaux de fichier), sans
qu’aucun serveur applicatif ne soit nécessaire : Object Storage (compatible
S3) sait répondre à des requêtes Range nativement.

1. **Générer l’extrait.** Le plus simple est d’utiliser un extrait déjà
   préparé par [Protomaps](https://maps.protomaps.com/builds/) (schéma
   compatible OpenMapTiles, donc compatible avec le style utilisé par ce
   projet) : téléchargez l’extrait correspondant à votre pays ou région
   (quelques centaines de Mo à quelques Go selon la zone). Pour un besoin très
   précis, l’outil `planetiler` permet de générer votre propre extrait à
   partir de données OpenStreetMap, mais c’est un travail à part entière (voir
   la documentation de [Planetiler](https://github.com/onthegomap/planetiler)).
2. **Uploader le fichier `.pmtiles` sur Object Storage.** Créez (ou
   réutilisez) un bucket Scaleway Object Storage - voir `STORAGE_*` dans
   `CONTRACT.md` §2 pour les variables déjà disponibles dans ce projet si
   `/add-storage` a été exécuté. Le fichier peut rester privé : les requêtes
   Range se font depuis le navigateur du visiteur, donc le bucket doit
   autoriser la lecture publique du fichier `.pmtiles` (pas d’écriture).
3. **Câbler le protocole PMTiles côté client.** Installer `pmtiles` (le
   paquet npm), puis dans le composant qui initialise MapLibre (avant de
   créer la `Map`) :

   ```ts
   import { Protocol } from "pmtiles";
   import maplibregl from "maplibre-gl";

   const protocol = new Protocol();
   maplibregl.addProtocol("pmtiles", protocol.tile);
   ```

   Remplacez ensuite `TILE_STYLE_URL` par un style JSON dont les sources
   pointent vers `pmtiles://https://<bucket>.s3.fr-par.scw.cloud/<fichier>.pmtiles`
   au lieu de l’URL OpenFreeMap. Un style de base compatible OpenMapTiles est
   fourni par Protomaps ; adaptez ses chemins de sources à l’URL ci-dessus.
4. **Polices et sprites.** Le style par défaut pointe aussi vers des polices
   et icônes hébergées par OpenFreeMap. Pour un auto-hébergement complet,
   téléchargez-les aussi et servez-les depuis le même bucket (sinon vous
   dépendez encore partiellement d’OpenFreeMap pour ces deux éléments).

**Coût d’exploitation** : stockage + bande passante sortante Object Storage
uniquement, pas de conteneur à faire tourner. Le point d’attention principal
est de penser à régénérer l’extrait périodiquement (les données OpenStreetMap
évoluent), sans quoi la carte affiche des informations de plus en plus
datées.

## Option B - Serveur de tuiles dans un conteneur Scaleway (plus lourd)

**Effort réaliste : une à deux journées pour la mise en place initiale, puis
une maintenance récurrente (mises à jour, supervision).**

Une alternative est de faire tourner un serveur de tuiles (par exemple
[Martin](https://github.com/maplibre/martin), qui sait lire directement un
fichier `.pmtiles` sur Object Storage) dans un Serverless Container Scaleway,
et de pointer `TILE_STYLE_URL` vers son URL publique.

Points d’attention propres à ce projet :

- Les Serverless Containers de ce harnais scalent à zéro par défaut
  (`DEFAULT_MIN_SCALE = 0`, `CONTRACT.md`). Le premier visiteur après une
  période d’inactivité subit donc un temps de démarrage à froid avant que la
  carte ne s’affiche - contrairement à l’Option A, qui n’a pas ce problème
  (Object Storage ne « dort » jamais).
- Ce conteneur est un service séparé de l’application principale : il a son
  propre déploiement, sa propre image Docker, et n’est pas géré par
  `/deploy` tel qu’il existe aujourd’hui dans ce plugin. Sa mise en place
  sort du périmètre automatisé des skills `/add-map` et `/deploy`.
- Prévoyez une supervision (Cockpit, `CONTRACT.md` §1) pour être averti si le
  serveur de tuiles tombe, plutôt que de découvrir le problème via un
  visiteur qui signale une carte blanche.

## Dans tous les cas

- Le changement de fournisseur ne touche qu’une constante
  (`TILE_STYLE_URL` dans `src/components/site/map.tsx`) et, si vous changez
  de méthode de chargement (Option A), l’ajout du protocole `pmtiles` côté
  client. Aucun autre refactor n’est nécessaire.
- Mettez à jour `src/lib/subprocessors.json` : si vous restez sur des
  serveurs Scaleway (Object Storage ou conteneur), aucune nouvelle entrée
  n’est nécessaire (déjà couvert par les entrées `scaleway-object-storage` /
  `scaleway`). Si vous utilisez un extrait tiers (Protomaps, un autre
  fournisseur), ajoutez une entrée dédiée en suivant le même format que
  l’entrée `openfreemap` existante (voir `skills/add-map/SKILL.md`).
