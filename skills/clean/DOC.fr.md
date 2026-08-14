# /clean

Détecte et supprime tout ce qui n'est plus utilisé dans ton projet pour l'alléger. Fichiers orphelins, code mort, dépendances inutiles, variables d'environnement et tables DB sans usage : les suppressions validées sont appliquées sur une branche séparée pour que tu puisses vérifier avant de merger.

## Quand l'utiliser

- Tu veux **alléger** ton projet après plusieurs mois d'évolutions.
- Tu veux **identifier** ce qui pourrait poser problème (variables d'env obsolètes, tables DB sans caller, etc.).
- Tu suspectes du code mort laissé par d'anciennes itérations en vibe coding.

## Comment ça se passe

1. **Disclaimer affiché en début** : l'assistant rappelle que c'est un diagnostic. Certaines trouvailles peuvent être des faux positifs (imports dynamiques, références en base, etc.). **Rien n'est supprimé sans ta validation explicite.**

2. **Audit complet** : l'assistant scanne ton projet selon plusieurs catégories :
   - **Fichiers orphelins** (fichiers qui ne sont importés nulle part)
   - **Code mort** (exports, fonctions, composants jamais utilisés)
   - **Déchets IA** (stubs, doublons, TODO laissés en plan)
   - **Dépendances inutilisées** (packages dans `package.json` mais jamais importés)
   - **Variables d'env orphelines** (déclarées dans `.env` ou Secret Manager mais jamais lues côté code)
   - **Tables DB sans caller** (tables Drizzle qu'aucun code ne référence - analyse statique uniquement, voir ci-dessous)
   - **Migrations obsolètes** (fichiers Drizzle qui ne servent plus)

3. **Rapport pédagogique** : pour chaque trouvaille, tu as un niveau de certitude, un niveau de danger, les vérifications déjà faites (des faits, pas une todo-list), et les questions auxquelles toi seul peux répondre.

4. **Tu valides ce que tu veux supprimer** : à la carte. Tout accepter, tout refuser, ou trier élément par élément.

5. **Application sur une branche séparée** : l'assistant crée une branche `cleanup-<date>` et y applique les suppressions. Si la base de données est touchée, pousser cette branche et la déployer en preview provisionne automatiquement sa propre base isolée (pas de branche de base à créer à la main).

6. **Merge** : une fois que tu es sûr que rien n'est cassé, tu merges vers la production comme d'habitude. Si quelque chose pose problème, tu abandonnes la branche - rien n'atteint la production.

## Ce que ça crée pour toi

- Un **rapport d'hygiène** complet du projet.
- Une **branche `cleanup-*`** avec les suppressions validées.
- Un commit propre par catégorie de suppression.
- Rien n'est touché tant que tu ne merges pas.

## Prérequis

- Aucun prérequis particulier - `/clean` peut tourner sur n'importe quel projet Baudrier.
- Mieux vaut avoir un état Git propre (rien de non-commité) avant de lancer, pour ne pas mélanger tes changements en cours avec les suppressions.

## Astuces

{{callout:warning|Toujours tester la preview avant de merger}}
Si le nettoyage touche la base de données, déployer la branche en preview lui donne sa propre vraie base isolée - teste tout là, pas seulement les parties que tu penses concernées.
{{/callout}}

{{callout:tip|Facile à annuler en cas de problème}}
Si quelque chose est cassé sur la preview après le clean : pas de panique. Tu n'as pas mergé, donc ton `main` est intact. Soit tu abandonnes la branche, soit tu demandes à l'assistant d'annuler seulement la suppression qui pose problème.
{{/callout}}

{{callout:info|Les vérifications DB sont statiques, pas en direct}}
La machine de l'opérateur n'a pas d'accès direct à ta base de données (seule une Job Scaleway dédiée l'a) - donc une trouvaille "table sans caller" repose uniquement sur la lecture de ton code, jamais sur une vérification que la table a réellement des lignes.
{{/callout}}

{{callout:warning|Supprimer une table DB n'est jamais automatique - même après validation de la trouvaille}}
Pour toutes les autres catégories, valider une trouvaille suffit pour qu'elle soit retirée sur la branche de nettoyage. Les tables DB, c'est différent : reconnaître qu'une table semble inutilisée ne fait que la noter comme recommandation, à titre indicatif. Rien n'est généré ni exécuté contre une base de données - même une base de preview - tant que tu ne demandes pas explicitement, et séparément, que cette table précise soit préparée et testée. C'est seulement à ce moment-là que l'assistant crée une migration et l'applique sur une base de preview isolée pour que tu la vérifies ; la production n'est jamais touchée avant que tu l'aies testée là-bas et confirmé le merge toi-même.
{{/callout}}

## Sites vitrines

Non disponible sur un site vitrine : cette commande est réservée aux applications complètes. Si votre projet est un site vitrine (Astro, sans base de données ni comptes utilisateurs), Baudrier refuse la commande et vous le dit - votre site reste tel quel, et vous pouvez toujours le déployer avec `/deploy`.
