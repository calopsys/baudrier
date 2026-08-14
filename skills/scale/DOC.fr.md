# /scale

Change la quantité de ressources allouées à votre application déployée, et si elle reste toujours allumée ou se met en veille quand elle est inactive.

## Quand l'utiliser

- L'application semble lente sous une charge réelle.
- Vous voulez éliminer complètement les temps de démarrage à froid pour une application de production visitée en continu.
- Vous voulez réduire les coûts sur une application peu visitée.

## Les quatre tailles

| Taille | Adaptée à |
|---|---|
| S | Petites applications, faible trafic - la valeur par défaut |
| M | Trafic en croissance, plus de visiteurs simultanés |
| L | Applications très fréquentées |
| XL | Trafic lourd et soutenu |

Chaque taille modifie trois choses ensemble : le CPU, la mémoire, et le nombre de requêtes qu'une seule instance traite en même temps. Ce dernier point compte plus qu'il n'y paraît : plus la taille est petite, plus vite une seule instance est débordée - donc les petites tailles limitent volontairement le nombre de requêtes simultanées : mieux vaut démarrer une deuxième instance un peu tôt que de faire attendre les visiteurs.

## Toujours allumé vs. veille automatique

Indépendamment de la taille, vous choisissez :
- **Veille quand inactif (par défaut)** - coûte presque rien entre deux visites, mais le tout premier visiteur après une période calme attend quelques secondes que l'application se réveille.
- **Toujours allumé** - jamais d'attente, mais vous payez la taille choisie en continu, même la nuit sans aucun visiteur.

## Ce que ça vous montre

Avant de changer quoi que ce soit, l'assistant affiche votre taille actuelle et une estimation de coût en langage simple pour chaque option, calculée à partir des tarifs publiés par Scaleway - pour que vous fassiez un choix informé, pas au hasard.

## Sites vitrines (Astro)

Un site vitrine n’a pas de base de données : la section base de données de cette commande ne s’applique pas à lui. Sa concurrence reste aussi fixée à 80 requêtes par instance quelle que soit la taille - un site statique n’a pas de traitement lourd susceptible de saturer une instance - donc seul le choix CPU/mémoire compte. Son environnement de production démarre aussi toujours allumé (pas de démarrage à froid sur un site public sans back-end) ; l’assistant vous avertit avant de désactiver ça.

## Astuces

{{callout:warning|Les health checks ne réveillent pas une application en veille}}
Si vous voulez une application qui ne démarre jamais à froid sans payer le mode toujours allumé, un moniteur de disponibilité ou un health check ne suffira PAS - les sondes de santé de Scaleway ne comptent pas comme du trafic. La seule chose qui maintient une application mise à zéro instance "au chaud" est une vraie requête programmée (une tâche Serverless Job qui fait un appel HTTP réel à intervalles réguliers).
{{/callout}}
