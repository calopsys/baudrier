# /add-blog

Installe un **blog** sur votre site vitrine : une liste d’articles, une page d’article, un flux RSS, une entrée dans le sitemap, et tout ce qui aide les moteurs de recherche et les moteurs de réponse IA à trouver et citer vos articles. À lancer une fois ; `/blogpost` écrit les articles ensuite.

## Quand l’utiliser

- Vous voulez une **section actualités ou blog** sur votre site vitrine
- Vous voulez publier du contenu régulièrement et être trouvé pour ça (SEO/GEO)
- Vous n’avez pas encore installé de blog sur ce projet

## Comment ça se passe

1. **Vérification site vitrine** : cette fonctionnalité ne s’applique qu’à un site vitrine (Astro). Sur une application, Baudrier explique que la fonctionnalité ne s’applique pas et vous renvoie vers votre façon habituelle de discuter puis déployer.

2. **Déjà installé ?** : si un blog existe déjà, Baudrier propose d’écrire un premier article tout de suite, de revérifier et réparer l’installation, ou juste de confirmer que tout est en ordre.

3. **Installation des pièces** : Baudrier ajoute la page de liste d’articles, la page d’article, le flux RSS, et le lien dans le sitemap ; définit l’adresse publique de votre site (`site:`) pour que les liens, le RSS et les balises pour les moteurs de recherche fonctionnent correctement ; et étend votre gabarit de page avec les balises supplémentaires dont un article a besoin (lien canonique, type article, lien RSS) sans changer l’apparence de vos pages existantes.

4. **Un lien "Blog"** : Baudrier propose où ajouter un lien Blog dans votre navigation, et demande avant de toucher quoi que ce soit.

5. **Fichier de preuve pour les moteurs** : Baudrier dépose un petit fichier de preuve, utilisé plus tard par `/blogpost` pour prévenir les moteurs de recherche « un nouvel article est en ligne » au moment de la publication. Ce fichier est public par construction, c’est ainsi que les moteurs confirment que vous êtes propriétaire du site.

6. **Vérification de la construction** : Baudrier vérifie que l’ensemble du site se construit encore correctement avant de terminer.

7. **Enregistrement, pas de mise en ligne** : Baudrier enregistre le blog dans votre projet, mais ne le met **pas** en ligne. La page du blog apparaîtra au prochain déploiement - soit juste après (si vous écrivez un premier article), soit au prochain `/deploy`.

## Ce que ça crée pour vous

- Une **section blog** (`/blog`) prête à recevoir des articles
- Un **flux RSS** (`/rss.xml`) qui se met à jour tout seul à chaque publication
- Des pages pensées pour les moteurs de recherche : liens canoniques, données structurées d’article, étiquettes
- Un **fichier de preuve** permettant à `/blogpost` de prévenir les moteurs de recherche instantanément à la publication

## Prérequis

- Un projet **site vitrine** (Astro) - pas une application
- Idéalement, une adresse publique déjà définie pour le site (un domaine personnalisé via `/add-domain`, ou au moins un premier déploiement pour qu’une adresse de conteneur existe) ; si aucune n’est trouvée, Baudrier vous la demande directement

## Astuces

{{callout:info|Le blog démarre vide, c’est normal}}
Juste après `/add-blog`, la page blog n’a pas encore d’article - elle affiche un court message « aucun article pour l’instant ». C’est normal : cette skill construit uniquement la mécanique. Lancez `/blogpost` pour écrire votre premier article.
{{/callout}}

{{callout:tip|Modifier ou retirer un article n’est pas une skill}}
`/blogpost` sert uniquement à **créer** de nouveaux articles. Pour changer ou supprimer un article déjà publié, dites simplement à Baudrier ce que vous voulez changer en discussion, comme pour n’importe quelle autre page, puis demandez `/deploy`. Il n’y a pas de skill séparée pour ça.
{{/callout}}

## Sites vitrines uniquement

`/add-blog` et `/blogpost` sont les deux skills réservées à un site vitrine ; elles refusent sur un projet application avec une explication claire, et votre application reste entièrement utilisable via la discussion habituelle et `/deploy`.
