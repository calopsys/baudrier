# /blogpost

Écrit un **article de blog** à partir de votre description, en français, et le fait passer par un aperçu privé avant qu’il n’atteigne votre site public. Donnez un sujet ; Baudrier s’occupe de la rédaction, de la structure, et des détails de référencement.

## Quand l’utiliser

- Vous voulez **publier un nouvel article** sur le blog de votre site vitrine
- `/add-blog` a déjà installé le blog sur ce projet

## Comment ça se passe

1. **Vérifications préalables** : Baudrier vérifie que le blog est installé (propose `/add-blog` sinon), et vérifie si d’autres changements ou un article déjà en attente traînent, pour qu’il n’y ait pas de surprise plus tard.

2. **Récupération du sujet** : vous décrivez de quoi parle l’article. Baudrier propose quelques étiquettes (tags), et demande si vous avez une image de couverture (facultatif - pas d’image donne un article parfaitement normal, Baudrier n’invente jamais une photo de banque d’images).

3. **Rédaction** : Baudrier écrit l’article - titre, courte description, et un texte français structuré (environ 600 à 1200 mots, organisé en sections) - sur une branche de révision séparée, sans jamais toucher votre site public pour l’instant.

4. **Votre validation, toujours** : Baudrier affiche le **texte complet de l’article** dans la discussion. Rien n’avance tant que vous ne l’avez pas validé, tel quel ou après les changements que vous avez demandés.

5. **Aperçu privé** : une fois validé, Baudrier déploie un aperçu privé - une adresse séparée, joignable uniquement depuis un endroit déjà autorisé (le VPN de votre entreprise, par défaut), quel que soit l’état du site public - pour que vous voyiez la vraie page, avec son style, avant tout le monde.

6. **Votre verdict** : vous choisissez de le publier pour de vrai, de demander encore des modifications, ou de le laisser en attente (rien n’est perdu, vous pouvez reprendre quand vous voulez).

7. **Publication** : si vous publiez, Baudrier déploie l’article sur votre vrai site, public.

8. **Prévenir les moteurs de recherche** : une fois public, Baudrier prévient les moteurs qui supportent la notification instantanée (Bing et quelques autres) que l’article existe, pour qu’il soit trouvé plus vite - étape sautée automatiquement si votre site est encore restreint.

## Ce que ça crée pour vous

- Un nouvel **article**, écrit et structuré pour vous
- Un **flux RSS** et un **sitemap** mis à jour, automatiquement
- Un **aperçu privé** pour vérifier avant que quiconque d’autre ne le voie
- Un départ plus rapide pour être trouvé par les moteurs de recherche, quand c’est possible

## Prérequis

- Un **site vitrine** avec le blog installé (`/add-blog`)
- Rien d’autre - Baudrier gère la rédaction, la branche de révision, et les deux déploiements

## Astuces

{{callout:warning|Cette skill ne fait que créer}}
`/blogpost` ne touche jamais à un article déjà publié. Pour changer un mot, corriger une coquille, ou retirer un ancien article, demandez simplement à Baudrier directement en discussion, puis demandez `/deploy` - comme vous le feriez pour n’importe quelle autre page de votre site.
{{/callout}}

{{callout:info|Deux déploiements, deux coûts différents}}
Publier un article passe toujours par un aperçu privé d’abord, puis la production - deux déploiements courts, quelques minutes chacun. L’aperçu lui-même coûte quasiment rien tant qu’il n’est pas visité : il redescend à zéro entre deux consultations.
{{/callout}}

{{callout:tip|L’état « en attente » n’est pas une perte}}
Si vous laissez un article en attente après l’aperçu, il reste enregistré sur la branche de révision interne de Baudrier. Rien ne disparaît - revenez avec `/blogpost` quand vous êtes prêt à le terminer.
{{/callout}}

## Sites vitrines uniquement

`/add-blog` et `/blogpost` sont les deux skills réservées à un site vitrine ; sur un projet application, elles refusent avec une explication claire, et votre application reste entièrement utilisable via la discussion habituelle et `/deploy`.
