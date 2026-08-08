# /rgpd-audit

Audite la conformité RGPD de votre projet et met à jour votre politique de confidentialité. Baudrier détecte automatiquement chaque service tiers utilisé par votre app, le compare avec votre politique en ligne, et propose les corrections - et vous montre concrètement à quel point votre hébergement est souverain.

## Quand l'utiliser

- Vous avez fait un `/bootstrap` ancien (avant la politique de confidentialité data-driven) et vous voulez **mettre à jour votre conformité**
- Vous avez ajouté plusieurs services au fil du temps et vous voulez **vérifier** que votre politique de confidentialité est à jour
- Vous voulez **régénérer** votre page de politique de confidentialité à partir de la liste réelle des sous-traitants
- Vous voulez vous assurer qu'**aucun service tiers n'est utilisé** sans être mentionné dans votre politique

## Comment ça se passe

1. **Préflight** : Baudrier vérifie que vous êtes bien à la racine d'un projet Next.js.

2. **Audit complet** : Baudrier scanne votre code (`src/`), vos variables d'environnement (`.env`) et vos dépendances (`package.json`) pour détecter **chaque sous-traitant tiers** réellement utilisé :
   - Hébergement (Scaleway Serverless Containers - toujours présent)
   - Base de données (Scaleway Serverless SQL Database)
   - Stockage de fichiers (Scaleway Object Storage)
   - Email (Scaleway Transactional Email)
   - Analytics (Matomo, sans cookies par défaut)
   - Et tous les autres détectables

   Il signale aussi les tiers impliqués dans la **construction et l'exploitation** du projet qui n'ont pas leur place dans la politique de confidentialité car ils ne touchent jamais aux données personnelles des visiteurs : GitHub (hébergement du code source + intégration continue, dans le pipeline de déploiement) et les outils SEO Google (PageSpeed Insights / Search Console, utilisés par `/seo-perf` et `/gsc` - lisent des données publiques du site, pas des données visiteur). Ils sont signalés séparément, par transparence, pas comme un écart de conformité.

3. **Comparaison avec le registre** : Baudrier lit `src/lib/subprocessors.json` (le registre central des sous-traitants RGPD du projet) et compare avec ce qui est détecté dans le code.

4. **Rapport** : Baudrier affiche le diagnostic :
   - **Détectés dans le code** : la liste complète des services tiers actuellement utilisés (avec la preuve : `package.json`, env var, ou pattern de code)
   - **Manquants** : services détectés mais **absents du registre** (à ajouter)
   - **Obsolètes** : services présents dans le registre mais **plus détectés** dans le code (à supprimer ou justifier)
   - **Souveraineté** : la part de vos sous-traitants déclarés réellement basés en France/UE - généralement la grande majorité, puisque l'hébergement, la base de données, le stockage et l'email sont tous Scaleway (région Paris, fr-par) par défaut dans cette stack

5. **Corrections proposées** : Baudrier vous propose :
   - **Mettre à jour le registre** `subprocessors.json` avec les manquants et / ou retirer les obsolètes
   - **Générer ou rafraîchir** la page de politique de confidentialité (si elle est manquante ou désynchronisée)
   - **Lier** la politique de confidentialité depuis les mentions légales si ce n'est pas déjà fait

6. **Application** : Baudrier applique les changements validés. La page de politique de confidentialité est **data-driven** : elle se met à jour automatiquement depuis le registre. Vous n'avez plus à éditer manuellement le contenu RGPD à chaque nouveau service ajouté.

## Ce que ça crée pour vous

- Un **registre `subprocessors.json`** à jour (la source de vérité unique sur vos sous-traitants RGPD)
- Une **page de politique de confidentialité** régénérée à partir du registre, conforme à la réglementation française
- Un **lien** depuis les mentions légales (si manquant)
- Un rapport clair avec les écarts détectés et un résumé de souveraineté réellement calculé

## Prérequis

- Le projet doit être en Next.js avec App Router (typiquement initialisé par `/bootstrap`)
- Aucune autre dépendance, `/rgpd-audit` fonctionne même si vous n'avez jamais touché à la politique de confidentialité

## Astuces

{{callout:info|Pourquoi un registre central}}
Au lieu d'écrire votre politique de confidentialité à la main (et de devoir penser à la mettre à jour à chaque nouveau service), Baudrier utilise un **registre central** (`subprocessors.json`) qui est la source unique de vérité. Chaque skill `/add-*` (`/add-db`, `/add-storage`, `/add-email`, `/add-analytics`, etc.) met à jour le registre automatiquement. La page de politique de confidentialité est juste un rendu de ce registre.
{{/callout}}

{{callout:tip|Lancez après une grosse refonte}}
Si vous avez ajouté ou retiré plusieurs services en peu de temps (par exemple : ajouté un agent IA, changé le mode d'hébergement de Matomo, retiré les analytics), `/rgpd-audit` est le moyen rapide de remettre tout en cohérence. Une seule commande, et votre politique est à jour.
{{/callout}}

{{callout:warning|RGPD = obligation légale en France}}
Pour tout site qui collecte ou traite des données personnelles d'utilisateurs français / européens (formulaire de contact, comptes utilisateurs, notifications, analytics, etc.), une politique de confidentialité à jour est **obligatoire**. Les amendes CNIL peuvent grimper. Lancer `/rgpd-audit` régulièrement (tous les 2-3 mois ou après chaque refonte) est une bonne hygiène.
{{/callout}}
