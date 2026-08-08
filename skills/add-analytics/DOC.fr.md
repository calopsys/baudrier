# /add-analytics

Active la mesure d'audience **Matomo** sur votre site. Fonctionne **sans cookies par défaut** : aucun cookie, aucune donnée personnelle, et aucune bannière de consentement qui bloque vos visiteurs - juste un moyen discret de s'opposer au suivi s'ils le souhaitent.

## Quand l'utiliser

- Vous voulez **mesurer l'audience** de votre site (nombre de visiteurs, pages les plus vues, sources de trafic, durée de visite)
- Vous voulez des statistiques **sans la contrainte de la bannière cookies RGPD** pour vos visiteurs
- Vous avez déjà (ou êtes prêt à créer) un compte Matomo - Matomo Cloud ou auto-hébergé

## Comment ça se passe

1. **Vérification** : si Matomo est déjà en place, Baudrier vous propose un menu (changer d'instance/de site, réinstaller le contrôle d'opt-out, exclure les routes admin, etc.).

2. **Votre instance Matomo** : contrairement à la plupart des fonctionnalités Baudrier, Matomo n'est pas hébergé pour vous. Vous donnez à Baudrier votre **URL Matomo** et votre **identifiant de site** - depuis Matomo Cloud (matomo.cloud) ou une instance auto-hébergée que vous avez déjà. Si vous n'avez ni l'un ni l'autre, Baudrier vous oriente vers matomo.org pour démarrer.

3. **Push des variables** : `NEXT_PUBLIC_MATOMO_URL` et `NEXT_PUBLIC_MATOMO_SITE_ID` sont poussées dans votre `.env` local et dans les secrets de votre app hébergée.

4. **Une vérification ponctuelle de votre côté** : Baudrier vous demande de confirmer que "Anonymiser les adresses IP des visiteurs" est activé dans votre admin Matomo (généralement déjà le cas par défaut). Ça ne peut pas être fait à distance, mais c'est ce qui permet de rester exempté de bannière de consentement.

5. **Création du composant MatomoAnalytics** : un composant React qui charge Matomo **sans cookies** (`disableCookies`) dès la première visite - pas besoin d'attendre un clic. Il **exclut automatiquement les routes d'administration** (`/admin`) du suivi, et Baudrier vous propose d'exclure aussi vos espaces authentifiés (dashboard, espace membres, compte).

6. **Création du contrôle d'opt-out** : un petit panneau caché par défaut, accessible via un lien "Gérer le suivi anonyme" dans votre pied de page. Les visiteurs peuvent désactiver le suivi pour eux-mêmes à tout moment - obligatoire même si aucun consentement préalable n'est requis pour une mesure sans cookies.

7. **Mise à jour des pages légales** : Baudrier met à jour votre politique de confidentialité pour mentionner Matomo et l'opt-out.

## Pourquoi pas de bannière de consentement cookies ?

Les outils d'analyse basés sur des cookies (comme l'ancien Google Analytics) demandent un consentement préalable car ils déposent un identifiant sur l'appareil du visiteur. Matomo configuré **sans cookies** n'en dépose pas - aucun cookie identifiant, aucun suivi entre sessions, aucun partage de données avec un tiers. Selon les critères d'exemption de la CNIL pour les outils de mesure d'audience, cette combinaison est exemptée de consentement préalable : une information claire plus un moyen simple de s'y opposer suffisent, ce qui est exactement ce que ce module installe. Si votre projet a besoin plus tard d'un suivi basé sur des cookies (reconnaissance multi-appareils, tunnels longs), c'est une montée en gamme délibérée qui nécessite une vraie bannière de consentement - demandez-le explicitement à Baudrier le moment venu.

## Ce que ça crée pour vous

- Les variables `NEXT_PUBLIC_MATOMO_URL` et `NEXT_PUBLIC_MATOMO_SITE_ID` dans `.env` + les secrets de votre app
- Un composant `MatomoAnalytics` qui suit sans cookies dès la première visite, en excluant les routes admin (et tout espace authentifié que vous choisissez d'exclure)
- Un composant `AnalyticsOptOut` (caché par défaut, ouvert depuis le lien du pied de page) avec le design de votre site
- Une mise à jour de la **politique de confidentialité** pour mentionner Matomo et l'opt-out

## Prérequis

- Le projet doit être en Next.js (typiquement initialisé par `/bootstrap`)
- Une instance Matomo (compte Matomo Cloud, ou une installation auto-hébergée) - Baudrier ne la crée pas pour vous

## Astuces

{{callout:info|Pourquoi le mode sans cookies par défaut}}
Le mode sans cookies supprime toute la contrainte de bannière de consentement pour vos visiteurs tout en restant conforme RGPD, tant que le suivi reste strictement une mesure d'audience anonyme. Baudrier le configure par défaut et vous explique le compromis si vous voulez un jour aller plus loin (suivi par cookies multi-appareils, par exemple).
{{/callout}}

{{callout:warning|Matomo n'est pas provisionné par Baudrier}}
Contrairement à votre base de données ou votre bucket de stockage, Matomo vit en dehors de Scaleway. Vous avez besoin de votre propre compte Matomo Cloud ou d'une instance auto-hébergée ; Baudrier se contente d'y raccorder le code de suivi.
{{/callout}}

{{callout:tip|Vos visites admin ne faussent pas vos stats}}
Le suivi est désactivé sur les routes d'administration (`/admin`) : quand vous gérez votre site, vos propres sessions ne sont pas comptées comme des visiteurs. Vous pouvez étendre cette exclusion à vos espaces authentifiés (dashboard, espace membres, compte) - Baudrier vous le propose pendant l'installation.
{{/callout}}
