# /add-email

Active **l'envoi d'emails transactionnels** depuis votre app, via **Scaleway Transactional Email (TEM)**. Pour les formulaires de contact, les confirmations, les notifications, les emails de bienvenue, etc.

## Quand l'utiliser

- Vous voulez ajouter un **formulaire de contact** sur votre site
- Vous voulez envoyer des emails automatiques à vos utilisateurs (confirmation d'inscription, mot de passe oublié, notification d'événement)
- Vous voulez envoyer des emails depuis votre propre domaine (`contact@monsite.fr`)

## Un seul provider : Scaleway TEM

Ce projet tourne entièrement sur Scaleway (voir le `CONTRACT.md` du projet), donc il n'y a plus de choix de provider à faire - pas de clé API séparée à créer chez un service tiers, pas de coffre-fort à déverrouiller. L'envoi utilise les mêmes identifiants Scaleway que le reste de votre infrastructure.

{{callout:warning|Pas d'adresse de test partagée}}
Contrairement à d'autres services d'emailing, **TEM n'a pas d'adresse de test partagée** utilisable immédiatement. Vous devez vérifier un domaine que vous possédez (enregistrements DNS SPF/DKIM/DMARC/MX, vérification qui peut prendre **jusqu'à 48 heures**) avant de pouvoir envoyer le moindre email. C'est pourquoi `/add-email` demande votre adresse d'expédition dès le départ.
{{/callout}}

## Comment ça se passe

1. **Vérification** : Baudrier regarde si l'envoi d'emails est déjà configuré sur CE projet. Si oui, un menu vous propose de changer l'adresse d'expédition, le destinataire, republier les enregistrements DNS, créer une page `/contact`, ou tout recommencer.

2. **Adresse d'expédition** : vous indiquez à Baudrier l'adresse depuis laquelle vous voulez envoyer (par exemple `contact@monsite.fr`). Son domaine devient le domaine d'envoi TEM.

3. **Vérification du domaine** : Baudrier crée (ou retrouve) ce domaine dans TEM, récupère les enregistrements SPF/DKIM/DMARC/MX nécessaires, et :
   - si le DNS du domaine est déjà géré par Scaleway (typiquement parce que vous avez lancé `/add-domain`), **publie les enregistrements automatiquement**
   - sinon, vous donne les enregistrements exacts à ajouter manuellement chez votre fournisseur DNS actuel

4. **Scaffolding** : un fichier `src/server/mail.ts` est créé avec une fonction `sendMail()` réutilisable + `escapeHtml()` pour insérer sans risque des données utilisateur dans le HTML d'un email. Un router tRPC `contact` est ajouté pour gérer le formulaire de contact côté serveur (honeypot anti-spam, rate limiting, échappement HTML).

5. **Variables d'environnement** : `TEM_SENDER_EMAIL` et `TEM_SENDER_NAME` sont écrites dans `.env` et dans le coffre-fort Scaleway Secret Manager de ce projet (qui alimente le container déployé au moment du déploiement).

6. **Page de contact (optionnel)** : à la fin, Baudrier vous propose de créer une page `/contact` fonctionnelle (formulaire Nom, Email, Message, responsive).

## Ce que ça crée pour vous

- Un **domaine d'envoi TEM**, vérifié à partir de l'adresse que vous avez donnée (vérification jusqu'à 48h)
- `src/server/mail.ts` avec `sendMail()` + `escapeHtml()`
- Un router tRPC `contact` (`src/server/api/routers/contact.ts`) pour le formulaire
- `TEM_SENDER_EMAIL` et `TEM_SENDER_NAME` dans `.env` + Scaleway Secret Manager
- Si le DNS de votre domaine est chez Scaleway : les enregistrements SPF/DKIM/DMARC/MX, publiés automatiquement
- Sinon : les enregistrements exacts à ajouter vous-même, et un rappel de lancer `/add-domain` si vous préférez que Baudrier gère le DNS de ce domaine
- Si vous le souhaitez : une **page `/contact`** complète et fonctionnelle

## Prérequis

- Le projet doit être en Next.js avec tRPC (typiquement initialisé par `/bootstrap`)
- Les quatre variables `SCW_*` doivent être renseignées dans votre environnement cloud « Baudrier » - pas de clé de provider email séparée nécessaire
- Une adresse email sur un domaine que vous possédez, à utiliser comme expéditeur

## Astuces

{{callout:warning|La vérification prend jusqu'à 48h}}
Une fois les enregistrements DNS publiés, Scaleway peut mettre **jusqu'à 48 heures** pour vérifier complètement votre domaine. L'envoi échouera tant que ce n'est pas fait. C'est normal - patientez, et ne relancez pas la configuration entre-temps.
{{/callout}}

{{callout:tip|Limites du compte gratuit}}
Un compte Scaleway récent (avant vérification d'identité) est limité à **500 emails/mois et 2 domaines d'envoi**. Une fois la vérification d'identité (KYC) effectuée dans la console Scaleway, cela passe à **5 000 emails/mois et 5 domaines**. Baudrier vous le rappelle à la fin de l'installation pour que l'arrêt soudain de l'envoi ne vous prenne pas au dépourvu.
{{/callout}}

{{callout:info|Les limites strictes de TEM}}
Chaque email doit avoir un sujet d'**au moins 10 caractères** et **3 destinataires maximum**. `sendMail()` vérifie les deux avant d'appeler l'API et lève un message clair en français si l'une des règles est dépassée, plutôt que de vous laisser essuyer un 400 incompréhensible.
{{/callout}}

{{callout:info|Pas de réception d'emails}}
TEM ne fait qu'envoyer. Il n'existe rien d'équivalent à la réception d'emails sur `contact@monsite.fr` redirigée vers votre boîte - voir la documentation de `/add-domain` pour le détail de cette limite. `/add-email` ne configure que l'envoi **sortant**.
{{/callout}}
