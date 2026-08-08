---
name: add-cron
description: Add a scheduled task (CRON) to an existing Next.js project. Creates a Scaleway Serverless Job with a native cron trigger - real IANA timezones, no account-wide slot limit, up to 24h runtime. For anything that needs the app's own database, email, or business logic, also creates a protected /api/cron/<task-name> route the Job calls; a "keep my site warm" task instead pings the app's own health-check endpoint (health probes alone never wake a scaled-to-zero container); a pure third-party ping needs neither. Can be called by /bootstrap, by /add-automation, or standalone.
argument-hint: "[description of what the cron should do]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Cron - Scheduled tasks on a native Scaleway Job

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You add a scheduled task to the current Next.js project. You **decide yourself** where the task's logic should live, based on its nature. You ask the user NOTHING about this choice - you act, then you explain in 1 sentence what you did in the final summary.

## Non-tech audience: language rules

The users of this plugin may be non-technical. In EVERYTHING you show to the user:

- **Zero gratuitous jargon**. No "Job", "cron expression", "endpoint", "query param", "bearer token", "repo" without explanation. When a technical term is unavoidable, put it in parentheses or explain it in a short clause.
- **Speak in business terms, not infrastructure**. Say *"a scheduled task"* rather than *"a cron"*, *"your site"* rather than *"your Next.js container"*.
- **NEVER suggest commands to type**. The user does not open a terminal. When an action is possible (delete, test, view the logs, change the schedule), offer it in natural language - *"dis-moi 'supprime la tâche X' et je m'en occupe"*, *"tu veux que je la lance tout de suite pour tester ?"*. Claude executes, the user does not type.
- **Avoid tech anglicisms** (*"skipped"*, *"deploy"*, *"fallback"*) in user-facing blocks. Internal use only.

---

## How it works (one mechanism, not three)

Every scheduled task becomes **one Scaleway Serverless Job with a native cron trigger** (`scripts/scaleway/jobs.mjs` - `ensureJobDefinition` + `setSchedule`). Scaleway Jobs support real IANA timezones directly, so the schedule stays in the user's own wall-clock time (e.g. `Europe/Paris`) - there is no UTC conversion step to get wrong. Jobs allow up to 1,000 definitions per Organization and run up to 24h, so there is no slot to ration and nothing to route around: **no shared worker, no dedicated worker, no fallback clock.**

The Job's body is always the same tiny, public `curlimages/curl` image (Scaleway Serverless Jobs can pull public registry images directly - no build, no push, no Docker on the user's machine). What differs is **where the task's actual logic lives**, decided silently in Step 4:

| Mode | The Job pings... | The logic lives in... | When |
|---|---|---|---|
| `app-route` (the default) | a protected `/api/cron/<task-name>` route | the Next.js app (full access to the database, email, everything already coded there) | Anything that reads/writes data, sends an email, or reuses app code - the large majority of tasks |
| `keep-warm` | the app's own health-check endpoint | nowhere - there is nothing to write | The task's only purpose is to generate real traffic (see the callout below) |
| `ping-external` | a third-party URL the user gave | nowhere - the Job's own request IS the task | A plain, no-transformation ping to an outside service (a webhook, a public status endpoint) |

**Health checks do not wake a scaled-to-zero container - only real traffic does.** That is exactly why `keep-warm` is its own mode: a Job making a genuine HTTP request is the only thing that works.

---

## Preflight

Invoke `_detect-project-root` to retrieve `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`, `IS_MONOREPO`. Abort if `IS_NEXTJS=no`.

### Sanity check (is the need really a cron?)

**Good candidate:**
- Daily, hourly, or every-N-minutes schedules
- A run that finishes in well under the Job's budget (see below - generous, but still not infinite)
- No need for the process to stay alive between runs

**Bad candidate (→ suggest `/add-automation` instead):**
- A continuous listener (WebSocket, queue consumer) that must stay up between ticks
- Genuinely needs in-memory state carried across runs (not just what's in the database)

Scaleway Serverless Jobs run up to **6 vCPU / 16 GB RAM / 24h** - there is no old "under 60 seconds, stateless" ceiling to warn about anymore. Almost nothing described as "a scheduled task" is too big for a Job; the real dividing line is *continuous* vs *scheduled*, not *big* vs *small*. If in doubt, continue - `/add-automation` will still catch a genuine mismatch.

If no red flag, continue silently.

---

## Step 1 - Get the task description

If the user passed a description as an argument (`$ARGUMENTS` not empty), use it directly. **Do not ask.**

Otherwise, ask:

> À quoi va servir cette tâche planifiée ?
>
> Décris en une phrase ce qu'elle doit faire, par exemple :
> - *"envoyer un rapport SEO hebdomadaire par email"*
> - *"réinitialiser les compteurs d'usage à minuit"*
> - *"synchroniser mes données avec une API externe toutes les heures"*
> - *"empêcher mon site de s'endormir"*

Capture the answer in `TASK_DESCRIPTION`.

---

## Step 2 - Project prerequisites

(Already done in Preflight - `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO` are available.)

---

## Step 3 - Ask for the schedule

> Quand veux-tu que cette tâche s'exécute ?
>
> Dis-le avec tes propres mots, par exemple : *"tous les jours à 9h"*, *"chaque lundi matin"*, *"toutes les heures"*, *"le 1er du mois à minuit"*.

Convert it into a 5-field cron expression **in the user's own local time** - Scaleway Jobs run on real IANA timezones, so no UTC conversion is needed. Store it in `CRON_EXPR` and keep the human-readable version in `CRON_HUMAN`. Default `TIMEZONE` to `Europe/Paris` unless the user is clearly elsewhere.

Also ask (skip if the description already makes it obvious, e.g. "keep my site warm"):

> Donne un nom court à cette tâche, pour qu'on puisse la reconnaître facilement plus tard. Par exemple : `rapport-hebdo`, `sync-clients`, `nettoyage`.

Store it in `TASK_NAME` (kebab-case ASCII).

---

## Step 4 - Infer the mode (silently)

**You ask the user nothing.**

### 4.a - `keep-warm`

Triggers when the description is about preventing cold starts / keeping the site responsive / "wakes up slowly" - e.g. *"keep my site from falling asleep"*, *"my site is slow to open"*, *"ping my site regularly"* with no other business logic implied. `TASK_NAME` defaults to `keep-warm` if not given.

### 4.b - `ping-external`

Triggers ONLY when the description is a plain, no-processing ping to a URL the user explicitly gives (a webhook, a status endpoint of a service they name) - and involves no reading/writing of the app's own data. Rare. If picked, ask for the URL:

> Quelle adresse dois-je contacter ? (le lien exact que l'autre service t'a donné)

Capture `TARGET_URL`.

### 4.c - `app-route` (the default)

Everything else - which is most tasks: it reads or writes the app's own data, sends an email, calls an external API and does something with the result, etc.

Build `REASON` (1 non-tech sentence, in French) for the final summary:
- `app-route`: *"J'ai mis la logique de ta tâche directement dans ton app, là où elle a déjà accès à tout ce dont elle a besoin, et j'ai programmé un horaire précis."*
- `keep-warm`: *"J'ai mis en place une petite tâche qui visite ton site à intervalle régulier, car seule une vraie visite - pas une simple vérification automatique - l'empêche de s'endormir."*
- `ping-external`: *"J'ai mis en place une petite tâche qui contacte l'adresse que tu m'as donnée, à l'horaire que tu as choisi."*

---

## Step 5 - Generate CRON_SECRET (only for `app-route`, if absent)

Check whether `CRON_SECRET` already exists in `.env`:
```bash
grep -q "^CRON_SECRET=" .env 2>/dev/null && echo "exists" || echo "missing"
```

### If missing
Invoke `_generate-secret` with `format=hex`, `length=32`. Capture the value.

Invoke `_push-env-vars` with:
- `CRON_SECRET=<value>`

This also writes it to Scaleway Secret Manager (CONTRACT.md §2 - a secret's name IS the env var name), which is where `setup-cron-worker.mjs` reads it back from - nothing to pass by hand.

### If present
Nothing to do - the script reads it itself.

---

## Step 6 - Create the Job

```bash
WEB_DIR_FLAG="--web-dir <WEB_DIR>"

result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/setup-cron-worker.mjs" \
  --action ensure \
  --task-name "<TASK_NAME>" \
  --mode "<app-route|keep-warm|ping-external>" \
  --cron-expr "<CRON_EXPR>" \
  --timezone "<TIMEZONE>" \
  --project-name "<PROJECT_NAME>" \
  $WEB_DIR_FLAG \
  --description "<TASK_DESCRIPTION>" \
  {{IF mode=ping-external}}--target-url "<TARGET_URL>"{{/IF}})
```

This single call does everything for the chosen mode: creates the protected route (`app-route` only, never overwrites an existing one on a re-run), exempts `/api/cron/` from the project's IP allowlist gate in `src/proxy.ts` (the route already authenticates itself via the secret - IP-gating it too would only block the Job, whose requests do not come from the VPN, CONTRACT.md §6), and creates/updates the Scaleway Job with its cron trigger.

Parse the JSON result:
- `ok=true, jobCreated=true` → done, the schedule is live.
- `ok=true, jobCreated=false` (only possible for `app-route`/`keep-warm`) → the project has never been deployed yet, so its public address doesn't exist. Everything else is ready. Tell the user honestly: *"Tout est prêt, mais je ne peux activer l'horaire qu'une fois ton site mis en ligne pour la première fois. Une fois que ce sera fait, dis-le-moi et je termine en une étape."* Remember `TASK_NAME`, `MODE`, `CRON_EXPR`, `TIMEZONE` for that follow-up (same command, `jobCreated` will be `true` the second time).

---

## Step 7 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `custom` heading: `## Cron`
- Body (adapt to the mode):

For **`app-route`**:
```
- **<TASK_NAME>** - `<CRON_EXPR>` (<TIMEZONE>, <CRON_HUMAN>) → Scaleway Job `<JOB_NAME>` → `/api/cron/<TASK_NAME>` (logic lives there)
```

For **`keep-warm`**:
```
- **<TASK_NAME>** (keep-warm) - `<CRON_EXPR>` (<TIMEZONE>, <CRON_HUMAN>) → Scaleway Job pings `/api/healthz`
```

For **`ping-external`**:
```
- **<TASK_NAME>** (external ping) - `<CRON_EXPR>` (<TIMEZONE>, <CRON_HUMAN>) → Scaleway Job pings `<TARGET_URL>`
```

Add as the section intro (created only once):
```
Scheduled tasks. Each one is a Scaleway Serverless Job with its own native cron trigger (real timezone, up to 24h runtime, no shared clock or account-wide slot limit). Most tasks run their logic in `/api/cron/<name>`, protected by a `?secret=` query param checked against `CRON_SECRET`; a couple of special tasks (keep-warm, a plain external ping) need no app code at all.
```

And `env-vars` (only if an `app-route` task exists):
- `- \`CRON_SECRET\` - secret used to authenticate the scheduled Job against \`/api/cron/<name>\``

---

## Step 8 - Final summary

Choose the right block according to the mode, incorporating `REASON` in non-tech language.

### If `app-route`
> ## ✅ Ta tâche **<TASK_NAME>** est en place
>
> Elle se déclenchera **<CRON_HUMAN>**. <REASON>
>
> Pour l'instant elle ne fait rien de concret - j'ai préparé le fichier où tu écriras ce qu'elle doit faire (*<TASK_DESCRIPTION>*). Dis-moi ce qu'elle doit exécuter et je code la logique pour toi.
>
> Tu peux aussi me demander à tout moment :
> - *"lance la tâche tout de suite pour tester"*
> - *"change l'horaire pour X"*
> - *"supprime cette tâche"*

### If `keep-warm`
> ## ✅ Ton site va maintenant rester éveillé
>
> Toutes les <CRON_HUMAN>, une petite visite l'empêche de se rendormir entre deux vrais visiteurs. <REASON>
>
> Tu peux me demander *"arrête de garder mon site éveillé"* à tout moment.

### If `ping-external`
> ## ✅ Ta tâche **<TASK_NAME>** est en place
>
> Elle se déclenchera **<CRON_HUMAN>**, en contactant l'adresse que tu m'as donnée. <REASON>
>
> Tu peux aussi me demander : *"lance-la tout de suite pour tester"*, *"change l'horaire"*, *"supprime cette tâche"*.

---

## Natural-language management (after setup)

- **"run the task right now"**: `node "${CLAUDE_SKILL_DIR}/../../scripts/setup-cron-worker.mjs" --action run-now --task-name <TASK_NAME> --project-name <PROJECT_NAME>`. Relay the run's outcome (`succeeded`/`failed`) in plain language.
- **"show me my scheduled tasks"**: `node "${CLAUDE_SKILL_DIR}/../../scripts/setup-cron-worker.mjs" --action list --project-name <PROJECT_NAME>`. Present the list in plain language (name + schedule).
- **"change the schedule"**: re-run Step 6 with the new `--cron-expr`/`--timezone` (same task name = update in place, idempotent).
- **"delete this task"**: `node "${CLAUDE_SKILL_DIR}/../../scripts/setup-cron-worker.mjs" --action delete --task-name <TASK_NAME> --project-name <PROJECT_NAME> [--web-dir <WEB_DIR>] --remove-route`. Only pass `--remove-route` if the user also wants the `/api/cron/<name>` route deleted (ask first if it contains real logic they might want to keep).
