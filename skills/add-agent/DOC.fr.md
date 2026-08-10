# /add-agent

Crée un agent IA autonome qui tourne dans votre projet et décide tout seul des actions à mener. Idéal pour lire des emails, résumer des articles, surveiller un flux, ou tout workflow qui demande de la compréhension plutôt que des étapes prédéfinies.

## Quand l'utiliser

- Vous voulez un assistant qui lit vos emails support et propose des réponses en brouillon
- Vous voulez un agent qui agrège chaque matin les news de plusieurs flux RSS et vous envoie un brief
- Vous voulez surveiller une file d'événements (commandes, alertes, signaux) et déclencher des actions intelligentes
- Vous voulez automatiser un workflow qui demande de la **compréhension** : lire un texte, le résumer, le classer, écrire une réponse personnalisée

**Bon à savoir** : quand la mission est en réalité personnelle (un brief ou un digest **pour vous**, à cadence fixe), Baudrier vous propose d'abord un chemin beaucoup plus léger, une **routine** sur votre propre compte Claude, au lieu de monter l'agent complet (voir plus bas).

**Pas adapté pour** : un chatbot temps-réel sur votre site (UI conversationnelle utilisateur), un cron simple sans IA, un traitement non-IA. Baudrier vous redirige automatiquement vers la bonne commande si elle détecte un décalage.

## Comment ça se passe

1. **Vérifications** : Baudrier vérifie que vous avez une base de données (pour stocker l'historique de l'agent) et un envoi d'emails configuré (pour les notifications). Sinon, elle vous propose de lancer `/add-db` et/ou `/add-email` d'abord.

2. **Discovery (5 questions max, en français simple)** :
  - **Q1** : Quel est le but de l'agent ? (en une phrase, exemples concrets)
  - **Q2** : Quand l'agent doit-il s'exécuter ? (à heure fixe / en continu / à la demande). Si à heure fixe, on précise le rythme.
  - **Q3** : Doit-il **se souvenir** entre ses exécutions ? (mémoire clé-valeur simple, ou mémoire sémantique, ou aucune mémoire)
  - **Q4** : Quel modèle ? (un modèle Scaleway Generative APIs équilibré par défaut ; un plus gros pour les tâches complexes)
  - **Q5** : Quel plafond de coût ? (par défaut : 1 EUR/jour, 10 EUR/mois, l'agent se met en pause s'il dépasse, et vous prévient par email)

3. **Le raccourci routine** : juste après la question du but, Baudrier regarde À QUI sert la mission. Si le résultat est pour **vous** (un brief du matin, un digest hebdo, un rapport de veille) et qu'elle tourne à heures fixes (toutes les heures ou moins souvent), elle vous propose une **routine** à la place : votre propre Claude exécute la mission au bon moment, zéro infrastructure, zéro code, prête en 2 minutes. L'agent complet reste le bon choix quand l'agent sert **les utilisateurs de votre app**, doit surveiller quelque chose **en continu**, ou doit être déclenché depuis un dashboard avec des logs d'exécution détaillés et auditables. Vous choisissez, Baudrier fait le reste.

4. **Conversion en monorepo si nécessaire** : pour héberger l'agent à côté de votre Next.js, Baudrier convertit votre projet en Turborepo (idempotent).

5. **Scaffolding** :
  - L'agent vit dans son propre dossier sous `apps/` (nommé d'après votre agent), déployable comme **Job Serverless Scaleway**
  - Boucle agentique propre sur **Scaleway Generative APIs** (compatible OpenAI)
  - Outils par défaut : `http-fetch` (lire des URLs), `send-email` (vous écrire), `db-query` (lire la DB en SELECT uniquement)
  - Plus d'autres outils selon le but
  - Si mémoire activée : tables `agent_memory_kv` (clé-valeur) ou `agent_memory_vector` (recherche sémantique, avec les mêmes identifiants Scaleway - pas de nouveau fournisseur)
  - **Circuit breaker** automatique : suit le coût en temps réel (EUR), met l'agent en pause si plafond dépassé, vous prévient par email
  - **Persistance complète** : chaque exécution + chaque tour de décision est sauvegardé en base pour audit
  - Ses propres clés API Scaleway, à portée réduite et créées automatiquement - rien à créer ni à coller

6. **Déploiement via `/deploy`** : les Jobs Serverless Scaleway sont entièrement pilotables par API, donc aucune manip manuelle dans un dashboard. `/deploy` construit l'image, applique la migration de base de données, et crée/met à jour le Job de l'agent automatiquement.

7. **Dashboard optionnel** : Baudrier vous propose ensuite d'ajouter `/admin/agents`, un dashboard pour suivre vos agents (`/add-agent-dashboard`).

## Ce que ça crée pour vous

- Un projet Turborepo si pas déjà (avec `apps/web/` + le dossier de votre agent sous `apps/`)
- Un agent IA complet : boucle agentique, outils, mémoire optionnelle, circuit breaker, persistance
- Tables en base : `agent_invocations`, `agent_turns`, `agent_memory_kv`, `agent_trigger_queue` (+ `agent_memory_vector` si mémoire sémantique) - appliquées via une migration à votre prochain `/deploy`
- Ses propres clés API Scaleway à portée réduite dans Secret Manager (`SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`)
- `apps/<name>/job-definition.json`, la spec déclarative du Job Serverless Scaleway utilisée par `/deploy`
- Le **schéma d'architecture** mis à jour dans `CLAUDE.md`

(Si vous avez choisi le raccourci routine, rien de tout ça n'est créé : vous obtenez une mission récurrente sur votre propre compte Claude, plus une note dans `CLAUDE.md`.)

## Prérequis

- Le projet doit être en Next.js (typiquement initialisé par `/bootstrap`)
- Base de données configurée (`/add-db`)
- Envoi d'emails configuré (`/add-email`), sinon l'agent ne peut pas vous alerter en cas de panne
- Les quatre variables `SCW_*` renseignées dans votre environnement cloud « Baudrier » - l’agent crée ses propres clés à portée réduite à partir de là, rien d’autre à créer

## Astuces

{{callout:tip|Un brief pour vous-même ? Une routine suffit}}
Si le but est une mission planifiée dont le résultat est pour **vous** (brief du matin, digest hebdo, rapport de veille), pas besoin de Job, de tables en base ni de dashboard : une **routine** sur votre propre compte Claude fait le travail avec zéro infrastructure. Contrepartie honnête : elle consomme un peu de votre abonnement Claude et s'arrête si l'abonnement s'arrête. Très bien pour une mission personnelle, jamais acceptable pour quelque chose dont votre app dépend : ces cas-là gardent la machinerie complète de l'agent.
{{/callout}}

{{callout:warning|Le circuit breaker est votre meilleur ami}}
Par défaut, l'agent s'arrête automatiquement s'il dépasse **1 EUR/jour ou 10 EUR/mois**. C'est crucial : un agent qui boucle peut consommer rapidement. Vous recevez un email d'alerte, et vous pouvez décider de relever le plafond ou de creuser le bug. **Ne désactivez jamais le circuit breaker.**
{{/callout}}

{{callout:tip|Mémoire = facultative mais puissante}}
- **KV (clé-valeur)** : pour des données simples (préférences utilisateur, dernier ID traité, compteurs). Rapide, lookup direct.
- **Sémantique (vector)** : pour des connaissances en texte libre que l'agent peut chercher par sens (notes, articles, conversations). Plus coûteux mais bien plus puissant. Utilise les mêmes identifiants Scaleway que le reste de l'agent - pas de nouveau fournisseur, pas de nouvelle clé.
- **Aucune mémoire** : l'agent repart à zéro à chaque exécution. Suffisant pour beaucoup de cas (digests quotidiens, etc.).
{{/callout}}

{{callout:info|Audit complet par défaut}}
Chaque exécution de l'agent est tracée dans la base : prompt initial, chaque tour de raisonnement (texte généré, outils utilisés, résultats), coût en EUR, durée. Vous pouvez tout rejouer / revoir depuis le dashboard `/admin/agents` (skill `/add-agent-dashboard`). Indispensable pour comprendre ce que fait votre agent et le déboguer.
{{/callout}}

{{callout:info|Des exécutions par rafales, pas un serveur toujours allumé}}
Un Job Serverless Scaleway tourne par rafales, pas en permanence. Selon comment vous déclenchez l'agent, un clic "Lancer maintenant" ou même une exécution planifiée peut prendre quelques minutes à être pris en compte plutôt que quelques secondes - la contrepartie d'une facturation proche de zéro entre les exécutions. Baudrier vous donne le compromis exact pour votre déclencheur au moment de la configuration.
{{/callout}}
