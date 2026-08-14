# /costs

Affiche ce que votre application vous coûte réellement sur Scaleway.

## Quand l'utiliser

- Dès que vous voulez une réponse réelle à "combien ça me coûte", pas une estimation.
- Avant de décider d'augmenter la taille, de garder une application toujours allumée, ou de faire du ménage.

## Ce que ça affiche

- **Votre dépense réelle totale** pour le mois en cours (ou une période que vous demandez), récupérée directement depuis la facturation Scaleway.
- **Une répartition par service** - hébergement, base de données, email, etc. - pour savoir où va l'argent.
- **L'usage email** sur la période.
- **Des limites de référence** pour les éléments que Scaleway ne mesure pas en temps réel (comme les plafonds du niveau gratuit) - clairement indiquées comme des valeurs de référence fixes, pas votre usage réel, car aucune API du fournisseur ne permet de vérifier cela.

## Une précision sur les périodes

La facturation Scaleway ne se découpe que par mois calendaire entier - pas par jour, ni par plage de dates arbitraire. Si vous demandez les coûts des "deux dernières semaines", attendez-vous à ce que l'assistant explique cette limite et vous donne à la place le total du mois en cours.

## Astuces

{{callout:info|Le niveau gratuit affiche bien 0 €}}
Si un service n'affiche aucun coût, cela signifie généralement que vous êtes encore dans le quota gratuit mensuel de Scaleway pour ce service - pas que quelque chose est cassé.
{{/callout}}

## Sites vitrines

Le conteneur de production d’un site vitrine tourne **toujours** (il ne se met jamais en veille), pour un coût fixe d’environ 6,40 €/mois. `/costs` le mentionne explicitement ; ajustable avec `/scale`.
