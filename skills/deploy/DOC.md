# /deploy

Deploys your project to Scaleway. This is the **only** way the harness ships code to a live URL - there is no Docker on your machine, nothing to install to make this work.

## When to use it

- Whenever you want your latest changes live on the public site.
- After merging changes into `main`. Production only deploys from that branch.

## How it works

1. **You choose what you want.** The assistant always asks - a local review, or production - it never guesses, because an accidental production deploy would be costly. A local review deploys nothing: the app opens on your own machine.
2. **Your code is committed and pushed** if you had unsaved changes.
3. **GitHub Actions builds the container image** from your pushed commit. The assistant waits for it, showing progress (a cold build can take a few minutes).
4. **Database migrations run first, on their own**, as a one-shot task against the new image - never inside the running app. If a migration fails, nothing else happens: your current live site keeps running untouched.
5. **The live container is updated** to the new image and the assistant waits until it reports healthy.
6. **If your project has an AI agent** (scaffolded earlier with `/add-agent`), its scheduled task on Scaleway is created or updated too, on the same freshly-built image.
7. **A real request is sent to the live URL** to confirm it actually works (HTTP 200 and the page's styling loads) - not just that the deploy "succeeded" on paper.
8. **Old container images are cleaned up** so storage cost doesn't creep up over time.

## Local review vs. production

- **Local review** runs the app on your own machine. You see your changes at once, nobody else can reach them, and it costs nothing. Nothing is built and nothing is sent to Scaleway.
- **Production** only deploys from the `main` branch. It's the live site your users see.

## What you get at the end

- The live URL, confirmed working.
- A clear list of what happened, in plain language.
- If anything fails, a precise explanation of what step failed and what's safe to do next - your production site is never left in a broken state by a failed deploy.

## Tips

{{callout:tip|Per-branch environments}}
The assistant can also deploy any other branch to its own container with its own database, fully isolated from production. It never proposes this by itself, because most projects do not need it. Ask for a preview by name if you want one.
{{/callout}}

{{callout:info|Why migrations run separately}}
Running database migrations as part of starting the app is unsafe here: several containers can start at the same time, and nothing prevents them from running the same migration concurrently. Running migrations as their own one-shot task, before the app is ever updated, avoids that entirely.
{{/callout}}

{{callout:warning|Uncommitted changes}}
If you have unsaved local changes when you run `/deploy`, they get committed automatically as part of the process. Make sure you're happy with what's in your working directory before deploying.
{{/callout}}
