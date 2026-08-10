---
name: add-agent
description: "Scaffold an autonomous AI agent into the user's project. The agent runs on a Scaleway Serverless Job, uses Scaleway Generative APIs (mistral-small-3.2-24b-instruct-2506 by default, OpenAI-compatible), has tools (http-fetch, send-email, db-query by default; more added based on the agent's job), optional Postgres KV or pgvector semantic memory, a daily/monthly EUR cost circuit breaker (default 1 EUR/day, 10 EUR/month - kills runs over budget and emails the admin), and persists every invocation + every loop turn to Postgres for full traceability. Use this when the user wants an LLM-driven process that is part of the PRODUCT (serves the app or its end users), decides actions, uses tools, and optionally has memory - distinct from /add-automation which handles non-AI background processing. When the mission is actually a personal recurring task for the OPERATOR (a brief, a watch, a weekly analysis for themselves) at a cadence of 1 hour or more, the discovery short-circuits to the much lighter _create-routine (a Claude routine on the user's own account, zero infrastructure). Discovery phase asks ~5 questions about the agent's job (goal, trigger, memory needs, model, budget) then runs setup-agent.mjs to scaffold. Deployment is fully automated via /deploy (no manual dashboard step). NOT for chatbots (real-time per-user UI agents) - those need a dedicated /add-chatbot skill (not yet built). Suitable for: continuous background agents (email surveillance, monitoring), cron-driven product agents, and on-demand agents (triggered manually from a dashboard)."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Agent - Scaffold an autonomous AI agent

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You help the user set up an AI agent in their project. You ask few questions (max 5 needed), and you do the scaffolding work for them - the agent then goes live through `/deploy`, fully automated, whenever the user is ready for that.

The deterministic code (scaffold templates, install deps, generate the migration, mint credentials, etc.) lives in `scripts/setup-agent.mjs`. This SKILL:
1. Asks the discovery questions (and short-circuits to `_create-routine` when the mission is operator-side and low-frequency - see Q1.bis)
2. Delegates to `_convert-to-turborepo` if the project is not a monorepo
3. Runs `setup-agent.mjs` with the right args
4. Communicates the result and proposes `/deploy` for when the user wants the agent live - it is scaffolded and committed either way, so nothing is lost by waiting

Everything that used to be a manual step (creating a third-party LLM console key, clicking through a hosting provider's blueprint UI) is now automated: `setup-agent.mjs` mints its own scoped Scaleway API keys via IAM, and `/deploy` creates/updates the Scaleway Serverless Job directly through the Jobs API.

---

## Preflight - Scaleway credentials

This skill needs `SCW_ACCESS_KEY` / `SCW_SECRET_KEY` / `SCW_DEFAULT_PROJECT_ID` to be available. If `setup-agent.mjs` fails at its `generativeApiKey` or `temApiKey` step with a credentials error, tell the user to check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation.

---

## Step 0 - Quick detection

### 0.a - Detect the Next.js project

Invoke `_detect-project-root` to get `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`, `IS_MONOREPO`. If `IS_NEXTJS=no` → explain to the user that a Next.js project is required (run `/bootstrap` first).

### 0.b - Detect whether email is configured

The agent sends emails (failures, daily digests, etc.) - email MUST be configured, otherwise error notifications won't go out.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" email
```

If `email_ok = false` → stop and tell the user:

> Pour que ton agent puisse t'envoyer des emails (alertes d'erreur, plafond budgétaire dépassé...), il faut d'abord configurer l'envoi d'emails sur ton projet. Lance `/add-email`, puis reviens ici. Ça prend ~3 min.

### 0.c - Detect a database

The agent persists its invocations + turns + memory to the DB.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" db
```

If `db_ok = false` → ask the user:

> Un agent stocke son historique d'exécution et sa mémoire dans une base de données. Tu n'en as pas encore. Je lance `/add-db` maintenant ? *(1 min)*

If yes → invoke `/add-db`, wait, come back here. If no → explain that we can't continue without a DB and stop.

---

## Step 1 - Discovery (5 questions max, in plain language)

You ask the questions one by one, in simple language. The answers fill the args for `setup-agent.mjs`.

If the user already gave a description as a command argument (`/add-agent <description>`), skip Q1 and infer the goal from their description.

### Q1 - What is the agent's goal?

> Décris en une phrase ce que tu veux que ton agent fasse. Quelques exemples :
>
> - *"Chaque matin à 7h, lis mes flux RSS et envoie-moi un résumé des articles importants"*
> - *"Surveille mes emails support, et pour chaque email avec une question simple, propose une réponse en brouillon"*
> - *"Une fois par semaine, agrège mes stats et envoie-moi un tableau de bord"*
>
> Le tien ?

→ Capture as `<USER_DESCRIPTION>`. Used for Q2 (inferring the trigger), for the system prompt, and for the additional tools.

### Q1.bis - The routine shortcut (check BEFORE going further)

Look at WHO the mission serves and HOW OFTEN it runs:

- **Operator-side + scheduled (cadence >= 1 hour)** - the output is for the user themselves (a brief, a digest, an analysis, a watch report) and it runs at fixed moments (daily, weekly...). → This does NOT need the full agent machinery (Serverless Job, database tables, dashboard, budget caps). Offer the light path:

> Bonne nouvelle : pour ce genre de mission personnelle récurrente, tu n'as besoin d'aucune infrastructure. Je peux la configurer comme une **routine** : ton propre Claude exécute la mission au bon rythme (ça consomme un peu de ton abonnement Claude, et ça te sert personnellement, pas ton app). Zéro code, zéro hébergement, prêt en 2 minutes.
>
> L'agent complet (avec son propre job, ses traces en base et un dashboard) reste le bon choix si tu veux que ça tourne pour les utilisateurs de ton app, ou si tu veux des logs d'exécution détaillés et auditables. Tu préfères la **routine** (recommandé ici) ou l'**agent complet** ?

If the user picks the routine → invoke **`_create-routine`** with the goal + cadence, and STOP here (no Step 2-7; `_create-routine` handles everything including the final summary).
If the user picks the full agent (or the mission is genuinely product-side / continuous / on-demand for a team) → continue with Q2.

- **Product-side, continuous, or on-demand dashboard** → Continue with Q2, this skill is the right tool.

### Q2 - When should the agent run? (trigger)

Infer a default from the description, but ask for confirmation:

> D'après ce que tu décris, ton agent se déclencherait : **[INFER: "à heure fixe (cron)" / "en continu (surveille tout le temps)" / "à la demande (tu cliques pour le lancer)"]**.
>
> 1. ⏰ **À heure fixe** - un cron (chaque matin 7h, chaque lundi…)
> 2. 🔄 **En continu** - l'agent tourne en permanence et réagit à des événements
> 3. 👤 **À la demande** - tu cliques sur un bouton "Lancer" depuis le dashboard
>
> Lequel ?

→ Capture `--trigger`: `cron` | `continuous` | `manual`.

Be upfront about the real trade-off (a Scaleway Serverless Job is not an always-on server, it runs in finite bursts):
- **cron**: the agent wakes up exactly at the scheduled time(s). A manual "Run now" click from the dashboard is picked up at the *next* scheduled tick, not instantly.
- **manual**: the Job wakes up every 5 minutes to check for a pending "Run now" click, then goes back to sleep. Near-zero cost between runs (billed only for actual compute), a few minutes of lag instead of instant.
- **continuous**: the Job stays up and reacts within seconds, like the old design - but costs the most since it never stops running, and self-restarts once a day (Jobs cap out at 24h per run).

If `cron` → ask a Q2.bis:

> À quel rythme ? *(en langage courant, je le traduis en expression cron)*
>
> 1. Chaque jour à heure fixe (ex : 7h)
> 2. Chaque lundi matin
> 3. Toutes les X heures
> 4. Autre - précise

→ Capture `AGENT_CRON_SCHEDULE` (e.g. `0 7 * * *` for 7am every day).
→ Also capture `AGENT_CRON_PROMPT`: a default prompt sent to the agent on each tick (e.g. `"Lis les flux RSS et envoie le brief du jour."`). Infer it from the description.

### Q3 - Memory between runs?

> Ton agent doit-il **se souvenir** de choses entre ses exécutions ?
>
> 1. **Non, agent sans mémoire** - il fait son travail, oublie tout, repart de zéro à chaque fois *(le plus simple, pour des cas comme "résume mes RSS chaque matin")*
> 2. **Oui, mémoire structurée** - il retient des choses précises identifiées par une clé : *"à qui j'ai déjà répondu", "le dernier article résumé", des compteurs…* *(une simple table en base, gratuit)*
> 3. **Oui, mémoire sémantique** *(avancé)* - il peut retrouver des souvenirs **par sens**, pas par clé : *"trouve les souvenirs liés à un thème", "cherche dans ma base de connaissances", RAG.* Utilise les mêmes identifiants Scaleway que le reste de ton agent - **aucune nouvelle clé à créer**.

→ Capture `--memory`: `none` | `kv` | `pgvector`.

**Recommendation**: `kv` covers 80% of cases. `pgvector` is useful if the agent needs to do semantic search over hundreds/thousands of memories. If the user hesitates, suggest `kv` - they can always add vector memory later via a second `/add-agent` command on the same name.

### Q4 - Which model?

`mistral-small-3.2-24b-instruct-2506` by default (Scaleway Generative APIs - good cost/quality balance, ~0.15-0.35 EUR/M tokens). Ask only if the use case justifies another:

> J'utilise `mistral-small-3.2-24b-instruct-2506` par défaut (bon compromis coût/qualité). Tu veux passer sur :
>
> - **Llama 3.3 70B** - plus de qualité pour des analyses complexes, ~3-6x plus cher
> - **Garder le modèle par défaut** *(recommandé)*

→ Capture `--model`. Map "Llama 3.3 70B" → `llama-3.3-70b-instruct`. Any other Scaleway Generative APIs model id the user names explicitly is also accepted as-is - do not invent model ids, only pass through ones the user actually named or the two above.

### Q5 - Budget cap

Clear display:

> ⚠️ **Garde-fou budgétaire**
>
> Pour éviter qu'un agent qui boucle te coûte cher en une nuit, il y a un plafond automatique : si la consommation dépasse le plafond, l'agent se met en pause et tu reçois un email.
>
> Plafonds par défaut :
> - **1 EUR / jour**
> - **10 EUR / mois**
>
> Tu veux les ajuster ?
>
> 1. **Garder les valeurs par défaut** *(recommandé pour démarrer)*
> 2. Personnaliser

→ Capture `--daily-budget` and `--monthly-budget` (EUR, defaults `1` and `10`).

### Inferring the agent name

No question - infer a kebab-case slug from the description. Check that no `apps/<slug>/` already exists - if it does, suffix it (`-2`, `-3`).

### Inferring the system prompt

Generate a clear system prompt from the description. Format:

```
You are <NAME>, an autonomous agent. Your goal: <GOAL>.
Triggers: <HOW_TRIGGERED>.
Tools at your disposal:
- <list>
Memory: <stateless|kv table|semantic search>.
When done with a task, respond with a brief summary of what you did. If you can't accomplish the task, explain why in plain text.
```

---

## Step 2 - Check the monorepo (and convert if needed)

The agent lives in `apps/<slug>/` - so the project must be a Turborepo monorepo.

If `IS_MONOREPO=no` (Step 0.a), invoke `_convert-to-turborepo`:

> Pour que ton agent vive à côté de ton site Next.js, je dois transformer ton projet en **monorepo** (juste un nouveau dossier `apps/web/` qui contient ton site, et tu pourras avoir d'autres apps à côté). C'est sûr, et réversible si besoin.

Invoke skill: `_convert-to-turborepo` then re-check `IS_MONOREPO=yes` before continuing.

---

## Step 3 - Run the setup-agent script

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-agent.mjs" \
  --name "<SLUG>" \
  --description "<USER_DESCRIPTION>" \
  --web-dir "<WEB_DIR>" \
  --trigger "<TRIGGER>" \
  --memory "<MEMORY_MODE>" \
  --model "<MODEL_ID>" \
  --system-prompt "<GENERATED_SYSTEM_PROMPT>" \
  --daily-budget "<DAILY_EUR>" \
  --monthly-budget "<MONTHLY_EUR>" \
  {{IF trigger=cron}}--cron-schedule "<AGENT_CRON_SCHEDULE>" --cron-prompt "<AGENT_CRON_PROMPT>"{{/IF}}
```

The script chains 13 sub-steps (preflight, generativeApiKey, temApiKey, ensureMonorepo, scaffoldAgent, patchSystemPrompt, patchAgentName, patchTools, patchMemory, mergeSchema, installDeps, generateMigration, handoff). Show progress to the user via `↳ <action>` then `✅`.

`generativeApiKey` and `temApiKey` mint their own scoped Scaleway IAM keys automatically - no key to paste.

### On success → JSON on stdout:

```json
{
  "success": true,
  "agentName": "<slug>",
  "agentDir": "apps/<slug>",
  "trigger": "cron",
  "memory": "kv",
  "model": "mistral-small-3.2-24b-instruct-2506",
  "dailyBudgetEur": "1",
  "monthlyBudgetEur": "10",
  "schemaPatched": true,
  "migrationFiles": ["drizzle/0007_xxx.sql"],
  "warnings": [],
  "nextSteps": { ... }
}
```

Capture this JSON, use it for the final summary (Step 5).

### On failure:

Read the error just above the handoff banner. Diagnose by step:
- `preflight` → bad args (invalid slug, folder already existing, missing `--cron-schedule` for a cron trigger) - fix then re-run
- `generativeApiKey` / `temApiKey` → Scaleway credentials issue - re-check `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` (have the user check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation, if needed)
- `ensureMonorepo` → `_convert-to-turborepo` did not run, back to Step 2
- `scaffoldAgent` / `patchXxx` → rare (filesystem issue), inspect
- `patchMemory` (pgvector) → the embeddings smoke test failed, or `drizzle-kit generate --custom` failed - read the exact error, usually a transient API issue or a missing `drizzle.config.ts`
- `mergeSchema` → conflict in `src/server/db/schema.ts` (resolve manually at the end)
- `installDeps` → pnpm/network error (retry)
- `generateMigration` → invalid schema (rare, since the snippet is fixed) - inspect the drizzle-kit error

---

## Step 4 - Offer the dashboard

> ## 🎛️ Tu veux un dashboard pour suivre ton agent ?
>
> Sans dashboard, ton agent tourne et tu ne vois rien - fonctionnel mais aveugle. **Avec un dashboard**, tu as dans ton espace admin (`/admin/agents`) :
>
> - La liste de chaque exécution avec date, durée, coût
> - Le détail tour par tour (chaque décision, chaque outil appelé) - utile pour déboguer
> - Les stats de coût agrégées (par jour, sur 30 jours)
> - Un bouton **"Lancer maintenant"** avec un prompt personnalisé - pratique pour tester
>
> ⚠️ Prérequis : ton site doit avoir l'authentification admin configurée (`/add-auth` en mode admin). Sans ça, je ne peux pas installer le dashboard car les pages seraient publiques.
>
> Tu veux que je l'ajoute ? *(j'invoque `/add-agent-dashboard` qui gère tout)*

If the user says yes:

1. Check that `/add-auth` admin is in place (look at `apps/web/src/server/auth.ts` for `isAdmin` or `adminProcedure`).
2. If missing → ask the user to run `/add-auth` (admin mode) first.
3. If present → invoke `/add-agent-dashboard`. This skill is idempotent: if already installed, it no-ops.

If the user says no:

> D'accord, ton agent tourne sans dashboard. Tu peux suivre ses logs via Cockpit (`node scripts/scaleway/cockpit.mjs query`). Si tu changes d'avis plus tard, lance `/add-agent-dashboard` - ça marche avec tous tes agents existants.

---

## RGPD - Privacy policy

Scaleway Generative APIs and the Serverless Job both run on the same Scaleway infrastructure already declared as the project's host - no separate subprocessor entry needed for the agent itself. If the agent's tools send end-user data to a genuinely different third party (e.g. a custom tool the user asked for that calls an outside API), flag that to the user and add it via `update-privacy-policy.mjs --add <key>` if a matching catalog entry exists.

---

## Step 5 - Final summary

From the JSON captured in Step 3, display exactly:

> ## ✅ Ton agent **<NAME>** est prêt
>
> 📁 Code : `apps/<NAME>/` *(boucle, outils, mémoire, définition de Job, …)*
> 🗃️ Tables créées dans ta base : `agent_invocations`, `agent_turns`, `agent_memory_kv`, `agent_trigger_queue`<if pgvector> + `agent_memory_vector`</if> *(via une migration générée, appliquée au prochain `/deploy`)*
> 🤖 Modèle : <MODEL_ID> (Scaleway Generative APIs)
> ⏰ Déclenchement : <TRIGGER> *(+ expression cron si applicable)*
> 🧠 Mémoire : <kv | sémantique | aucune>
> 💰 Plafonds : <DAILY> EUR/jour, <MONTHLY> EUR/mois
>
> ### Pour le mettre en ligne, quand tu es prêt
>
> 1. **Commit + push** ce que je viens de générer :
>    ```
>    git add . && git commit -m "feat(agent): scaffold <NAME> agent" && git push
>    ```
>
> 2. **Dis-moi quand tu veux le voir tourner en ligne** - je lance alors `/deploy` : il construit l’image, applique la migration de base de données, et crée/met à jour le Job Scaleway de ton agent automatiquement. Aucune étape manuelle de configuration à faire ailleurs. En attendant, ton code reste prêt et enregistré localement.
>
> ### Une fois en ligne
>
> - Les logs de l'agent sont dans Cockpit (demande-moi *"montre-moi les logs de mon agent"*)
> - Tu reçois un email automatique en cas d'erreur ou de plafond atteint
> - Pour déclencher manuellement (sans dashboard dédié) : insère une ligne dans la table `agent_trigger_queue` avec ton prompt - l'agent la reprend à son prochain réveil
>
> Quand tu as un projet plus avancé, dis-moi *"ajoute le dashboard de mon agent"* (ou lance `/add-agent-dashboard`) et je monte les pages de suivi.

---

## Important conventions

- **Scaleway keys minted automatically**: `SCW_GENERATIVE_API_KEY` and `TEM_API_SECRET_KEY` are per-app Secret Manager secrets, minted by `setup-agent.mjs` via a narrowly-scoped IAM Application (`GenerativeApisModelAccess` / `TransactionalEmailEmailApiCreate` - never the operator's own broad `SCW_SECRET_KEY`). Nothing to paste, nothing in the repo.
- **Jobs are fully API-driven**: `/deploy` creates and updates the agent's Scaleway Serverless Job directly via `scripts/scaleway/jobs.mjs`, reading `apps/<name>/job-definition.json`. No manual dashboard step.
- **Finite runs, not an always-on server**: a Serverless Job run is capped at 24h. `apps/<name>/entry.ts` picks a run shape (`cron` / `manual` / `continuous`) from `AGENT_TRIGGER_MODE` - see that file's header comment for the exact trade-offs of each. Be honest with the user about the "manual" and "cron" trigger lag (minutes, not seconds) - it buys real scale-to-zero economics an always-on worker never had.
- **Migrations, never applied by the operator directly**: `setup-agent.mjs` runs `drizzle-kit generate` (writes SQL, no DB connection - CONTRACT.md §4). The migration is applied by `/deploy`'s migration Job, not by this script.
- **Shared schema**: the `agent_*` tables live in the app's own Serverless SQL Database, not a separate one. The Job has its own copy of `schema.ts` that points at the same physical tables.
- **No chatbot**: if the user describes a real-time UI thing ("a chatbot on my site that answers visitors"), explain that it's a distinct case requiring streaming + dedicated UI - not the scope of `/add-agent` v1, propose `/add-automation` or waiting for a future dedicated chatbot skill (not yet built).

---

## Common errors

- **"The agent doesn't trigger despite the cron"** → check `job-definition.json`'s `cronSchedule` was picked up by `/deploy` (5-field cron expression, `m h dom mon dow`) and that the Job definition shows a `cron_schedule` in the Scaleway console.
- **"The error email doesn't arrive"** → check `ADMIN_EMAIL` is set as a Job secret + `TEM_SENDER_EMAIL`/`TEM_SENDER_NAME` are configured (`/add-email`). Test with an invocation that fails on purpose.
- **"The Job crashes at boot with SCW_GENERATIVE_API_KEY missing"** → the secret reference isn't resolving. Re-check `job-definition.json`'s `secretRefs` and that the secret exists in Secret Manager (`node scripts/scaleway/secrets.mjs list`).
- **"Migration fails or schema error"** → conflict with the existing schema (table `agent_invocations` already present with other columns?). Inspect the generated SQL diff.
