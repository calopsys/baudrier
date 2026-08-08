---
name: costs
description: Show real Scaleway spend for the app's Project (per service, with a total, via the Billing API) plus Transactional Email consumption. Also shows static reference limits (TEM caps, Serverless Containers free tier) clearly labeled as fixed reference values, not live usage, since Scaleway has no quota-vs-limit API. Use when the user says "how much am I spending", "what's this costing me", "show my bill", "/costs".
argument-hint: "[mois AAAA-MM]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use scw, gh."
---

# Costs

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You report **real** money spent on Scaleway for this app's Project, plus email usage - never an estimate when a real number is available.

---

## Step 1 - Run the script

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/costs.mjs" [--months N] [--from AAAA-MM] [--to AAAA-MM]
```

Default (no flags) reports the **current calendar month only**. If the user asks for "the last 3 months" or similar, pass `--months 3`; if they name explicit months, pass `--from`/`--to` in `YYYY-MM` form.

Run it from the app's project directory: the script scopes every number to **this app's own Scaleway Project** (the harness resolves the Project by name - the app name, which is the repo name; `SCW_DEFAULT_PROJECT_ID` overrides the lookup) and filters out every other Project's rows - the user must never see Organization-wide figures here. If the JSON reports `"projectSource":"default-project"`, the name lookup did not find a dedicated Project: relay the script's warning and ask the user to run the command from their project folder (or name the project) before presenting any number as "this app's costs".

**Important granularity note to keep in mind while relaying this**: Scaleway's billing API only reports whole calendar months, not arbitrary date ranges - if the user asks "how much did the last 10 days cost", explain that Scaleway can only break this down by month, not by day, and give them the current month's total instead of pretending to have a daily figure.

---

## Step 2 - Relay the numbers, in French, plainly

From the script's final JSON line, present:

1. **Total** for the period, in euros.
2. **Breakdown by service** (`byCategory`), sorted biggest first - name each Scaleway service in plain language (e.g. "Conteneurs serverless" rather than the raw API category string, if it's cryptic).
3. **Breakdown by month** (`byPeriod`) if more than one month was requested.
4. **Transactional email**: number of emails sent this period if the script could parse it (`tem.emailsSent`); otherwise say email usage was retrieved but the harness couldn't extract a simple count from it, and offer to show the raw detail if the user wants it.

If `byCategory` is empty, say plainly that there was no billed usage this period (likely still inside Scaleway's free tier) rather than implying something went wrong.

---

## Step 3 - Reference limits [ALWAYS include this caveat]

The script also prints a small table of **static reference limits** (`referenceLimits` in the JSON, `referenceLimitsAreLive: false`). When you show these to the user:

🚨 **Always say explicitly, in French, that these are fixed reference values maintained by hand, NOT a live read of the account's actual usage** - Scaleway has no API that reports "you've used X of your Y allowance" for these. Suggested phrasing:

> ℹ️ Les limites ci-dessous sont des **valeurs de référence fixes** (Scaleway ne fournit aucune API pour lire votre usage réel par rapport à un quota) - elles ne reflètent pas votre consommation actuelle, seulement ce que Scaleway autorise en général :
> - Transactional Email : 500 emails/mois et 2 domaines avant vérification d'identité (KYC), 5 000 emails/mois et 5 domaines après.
> - Conteneurs serverless : 200 000 vCPU-secondes et 400 000 GB-secondes gratuits par mois, tous conteneurs confondus.

Never present these as "you have used X / Y" - that number doesn't exist. Only the real spend from Step 2 is a live figure.
