# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Stack
- **Framework** : Astro 7, sortie statique (`output: "static"`)
- **Styling** : Tailwind CSS v4 - jetons sémantiques dans `src/styles/theme.css`
- **Hébergement** : Scaleway Serverless Containers, région `fr-par` (Paris) - image Caddy servant les fichiers statiques
- **Build de l’image** : directement par la machine qui lance `/bootstrap` ou `/deploy` (`docker build` + `docker push`), jamais par GitHub Actions
- **Backend** : aucun - pas de base de données, pas d’API serveur, pas de compte utilisateur
- **Langue** : French uniquement, pas d’internationalisation (i18n)

## Project structure
```
src/
├── layouts/BaseLayout.astro   ← squelette HTML commun (meta, favicon, ancres analytics/thème)
├── components/                ← sections réutilisables (Header, Hero, Services, About, Testimonials, Contact, Footer)
├── pages/                     ← une page = une route (index.astro, mentions-legales.astro, ...)
└── styles/
    ├── global.css               ← importe Tailwind puis theme.css
    ├── theme.css                 ← préréglage choisi au bootstrap (jetons sémantiques)
    └── presets/                  ← les trois préréglages disponibles (épuré, chaleureux, audacieux)
Dockerfile                      ← build multi-stage (node:24-alpine → caddy:2-alpine)
Caddyfile                       ← sert les fichiers statiques + filtre IP
docker-entrypoint.sh            ← génère le filtre IP au démarrage du conteneur
```

## Key Commands
- `pnpm dev` - serveur de développement (port 4321)
- `pnpm build` - build statique dans `dist/`
- `pnpm check` - vérification des types Astro (`astro check`) - c’est le seul gate ; pas d’ESLint sur ce projet

## Conventions
- **Jetons sémantiques uniquement** : toujours utiliser les classes Tailwind dérivées de `src/styles/theme.css` (`bg-surface`, `text-ink`, `text-accent`, `text-muted`, `font-display`, `font-body`, ...). Ne jamais écrire de couleur hexadécimale en dur dans un composant.
- **Composition libre** : les composants de `src/components/` prennent leur contenu en props typées, avec des valeurs par défaut en français. Composer les pages à partir de la description de l’utilisateur.
- **Pas de formulaire de contact** : `Contact.astro` affiche des coordonnées statiques (téléphone, email, adresse, horaires, lien de prise de rendez-vous optionnel) - ce site n’a pas de backend pour traiter un envoi.
- **Images** : uniquement des SVG en ligne pour les illustrations de remplacement - jamais d’image hébergée sur un service tiers.

## Accès restreint (filtre IP)
Ce site est livré **restreint par IP** par défaut (`ACCESS_RESTRICTED=true`). La logique vit entièrement dans `docker-entrypoint.sh`, qui génère `/etc/caddy/gate.caddy` au démarrage du conteneur : seules les IP listées dans `ACCESS_ALLOWED_IPS` (à défaut, l’IP du VPN de l’opérateur) peuvent accéder au site ; les autres reçoivent une page 403. C’est une barrière **applicative**, pas un pare-feu réseau. Les chemins `/.well-known/acme-challenge/*` et le healthcheck (`/api/healthz`, correspondance exacte) sont toujours exemptés, quel que soit l’état de la restriction.

## Déploiement
Ce projet est hébergé sur **Scaleway Serverless Containers** (région `fr-par`), en production avec `min_scale` 1 : le conteneur reste toujours allumé (coût fixe d’environ 6,40 €/mois), car un site vitrine ne peut pas se permettre le délai de réveil d’un conteneur à `min_scale` 0. L’aperçu de prévisualisation utilise la branche stable `revue`, à `min_scale` 0, sans base de données de prévisualisation puisqu’il n’y a pas de base de données du tout.
Le déploiement complet (build + mise à jour du conteneur + smoke test) se fait via la skill interne `/deploy`, jamais manuellement.

## Skills disponibles
Ce projet est un site vitrine (Astro statique) : seules les skills suivantes s’appliquent -
`/deploy`, `/publish`, `/unpublish`, `/add-domain`, `/costs`, `/save-project`,
`/delete-project`, `/add-analytics`, `/add-dark-mode`, `/seo`, `/seo-perf`, `/geo`,
`/rotate-secret`, `/scale`, `/gsc`, `/add-blog`, `/blogpost`. Les autres skills projet (base
de données, authentification, automatisations, ...) refusent avec un message explicite : ce
site reste modifiable et déployable, elles ne s’appliquent simplement pas à un site sans
backend.

Pas encore de blog sur ce site : `/add-blog` l’installe une fois pour toutes (articles, flux
RSS, plan du site), puis `/blogpost` rédige et publie chaque article depuis la conversation.

## Variables d’environnement
- `APP_URL` - URL publique du conteneur (`https://<domaine>.containers.scw.cloud` par défaut, ou le domaine personnalisé une fois configuré).
- `ACCESS_RESTRICTED` / `ACCESS_ALLOWED_IPS` / `ACCESS_BYPASS_TOKEN` - filtre IP (voir "Accès restreint" ci-dessus).
