# /deploy

Deploys your project to Scaleway. This is the **only** way the harness ships code to a live URL - there is no Docker on your machine, nothing to install to make this work.

## When to use it

- Whenever you want your latest changes live on the public site.
- Whenever you want a private preview of a branch before it joins `main`.

## How it works

1. **The assistant checks first whether your site is already published.** If it is not, one confirmation is enough before it goes live, because an unpublished site is already visible to you alone. If it is already published, the assistant offers a private preview first, or a direct production deploy - because an accidental production deploy would be costly. You get the same choice on any branch, and your answer also decides whether that branch joins `main`.
2. **Your code is committed and pushed** if you had unsaved changes.
3. **The assistant builds the container image itself**, on this machine, from your commit, then pushes it to the Scaleway Container Registry. GitHub takes no part in this build. The assistant waits and shows progress (a cold build can take a few minutes).
4. **Database migrations run first, on their own**, as a one-shot task against the new image - never inside the running app. If a migration fails, nothing else happens: your current live site keeps running untouched.
5. **The live container is updated** to the new image and the assistant waits until it reports healthy.
6. **If your project has an AI agent** (scaffolded earlier with `/add-agent`), its scheduled task on Scaleway is created or updated too, on the same freshly-built image.
7. **A real request is sent to the live URL** to confirm it actually works (HTTP 200 and the page's styling loads) - not just that the deploy "succeeded" on paper.
8. **Old container images are cleaned up** so storage cost doesn't creep up over time.

## Private preview vs. production

This choice also decides one more thing: what joins the project's main line.

- **An unpublished site is already private.** Only your own address can reach it. Deploying it to production changes nothing here: that deploy is already your private review.
- **A published site** is live for real users. Before you touch it, the assistant offers a private preview at a separate address, visible to you alone, so you can check your changes first.
- **Production also merges your branch into `main`** when you work on another branch. The assistant merges it before it puts the site online. If the merge conflicts, nothing goes online, and the assistant explains the conflict.
- **A private preview leaves your work on its own branch.** Nothing merges into `main`. The assistant pushes the branch to GitHub. Open the pull request yourself from the Claude Code web interface.
- **Production always runs from `main`.** That is why choosing it merges your branch first. It's the live site your users see.

## What you get at the end

- The live URL, confirmed working.
- A clear list of what happened, in plain language.
- If anything fails, a precise explanation of what step failed and what's safe to do next - your production site is never left in a broken state by a failed deploy.

## Tips

{{callout:tip|Per-branch environments}}
Every branch you preview gets its own address, fully isolated from production. For an app with a database, that isolation has a price: each branch previewed this way keeps its own Serverless SQL database, and the harness never deletes a database - removing one is a manual job in the Scaleway console. A vitrine has no database at all, so its preview is just one container at rest, close to zero cost. Either way, prefer one review branch over many short-lived ones.
{{/callout}}

{{callout:info|Why migrations run separately}}
Running database migrations as part of starting the app is unsafe here: several containers can start at the same time, and nothing prevents them from running the same migration concurrently. Running migrations as their own one-shot task, before the app is ever updated, avoids that entirely.
{{/callout}}

{{callout:warning|Uncommitted changes}}
If you have unsaved local changes when you run `/deploy`, they get committed automatically as part of the process. Make sure you're happy with what's in your working directory before deploying. If you choose production from another branch, the assistant also merges that branch into `main` before it goes live.
{{/callout}}
