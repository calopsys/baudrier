# /delete-project

Cleanly and permanently deletes a Baudrier project's **disposable** Scaleway infrastructure. Before any action, a big warning and a double confirmation, because the operation is **irreversible** for what it does delete.

**This skill never deletes your database, your file storage bucket, or the Scaleway Project itself.** That is a deliberate, hard-coded limit, not a setting you can turn off - see below.

## When to use it

- You are abandoning a project (test, prototype, obsolete app) and want to clean everything up rather than leave infrastructure running.
- You want to stop paying for a project you no longer need.
- You want to fully decommission an app (end of a mission, a client leaving, a full rebuild).

## How it works

**Phase 1 - Identification + big warning.** The assistant asks for the exact project name (if not already given), shows a full warning listing what will be deleted **and, just as prominently, what never will be** (database, storage, the Project itself), offers to take a backup of the code/config first, then asks for two separate confirmations - the second one requires retyping the exact project name.

**Phase 2 - Complete inventory.** Since Baudrier keeps one dedicated Scaleway Project per app, the assistant resolves that Project and lists everything inside it in one pass: the deployed site (container) and its custom domain, the build image registry, scheduled jobs (migrations, agents, cron tasks), stored secrets, the technical access keys (IAM) created for the app, the email-sending domain, the DNS records added for it, the assistant's own working memory of the project, and the GitHub repository. It also looks up the database and the file storage bucket - **only to be able to name them in the final report**, never to delete them - and scans environment variables to flag any third-party service you plugged in yourself (Sentry, OpenAI, Mapbox, etc.) that Baudrier has no way to delete for you.

**Phase 3 - Scope selection.** You get a clear recap in sections, starting with what is permanently kept (database, storage, the Project), then what can be deleted automatically, third-party services to handle yourself (with the exact URL and instructions for each), manual actions only you can do (deleting the local folder), and anything else deliberately left untouched. You choose to delete everything in the disposable-infrastructure list or keep specific pieces (e.g. the DNS entries) - nothing runs until this is validated.

**Phase 4 - Execution + report.** Everything approved gets deleted, in parallel where safe. The report opens with a prominent, un-skippable reminder of exactly what was left behind - database name(s), bucket name, the Scaleway Project - each with a link to the Scaleway console, in case you want to delete them yourself by hand.

## What it does for you

- Deletes the automatable, disposable Scaleway infrastructure of the project in a single pass.
- Proactively detects third-party services you connected yourself, with exact cleanup instructions for each.
- Guarantees no orphaned Scaleway resource among what it does delete - including technical access keys, which are easy to forget and count against the Organization's account limits.
- Never touches a sibling project that happens to share part of its name.
- **Never destroys your data.** The database, the file storage bucket (and everything inside it), and the Scaleway Project that holds them are always left in place - named explicitly in the final report, with console links, so you always know exactly what still exists and how to reach it yourself.

## Prerequisites

- The project must be a Baudrier project (created via `/bootstrap`), with its own Scaleway Project.
- The four `SCW_*` variables must be set in your Baudrier cloud environment.

## Tips

{{callout:warning|What IS deleted is strictly irreversible}}
Once launched, the disposable infrastructure listed in the recap (container, registry, jobs, secrets, IAM, DNS records, email domain, GitHub repo) cannot be recovered. If any of that holds something you'd want back (code, configuration), take a backup first - the skill offers to do this for you before the double confirmation.
{{/callout}}

{{callout:info|Your database and file storage are never deleted}}
This is a hard limit built into the deletion script itself, not a checkbox: `/delete-project` has no code path capable of deleting a database or a bucket (or emptying one). The Scaleway Project that holds them is never deleted either - deleting a Project would cascade to everything still inside it, including your data. The final report always names exactly what was left behind and links to the Scaleway console, so you (a human) can delete it yourself if you're certain you want to.
{{/callout}}

{{callout:info|The pre-deletion backup does not include the database}}
The operator machine has no direct database access (see `/save-project`'s documentation for why), so `/delete-project`'s optional pre-deletion snapshot does not contain the database - though since the database is never deleted by this skill anyway, that's rarely a problem in practice.
{{/callout}}

{{callout:info|Stay in control of what gets deleted}}
At the scope step, you don't have to delete everything at once - for instance you can keep the DNS entries to reuse the domain on a new project.
{{/callout}}

{{callout:info|The local folder remains your responsibility}}
For safety, the assistant never deletes the project's code folder on your computer. At the end, you get the exact path to open in your file explorer.
{{/callout}}

## Landing sites (site vitrine)

A landing site has no database and no storage bucket to begin with, so there is simply nothing to preserve or hand you a console link for on that front - the report says so plainly, as the normal state for this type of site, not a gap.
