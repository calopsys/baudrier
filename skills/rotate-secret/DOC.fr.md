# /rotate-secret

Renouvelle une clé secrète partout où elle vit - Scaleway Secret Manager, et le conteneur en cours d’exécution - en une seule commande. Clés IAM générées par Scaleway, jetons auto-générés, identifiants externes (GitHub, Matomo, PageSpeed, Google Search Console) : Baudrier vous guide selon le type de clé, et s’assure toujours que le changement prend effet réellement.

## Quand l'utiliser

- Vous **suspectez une fuite** d'une de vos clés (commit accidentel sur un dépôt public, capture d'écran partagée, etc.)
- Un **opérateur quitte** votre équipe et vous voulez révoquer son accès indirect
- Vous faites une **rotation périodique** par hygiène de sécurité (tous les 3-6 mois sur les secrets critiques)

## Comment ça se passe

1. **Identification du secret** : vous pouvez passer le nom de la clé en argument (`/rotate-secret database`) ou Baudrier interroge directement le Secret Manager Scaleway de ce projet et vous montre ce qui existe réellement, regroupé par catégorie.

2. **Type de secret** : Baudrier détecte si c'est :
   - **Une clé IAM générée par Scaleway** (`DATABASE_URL`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, `SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`) → Baudrier génère elle-même une nouvelle clé, à portée restreinte, sans passer par un tableau de bord
   - **Un secret auto-géré** (`AUTH_SECRET`, `CRON_SECRET`, la paire de clés VAPID pour les notifications push) → Baudrier le régénère localement, aucun tiers impliqué
   - **Un identifiant externe** (`MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`) → émis par un tableau de bord externe (Matomo, Google Cloud), stocké dans le Secret Manager Scaleway propre à ce projet ; Baudrier vous y guide et stocke la valeur que vous collez

3. **Stockage de la nouvelle valeur** : chaque secret renouvelé est écrit dans le Secret Manager Scaleway de ce projet (région `fr-par`).

4. **La faire prendre effet - la partie qui compte** : les Serverless Containers Scaleway **ne peuvent pas référencer directement le Secret Manager** (une limitation actuelle de la plateforme Scaleway). Le harness copie les valeurs des secrets dans la configuration propre au conteneur, donc Baudrier **redéploie toujours le conteneur** comme dernière étape d'une rotation applicative - stocker la nouvelle valeur seule laisserait l'ancienne, potentiellement compromise, active en production. Si rien n'est encore déployé, Baudrier le signale au lieu de prétendre que la rotation est « en ligne ».

   Les Serverless Jobs Scaleway (le job de migration de base de données, un agent autonome) fonctionnent différemment : ils lisent directement le Secret Manager, donc ils prennent en compte une valeur renouvelée automatiquement à leur **prochaine exécution** - aucun redéploiement nécessaire pour cette partie.

5. **Révocation** : pour les clés générées via IAM, l'ancienne clé est supprimée côté IAM Scaleway une fois la nouvelle confirmée fonctionnelle - pas simplement laissée à traîner à côté.

## Ce que ça crée pour vous

- Une **nouvelle valeur** pour le secret choisi, stockée dans le Secret Manager Scaleway
- Pour les secrets applicatifs : le conteneur en cours d'exécution **redéployé** avec la nouvelle valeur déjà active
- Pour les secrets adossés à IAM : l'**ancienne clé révoquée** au niveau IAM Scaleway
- Interruption brève spécifiquement pour la rotation de `DATABASE_URL` (généralement moins d'une minute, le temps que le redéploiement prenne le relais avec les nouveaux identifiants de base de données) et pour les clés VAPID (les abonnements push existants sont invalidés, les utilisateurs devront se réabonner) - Baudrier vous prévient avant les deux

## Prérequis

- Vous devez être dans un projet baudrier existant, avec des identifiants Scaleway configurés (`/start`)
- Pour les identifiants externes : un accès au tableau de bord concerné (GitHub, Matomo, Google Cloud)

## Astuces

{{callout:tip|Faites-le sans hésiter en cas de doute}}
Si vous avez le moindre doute sur la sécurité d'une clé (capture d'écran partagée par mégarde, commit suspect, ancien opérateur qui aurait pu voir l'écran...), **renouvelez immédiatement**. Ça ne prend que quelques minutes, et une clé `DATABASE_URL` ou Object Storage compromise peut exposer les données de tous les utilisateurs.
{{/callout}}

{{callout:info|Rotation périodique = bonne hygiène}}
Sur les secrets les plus critiques (`DATABASE_URL`, `AUTH_SECRET`, `STORAGE_ACCESS_KEY`) : pensez à les renouveler tous les 3-6 mois même sans suspicion de fuite. C'est une protection contre les fuites silencieuses (un commit ancien sur un dépôt public, une valeur qui aurait fuité dans des logs, etc.).
{{/callout}}

{{callout:warning|Conteneurs vs. Jobs - pourquoi « renouvelé » ne veut pas toujours dire « redéployé »}}
Si votre projet a un agent autonome (`/add-agent`), renouveler ses clés (`SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`) ne déclenche **pas** de redéploiement du conteneur pour cette partie - l'agent tourne comme un Serverless Job, qui lit le Secret Manager nativement et utilise simplement la nouvelle valeur à sa prochaine exécution planifiée. Baudrier vous indique lequel des deux s'est produit pour que vous ne soyez jamais dans le doute sur ce qui est réellement actif.
{{/callout}}
