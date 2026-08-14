# /add-automation

Adds an automation: a process that runs in the background for your app, or a recurring mission for yourself. Scheduled task, intelligent chain, autonomous agent, or a personal AI brief: Baudrier analyzes your need and picks the right shape for it.

## When to use it

- You want something to run **at a fixed time** (a report, a cleanup, a sync)
- You want a **chain of steps** to run automatically when something happens (a document lands, a form is submitted, a payment arrives) - some steps possibly intelligent
- You want a **true AI agent** that is part of your product, deciding its own actions
- You want a **recurring mission for yourself**: a morning brief, a weekly analysis, a watch that alerts you

Baudrier asks one open question, infers who the automation serves, and routes you to the right dedicated command: `/add-cron` (scheduled task), `/add-workflow` (intelligent chain inside your app), `/add-agent` (autonomous product agent), or `/add-routine` (recurring mission for yourself).

## How it works

1. **Discovery (1 open question)**: Baudrier asks you to describe your need in a few sentences: what this automation will do, how often it should run, and anything else that seems important to you.

2. **First inference: who is it for?** Before any technical choice, Baudrier determines who benefits from the result:
  - **Your app or its users** (cleaning the database, emailing customers, syncing data the app displays) → the job runs on the **app's own infrastructure**, so it keeps running no matter what happens to your personal tools.
  - **You** (a brief, an analysis, a watch, a report for your own eyes) → if the work needs AI (reading, judging, writing), it becomes a **Claude routine**: a recurring mission that your own Claude runs for you. Zero infrastructure, zero code in the project.

   Baudrier infers this from your phrasing and only asks when genuinely ambiguous (*"a weekly report"*, for whom?).

3. **Targeted clarifications** (max 3 questions, only if needed): Baudrier analyzes your answer against a few dimensions - is it triggered by an event or by a schedule, is it one self-contained action or a chain of several steps, does it need to remember things between runs.

   If everything is clear after your first description, Baudrier asks no question and goes straight to the recommendation.

4. **Automatic decision**:
  - **Personal recurring AI mission** → **Claude routine** (your own Claude runs it on schedule; no infrastructure at all)
  - **Simple scheduled task for the app** → delegates to `/add-cron` (its own precisely scheduled task on Scaleway, no size limit to worry about)
  - **Finite event-triggered chain, possibly intelligent** → delegates to `/add-workflow` (the chain runs inside your app, every run traced step by step; escalates itself if a run is genuinely too long)
  - **A true AI agent for your app's end users** → hands off to `/add-agent` (a production agent with budget caps and full traceability)

5. **Setting it up**: Baudrier hands off to the chosen command, which does its own setup and reports back with its own summary - schedule, what was created, and how to manage it going forward.

## What it creates for you

Nothing directly - `/add-automation` is a router. Whatever it created is described in the summary of the command it handed off to (`/add-cron`, `/add-workflow`, `/add-agent`, or `/add-routine`).

## Prerequisites

- The project must be in Next.js (typically initialized by `/bootstrap`)
- For a Claude routine: nothing but your Claude subscription (the routine runs on your own account)

## Tips

{{callout:info|Your app or you? The one split that matters}}
A job that serves **your app** runs on the app's own infrastructure: it must keep running even if you change tools or cancel subscriptions. A job that serves **you** can become a **routine**: your own Claude runs it, with zero infrastructure. Two honest things about routines: each run consumes a bit of your Claude subscription, and if your subscription stops, the routine stops with it. That is exactly why anything your app depends on NEVER goes on a routine. Also good to know: minimum cadence 1 hour; cloud routines run even with your computer off, local ones run while the Claude app is open.
{{/callout}}

{{callout:info|4 shapes, 1 command}}
`/add-automation` is an **orchestrator** over the 4 automation shapes: `/add-cron` (scheduled task), `/add-workflow` (intelligent chain inside the app), `/add-agent` (autonomous product agent), `/add-routine` (recurring mission for yourself). Each shape stays directly invocable; you never have to choose yourself: you describe, Baudrier decides and explains why.
{{/callout}}

{{callout:warning|A rare case with no home yet}}
If what you truly need is a process that stays awake all the time reacting within seconds (a live listener, a persistent connection), Baudrier will tell you honestly: this is not a one-command setup today. It will offer the closest working alternatives (a fast-ticking scheduled task, or an AI agent's continuous mode if the process is AI-driven) rather than silently forcing your need into a shape that won't really fit.
{{/callout}}

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
