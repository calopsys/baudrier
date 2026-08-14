# /add-domain

Connecte un **nom de domaine personnalisé** à votre app : `monsite.fr` au lieu de l'URL par défaut du container Scaleway.

## Quand l'utiliser

- Vous voulez que votre site soit accessible sur **votre propre adresse** (plus pro, mieux référencé, plus crédible)
- Vous possédez déjà un nom de domaine et voulez le connecter à votre projet

## Ce que ça ne fait PAS

{{callout:warning|Domaines externes uniquement - pas d'automatisation de registrar}}
Ce projet ne **vend** ni n'**enregistre** de noms de domaine, et n'automatise **aucun registrar** (pas de Hostinger, OVH, Namecheap, GoDaddy, etc.). Vous devez déjà posséder le domaine. S'il n'est pas encore délégué aux DNS Scaleway, `/add-domain` s'arrête et vous donne les valeurs exactes de nameservers à transmettre à qui gère le domaine - il n'essaie jamais de les changer à votre place.
{{/callout}}

{{callout:warning|Pas de réception d'emails}}
Scaleway n'a **aucun équivalent** à un service de redirection d'emails. Connecter un domaine ici permet seulement d'**envoyer** des emails depuis ce domaine (via un `/add-email` séparé) - pas de **recevoir** sur `contact@monsite.fr`. Pour une vraie boîte mail sur ce domaine, il faut un fournisseur d'hébergement email séparé ; ce projet ne le met pas en place.
{{/callout}}

## Comment ça se passe

L'architecture cible : **votre domaine (acheté n'importe où) → DNS Scaleway (zone déléguée) → Scaleway Serverless Containers (hébergement)**.

1. **Nom de domaine** : vous donnez à Baudrier le domaine exact, par exemple `monsite.fr`.

2. **Vérification de la délégation** : Baudrier vérifie si les nameservers du domaine pointent déjà vers Scaleway (`ns0.dom.scw.cloud` / `ns1.dom.scw.cloud`) et si une zone DNS existe déjà pour lui dans votre compte Scaleway. Sinon, elle s'arrête et vous donne les valeurs exactes à renseigner chez votre registrar - elle ne tente jamais cette opération automatiquement.

3. **Enregistrement DNS** : une fois délégué, Baudrier ajoute un enregistrement DNS qui pointe votre domaine vers l'adresse de votre container.

4. **Attente de la propagation** : Baudrier attend activement (jusqu'à 3 minutes, la même fenêtre que l'émission du certificat Scaleway) que cet enregistrement DNS soit visible sur internet - **avant** de toucher à quoi que ce soit d'autre. Cet ordre est important : attacher le domaine trop tôt peut le mettre dans un état cassé qui ne se répare qu'en recommençant de zéro.

5. **Rattachement + certificat** : Baudrier rattache le domaine à votre container, ce qui déclenche l'émission automatique et gratuite du certificat HTTPS.

6. **Nettoyage** : les références restantes à l'ancienne URL par défaut Scaleway dans votre code (sitemap, metadata, robots.txt) sont remplacées par votre nouveau domaine - important pour le référencement.

## Ce que ça crée pour vous

- Un enregistrement DNS sur votre domaine, pointant vers le container de votre app
- Le domaine **rattaché à votre container Scaleway** avec un certificat HTTPS automatique et auto-renouvelé
- La variable `APP_URL` mise à jour partout (`.env`, Scaleway Secret Manager, code source), avec `AUTH_URL` qui suit automatiquement à la prochaine synchronisation des secrets du container

## Prérequis

- Une app déjà déployée sur un container Scaleway Serverless (typiquement via `/bootstrap` puis `/deploy`)
- Un nom de domaine que vous possédez déjà, avec accès pour changer ses nameservers chez votre registrar (ou quelqu'un dans votre équipe qui l'a)
- Les quatre variables `SCW_*` doivent être renseignées dans votre environnement cloud « Baudrier »

## Astuces

{{callout:tip|Délai de propagation DNS}}
Un changement de nameservers peut prendre de quelques minutes à 24-48h pour se propager dans le monde entier. Baudrier vérifie activement plutôt que de deviner, et vous dira clairement si elle attend encore.
{{/callout}}

{{callout:info|Pourquoi cette attente est importante}}
L'émission du certificat HTTPS de Scaleway utilise un défi avec une fenêtre stricte de **3 minutes**. Si l'enregistrement DNS n'est pas encore visible quand ce défi se déclenche, le domaine peut se retrouver dans un état qui ne sert **ni HTTP ni HTTPS**, sans réparation automatique possible - la seule solution est de le supprimer et de recommencer. C'est pourquoi Baudrier confirme toujours la propagation avant, quitte à attendre ou à vous demander de réessayer plus tard.
{{/callout}}

{{callout:info|Limite au niveau de l'Organisation}}
Une Organisation Scaleway peut avoir au maximum **10 domaines externes** connectés. Si vous atteignez cette limite, supprimez-en un inutilisé dans la console Scaleway avant d'en ajouter un nouveau.
{{/callout}}

{{callout:info|Ne touchez pas à l'exemption ACME dans proxy.ts}}
Votre app est protégée par défaut par une liste d'adresses IP autorisées. Son `proxy.ts` exempte toujours `/.well-known/acme-challenge/*` de ce filtre, précisément pour que Scaleway puisse continuer à émettre et renouveler votre certificat HTTPS. Ne retirez jamais cette exemption - cela casserait silencieusement le renouvellement du certificat et rendrait votre site inaccessible en HTTPS à terme.
{{/callout}}

## Sites vitrines

Sur un site vitrine (Astro), l’étape finale de nettoyage du code est différente : au lieu de toucher `sitemap.ts`/`layout.tsx`, Baudrier renseigne le champ `site:` de `astro.config.mjs` avec votre nouveau domaine et installe `@astrojs/sitemap` s’il n’est pas déjà présent. Le reste (vérification de la délégation, attente de la propagation DNS, rattachement du domaine, mise à jour d’`APP_URL`) fonctionne à l’identique.
