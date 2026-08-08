# /spec

Construit avec vous un **cahier des charges** structuré pour votre projet, question par question, sans jargon.

## Quand l'utiliser

- Avant un `/bootstrap` quand vous voulez prendre le temps de clarifier ce que vous voulez vraiment construire
- À tout moment pour clarifier un nouveau projet, même si vous ne le lancerez pas tout de suite
- Quand vous avez plein d'idées en vrac et que vous voulez les structurer avant de coder

Le cahier des charges qu'on en tire est un fichier `.md` lisible que `/bootstrap` peut consommer ensuite.

## Comment ça se passe

Baudrier vous guide en **4 blocs** courts. À chaque bloc, vous répondez aux questions à votre rythme, Baudrier résume ce qu'elle a compris, et on passe au suivant.

**Bloc 1 : Identité du projet**
- À qui s'adresse l'app (clients, équipe, grand public, vous-même) ?
- Quel problème elle résout ?
- Vous inspirez-vous d'un site ou d'une app existant pour l'ambiance ?

**Bloc 2 : Les pages**
- Quelles pages votre app doit avoir ? (Baudrier propose une base type "accueil, à propos, contact, dashboard" que vous adaptez.)
- Pour chaque page, que voit l'utilisateur ? Quelles actions peut-il faire ?
- Y a-t-il un espace admin ou réservé ?

**Bloc 3 : Le design**
- Quelle ambiance visuelle ? Plusieurs options sont proposées : moderne et épuré, sombre et élégant, coloré et dynamique, corporate, ou autre.
- Avez-vous des couleurs en tête ?
- Un site que vous trouvez beau et qu'on peut prendre comme référence ?

**Bloc 4 : Contenu et détails**
- Vous avez déjà rédigé des textes, ou on met du contenu placeholder à remplacer après ?
- Quelque chose qu'on n'a pas couvert ? (Une intégration spécifique, un outil que vous voulez absolument utiliser, une contrainte particulière.)

À la fin, Baudrier écrit le fichier `cahier-des-charges.md` dans votre dossier de projet et vous le montre pour validation. Vous pouvez encore le modifier avant qu'il soit utilisé.

## Ce que ça crée pour vous

- Un fichier `cahier-des-charges.md` clair et structuré, prêt à être consommé par `/bootstrap`
- Une trace écrite de votre vision du projet (utile pour vous, pour d'autres, pour vous-même dans 6 mois)
- Baudrier en profite aussi pour déduire silencieusement les briques techniques nécessaires (base de données, comptes, emails, stockage de fichiers, notifications, automatisations, et plus). Vous n'avez **pas** besoin d'y penser

## Ce que ça ne couvre PAS

Ce harnais ne propose pas de paiement en ligne et ne construit que des sites en français (pas de version multilingue). Si vous en parlez pendant la construction du cahier des charges, `/spec` vous le dit clairement et l'inscrit dans une section "hors périmètre" dédiée, plutôt que de l'ignorer silencieusement ou de vous laisser croire que ce sera construit.

## Prérequis

Aucun. Vous pouvez lancer `/spec` même sans projet existant. Si vous le lancez depuis `/bootstrap`, c'est encore mieux car le nom et la description initiale du projet sont déjà connus.

## Astuces

{{callout:tip|Mode audio}}
Pour répondre plus vite et plus naturellement, passez en **mode audio** dans Claude Desktop (icône micro dans la barre de chat). Vous parlez, Claude comprend. Souvent plus fluide que de tout taper, surtout pour décrire votre vision.
{{/callout}}

{{callout:info|Pas de jargon technique attendu}}
Vous n'avez aucun terme technique à connaître. Si Baudrier vous demande quelque chose, c'est en français simple. Si une option n'est pas claire, demandez-lui d'expliquer ou de proposer des exemples concrets.
{{/callout}}
