# /rotate-secret

Renews a secret key everywhere it lives - Scaleway Secret Manager, and the running container - in a single command. Scaleway-minted IAM keys, self-generated tokens, external credentials (GitHub, Matomo, PageSpeed, Google Search Console): Baudrier guides you based on the type of key, and always makes sure the change actually takes effect.

## When to use it

- You **suspect a leak** of one of your keys (accidental commit to a public repo, shared screenshot, etc.)
- An **operator is leaving** and you want to revoke their indirect access
- You are doing a **periodic rotation** for security hygiene (every 3-6 months on critical secrets)

## How it works

1. **Identifying the secret**: you can pass the key name as an argument (`/rotate-secret database`) or Baudrier queries this project's Scaleway Secret Manager directly and shows you what's actually there, grouped by category.

2. **Secret type**: Baudrier detects whether it is:
   - **A Scaleway-minted IAM key** (`DATABASE_URL`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, `SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`) → Baudrier mints a fresh, narrowly-scoped IAM key itself, no dashboard needed
   - **A self-managed secret** (`AUTH_SECRET`, `CRON_SECRET`, the VAPID Web Push keypair) → Baudrier regenerates it locally, no third party involved
   - **An external credential** (`MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`) → issued by an external dashboard (Matomo, Google Cloud), stored in this project's own Scaleway Secret Manager; Baudrier guides you there and stores the value you paste back

3. **Storing the new value**: every rotated secret is written to this project's Scaleway Secret Manager (region `fr-par`).

4. **Making it take effect - the part that matters**: Scaleway Serverless Containers **cannot reference Secret Manager directly** (a current Scaleway platform limitation). The harness copies secret values into the container's own configuration, so Baudrier **always redeploys the container** as the last step of a per-app rotation - storing the new value alone would leave the old, possibly-compromised one live in production. If nothing is deployed yet, Baudrier says so instead of pretending the rotation is "live".

   Scaleway Serverless Jobs (the database-migration job, an autonomous agent) work the other way: they read Secret Manager directly, so they pick up a rotated value automatically on their **next run** - no redeploy needed for that part.

5. **Revocation**: for IAM-minted keys, the previous key is deleted from Scaleway IAM once the new one is confirmed working - not just left dangling alongside it.

## What it creates for you

- A **new value** for the chosen secret, stored in Scaleway Secret Manager
- For per-app secrets: the running container **redeployed** with the new value already active
- For IAM-backed secrets: the **old key revoked** at the Scaleway IAM level
- Brief downtime for `DATABASE_URL` rotation specifically (typically under a minute, while the redeploy takes over with the new database credentials) and for VAPID keys (existing push subscriptions are invalidated and users need to re-subscribe) - Baudrier warns you before either

## Prerequisites

- You must be inside an existing baudrier project, with Scaleway credentials configured (`/start`)
- For external credentials: access to the relevant dashboard (GitHub, Matomo, Google Cloud)

## Tips

{{callout:tip|Do it without hesitation when in doubt}}
If you have the slightest doubt about the security of a key (a screenshot shared by mistake, a suspicious commit, a former operator who might have seen the screen...), **renew it immediately**. It only takes a few minutes, and a compromised `DATABASE_URL` or Object Storage key can expose every user's data.
{{/callout}}

{{callout:info|Periodic rotation = good hygiene}}
For the most critical secrets (`DATABASE_URL`, `AUTH_SECRET`, `STORAGE_ACCESS_KEY`): consider renewing them every 3-6 months even without any suspicion of a leak. It's a safeguard against silent leaks (an old commit on a public repo, a value that leaked into logs, etc.).
{{/callout}}

{{callout:warning|Containers vs. Jobs - why "rotated" doesn't always mean "redeployed"}}
If your project has an autonomous agent (`/add-agent`), rotating its keys (`SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`) does **not** trigger a container redeploy for that part - the agent runs as a Serverless Job, which reads Secret Manager natively and simply uses the new value on its next scheduled run. Baudrier tells you which of the two happened so you're never left wondering whether the change is actually live.
{{/callout}}
