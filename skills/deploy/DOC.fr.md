# /deploy

Déploie votre projet sur Scaleway. C'est la **seule** façon dont le harnais met du code en ligne - il n'y a pas de Docker à installer sur votre machine, rien à configurer pour que ça marche.

## Quand l'utiliser

- Dès que vous voulez que vos derniers changements soient en ligne sur le site public.
- Dès que vous voulez un aperçu privé d’une branche, avant qu’elle rejoigne `main`.

## Comment ça se passe

1. **L’assistant vérifie d’abord si votre site est déjà publié.** S’il ne l’est pas encore, une seule confirmation suffit avant la mise en ligne, car un site non publié n’est déjà visible que par vous. S’il est déjà publié, l’assistant propose un aperçu privé d’abord, ou la mise en production directe - car un déploiement accidentel en production serait coûteux. Vous avez le même choix sur n’importe quelle branche, et votre réponse décide aussi si cette branche rejoint `main`.
2. **Votre code est committé et poussé** si vous aviez des changements non enregistrés.
3. **L’assistant construit lui-même l’image du conteneur**, directement sur cette machine, à partir de votre commit, puis l’envoie sur le registre d’images de Scaleway. GitHub n’intervient pas dans cette construction. L’assistant attend, en affichant la progression (une construction « à froid » peut prendre quelques minutes).
4. **Les migrations de base de données s'exécutent d'abord, à part**, comme une tâche unique sur la nouvelle image - jamais dans l'application en cours d'exécution. Si une migration échoue, rien d'autre ne se passe : votre site actuellement en ligne continue de tourner sans être touché.
5. **Le conteneur en ligne est mis à jour** vers la nouvelle image, et l'assistant attend qu'il redevienne en bonne santé.
6. **Si votre projet contient un agent IA** (créé plus tôt avec `/add-agent`), sa tâche planifiée sur Scaleway est créée ou mise à jour aussi, sur la même image fraîchement construite.
7. **Une vraie requête est envoyée vers l'URL en ligne** pour confirmer que ça fonctionne réellement (HTTP 200 et le style de la page se charge) - pas seulement que le déploiement a "réussi" sur le papier.
8. **Les anciennes images du conteneur sont nettoyées** pour que le coût de stockage n'augmente pas indéfiniment.

## Aperçu privé vs. production

Ce choix décide aussi d’une autre chose : ce qui rejoint la ligne principale du projet.

- **Un site non publié est déjà privé.** Seule votre propre adresse peut le voir. Le déployer en production ne change rien à cela : ce déploiement est déjà votre revue privée.
- **Un site déjà publié** est vu par de vrais utilisateurs. Avant d’y toucher, l’assistant propose un aperçu privé sur une adresse séparée, réservée à vous, pour que vous validiez vos changements en premier.
- **Choisir la production fusionne aussi votre branche dans `main`** si vous travaillez sur une autre branche. L’assistant fait cette fusion avant de mettre le site en ligne. En cas de conflit, rien n’est mis en ligne, et l’assistant vous explique le conflit.
- **Choisir l’aperçu privé laisse votre travail sur sa propre branche.** Rien n’est fusionné dans `main`. L’assistant pousse la branche sur GitHub ; ouvrez ensuite vous-même la pull request depuis l’interface web de Claude Code.
- **La production part toujours de `main`.** C’est pour cela que la choisir fusionne d’abord votre branche. C’est le site public que voient vos utilisateurs.

## Ce que vous obtenez à la fin

- L'URL en ligne, confirmée fonctionnelle.
- Une liste claire de ce qui s'est passé, en langage simple.
- Si quelque chose échoue, une explication précise de l'étape en cause et de ce qu'il est sûr de faire ensuite - votre site de production n'est jamais laissé dans un état cassé par un déploiement raté.

## Astuces

{{callout:tip|Environnements par branche}}
Chaque branche que vous prévisualisez reçoit sa propre adresse, isolée de la production. Pour une application avec base de données, cette isolation a un prix : chaque branche ainsi prévisualisée garde sa propre base de données Serverless SQL, et le harnais ne supprime jamais une base - la retirer est une opération manuelle dans la console Scaleway. Un site vitrine n’a pas de base de données du tout, donc son aperçu n’est qu’un seul conteneur au repos, à coût quasi nul. Dans tous les cas, préférez une seule branche de revue à plusieurs branches éphémères.
{{/callout}}

{{callout:info|Pourquoi les migrations tournent à part}}
Exécuter les migrations de base de données au démarrage de l'application est risqué ici : plusieurs conteneurs peuvent démarrer en même temps, et rien n'empêche qu'ils exécutent la même migration en même temps. Exécuter les migrations comme une tâche unique, avant même que l'application soit mise à jour, évite complètement ce problème.
{{/callout}}

{{callout:warning|Changements non enregistrés}}
Si vous avez des changements locaux non enregistrés au moment de lancer `/deploy`, ils sont committés automatiquement dans le cadre du processus. Assurez-vous d'être satisfait du contenu de votre dossier de travail avant de déployer. Si vous choisissez la production depuis une autre branche, cette branche est aussi fusionnée dans `main` avant la mise en ligne.
{{/callout}}
