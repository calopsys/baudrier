---
name: add-automation
description: "Add an automation - scheduled task, in-app agentic workflow, autonomous product agent, or a personal recurring AI mission. Acts as a smart orchestrator over the four shapes that now exist: /add-cron (a Scaleway Serverless Job with a native cron trigger), /add-workflow (a finite event-triggered pipeline, some steps intelligent, running inside the app or escalating to its own Job), /add-agent (an autonomous product agent on a Scaleway Serverless Job), /add-routine (a recurring personal AI mission on the user's own Claude account). Discovery phase to understand the actual need, infers whether the job belongs to the APP or to the OPERATOR, recommends with plain-words reasoning, and delegates after validation."
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Automation - Discovery & routing

You help the user add an automation: to their project, or to their own toolkit.

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Step 0 - Garde vitrine

**Garde vitrine** : invoke `_detect-project-root` first. If `PROJECT_TYPE=landing`, stop and tell the user, in their language (French shown): « Cette fonctionnalité n’est pas disponible pour un site vitrine : elle est réservée aux applications web. Votre site reste modifiable, et vous pouvez le déployer avec /deploy. »

---

This skill is **pure orchestration** - it scaffolds nothing itself. Your job is:
1. Understand what the user actually wants
2. Infer WHO the automation serves: the app, or the operator (see "The app/ops split")
3. Decide on the right shape and recommend it with reasons
4. Invoke the right skill to do the actual work, and relay its result

You delegate to exactly four skills - every automation in this harness is one of these:
- **`add-cron`** - a scheduled task. Every task becomes its own Scaleway Serverless Job with a native cron trigger (real timezone, up to 24h runtime, no shared clock, no account-wide slot limit to ration).
- **`add-workflow`** - a finite event-triggered pipeline running INSIDE the app by default (2-8 known steps, some intelligent via Scaleway Generative APIs), escalating to its own dedicated Scaleway Job only for the rare pipeline that doesn't fit one request. The most common shape behind "I want an agent".
- **`add-agent`** - an AI-driven process that is part of the PRODUCT (serves the app's end users), with a true agentic loop (tools, memory, budget caps) on its own Scaleway Serverless Job.
- **`add-routine`** (thin front over the **`_create-routine`** engine) - a recurring AI mission on the user's own Claude account, for the operator themselves. Zero infrastructure.

There is no fifth "dedicated worker" option anymore, and that is deliberate - see the note at the end of Step 3.

---

## The app/ops split (the FIRST inference, before any architecture choice)

Every automation belongs to one of two worlds, and mixing them up is the one unforgivable routing mistake:

**A job of the APP** - its output feeds the app or its end users: cleaning the database, sending emails to customers, syncing data the app displays, processing user uploads, webhooks. It must keep running no matter what happens to the operator's tools or subscriptions → it runs on the **app's own infrastructure** (a Scaleway Serverless Job, one way or another).

**A job of the OPERATOR** - its output is for the user themselves (or their team): a morning brief, a weekly analysis, a watch that alerts them, a report, a triage with proposals. It is personal tooling → it runs as a **Claude routine on the user's own account** (their personal AI doing recurring work for them).

### How to infer it (do NOT ask by default)

Read the beneficiary of the output in the user's phrasing:
- "send OUR USERS their weekly digest", "clean up expired sessions", "sync the catalog" → **app**
- "send ME a brief", "alert ME when...", "analyze MY week", "watch my competitors and tell me" → **ops**

Ask ONLY when genuinely ambiguous (e.g. *"a weekly report"* - for whom?). One short question:
> Ce rapport, c'est pour **toi** (ton propre suivi), ou c'est quelque chose que **ton app envoie à ses utilisateurs** ?

### The safety rule, in both directions

- An APP job must NEVER run as a routine: it would depend on the operator's personal Claude subscription (if they cancel, the app silently breaks), it costs AI usage for deterministic work, and routines have a minimum cadence of 1 hour with no strict timing guarantee.
- An OPS job should not get app infrastructure by default: a dedicated Scaleway Job + database wiring to send yourself a weekly brief is heavy machinery for a personal mission your Claude can just... do.

---

## Routing rule: AI-driven processes

When the user describes a process that must **understand / interpret / decide / write** (mentions AI, Claude, GPT, agent, or uses verbs like *analyze, summarize, classify, judge, draft, reason*), combine it with the app/ops split:

- **Ops + AI** ("brief me", "analyze and propose to me", "watch and alert me") → **`_create-routine`** (via `add-routine`). This is the sweet spot of routines: no infrastructure at all, the user's own Claude runs the mission on a schedule.
- **App + AI, finite pipeline** (an event triggers a KNOWN sequence of 2-8 steps, some intelligent: "when a document lands, analyze it, extract, notify"; "on form submit, enrich, summarize, save") → **`add-workflow`**. This is the MOST COMMON case behind the words "I want an agent": no agent is needed, the app itself runs the chain, every run traced step by step. Check it BEFORE reaching for `/add-agent`.
- **App + AI, true agent** (the AI decides its own next actions in a loop with tools, or runs with autonomy: an open-ended assistant for THEIR tickets, a process that plans and acts) → offer to hand off to **`/add-agent`**. Sample phrasing:

> Ce que tu décris est un **agent IA qui fait partie de ton produit**. J'ai une commande dédiée, `/add-agent`, conçue pour ça : elle pose les bonnes questions (modèle, mémoire entre exécutions, plafond budgétaire, outils) et met en place un agent propre avec coupe-circuit budgétaire et traçabilité complète. Je passe la main à `/add-agent` ?

**Edge cases**: a script that calls Claude once (no tool loop) on a SCHEDULE → its logic lives in `/add-cron`'s app-side route, calling Scaleway Generative APIs directly - simple, no special case needed. The same single call triggered by an EVENT, or chained with other steps → `/add-workflow`. The decisive criterion for `/add-agent` is: agentic loop (multi-turn tool use) or autonomy, IN THE PRODUCT - a finite chain, however smart, is a workflow.

---

## Step 1 - Discovery (one open question)

Tell the user:
> Avant de configurer quoi que ce soit, j'ai besoin de comprendre ce que tu veux faire.
>
> **Décris ton besoin en quelques phrases** : ce que doit faire cette automatisation, à quel rythme elle doit tourner, et tout ce qui te semble important.

Wait for the user's response. Read it carefully. Apply the app/ops inference and the AI routing rule from the sections above BEFORE anything else: if it is clearly an ops mission or a product AI agent, short-circuit to the corresponding branch of Step 3.

## Step 2 - Clarify (max 3 questions, only if needed)

Analyze the user's description against these dimensions:

| Dimension | Possible values | Why it matters |
|---|---|---|
| **Beneficiary** | the app / its users, or the operator | The FIRST split: infrastructure vs routine |
| **Execution pattern** | scheduled (a fixed time or interval), or event-driven (a user action, an upload, an incoming webhook) | Determines cron vs workflow |
| **Structure** | a single self-contained action, or a traced chain of several steps (some possibly intelligent) | Determines cron vs workflow - NOT how "heavy" it is: a Scaleway Job runs up to 6 vCPU / 16 GB / 24h, so size alone is rarely the deciding factor anymore |
| **Frequency** (if scheduled) | Daily, hourly, sub-minute, irregular | A Serverless Job's own native cron trigger handles all of these precisely - nothing to route around |
| **Persistence** | Stateless, state kept in the database between runs, or genuinely must stay resident in memory (an open connection, sub-second reactivity) | The third case is rare and is not a one-command scaffold today - see the note at the end of Step 3 |

If the user's description **already covers all these dimensions clearly**, skip to Step 3.

If something is ambiguous, ask **at most 3 short, targeted questions**. Examples:
- *"Tu me dis 'envoyer une newsletter' - grosso modo combien d'emails par envoi ?"*
- *"Ce résumé hebdomadaire, c'est pour toi ou pour les utilisateurs de ton app ?"*
- *"Quand tu dis 'en continu', tu veux dire vraiment 24h/24, ou seulement pendant les heures ouvrées ?"*

**Rule**: no more than 3 questions. If after that it is still unclear, recap what you have understood and ask the user to confirm/correct in one sentence.

## Step 3 - Decide and recommend

Based on what you've learned, choose ONE shape using these heuristics:

### → Recommend a **Claude routine** (`add-routine`) if:
- Beneficiary = the operator (the output is for THEM, not for the app)
- The work needs reading / analyzing / writing / judgment (an AI mission, not a fixed script)
- Frequency ≥ 1 hour (typically daily or weekly)
- **Examples**: morning market brief, weekly analysis of the project's errors with proposals, competitor watch with alerts, weekly cross-service stats digest for the founder

### → Recommend `add-cron` if:
- Beneficiary = the app; Pattern = scheduled; Structure = a single self-contained action (however big - a Job has real headroom); State = stateless or DB-backed
- **Examples**: daily newsletter to subscribers, nightly DB cleanup, hourly API sync, weekly report emailed to customers, keeping the site from cold-starting
- Note: since every `add-cron` task is its own Scaleway Job with a native cron trigger, this is virtually always the right default for scheduled work, regardless of size - there is no "keep it small or it won't fit" ceiling to check anymore.

### → Recommend `add-workflow` if:
- Beneficiary = the app; Pattern = event-driven (a user action, an upload, an incoming webhook) or on-demand
- The work is a **finite chain of known steps** (2-8), possibly with intelligent steps (Scaleway Generative APIs), each run traced step by step
- **Examples**: analyze an uploaded document then notify, enrich a form submission through 2 APIs then summarize, generate and send an invoice on payment, classify an incoming request and draft a reply
- This is the default answer to most "I want an agent" requests, and to most webhooks: the chain lives INSIDE the app by default (no new infrastructure), and escalates automatically to its own Scaleway Job only if a run genuinely can't fit inside one request (`add-workflow`'s own honest gate handles that estimate and, if needed, the escalation - you don't need to pre-judge it here).

### → Recommend **`add-agent`** if:
- Beneficiary = the app's end users; the AI decides its own next actions in a loop with tools, or runs with real autonomy (not a fixed, known sequence)
- **Examples**: an inbox-watching support agent that drafts replies, an open-ended research agent triggered on demand
- This is the heaviest of the four shapes (its own Job, tables, budget caps, optional dashboard) - reach for it only when the AI routing rule above genuinely points here, not for anything a workflow could do.

### A rare fifth case: genuinely continuous, non-AI work

Some needs ("watch a mailbox and react within seconds", "hold a persistent websocket connection", "consume a queue in real time") really do want an always-resident process, not a scheduled tick or an event-triggered run. **Be honest: this harness has no dedicated always-on worker product anymore** (the dedicated-worker options that used to exist were built for a hosting stack this project no longer uses). The closest available building blocks are:
- If a short delay (a few minutes) is actually fine: `add-cron` ticking frequently, or `add-workflow`'s own Job escalation - both are honest, supported paths.
- If it must genuinely stay resident: the Job "continuous" run shape `/add-agent` uses internally (self-restarting daily, polling in a loop) is a real, working pattern, but `/add-agent` itself is scoped to AI-driven agents - offer it only if the process is AI-driven, and say plainly that a non-AI always-on process is not a one-command scaffold today, so the user is not surprised later.

Do not silently force this case into `add-cron` or `add-workflow` and let it fail quietly - say so up front.

### Present the recommendation

Tell the user, with explicit reasoning:

> ## 📋 Recommandation : **<choix>**
>
> Vu ton besoin (<résumé en 1 phrase>), je recommande **<une routine Claude | une tâche planifiée | un workflow dans ton app | un agent autonome>** parce que :
>
> - <raison 1>
> - <raison 2>
> - <raison 3>
>
> <si pertinent : pourquoi les autres options ne conviennent pas ici>
>
> ## ⚙️ Ce que je vais faire concrètement
>
> <if routine>
> Je vais mettre en place une **routine** : une mission que ton propre Claude exécute pour toi à intervalle régulier. Aucune infrastructure, aucun code dans ton projet : on écrit la mission ensemble, on choisit l'horaire, et ton Claude s'occupe du reste. Deux choses honnêtes à savoir avant que tu valides :
> 1. Elle tourne sur **ton compte Claude** (ça consomme un peu de ton abonnement, et ça s'arrête si ton abonnement s'arrête - ce qui est normal, puisque cette mission te sert, pas ton app).
> 2. Selon ta configuration, elle tourne soit dans le cloud (marche même ordinateur éteint), soit sur cet ordinateur quand l'app Claude est ouverte - je te dirai laquelle.
> </if>
>
> <if add-cron>
> Je vais lancer la compétence `add-cron`, qui va :
> 1. Créer une petite tâche planifiée sur l'infrastructure Scaleway, avec un horaire précis dans ton fuseau horaire
> 2. Préparer, si besoin, l'endroit dans ton app où vivra la logique
> 3. Tu n'auras plus qu'à me décrire ce qu'elle doit faire
>
> Aucun monorepo nécessaire. Mise en place en ~5 minutes.
> </if>
>
> <if workflow>
> Je vais lancer la compétence `add-workflow`, qui va mettre en place **une chaîne intelligente dans ton app** :
> 1. Le déclencheur que tu as décrit (<action utilisateur | webhook sécurisé | horaire>)
> 2. Les étapes, exécutées dans l'ordre, avec nouvelle tentative automatique en cas d'incident réseau<si étapes IA> - les étapes intelligentes appellent l'IA de Scaleway</if>
> 3. Une trace de chaque exécution, étape par étape, dans ta base de données
>
> Aucune nouvelle infrastructure, aucun déploiement en plus de ton app elle-même. Mise en place en ~5-10 minutes.
> </if>
>
> <if agent>
> Je vais passer la main à `/add-agent`, qui va poser quelques questions (modèle IA, mémoire entre exécutions, plafond de budget, outils) puis mettre en place un agent complet : sa propre tâche planifiée Scaleway, ses tables de traçabilité, son coupe-circuit budgétaire.
>
> Mise en place en ~10 minutes, questions comprises.
> </if>
>
> Tu valides cette approche ? Si tu préfères une autre option, dis-moi laquelle et pourquoi.

**Wait for explicit user validation** before continuing.

If the user disagrees with the recommendation, listen to their reasoning. They may have constraints you didn't know about (cost, existing habits, personal preference). Adjust the recommendation accordingly. If the user is convinced of an option that's clearly wrong for their use case, push back politely once, but ultimately respect their choice. The ONE exception where you insist harder: an app-critical job on a routine (explain that their app would silently break if their Claude subscription stopped, and that a Scaleway Job costs them close to nothing anyway).

## Step 4 - Execute

### Branch A - User accepted `add-cron`

Invoke the **`add-cron`** skill with the discovery material (description, schedule). It handles its own mode inference, secret generation, `CLAUDE.md` update and final summary - when it returns, go straight to Step 5.

### Branch W - User accepted the in-app workflow

Invoke the **`add-workflow`** skill with the discovery material (trigger, steps, which steps are intelligent). It handles its own scaffolding, duration gate (and Job escalation if needed), `CLAUDE.md` section and summary - when it returns, go straight to Step 5.

### Branch Agent - User accepted `/add-agent`

Invoke the **`add-agent`** skill with the discovery material as its initial description. It runs its own discovery questions, scaffolding and summary - when it returns, go straight to Step 5.

### Branch D - User accepted a Claude routine

Invoke **`add-routine`** with the goal and cadence gathered during discovery. It handles: mechanism detection (cloud/local), the honest warnings, the self-contained mission prompt (validated by the user), creation and verification, and its own `CLAUDE.md` note when relevant - when it returns, go straight to Step 5.

### Branch X - Genuinely continuous, non-AI need

Do not invoke any skill automatically. Present the honest options from Step 3's "rare fifth case", let the user pick a concrete direction (a frequent `add-cron` tick, `add-workflow`'s Job escalation, or - only if they confirm the process should be AI-driven - `/add-agent`'s continuous mode), then invoke the matching skill as in the branches above.

## Step 5 - Final summary

Each of the four skills already prints its own complete final summary (schedule, what was created, how to manage it). Do not repeat it. Add one short closing line:

> Voilà, c'est en place. Si tu changes d'avis sur l'architecture plus tard, relance `/add-automation` et on réévalue ensemble.

If the branch failed or was left incomplete, relay the delegate skill's own error/handoff state honestly - never claim success if the underlying skill did not report one.
