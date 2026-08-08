# /clean

Detects and removes everything that is no longer used in your project to slim it down. Orphan files, dead code, useless dependencies, unused environment variables and DB tables: the validated deletions are applied on a separate branch so that you can verify before merging.

## When to use it

- You want to **slim down** your project after several months of changes.
- You want to **identify** what could cause problems (obsolete env vars, DB tables with no caller, etc.).
- You suspect dead code left over from old vibe coding iterations.

## How it works

1. **Disclaimer shown at the start**: the assistant reminds you that this is a diagnostic. Some findings may be false positives (dynamic imports, references in the database, etc.). **Nothing is deleted without your explicit approval.**

2. **Full audit**: the assistant scans your project across several categories:
   - **Orphan files** (files that are imported nowhere)
   - **Dead code** (exports, functions, components never used)
   - **AI leftovers** (stubs, duplicates, TODOs left hanging)
   - **Unused dependencies** (packages in `package.json` but never imported)
   - **Orphan env vars** (declared in `.env` or Secret Manager but never read in the code)
   - **DB tables with no caller** (Drizzle tables that no code references - static analysis only, see below)
   - **Obsolete migrations** (Drizzle files that are no longer of any use)

3. **Educational report**: for each finding, you get a certainty level, a danger level, the checks already done (facts, not homework), and any question only you can answer.

4. **You validate what you want to delete**: à la carte. Accept everything, refuse everything, or sort item by item.

5. **Applied on a separate branch**: the assistant creates a `cleanup-<date>` branch and applies the deletions there. If the database is touched, pushing that branch and deploying it as a preview automatically provisions its own isolated preview database (no manual database branching to do).

6. **Merge**: once you're sure nothing is broken, you merge to production as usual. If something's wrong, you abandon the branch - nothing reaches production.

## What it creates for you

- A complete project **hygiene report**.
- A **`cleanup-*` branch** with the validated deletions.
- A clean commit per deletion category.
- Nothing is touched until you merge.

## Prerequisites

- No particular prerequisite - `/clean` can run on any Baudrier project.
- Better to have a clean Git state (nothing uncommitted) before launching, so as not to mix your work in progress with the deletions.

## Tips

{{callout:warning|Always test the preview before merging}}
If the cleanup touches the database, deploying the branch as a preview gives it its own real, isolated database - test everything there, not just the parts you think might be affected.
{{/callout}}

{{callout:tip|Easy to undo if there is a problem}}
If something's broken on the preview after the clean: no panic. You haven't merged, so `main` is intact. Either abandon the branch, or ask the assistant to undo only the deletion that's causing the problem.
{{/callout}}

{{callout:info|Database checks are static, not live}}
The operator's machine has no direct access to your database (only a dedicated Scaleway Job does) - so a "table with no caller" finding is based purely on reading your code, never on checking whether the table actually has rows.
{{/callout}}

{{callout:warning|Dropping a DB table is never automatic - not even a "yes" to the finding}}
For every other category, approving a finding is enough to have it removed on the cleanup branch. DB tables are different: agreeing that a table looks unused only logs it as a report-only recommendation. Nothing is generated or run against any database - not even a preview one - unless you separately and explicitly ask for that specific table's removal to be prepared and tested. Only then does the assistant create a migration and apply it to an isolated preview database for you to verify; production is never touched until you've tested it there and confirmed the merge yourself.
{{/callout}}
