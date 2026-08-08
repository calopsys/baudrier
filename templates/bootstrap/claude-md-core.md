# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Stack
- **Framework**: Next.js 16 (App Router) - T3 Stack
- **Langage**: TypeScript
- **Styling**: Tailwind CSS v4 + shadcn/ui (composants dans `src/components/ui/`)
- **Fonts**: Geist Sans (via `next/font/google` dans `src/app/layout.tsx`)
- **API**: tRPC v11
- **ORM**: Drizzle (`pg` + `drizzle-orm/node-postgres`)
- **Base de données**: Scaleway Serverless SQL Database (PostgreSQL 16) - une base dédiée à ce projet
- **Hébergement**: Scaleway Serverless Containers, région `fr-par` (Paris)
- **Build de l’image** : directement par la machine qui lance `/bootstrap` ou `/deploy` (`docker build` + `docker push`), jamais par GitHub Actions
- **Langue** : French uniquement, pas d’internationalisation (i18n)

## Project structure
```
src/
├── app/             ← App Router (pages, layouts)
├── proxy.ts          ← filtre IP (voir "Accès restreint" ci-dessous)
├── server/
│   ├── api/         ← tRPC routers (root.ts + routers/*.ts)
│   └── db/          ← Drizzle schema + connection
├── components/ui/   ← shadcn/ui + LinkButton
├── styles/          ← globals.css (Tailwind + CSS vars + Geist wiring)
└── trpc/            ← tRPC client setup
Dockerfile            ← build multi-stage (node:24-alpine, output: 'standalone')
copy-assets.js         ← restaure .next/static/ + public/ dans le build standalone
```

## Key Commands
- `pnpm dev` - dev server (port 3000). **Ne pas lancer `pnpm db:studio`** - outil de debug avancé, pas nécessaire en usage normal.
- `pnpm lint` - ESLint
- `pnpm tsc --noEmit` - type-check sans émettre

## Conventions
- **Design** : toujours lire `src/styles/globals.css` avant de créer un composant - les CSS variables de palette, fonts et espacements y sont définies. Ne jamais utiliser de couleurs Tailwind par défaut. Police par défaut : Geist Sans.
- **UI** : toujours utiliser les composants shadcn/ui de `~/components/ui/` avant de créer des composants custom. Installer de nouveaux composants avec `npx shadcn@latest add <name>` (toujours `npx`, jamais `pnpm dlx` - ce dernier échoue avec ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND).
- **Boutons-liens** : utiliser `<LinkButton href="..." variant="...">` depuis `~/components/ui/link-button`. JAMAIS `<Button asChild><Link>...</Link></Button>` - shadcn v4 n’expose pas `asChild` et ça casse le build.
- **Police Geist** : Geist (via `next/font/google`) est wirée dans `<html className={geist.variable}>` (`src/app/layout.tsx`) + rule `--font-sans` dans `globals.css`. Ne JAMAIS retirer ces éléments en modifiant `layout.tsx` ou `globals.css` - sans ça, l’app tombe sur Times New Roman. Pour changer la police, remplacer Geist explicitement par une autre Google Font via `next/font` en préservant la structure (import → instance → variable sur html → rule CSS).
- **Images** : toujours utiliser le composant `<Image>` de `next/image` au lieu de `<img>`. Toujours inclure un attribut `alt` descriptif. `next.config.js` autorise les images servies depuis `**.scw.cloud` (Object Storage).
- **Feedback** : utiliser les composants `toast` / `sonner` de shadcn/ui pour les messages de succès, erreur, et information. Ne jamais utiliser `alert()` ou `window.confirm()`.
- **Formulaires** : toute route tRPC publique qui accepte des données utilisateur (formulaire de contact, inscription, etc.) doit utiliser `rateLimitedProcedure` au lieu de `publicProcedure`.
- **API** : toute communication client-serveur passe par tRPC (routeurs dans `src/server/api/routers/`, enregistrés dans `root.ts`). Ne jamais créer de route API Next.js (`src/app/api/`) sauf pour les webhooks de services externes.
- **Server vs client tRPC** : server components → `import { api } from "~/trpc/server"` puis `await api.router.procedure()`. Client components → `import { api } from "~/trpc/react"` puis hooks `api.router.procedure.useQuery()`.
- **Base de données** : chaque projet a sa propre base Postgres dédiée (pas de préfixe de table multi-projets). Déclarer les tables directement avec `pgTable` de `drizzle-orm/pg-core` dans `src/server/db/schema.ts`. `drizzle-kit generate` (local, sans connexion) écrit les fichiers SQL ; `drizzle-kit migrate` ne tourne JAMAIS en local ni au démarrage du conteneur - uniquement via le Job de migration Scaleway invoqué par `/deploy`.

## Accès restreint (filtre IP)
Ce site est livré **restreint par IP** par défaut (`ACCESS_RESTRICTED=true`, `src/proxy.ts`). Seules les IP listées dans `ACCESS_ALLOWED_IPS` (à défaut, l’IP du VPN de l’opérateur) peuvent y accéder ; les autres reçoivent une page 403. C’est une barrière **applicative**, pas un pare-feu réseau - Scaleway ne filtre pas les IP au niveau réseau pour les Serverless Containers. Les chemins `/.well-known/acme-challenge/*` et le healthcheck (`/api/healthz`, correspondance exacte) sont toujours exemptés, quel que soit l’état de la restriction.

## Boucle de développement
- **Le local d’abord** : lancer `pnpm dev`, tester sur http://localhost:3000 (les pages s’affichent, les textes sont corrects, les parcours fonctionnent). `pnpm tsc --noEmit` et `pnpm lint` ne vérifient que les types et le style - ils ne disent rien sur le bon fonctionnement d’une page.
- **Le filtre IP est coupé en local** : `src/proxy.ts` laisse passer toute requête quand `NODE_ENV=development` (c’est la valeur que `next dev` fixe automatiquement). Rien à configurer.
- **Le `.env` local contient un placeholder** syntaxiquement valide, jamais une vraie chaîne de connexion ; ne pas le supprimer (il est requis par la validation d’env et `pnpm db:generate`). Écrire l’accès à la base pour que les pages DÉGRADENT au lieu de planter : traiter une donnée stockée comme un cache ou une optimisation quand la valeur peut être recalculée, et en cas d’erreur de base de données, logger une ligne puis se rabattre (calcul en direct, ou état vide explicite). Voir `src/server/db/safe.ts` et son utilitaire `tryDb(fn, fallback)`. Cette règle couvre les pages de données dans la boucle locale ET garde le site déployé opérationnel pendant une panne de base de données.
- **Tester la logique sans interface** : pour la logique cœur (analyseurs, calculs de score, générateurs), écrire un script d’essai lancé directement - `pnpm dlx tsx scratch/try.ts` (ou `node` pour un `.mjs`) - qui affiche les entrées et les sorties. Quelques secondes au lieu d’un déploiement. Garder ces scripts hors de git, dans un dossier `scratch/` ignoré par git.
- **Le déploiement sert à la revue, pas au test** : ne déployer que si l’utilisateur le demande, ou pour présenter un changement fonctionnel à sa revue. Un déploiement déclenche un build d’image complet. Ne jamais déployer en production sans demander ; si l’app est déjà publiée, déployer d’abord sur l’app de prévisualisation et laisser l’utilisateur la vérifier là.

## Déploiement
Ce projet est hébergé sur **Scaleway Serverless Containers** (région `fr-par`). Le build de l’image Docker se fait directement par la machine qui exécute `/deploy` (`docker build` + `docker push` vers le Container Registry Scaleway) - jamais via GitHub Actions. Le déploiement complet (build + mise à jour du conteneur avec la nouvelle image + migration DB + smoke test) se fait via la skill interne `/deploy`, jamais manuellement.
Ne jamais lancer `docker build` en dehors de `/deploy` ou `/bootstrap` - ces deux skills démarrent le démon Docker si besoin et gèrent le tag/push correctement.

## Variables d’environnement
- `DATABASE_URL` - placeholder pour l’instant (secret du conteneur). Remplacé par la vraie chaîne de connexion Scaleway Serverless SQL quand `/add-db` est invoqué.
- `APP_URL` - URL publique du conteneur (`https://<domaine>.containers.scw.cloud` par défaut, ou le domaine personnalisé une fois configuré).
- `ACCESS_RESTRICTED` / `ACCESS_ALLOWED_IPS` - filtre IP (voir "Accès restreint" ci-dessus).
