---
name: scale
description: View or change the compute size of a deployed Serverless Container - S/M/L/XL presets that move CPU, memory, and max-concurrency together, plus min_scale (0 = scale to zero and cost nothing idle, 1 = always warm, no cold starts) - and the Serverless SQL Database's autoscaling bounds (provisioned at 0-5 vCPU by /add-db, adjustable up to 15). Shows a plain-French cost estimate per preset. Use when the user says "scale up", "it's too slow", "make it bigger/smaller", "keep it always warm", "avoid cold starts", "scale the database", "/scale".
argument-hint: "[S|M|L|XL]"
allowed-tools: Bash AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use scw, gh."
---

# Scale

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You read or change how much compute a deployed container gets. Everything here reads from `SCALE_PRESETS` in `scripts/scaleway/container.mjs` (S/M/L/XL) - never re-hardcode the CPU/memory/concurrency numbers in this skill, always let `scripts/scale.mjs` report the live values so the two can't drift apart.

---

## Step 1 - Identify the environment

Invoke `_detect-project-root` to get `PROJECT_NAME`. Detect the stack (never guess from the description):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/_stack.mjs"
```

This prints `{"stack":"landing"|"application"|"unknown"}`. A `landing` (vitrine) has no database and no concurrency choice - Steps 2 to 4 below note where it differs, and the **Database** section does not apply to it at all.

If the user didn't specify which environment, ask via `AskUserQuestion`:
- Question: "Quel environnement voulez-vous ajuster ?"
- Options: `Production` / `Aperçu (branche actuelle)`

**If the user's request is about the database** (they mention "base de données", slow queries, database cost, or the app has a database and they ask "everything"): for an `application`, jump to the **Database** section at the end instead of (or in addition to) the container flow below. For a `landing`, say so in French and stay in the container flow: « Ce site vitrine n’a pas de base de données : il n’y a rien à ajuster de ce côté. »

---

## Step 2 - Show the current size and the presets

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scale.mjs" current --project-name "<PROJECT_NAME>" --target <production|preview> [--branch <branch>]
node "${CLAUDE_SKILL_DIR}/../../scripts/scale.mjs" presets
```

If `current` reports `container_not_found`, tell the user to run `/deploy` first - there's nothing to scale yet.

Present the presets as a simple table, in French, using the numbers the script just printed (do not invent your own numbers):

| Taille | CPU | Mémoire | Requêtes simultanées/instance | Coût estimé si toujours allumé |
|---|---|---|---|---|
| S | ... | ... | ... | ~... €/mois |
| M | ... | ... | ... | ~... €/mois |
| L | ... | ... | ... | ~... €/mois |
| XL | ... | ... | ... | ~... €/mois |

**Vitrine (Astro/Caddy)** : présentez uniquement le CPU et la mémoire de chaque taille, sans la colonne « Requêtes simultanées/instance » ni l’explication ci-dessous - la concurrence reste fixée à 80 requêtes simultanées quelle que soit la taille choisie, un site statique servi par Caddy n’ayant pas de traitement lourd susceptible de saturer une instance. Ajoutez cette phrase à la place : « La concurrence reste à 80 requêtes simultanées pour ce site vitrine, quelle que soit la taille choisie. »

For an **application**, explain **why concurrency moves with CPU**, in plain language:
> Scaleway limite par défaut chaque instance à 80 requêtes en même temps. Avec seulement 250 mvCPU (taille S), ça sature bien avant que Scaleway ait le temps de démarrer une deuxième instance - c'est pour ça que la taille S limite volontairement à 8 requêtes simultanées : mieux vaut démarrer une nouvelle instance plus tôt que de faire attendre les visiteurs.

Explain **min_scale**, in plain language:
> - `min_scale = 0` : le site se met en veille quand personne ne le visite, donc ça ne coûte quasiment rien à l'arrêt - mais le tout premier visiteur après une pause attend quelques secondes le temps que le site redémarre ("cold start").
> - `min_scale = 1` : une instance reste toujours allumée, donc jamais d'attente au démarrage - mais ça coûte le prix indiqué ci-dessus en continu, même sans aucun visiteur.

**Mandatory correction if the user suggests using health checks to keep the app warm**: health checks do **not** wake, and do not keep alive, a container scaled to zero - only real traffic does. If the user wants an always-responsive app without paying for `min_scale=1`, the only way is a Serverless Job that pings the app on a schedule (a real HTTP request), not a monitoring/health-check tool. Say this explicitly rather than letting the user set up a health-check monitor that silently won't work.

---

## Step 3 - Ask what to change

Ask via `AskUserQuestion`:
- Question: "Quelle taille voulez-vous appliquer ?"
- Options: `S` / `M` / `L` / `XL` (mark the current one)

Then ask about `min_scale` only if relevant to what the user is trying to achieve (e.g. they mentioned slowness at startup, or cost):
- Question: "Le site doit-il rester toujours allumé, ou peut-il se mettre en veille quand personne ne visite ?"
- Options: `Toujours allumé (min_scale=1)` / `Veille automatique (min_scale=0, par défaut)`

**Vitrine (Astro/Caddy), environnement production** : cette valeur démarre à `min_scale=1` (toujours allumé), pas à 0 comme pour une application. Si le choix ferait passer la production en dessous de `min_scale=1`, avertissez d’abord en français avant de continuer : « Votre site vitrine en production reste allumé en permanence pour éviter tout temps de démarrage. Le mettre en veille fera attendre quelques secondes le premier visiteur après une pause : voulez-vous vraiment continuer ? »

---

## Step 4 - Apply

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scale.mjs" apply \
  --project-name "<PROJECT_NAME>" \
  --target <production|preview> [--branch <branch>] \
  --preset <S|M|L|XL> \
  [--min-scale <0|1>] \
  [--max-concurrency <N>]
```

**Vitrine (Astro/Caddy)**: always add `--max-concurrency 80` here, whatever preset was chosen - a static site's concurrency never moves with size (Step 2's note above).

Wait for the container to report ready (the script waits for you and prints a final JSON line). Relay the result:

> ✅ Taille **<preset>** appliquée sur **<environnement>**. Coût estimé si toujours allumé : ~<estimatedMonthlyCostAlwaysOnEur> €/mois. Le conteneur est prêt.

If `min_scale` wasn't changed, don't claim it was.

---

## Database - Serverless SQL autoscaling bounds

**This section applies only to an `application`.** A `landing` (vitrine) has no database at all - refuse in French and stop here: « Ce site vitrine n’a pas de base de données : il n’y a rien à afficher ou à modifier ici. »

The database scales its own compute independently of the container, between two bounds in vCPU units. `/add-db` provisions every database at **0 → 5 vCPU** (0 = the database sleeps and costs nothing when idle; 5 caps what a traffic spike can cost). This section changes those bounds.

Show the current bounds:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scale.mjs" db-current --project-name "<PROJECT_NAME>"
```

If it reports `database_not_found`, tell the user the project has no database yet (`/add-db` creates one) and stop here.

Explain, in plain French, before any change:

> La base de données s’adapte toute seule entre deux bornes :
> - **Borne basse à 0** : la base se met en veille quand rien ne l’utilise, et ne coûte alors rien. Le premier accès après une pause prend quelques secondes de plus. Une borne basse à 1 ou plus la garde toujours allumée (plus réactive, mais facturée en continu).
> - **Borne haute** : le plafond que la base peut atteindre en cas de forte activité. C’est votre garde-fou de coût : elle ne dépassera jamais cette puissance, donc jamais le coût correspondant. Maximum autorisé par Scaleway : 15.

Ask what the user wants via `AskUserQuestion` (propose keeping 0 as the low bound unless they complained about first-access slowness), then apply:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/scale.mjs" db-apply --project-name "<PROJECT_NAME>" --min-cpu <N> --max-cpu <N>
```

The script validates 0 <= min <= max <= 15 and prints a final JSON line. Relay:

> ✅ La base de données s’adapte maintenant entre **<cpuMin>** et **<cpuMax>** vCPU.
