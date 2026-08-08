# /publish

Rend votre application accessible à n'importe qui sur internet, plus seulement depuis le VPN du bureau.

## Quand l'utiliser

- Quand vous êtes prêt à ce que de vrais visiteurs voient le site.
- Avant de lancer `seo-perf`, `eco-audit`, ou `gsc` - ces trois outils ont besoin que Google puisse réellement charger votre site, ce qui n'est pas possible tant qu'il est restreint au VPN.

## Ce que ça fait

Par défaut, chaque application construite avec ce harnais ne répond qu'aux requêtes venant du VPN du bureau - un filet de sécurité simple et honnête pour éviter de montrer accidentellement un travail inachevé au monde entier. `/publish` désactive cette restriction pour l'environnement de votre choix (production ou un aperçu), rendant le site accessible à quiconque possède le lien.

L'assistant affiche toujours un avertissement clair et vous demande de confirmer avant de faire ce changement - ce n'est pas quelque chose qui arrive par accident.

## Ce qui se passe

1. Vous confirmez quel environnement publier (production ou un aperçu) et confirmez l'avertissement.
2. La restriction d'accès est levée et le site est redéployé avec le nouveau réglage.
3. L'assistant vérifie que le changement a bien pris effet et vous donne l'URL en ligne, désormais publique.

## Annuler

Lancez `/unpublish` à tout moment pour rétablir la restriction VPN.

## Astuces

{{callout:warning|Ce n'est pas un pare-feu}}
La restriction d'accès (activée ou non) est une vérification au niveau de l'application, pas un filtrage réseau. La réactiver avec `/unpublish` est une bonne pratique par défaut pour un travail inachevé, mais considérez-la comme une barrière de courtoisie, pas une sécurité étanche.
{{/callout}}

{{callout:info|Pourquoi certains outils en ont besoin}}
`seo-perf`, `eco-audit` et `gsc` fonctionnent tous en faisant charger votre site par un service externe (généralement Google). Si le site ne répond qu'au trafic VPN, ces chargements échouent ou donnent des résultats faussés - publier d'abord évite ce problème.
{{/callout}}
