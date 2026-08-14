# /add-cron

Adds a task that runs automatically at a fixed time in your project. Ideal for sending a newsletter every night, a weekly cleanup, or a monthly report.

## When to use it

- Send a **daily newsletter** at a fixed time
- **Clean up** the database at night (delete temporary files, expired sessions, etc.)
- **Sync** your data with an external API every hour
- Generate an automatic **weekly report**
- **Keep your site from falling asleep** between visitors

## How it works

1. **Task description**: you describe in one sentence what the task should do (e.g.: *"send a weekly SEO report by email"*, *"reset usage counters at midnight"*).

2. **When to run it**: you specify the schedule in natural language (*"every day at 9am"*, *"every Monday morning"*, *"every hour"*). Baudrier keeps it in your own local time - no hidden conversion.

3. **Short name**: you give a kebab-case name for the task (`rapport-hebdo`, `sync-clients`, `nettoyage`).

4. **Automatic decision**: Baudrier decides for itself where the task's logic should live (you have no choice to make):
  - **In your app** (the default, for almost everything): the task can read and write your data, send emails, and reuse everything already coded in your site.
  - **A "keep it awake" visit** (rare): if all you want is to stop your site from falling asleep between visitors, since only a real visit - not an automatic check - keeps it awake.
  - **A direct ping to another service** (rare): if the task is simply "notify this other address on a schedule", with nothing to process.

5. **Automatic setup**: Baudrier creates a small scheduled task on Scaleway's infrastructure (a "Job" with its own precise clock, real timezone, no shared or limited slot), the protected file where your logic will live if needed, and the `CRON_SECRET` key (generated if missing).

6. **Recap**: Baudrier explains in one sentence **what it set up and why**.

7. **Up to you to code the logic** (when relevant): the task is in place but does nothing yet. Baudrier has prepared the file where you (or Claude) will write what it should run.

## What it creates for you

- A **scheduled task** on Scaleway, precise, on your own timezone, with no limit on how many you can have
- For most tasks: a **protected route** `/api/cron/<name>` in your app (secured by a private key) where the logic lives
- The `CRON_SECRET` key in `.env` + your site's configuration
- An update to `CLAUDE.md` with the task recap

## Prerequisites

- The project must be Next.js, deployed on Scaleway (typically via `/bootstrap` then `/deploy`)
- If your site hasn't been put online yet, Baudrier prepares everything and finishes turning on the schedule the moment you tell it your first deployment is done

## Tips

{{callout:tip|You can drive it in natural language}}
Once the task is in place, simply tell Baudrier:
- *"run the task right now to test it"*, manual trigger
- *"change the schedule to 10am"*, cron modification
- *"delete this task"*, full deletion

You have **nothing** to type in a terminal.
{{/callout}}

{{callout:info|One task, one precise clock}}
Each scheduled task gets its own small, dedicated mechanism on Scaleway's infrastructure, with a real timezone and no limit on how many you can add - unlike some other platforms, there is no shared bottleneck to manage and nothing to migrate later if you add more tasks.
{{/callout}}

{{callout:warning|Bad candidate for /add-cron}}
If your need is a **continuous process** that must stay running between ticks (a live listener, a queue consumer), you should run `/add-automation` instead (not `/add-cron`). Baudrier detects this case and redirects you automatically.
{{/callout}}

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
