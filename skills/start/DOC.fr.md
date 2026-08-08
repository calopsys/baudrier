# /start

Prépare votre environnement Claude Code web pour qu’il puisse créer des applications avec Baudrier.

## Quand l’utiliser

C’est la **toute première commande** à lancer juste après avoir ouvert un environnement cloud « Baudrier » sur Claude Code web (claude.ai/code). Elle vérifie chaque prérequis et vous guide en cas de configuration Scaleway manquante. Vous ne devriez avoir à la lancer qu’une seule fois par environnement.

## Comment ça se passe

1. **Vérification de l’environnement** : la commande vérifie qu’elle tourne bien sur Claude Code web. Baudrier n’a plus de chemin d’installation locale : sur toute autre session, elle s’arrête immédiatement et vous renvoie au chapitre Installation du README, plutôt que de démarrer à moitié.
2. **Dépendances internes** : Baudrier vérifie les librairies qui lui permettent de dialoguer avec votre hébergeur. Le script de configuration de l’environnement cloud les installe normalement à la construction ; un échec ici signifie qu’une vraie réparation est nécessaire - Baudrier rejoue alors ce script pour vous.
3. **Accès au dépôt** : confirme que cette session peut atteindre le dépôt GitHub sur lequel elle a été ouverte.
4. **Signature de votre code** : Git a besoin de savoir qui signe les enregistrements de votre code, sinon il refuse d’en créer un seul. Baudrier reprend votre nom depuis le propriétaire du dépôt et vous propose une adresse de redirection GitHub : vos contributions restent rattachées à votre compte, mais votre adresse personnelle n’apparaît jamais dans l’historique public. Une seule confirmation, et c’est réglé pour tous vos projets.
5. **Identifiants et droits Scaleway** : vérifie que les quatre variables d’environnement requises sont présentes, les valide par un vrai appel API, puis vérifie si votre compte peut créer des Projets Scaleway. Si ce n’est pas le cas, Baudrier explique les deux façons de continuer : recréer la clé vous-même (administrateur d’organisation), ou pointer vers un Projet existant et laisser votre administrateur gérer le reste (membre d’organisation).
6. **Accès réseau** : confirme que l’accès réseau de l’environnement atteint bien l’API Scaleway.
7. **Docker et audit des outils** : confirme que Docker répond et que tous les outils que l’environnement devait installer sont vraiment prêts. Sinon, Baudrier recommande de reconstruire l’environnement cloud plutôt que de réparer les outils un par un.
8. **Vérification d’identité (optionnelle)** : Baudrier explique pourquoi vérifier votre identité chez Scaleway est utile (plafonds plus hauts pour les emails, le stockage, les conteneurs) et propose d’ouvrir la page - entièrement optionnel, jamais bloquant.
9. **Récap final et conclusion** : un tour d’horizon de ce que vous pouvez faire ensuite (`/bootstrap`, `/prof`, etc.).

## Ce que ça crée pour vous

- Les librairies internes de Baudrier installées et vérifiées
- Un accès confirmé à votre dépôt GitHub
- Une identité de signature git, pour que chaque enregistrement de votre travail vous soit attribué sans exposer votre adresse personnelle
- Des identifiants Scaleway confirmés, avec un chemin clair si votre compte n’a pas les droits au niveau de l’organisation
- Docker et les outils confirmés prêts dans l’environnement cloud
- Une liste des commandes que vous pouvez maintenant utiliser

## Prérequis

Un environnement cloud « Baudrier » déjà créé et actif sur Claude Code web, avec les variables d’environnement Scaleway renseignées - voir le chapitre Installation du README.

{{callout:info|Pourquoi si peu d’outils}}
Ce plugin repose entièrement sur Scaleway : un seul hébergeur pour tout (l’app, la base de données, le stockage, les emails, le registre de conteneurs, les secrets). Le script de configuration de l’environnement cloud préinstalle exactement ce que ça demande - Node.js, Git, pnpm et Docker. `/start` n’a plus qu’à les vérifier, ainsi que votre connexion GitHub et vos identifiants Scaleway.
{{/callout}}

{{callout:tip|Si quelque chose se passe mal}}
Aucun problème : relancez simplement `/start`. La commande détecte ce qui est déjà OK et reprend là où ça s’était arrêté. Pas de risque de tout casser.
{{/callout}}

{{callout:info|Installer sur Claude Code web}}
Le guide complet pas à pas est le chapitre Installation du README : création de votre clé API Scaleway, connexion de GitHub, et création de l’environnement cloud « Baudrier ».
{{/callout}}
