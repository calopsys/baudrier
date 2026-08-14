# /unpublish

Restreint à nouveau votre application à un accès VPN uniquement. Annule `/publish`.

## Quand l'utiliser

- Si vous avez publié par erreur, ou voulez retirer le site du public pendant que vous continuez à travailler dessus.
- Avant de faire des changements que vous ne voulez pas montrer aux visiteurs en cours d'édition.

## Ce que ça fait

Rétablit la restriction d'accès par défaut : seules les requêtes venant du VPN du bureau atteignent l'application ; tous les autres reçoivent un simple message "accès refusé" à la place du site.

## Ce qui se passe

1. Vous confirmez quel environnement restreindre (production ou un aperçu).
2. L'assistant avertit que `seo-perf`, `eco-audit` et `gsc` cessent de fonctionner correctement tant que c'est restreint (ils ont besoin que Google puisse accéder au site).
3. La restriction est réactivée et le site est redéployé avec le nouveau réglage.

## Astuces

{{callout:info|Pas un verrouillage total}}
Ceci rétablit la même barrière légère, au niveau de l'application, que chaque application a par défaut - c'est une barrière de courtoisie, pas un blocage réseau.
{{/callout}}

## Sites vitrines

`/unpublish` s’applique à l’identique sur un site vitrine : le redéploiement qui suit redémarre le conteneur et relit la porte d’accès, qu’elle soit implémentée dans le `proxy.ts` de Next.js ou dans le Caddyfile d’un site vitrine.
