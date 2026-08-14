# /add-cron

Ajoute une tâche qui s'exécute automatiquement à heure fixe dans votre projet. Idéal pour un envoi de newsletter chaque nuit, un nettoyage hebdomadaire, ou un rapport mensuel.

## Quand l'utiliser

- Envoyer une **newsletter quotidienne** à heure fixe
- **Nettoyer** la base de données la nuit (supprimer des fichiers temporaires, des sessions expirées…)
- **Synchroniser** vos données avec une API externe toutes les heures
- Générer un **rapport hebdomadaire** automatique
- **Empêcher votre site de s'endormir** entre deux visiteurs

## Comment ça se passe

1. **Description de la tâche** : vous décrivez en une phrase ce que doit faire la tâche (ex : *"envoyer un rapport SEO hebdomadaire par email"*, *"réinitialiser les compteurs d'usage à minuit"*).

2. **Quand l'exécuter** : vous indiquez l'horaire en langage naturel (*"tous les jours à 9h"*, *"chaque lundi matin"*, *"toutes les heures"*). Baudrier le garde dans votre propre fuseau horaire - aucune conversion cachée.

3. **Nom court** : vous donnez un nom kebab-case pour la tâche (`rapport-hebdo`, `sync-clients`, `nettoyage`).

4. **Décision automatique** : Baudrier décide elle-même où doit vivre la logique de la tâche (vous n'avez aucun choix à faire) :
  - **Dans votre app** (le défaut, pour presque tout) : la tâche peut lire et écrire vos données, envoyer des emails, et réutiliser tout ce qui est déjà codé dans votre site.
  - **Une visite "réveil"** (rare) : si tout ce que vous voulez, c'est empêcher votre site de s'endormir entre deux visiteurs, puisque seule une vraie visite - pas une simple vérification automatique - le maintient éveillé.
  - **Un signal direct vers un autre service** (rare) : si la tâche consiste juste à "prévenir cette autre adresse à heure fixe", sans rien à traiter.

5. **Configuration automatique** : Baudrier crée une petite tâche planifiée sur l'infrastructure Scaleway (un "Job" avec sa propre horloge précise, un vrai fuseau horaire, sans place partagée ou limitée), le fichier protégé où vivra votre logique si besoin, et la clé `CRON_SECRET` (générée si manquante).

6. **Récap** : Baudrier vous explique en une phrase **ce qu'elle a mis en place et pourquoi**.

7. **À vous de coder la logique** (quand c'est pertinent) : la tâche est en place mais ne fait rien encore. Baudrier a préparé le fichier où vous (ou Claude) écrirez ce qu'elle doit exécuter.

## Ce que ça crée pour vous

- Une **tâche planifiée** sur Scaleway, précise, sur votre propre fuseau horaire, sans limite sur le nombre que vous pouvez avoir
- Pour la plupart des tâches : une **route protégée** `/api/cron/<nom>` dans votre app (sécurisée par une clé privée) où vit la logique
- La clé `CRON_SECRET` dans `.env` + la configuration de votre site
- Mise à jour de `CLAUDE.md` avec le récap de la tâche

## Prérequis

- Le projet doit être en Next.js, déployé sur Scaleway (typiquement via `/bootstrap` puis `/deploy`)
- Si votre site n'a pas encore été mis en ligne, Baudrier prépare tout et termine d'activer l'horaire dès que vous lui dites que votre premier déploiement est fait

## Astuces

{{callout:tip|Vous pouvez piloter en langage naturel}}
Une fois la tâche en place, dites simplement à Baudrier :
- *"lance la tâche tout de suite pour tester"*, déclenchement manuel
- *"change l'horaire pour 10h"*, modification du cron
- *"supprime cette tâche"*, suppression complète

Vous n'avez **rien** à taper dans un terminal.
{{/callout}}

{{callout:info|Une tâche, une horloge précise}}
Chaque tâche planifiée obtient son propre petit mécanisme dédié sur l'infrastructure Scaleway, avec un vrai fuseau horaire et sans limite sur le nombre que vous pouvez ajouter - contrairement à d'autres plateformes, il n'y a aucun goulot d'étranglement partagé à gérer, ni rien à migrer plus tard si vous ajoutez des tâches.
{{/callout}}

{{callout:warning|Mauvais candidat pour /add-cron}}
Si votre besoin est un **processus continu** qui doit rester actif entre deux exécutions (une écoute en direct, un consommateur de file d'attente), c'est `/add-automation` qu'il faut lancer à la place (pas `/add-cron`). Baudrier détecte ce cas et vous redirige automatiquement.
{{/callout}}

## Sites vitrines

Non disponible sur un site vitrine : cette commande est réservée aux applications complètes. Si votre projet est un site vitrine (Astro, sans base de données ni comptes utilisateurs), Baudrier refuse la commande et vous le dit - votre site reste tel quel, et vous pouvez toujours le déployer avec `/deploy`.
