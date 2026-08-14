# /gsc

Connecte votre site à **Google Search Console** et lit les données Google réelles : impressions, clics, requêtes, indexation. C'est ce que `/seo` ne peut pas voir, ce que Google **voit vraiment** sur votre site.

## Quand l'utiliser

- Votre site est en ligne depuis quelques semaines et vous voulez **savoir comment Google le voit**
- Vous voulez voir **quelles recherches** ramènent du trafic sur votre site
- Vous voulez identifier les **opportunités faciles** (requêtes où vous êtes en page 2 et où un petit coup de pouce suffirait)
- Vous voulez vérifier que toutes vos **pages sont indexées** (ou comprendre pourquoi certaines ne le sont pas)

## Comment ça se passe

1. **Vérification de l'accès public** : chaque application est restreinte au VPN de l'entreprise par défaut. Googlebot ne peut pas du tout atteindre un site restreint, donc Baudrier vérifie ça en premier et, si besoin, vous demande de lancer `/publish` avant de continuer.

2. **Vérification du domaine** : Baudrier regarde le domaine de production de votre site. Sans domaine custom (juste l'URL brute du conteneur), elle vous recommande `/add-domain` d'abord (GSC l'accepte, mais l'intérêt est limité : pas de marque, pas de contrôle DNS stable).

3. **Vérification (ou installation) du connecteur GSC** : la première fois, Baudrier vous accompagne pour brancher Google Search Console à Claude Code. C'est un setup unique par machine (≈ 10 min), entièrement guidé clic par clic : vous créez un "compte de service" dans Google Cloud (un type de compte technique conçu pour ça), vous l'ajoutez comme propriétaire de votre Search Console, et c'est fini. Une fois ce setup en place, Baudrier peut ajouter des propriétés, vérifier le DNS, soumettre des sitemaps, et plus encore, sans que vous ayez à retourner dans Search Console vous-même.

4. **Déclaration de la propriété GSC** : si votre site n'est pas encore déclaré dans GSC, Baudrier vous guide pour ajouter une **propriété domaine** (la version la plus complète, qui couvre toutes les sous-URLs) :
  - Vous récupérez un enregistrement TXT à ajouter dans votre DNS
  - Baudrier peut le faire pour vous directement si votre domaine est délégué au DNS Scaleway (après `/add-domain`)
  - Google vérifie la propriété en quelques minutes

5. **Soumission du sitemap** : Baudrier soumet automatiquement le sitemap de votre site à GSC.

6. **Lecture des données GSC** : Baudrier affiche un récap en langage simple :
  - **Impressions** : combien de fois votre site apparaît dans les résultats Google
  - **Clics** : combien de personnes cliquent réellement
  - **CTR** : taux de clic (impressions → clics). Un bon CTR = 3-5 % et plus.
  - **Position moyenne** : à quelle place votre site sort en moyenne. Place 1 = top, place 10 = bas de la première page.
  - **Couverture d'indexation** : combien de pages Google a bien enregistrées
  - **Top requêtes** : les recherches qui vous ramènent le plus de trafic
  - **Opportunités** : les requêtes où vous êtes en position 11-20 (proche du top 10, un petit effort peut suffire)

7. **Recommandations d'action** : selon ce que les données montrent, Baudrier propose des **actions concrètes** pour améliorer votre référencement.

## Ce que ça crée pour vous

- Votre site **déclaré dans Google Search Console** (propriété domaine, la plus complète)
- Votre **sitemap soumis** à Google (Google le re-crawle plus vite)
- Un **rapport régulier** des données GSC en langage simple
- Des **recommandations d'action** basées sur ce que Google voit vraiment

## Prérequis

- Le site doit être **public** (`/publish`) : chaque application est restreinte au VPN de l'entreprise par défaut, et Google ne peut pas atteindre un site restreint
- Le site doit être **déployé sur un domaine custom** (idéalement), sinon Baudrier propose `/add-domain` d'abord
- Le site doit être **en ligne depuis quelques semaines** pour que les données GSC soient pertinentes (Google met du temps à crawler et accumuler des stats)
- Un compte Google (le même que pour Analytics si vous en avez un)
- L'accès Search Console pour le site (Baudrier met en place la connexion pour vous via un compte de service Google, pas de MCP nécessaire)

## Astuces

{{callout:tip|/seo dit ce qui pourrait, /gsc dit ce qui est}}
Pensez aux deux skills comme à des miroirs complémentaires : `/seo` audite votre site et vous dit *"voilà ce que Google **pourrait** voir si tout est bien fait"*. `/gsc` vous dit *"voilà ce que Google **voit vraiment** et ce qu'il en fait"*. Si `/seo` est ✅ partout mais que `/gsc` montre 0 indexation, c'est bizarre, il y a un blocage à creuser (robots.txt, noindex caché, problème DNS).
{{/callout}}

{{callout:info|Patience nécessaire}}
GSC a besoin de **temps** pour accumuler des données. Une nouvelle propriété montre 0 résultat la première semaine, parfois 2-3 semaines. Si vous lancez `/gsc` immédiatement après la déclaration, vous verrez surtout *"pas encore de données"*, ce qui est normal. Relancez quelques semaines plus tard.
{{/callout}}

{{callout:warning|Les "opportunités faciles" valent leur pesant d'or}}
La métrique la plus actionnable : les requêtes où vous êtes en **position 11 à 20**. Vous êtes proche du top 10 (la première page), un petit effort de contenu / meta peut vous y faire passer, et le trafic grimpe fortement une fois que vous entrez dans le top 10. Baudrier les met en avant dans son rapport.
{{/callout}}

## Sites vitrines

Entièrement disponible sur un site vitrine. Le déroulé est identique ; seuls deux détails changent en coulisses : le sitemap soumis est `sitemap-index.xml` (généré par Astro) au lieu de `sitemap.xml`, et une éventuelle redirection 301 pour une page renommée passe par la configuration Caddy du site au lieu de la configuration Next.js.
