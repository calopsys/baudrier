# /add-agent

Creates an autonomous AI agent that runs in your project and decides on its own which actions to take. Ideal for reading emails, summarizing articles, watching a feed, or any workflow that calls for understanding rather than predefined steps.

## When to use it

- You want an assistant that reads your support emails and proposes replies as drafts
- You want an agent that aggregates the news from several RSS feeds every morning and emails you a brief
- You want to watch a queue of events (orders, alerts, signals) and trigger smart actions
- You want to automate a workflow that requires **understanding**: read a text, summarize it, classify it, write a personalized reply

**Good to know**: when the mission is actually personal (a brief or digest **for you**, at a fixed cadence), Baudrier first offers a much lighter path, a **routine** on your own Claude account, instead of scaffolding the full agent (see below).

**Not suitable for**: a real-time chatbot on your site (user-facing conversational UI), a simple cron without AI, a non-AI process. Baudrier automatically redirects you to the right command if it detects a mismatch.

## How it works

1. **Checks**: Baudrier verifies that you have a database (to store the agent's history) and email sending configured (for notifications). Otherwise, it offers to run `/add-db` and/or `/add-email` first.

2. **Discovery (5 questions max, in plain language)**:
  - **Q1**: What is the agent's goal? (in one sentence, with concrete examples)
  - **Q2**: When should the agent run? (at a fixed time / continuously / on demand). If at a fixed time, the cadence is specified.
  - **Q3**: Should it **remember** between its runs? (simple key-value memory, or semantic memory, or no memory)
  - **Q4**: Which model? (a balanced Scaleway Generative APIs model by default; a larger one for complex tasks)
  - **Q5**: What cost cap? (default: 1 EUR/day, 10 EUR/month, the agent pauses if it exceeds it and warns you by email)

3. **The routine shortcut**: right after the goal question, Baudrier checks WHO the mission serves. If the output is for **you** (a morning brief, a weekly digest, a watch report) and it runs at fixed times (every hour or less often), it offers a **routine** instead: your own Claude runs the mission on schedule, with zero infrastructure, zero code, ready in 2 minutes. The full agent remains the right choice when the agent serves **your app's users**, must watch something **continuously**, or must be triggered from a dashboard with detailed, auditable execution logs. You pick, Baudrier does the rest.

4. **Monorepo conversion if needed**: to host the agent alongside your Next.js, Baudrier converts your project into a Turborepo (idempotent).

5. **Scaffolding**:
  - The agent lives in its own folder under `apps/` (named after your agent), deployable as a **Scaleway Serverless Job**
  - A clean agentic loop on **Scaleway Generative APIs** (OpenAI-compatible)
  - Default tools: `http-fetch` (read URLs), `send-email` (write to you), `db-query` (read the DB, SELECT only)
  - Plus other tools depending on the goal
  - If memory is enabled: tables `agent_memory_kv` (key-value) or `agent_memory_vector` (semantic search, via the same Scaleway credentials - no new vendor)
  - Automatic **circuit breaker**: tracks cost in real time (EUR), pauses the agent if the cap is exceeded, warns you by email
  - **Full persistence**: each run + each decision turn is saved in your database for audit
  - Its own Scaleway API keys, scoped narrowly and minted automatically - nothing to create or paste

6. **Deployment via `/deploy`**: Scaleway Serverless Jobs are fully API-driven, so there is no manual dashboard step. `/deploy` builds the image, applies the database migration, and creates/updates the agent's Job automatically.

7. **Optional dashboard**: Baudrier then offers to add `/admin/agents`, a dashboard to monitor your agents (`/add-agent-dashboard`).

## What it creates for you

- A Turborepo project if not already one (with `apps/web/` + your agent's own folder under `apps/`)
- A complete AI agent: agentic loop, tools, optional memory, circuit breaker, persistence
- Database tables: `agent_invocations`, `agent_turns`, `agent_memory_kv`, `agent_trigger_queue` (+ `agent_memory_vector` if semantic memory) - applied via a migration on your next `/deploy`
- Its own scoped Scaleway API keys in Secret Manager (`SCW_GENERATIVE_API_KEY`, `TEM_API_SECRET_KEY`)
- `apps/<name>/job-definition.json`, the declarative Scaleway Serverless Job spec `/deploy` uses
- The **stack diagram** updated in `CLAUDE.md`

(If you chose the routine shortcut instead, none of the above is created: you get a recurring mission on your own Claude account, plus a note in `CLAUDE.md`.)

## Prerequisites

- The project must be in Next.js (typically initialized by `/bootstrap`)
- Database configured (`/add-db`)
- Email sending configured (`/add-email`), otherwise the agent can't alert you when it breaks
- The four `SCW_*` variables set in your Baudrier cloud environment - the agent mints its own scoped keys from there, nothing extra to create

## Tips

{{callout:tip|A brief for yourself? A routine is enough}}
If the goal is a scheduled mission whose output is for **you** (morning brief, weekly digest, watch report), you do not need a Job, database tables, or a dashboard: a **routine** on your own Claude account does it with zero infrastructure. Honest counterpart: it consumes a bit of your Claude subscription and stops if the subscription stops. Fine for a personal mission, never acceptable for something your app depends on: those keep the full agent machinery.
{{/callout}}

{{callout:warning|The circuit breaker is your best friend}}
By default, the agent stops automatically if it exceeds **1 EUR/day or 10 EUR/month**. This is crucial: an agent that loops can consume quickly. You receive an alert email, and you can decide to raise the cap or dig into the bug. **Never disable the circuit breaker.**
{{/callout}}

{{callout:tip|Memory = optional but powerful}}
- **KV (key-value)**: for simple data (user preferences, last processed ID, counters). Fast, direct lookup.
- **Semantic (vector)**: for free-text knowledge that the agent can search by meaning (notes, articles, conversations). More costly but much more powerful. Uses the same Scaleway credentials as the rest of the agent - no new vendor, no new key.
- **No memory**: the agent starts from scratch on each run. Enough for many cases (daily digests, etc.).
{{/callout}}

{{callout:info|Full audit by default}}
Each run of the agent is traced in the database: initial prompt, each reasoning turn (generated text, tools used, results), cost in EUR, duration. You can replay / review everything from the `/admin/agents` dashboard (skill `/add-agent-dashboard`). Essential for understanding what your agent does and debugging it.
{{/callout}}

{{callout:info|Finite runs, not an always-on server}}
A Scaleway Serverless Job runs in bursts, not forever. Depending on how you trigger it, a manual "Run now" click or even a scheduled run can take a few minutes to be picked up rather than a few seconds - the trade-off for near scale-to-zero billing between runs. Baudrier tells you the exact trade-off for your chosen trigger at setup time.
{{/callout}}
