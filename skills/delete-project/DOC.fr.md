# /delete-project

Supprime proprement et définitivement l'infrastructure Scaleway **jetable** d'un projet Baudrier. Avant toute action, un gros avertissement et une double confirmation, car l'opération est **irréversible** pour ce qu'elle supprime réellement.

**Cette skill ne supprime jamais ta base de données, ton bucket de stockage de fichiers, ni le Project Scaleway lui-même.** C'est une limite volontaire, câblée en dur - pas une case à cocher. Voir ci-dessous.

## Quand l'utiliser

- Tu abandonnes un projet (test, prototype, app obsolète) et tu veux tout nettoyer plutôt que laisser de l'infrastructure tourner.
- Tu veux arrêter de payer pour un projet dont tu n'as plus besoin.
- Tu veux décommissionner complètement une app (fin de mission, départ d'un client, refonte complète).

## Comment ça marche

**Phase 1 - Identification + gros avertissement.** L'assistant demande le nom exact du projet (s'il n'est pas déjà donné), affiche un avertissement complet listant ce qui sera supprimé **et, tout aussi visiblement, ce qui ne le sera jamais** (base de données, stockage, le Project lui-même), propose de faire une sauvegarde du code/de la config d'abord, puis demande deux confirmations séparées - la deuxième nécessite de retaper le nom exact du projet.

**Phase 2 - Inventaire complet.** Comme Baudrier garde un Scaleway Project dédié par app, l'assistant résout ce Project et liste tout ce qu'il contient en une passe : le site déployé (container) et son domaine personnalisé, le registre des images de build, les tâches planifiées (migrations, agents, tâches cron), les secrets stockés, les accès techniques (IAM) créés pour l'app, le domaine d'envoi d'emails, les entrées DNS ajoutées pour lui, la propre mémoire de travail de l'assistant sur le projet, et le dépôt GitHub. Il retrouve aussi la base de données et le bucket de stockage de fichiers - **uniquement pour pouvoir les nommer dans le rapport final**, jamais pour les supprimer - et scanne les variables d'environnement pour signaler tout service tiers que tu as connecté toi-même (Sentry, OpenAI, Mapbox, etc.) que Baudrier ne peut pas supprimer à ta place.

**Phase 3 - Choix du périmètre.** Tu reçois un récap clair en sections, en commençant par ce qui est définitivement conservé (base de données, stockage, le Project), puis ce qui peut être supprimé automatiquement, les services tiers à gérer toi-même (avec l'URL exacte et les instructions pour chacun), les actions manuelles que toi seul peux faire (supprimer le dossier local), et le reste laissé volontairement de côté. Tu choisis de tout supprimer dans la liste jetable ou de garder certaines pièces (par exemple les entrées DNS) - rien ne s'exécute avant validation.

**Phase 4 - Exécution + rapport.** Tout ce qui est approuvé est supprimé, en parallèle quand c'est sûr. Le rapport commence par un rappel bien visible, jamais escamoté, de ce qui a été volontairement laissé en place - nom(s) exact(s) de la base, du bucket, du Project Scaleway - chacun avec un lien vers la console Scaleway, au cas où tu voudrais le supprimer toi-même à la main.

## Ce que ça fait pour toi

- Supprime l'infrastructure Scaleway automatisable et jetable du projet en une seule passe.
- Détecte de façon proactive les services tiers que tu as connectés toi-même, avec des instructions de nettoyage précises pour chacun.
- Garantit qu'aucune ressource Scaleway ne reste orpheline parmi ce qu'elle supprime - y compris les accès techniques, faciles à oublier et qui comptent dans les plafonds du compte.
- Ne touche jamais à un projet frère qui partage une partie de son nom.
- **Ne détruit jamais tes données.** La base de données, le bucket de stockage (et tout son contenu), et le Project Scaleway qui les contient restent toujours en place - nommés explicitement dans le rapport final, avec des liens console, pour que tu saches toujours exactement ce qui existe encore et comment y accéder toi-même.

## Prérequis

- Le projet doit être un projet Baudrier (créé via `/bootstrap`), avec son propre Scaleway Project.
- Les identifiants Scaleway doivent être configurés (`/start` s'en charge).

## Astuces

{{callout:warning|Ce qui EST supprimé l'est strictement irréversiblement}}
Une fois lancée, l'infrastructure jetable listée dans le récap (container, registre, jobs, secrets, IAM, entrées DNS, domaine email, dépôt GitHub) ne peut pas être récupérée. Si quelque chose là-dedans compte pour toi (code, configuration), fais d'abord une sauvegarde - la skill te le propose avant la double confirmation.
{{/callout}}

{{callout:info|Ta base de données et ton stockage de fichiers ne sont jamais supprimés}}
C'est une limite câblée dans le script de suppression lui-même, pas une case à cocher : `/delete-project` n'a aucun chemin de code capable de supprimer une base de données ou un bucket (ou de le vider). Le Project Scaleway qui les contient n'est pas non plus supprimé - le supprimer ferait disparaître tout ce qu'il contient encore, tes données comprises. Le rapport final nomme toujours exactement ce qui a été laissé en place et donne le lien console correspondant, pour que TOI (un humain) puisses le supprimer toi-même si tu en es certain.
{{/callout}}

{{callout:info|La sauvegarde avant suppression n'inclut pas la base}}
La machine de l'opérateur n'a pas d'accès direct à la base de données (voir la documentation de `/save-project` pour comprendre pourquoi), donc l'instantané optionnel proposé avant suppression ne contient pas la base - même si, la base n'étant jamais supprimée par cette skill, ça pose rarement problème en pratique.
{{/callout}}

{{callout:info|Tu gardes le contrôle de ce qui est supprimé}}
À l'étape du périmètre, tu n'es pas obligé de tout supprimer d'un coup - tu peux par exemple garder les entrées DNS pour réutiliser le domaine sur un nouveau projet.
{{/callout}}

{{callout:info|Le dossier local reste sous ta responsabilité}}
Pour ta sécurité, l'assistant ne supprime jamais le dossier de code du projet sur ton ordinateur. À la fin, tu reçois le chemin exact à ouvrir dans ton explorateur de fichiers.
{{/callout}}
