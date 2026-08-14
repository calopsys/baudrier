# /security

Audite la sécurité de votre app et corrige automatiquement les failles courantes. Baudrier couvre 13 catégories de risques (secrets exposés, routes mal protégées, dépendances vulnérables, webhooks falsifiés, la barrière d'accès par IP, etc.) avec une explication en langage simple pour chaque trouvaille.

## Quand l'utiliser

- **Avant le passage en production** sur un domaine public (surtout avant `/publish`, qui retire la barrière VPN par défaut)
- Après l'ajout d'une fonctionnalité critique (auth, upload de fichiers, un agent autonome)
- De manière périodique (tous les 2-3 mois) pour rester à jour

## Comment ça se passe

1. **Disclaimer affiché en début** : Baudrier rappelle que c'est un audit des failles courantes. Pour les apps qui traitent des données très sensibles (santé, bancaire, données critiques), un audit de sécurité professionnel reste nécessaire.

2. **Audit en 13 catégories** :
  - **Secrets et variables d'env** : recherche de clés/tokens en dur dans le code, vérification du `.gitignore`, vérification que les secrets ne sont pas commités dans l'historique Git
  - **Authentification et contrôle d'accès** : vérification que les pages admin/protégées ne sont pas accessibles sans login, que les règles d'accès sont appliquées côté serveur, et que chaque utilisateur ne peut accéder qu'à ses propres données (pas à celles d'un autre en changeant un id dans la requête)
  - **Validation des inputs** : vérification que les données utilisateur sont validées côté serveur (zod, etc.), y compris les uploads de fichiers (type et taille)
  - **Injection SQL et requêtes BDD** : vérification que les requêtes sont paramétrées (pas de concaténation de chaînes)
  - **Headers de sécurité** : CSP, HSTS, X-Content-Type-Options, etc.
  - **CORS** : configuration des cross-origin requests
  - **Dépendances vulnérables** : `npm audit` sur les dépendances de production, framework compris
  - **Rate limiting et protection anti-abus** : protection contre le brute force et les abus (ex : sur le login)
  - **Exposition de données** : vérification que les réponses d'API et les logs ne fuient pas de données sensibles
  - **Configuration Next.js** : réglages sûrs du framework (pas de secrets dans les bundles client, etc.)
  - **Webhooks** : vérification que tout point d'entrée appelé par un tiers (un webhook GitHub, `/api/cron/*`) est authentifié, pour que personne ne puisse le déclencher gratuitement
  - **Requêtes côté serveur (SSRF)** : vérification que votre serveur ne peut pas être manipulé pour appeler des adresses internes via une URL fournie par un utilisateur
  - **Barrière d'accès par IP** : vérification que `proxy.ts` implémente correctement la restriction VPN par défaut, exempte toujours les chemins ACME-challenge et health-check, et est décrite avec exactitude - c'est un contrôle applicatif, pas un pare-feu réseau

3. **Rapport pédagogique** : chaque trouvaille est classée ✅ OK / ⚠️ À améliorer / 🔴 Critique. Pour chaque problème :
  - **Explication en langage simple** ("XSS = attaque où quelqu'un injecte du code malveillant dans une page que d'autres visitent")
  - **Conséquence concrète** ("si quelqu'un exploite cette faille, il peut voler les cookies de tes visiteurs")
  - **Correction proposée** avec le **pourquoi** du fix, pas juste le code

4. **Corrections automatiques** : Baudrier corrige ce qui peut l'être sans risque (ajout de headers, fix dans le code, mise à jour des dépendances vulnérables). Pour le reste, elle vous propose le diff et vous validez.

## Ce que ça crée pour vous

- Un **rapport de sécurité complet** avec verdicts et explications
- Des **corrections appliquées** automatiquement (avec votre accord pour les changements de comportement)
- Une mise à jour potentielle de `CLAUDE.md` avec les conventions de sécurité du projet

## Prérequis

- Aucun prérequis particulier, `/security` peut tourner sur n'importe quel projet du plugin

## Astuces

{{callout:warning|Ne remplace pas un audit pro pour des cas sensibles}}
Si votre app traite des données médicales, financières, ou très personnelles (par ex. identité, biométrie), un audit professionnel reste indispensable. `/security` couvre 95 % des erreurs courantes mais ne remplace pas un expert qui creuse les cas business spécifiques à votre métier.
{{/callout}}

{{callout:tip|Lancez régulièrement}}
Les vulnérabilités évoluent vite (nouvelles failles dans des packages npm chaque semaine). Lancer `/security` tous les 2-3 mois est une bonne hygiène. Baudrier propose les mises à jour automatiques pour les failles critiques et hautes.
{{/callout}}

{{callout:info|Pas alarmiste}}
Baudrier est conçue pour **expliquer**, pas pour vous faire peur. Vous voyez chaque problème avec sa conséquence concrète, mais aussi la sévérité réelle (un site vitrine sans formulaire n'a pas les mêmes risques qu'un site avec auth + paiements). Vous priorisez ce qui compte vraiment.
{{/callout}}

## Sites vitrines

Non disponible sur un site vitrine : cette commande est réservée aux applications complètes. Si votre projet est un site vitrine (Astro, sans base de données ni comptes utilisateurs), Baudrier refuse la commande et vous le dit - votre site reste tel quel, et vous pouvez toujours le déployer avec `/deploy`.
