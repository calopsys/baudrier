# /add-automation

Ajoute une automatisation : un traitement qui tourne en arrière-plan pour votre app, ou une mission récurrente pour vous-même. Tâche planifiée, chaîne intelligente, agent autonome, ou brief IA personnel : Baudrier analyse votre besoin et choisit elle-même la bonne forme.

## Quand l'utiliser

- Vous voulez que quelque chose s'exécute **à heure fixe** (un rapport, un nettoyage, une synchronisation)
- Vous voulez qu'une **chaîne d'étapes** s'exécute automatiquement quand quelque chose se passe (un document arrive, un formulaire est soumis, un paiement arrive) - certaines étapes potentiellement intelligentes
- Vous voulez un **vrai agent IA** qui fait partie de votre produit, décidant lui-même de ses actions
- Vous voulez une **mission récurrente pour vous-même** : un brief du matin, une analyse hebdo, une veille qui vous alerte

Baudrier pose une question ouverte, déduit à qui sert l'automatisation, et vous route vers la bonne commande dédiée : `/add-cron` (tâche planifiée), `/add-workflow` (chaîne intelligente dans votre app), `/add-agent` (agent autonome du produit), ou `/add-routine` (mission récurrente pour vous).

## Comment ça se passe

1. **Discovery (1 question ouverte)** : Baudrier vous demande de décrire votre besoin en quelques phrases : ce que fera cette automatisation, à quel rythme elle doit tourner, et tout ce qui vous semble important.

2. **Première inférence : pour qui ?** Avant tout choix technique, Baudrier détermine à qui profite le résultat :
  - **Votre app ou ses utilisateurs** (nettoyer la base, écrire aux clients, synchroniser des données affichées) → le job part sur l'**infrastructure de l'app elle-même**, pour continuer de tourner quoi qu'il arrive à vos outils personnels.
  - **Vous** (un brief, une analyse, une veille, un rapport pour vos propres yeux) → si le travail demande de l'IA (lire, juger, rédiger), il devient une **routine Claude** : une mission récurrente que votre propre Claude exécute pour vous. Zéro infrastructure, zéro code dans le projet.

   Baudrier le déduit de votre formulation et ne pose la question que si c'est vraiment ambigu (*"un rapport hebdomadaire"*, pour qui ?).

3. **Clarifications ciblées** (max 3 questions, seulement si nécessaire) : Baudrier analyse votre réponse selon quelques dimensions - déclenché par un événement ou par un horaire, une action isolée ou une chaîne de plusieurs étapes, besoin ou non de se souvenir de choses entre deux exécutions.

   Si tout est clair après votre première description, Baudrier ne pose aucune question et passe directement à la recommandation.

4. **Décision automatique** :
  - **Mission IA récurrente pour vous** → **routine Claude** (votre propre Claude l'exécute au bon rythme ; aucune infrastructure)
  - **Tâche planifiée simple pour l'app** → délègue à `/add-cron` (sa propre tâche précisément programmée sur Scaleway, sans limite de taille à surveiller)
  - **Chaîne finie déclenchée par un événement, éventuellement intelligente** → délègue à `/add-workflow` (la chaîne tourne dans votre app, chaque exécution tracée étape par étape ; elle s'agrandit d'elle-même si une exécution est vraiment trop longue)
  - **Un vrai agent IA pour les utilisateurs de votre app** → passe la main à `/add-agent` (agent de production avec plafonds de budget et traçabilité complète)

5. **Mise en place** : Baudrier passe la main à la commande choisie, qui fait sa propre mise en place et vous fait son propre récap - horaire, ce qui a été créé, et comment le gérer par la suite.

## Ce que ça crée pour vous

Rien directement - `/add-automation` est un aiguilleur. Ce qui a été créé est décrit dans le récap de la commande vers laquelle elle vous a orienté (`/add-cron`, `/add-workflow`, `/add-agent`, ou `/add-routine`).

## Prérequis

- Le projet doit être en Next.js (typiquement initialisé par `/bootstrap`)
- Pour une routine Claude : rien d'autre que votre abonnement Claude (la routine tourne sur votre propre compte)

## Astuces

{{callout:info|Votre app ou vous ? La seule frontière qui compte}}
Un job qui sert **votre app** part sur l'infrastructure de l'app elle-même : il doit continuer de tourner même si vous changez d'outils ou résiliez des abonnements. Un job qui sert **vous** peut devenir une **routine** : votre propre Claude l'exécute, sans aucune infrastructure. Deux choses honnêtes sur les routines : chaque exécution consomme un peu de votre abonnement Claude, et si votre abonnement s'arrête, la routine s'arrête avec. C'est exactement pour ça que rien de ce dont votre app dépend ne va JAMAIS sur une routine. Bon à savoir aussi : cadence minimum 1 heure ; les routines cloud tournent même ordinateur éteint, les locales tournent quand l'app Claude est ouverte.
{{/callout}}

{{callout:info|4 formes, 1 commande}}
`/add-automation` est un **orchestrateur** au-dessus des 4 formes d'automatisation : `/add-cron` (tâche planifiée), `/add-workflow` (chaîne intelligente dans l'app), `/add-agent` (agent autonome du produit), `/add-routine` (mission récurrente pour vous). Chaque forme reste invocable en direct ; vous n'avez pas à choisir vous-même : vous décrivez, Baudrier décide et vous explique pourquoi.
{{/callout}}

{{callout:warning|Un cas rare sans solution toute faite}}
Si ce dont vous avez vraiment besoin, c'est un processus qui reste éveillé en permanence et réagit en quelques secondes (une écoute en direct, une connexion persistante), Baudrier vous le dira honnêtement : ce n'est pas une mise en place en une commande aujourd'hui. Elle vous proposera les alternatives les plus proches qui fonctionnent réellement (une tâche planifiée à intervalle rapproché, ou le mode continu d'un agent IA si le processus est piloté par l'IA) plutôt que de forcer silencieusement votre besoin dans une forme qui ne conviendra pas vraiment.
{{/callout}}

## Sites vitrines

Non disponible sur un site vitrine : cette commande est réservée aux applications complètes. Si votre projet est un site vitrine (Astro, sans base de données ni comptes utilisateurs), Baudrier refuse la commande et vous le dit - votre site reste tel quel, et vous pouvez toujours le déployer avec `/deploy`.
