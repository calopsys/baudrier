---
name: deploy
description: Deploy the current project to Scaleway - production (branch main) or a preview environment (any other branch). The published state of the app picks the question asked; choosing production from a non-main branch merges that branch into main first. Pushes the branch, builds and pushes the container image directly (docker build --platform linux/amd64, no GitHub Actions), runs database migrations as a one-shot Serverless Job, updates the Serverless Container, prunes old registry images, and smoke-tests the health probe (`/api/healthz`) on the live URL. This is the ONLY deploy path. Use when the user says "deploy", "ship this", "push to production", "deploy a preview", "/deploy".
argument-hint: "[production|preview]"
allowed-tools: Bash AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js and Docker."
---

# Deploy

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You deploy the current project to Scaleway. The machine running Claude Code builds the `amd64` container image itself and pushes it straight to the Scaleway Container Registry - no GitHub Actions anywhere in this pipeline (CONTRACT.md §5). The deterministic, multi-minute orchestration (start Docker if needed, build + push the image, run the migration Job, update the container, prune old images, smoke-test) is entirely handled by `scripts/deploy.mjs` - your role is to ask the one question that must never be inferred, relay its progress, and translate the result for a non-technical user.

---

## Step 0 - Confirm a deploy is actually wanted [only when reached automatically]

A deploy is for review or an explicit user request, never the silent default next step - it also costs a full image build (several minutes, built and pushed directly by this machine), so proposing one without being asked wastes the user's time.

- If the user's own message this turn already asked for a deploy, in any form ("déploie", "mets en ligne", "ship this", "/deploy", "push to preview"...), that request **is** the confirmation - go straight to Step 1.
- If instead this skill was reached as an automatic next step of another flow (an addon's summary, an audit's suggestion, anything that did not come from the user asking to deploy right now), stop and ask first with `AskUserQuestion`:
  - Question: "Veux-tu que je déploie maintenant ? Un déploiement relance une construction complète de l’image (plusieurs minutes)."
  - Options: `Oui, déployer maintenant` / `Non, pas pour l’instant`
  - If "Non" → stop here. Tell the user their work is saved, and that they can ask for a deploy whenever they want the site updated.
  - If "Oui" → continue to Step 1.

This step does not apply to `/bootstrap`'s own closing deploy (its Step 8b) - the user's initial request to build the whole app already is that explicit consent, as documented there.

---

## Step 1 - Ask what the user wants: production or preview [MANDATORY, NEVER SKIP]

🚨 **Always ask one of the two questions below - never infer the answer from context or from what the user seems to want.** An accidental production deploy is costly and cannot be silently undone - this is a deliberate product decision, not a formality.

The published state of the app, not the current branch, picks which question to ask. Before asking anything, read the canonical `ACCESS_RESTRICTED` value from Secret Manager - it is not sensitive (`"true"` \| `"false"`), so reading it here is safe, and it is the only readable source of truth for it (CONTRACT.md §1: a container's own secrets can only be written, never read back):

```bash
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
try {
  const accessRestricted = await getSecret("ACCESS_RESTRICTED");
  console.log(JSON.stringify({ ok: true, accessRestricted }));
} catch (e) {
  // not_found (or any other read failure) fails closed: treat as restricted,
  // the same rule the proxy itself applies.
  console.log(JSON.stringify({ ok: true, accessRestricted: e.type === "not_found" ? "true" : null }));
}
'
```

Also note the current branch (`git rev-parse --abbrev-ref HEAD`) - it does not pick the question, but Step 2 needs it to know whether a merge into `main` is required afterward.

### Which question to ask

| `ACCESS_RESTRICTED` | Question |
|---|---|
| `"true"`, or the read failed | One confirmation, offering production only |
| `"false"` | A menu: private preview, or production |

Reason: an unpublished production site is already private - only the addresses in `ACCESS_ALLOWED_IPS` reach it. A separate preview adds cost and gives the user nothing, whatever branch the work sits on.

**`accessRestricted === "true"`, or the read failed** - ask with `AskUserQuestion`:
- Question: "Mise en ligne"
- Options:
  - `Oui, mets en ligne maintenant` - le site part en production, à l’adresse publique du projet.
  - `Non, pas maintenant`

If "Non, pas maintenant" → stop here, no deploy.
If "Oui, mets en ligne maintenant" → the target is production; go to "What happens next" below.

**`accessRestricted === "false"`** - **the app is published: real users can already reach it.** Ask with `AskUserQuestion`:
- Question: "Mise en production"
- Options:
  - `Non, un aperçu privé d’abord` - une adresse séparée, réservée à vous, pour vérifier vos changements avant de toucher au site public.
  - `Oui, déploie en production` - le site public, visible par vos utilisateurs réels.

If "Non, un aperçu privé d’abord" → the target is preview; go to "What happens next" below.
If "Oui, déploie en production" → the target is production; go to "What happens next" below.

If the user already stated it unambiguously in their message (e.g. "deploy to production"), you may skip asking again **only within the same turn** - but if there is any doubt at all, ask.

### What happens next: the branch decides, not another question

The choice above is now one decision about **where the work ends up**, not only a deploy target:

- **Production chosen, current branch already `main`** → nothing to merge; continue to Step 2 with `--target production`.
- **Production chosen, current branch anything else** → the work must reach `main` first. Continue to Step 2, which merges the branch into `main` before running `--target production`.
- **Preview chosen, current branch anything other than `main`** → continue to Step 2 with `--target preview`; the branch is left exactly as it is, nothing merges.
- **Preview chosen, current branch already `main`** → the work needs its own branch first. Continue to Step 2, which switches it onto the stable `revue` review branch (reusing it if it exists, creating it from `main` otherwise) before running `--target preview`.

Reason: `scripts/deploy.mjs` refuses `--target production` on any branch except `main`, and refuses `--target preview` on `main` itself - Step 2 is what resolves both cases: merging into `main` for production, or switching onto `revue` for preview.

This repository's GitHub token cannot open or merge pull requests from this environment (CONTRACT.md §1: PRs are read-only, and `gh` is not part of the web toolchain). The merge in Step 2 is a direct `git merge`, never a pull-request merge, and this skill never opens a pull request itself.

### Preview: cost, and what stays untouched

The first time in this conversation a branch's preview is deployed, tell the user, in plain French, before continuing: a preview creates one Serverless Container and one Serverless SQL database, and this harness never deletes a database (`_destructive-guard.mjs` refuses it), so removing that database later is a manual job in the Scaleway console. Do not repeat this note on a later `/deploy` of the same branch in the same conversation.

**A preview deploy must never write `ACCESS_ALLOWED_IPS`.** That secret is production's own access list (CONTRACT.md §6). Adding an address to it while production is restricted grants that address production access. No preview flow may touch it, whatever the user asks for.

---

## Step 2 - Project context

Invoke `_detect-project-root` to get `PROJECT_NAME` and confirm this is a Next.js project. Note the **git repository root** (usually the current directory; in a monorepo it's above `WEB_DIR`) - `deploy.mjs` needs to run from there, since that's where `.git` lives and where `docker build` reads its context.

There is no workflow file to read a registry namespace out of - the harness itself builds and pushes the image (CONTRACT.md §5), and `deploy.mjs` already defaults `--registry-namespace` to the slugified project name, so you only need to pass it explicitly if this app's registry namespace was ever named differently.

Tell the user briefly what's about to happen:
> Je vais committer et pousser vos changements, construire et publier l’image, migrer la base de données, puis mettre à jour le site. Ça prend en général quelques minutes.

Mention explicitly that any uncommitted local change will be committed as part of this (so nothing is a surprise): *"Si vous avez des modifications non enregistrées, je vais les committer avant de déployer."*

### If Step 1 found that production needs a merge into `main`

Only applies when the target is production and the current branch is not `main`. Warn the user first, next to the sentence above, before touching git: *"Comme vous déployez en production, je vais d’abord fusionner votre branche dans main."* Then run:

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git add -A
git diff --cached --quiet || git commit -m "chore: prepare branch for merge into main"
git push -u origin "$BRANCH"
git checkout main
git pull origin main
git merge --no-edit "$BRANCH" || { git merge --abort; echo "MERGE_CONFLICT"; }
```

- If the output shows `MERGE_CONFLICT`, the abort already restored `main` to its pre-merge state - **stop here, deploy nothing.** Report the conflict to the user in plain French, name the branch, and tell them to resolve it themselves before asking for a deploy again.
- Otherwise, finish with `git push origin main`, then continue - the current branch is now `main`.
- **Never force-push, and never discard the branch.** A failed merge must always leave the repository in a state the user can recover from.

### If Step 1 found that preview needs the `revue` branch

Only applies when the target is preview and the current branch is already `main`. The user asked for a private preview, not a branch - a preview still needs one, so make it for them instead of stopping. Warn the user first, before switching anything: *"Je mets ce changement sur une branche de révision appelée revue, pour que le site public reste inchangé."*

Then switch onto it:

```bash
git fetch origin
if git rev-parse --verify revue >/dev/null 2>&1; then
  git checkout revue
elif git rev-parse --verify origin/revue >/dev/null 2>&1; then
  git checkout -b revue origin/revue
else
  git checkout -b revue
fi
```

- Check out `revue` **before** committing anything: any uncommitted change follows the user onto the branch, and `deploy.mjs`'s own `commitPush` step (Step 3) commits and pushes it from there - never commit on `main` first.
- If the checkout itself fails (an uncommitted change conflicts with `revue`'s own history), **stop here - never discard the change.** Tell the user in French, and ask them to commit or stash it before trying again.
- `revue` is one stable, reused branch per project - never generate a new name per review, never add a date or a slug. Reusing it is what keeps this to exactly one preview Serverless SQL database, since this harness never deletes one (see the cost note above).

Check whether `.github/workflows/clean-merged-branches.yml` exists in the project. If it does not, run `node "${CLAUDE_SKILL_DIR}/../../scripts/add-cleanup-workflow.mjs"` now - the deploy's own `commitPush` step then ships it. This dispatch-only maintenance workflow lets the repository owner delete merged branches from the GitHub Actions tab; a session itself can never delete a remote ref (CONTRACT.md §5/§7).

---

## Step 3 - Run the deploy

### Invocation (background + narration via Monitor)

A synchronous `Bash` call buffers all its output until the command exits, so the user would see nothing for minutes; worse, the deploy's own budgets (the local `docker build`/`push` has no fixed timeout and can itself take several minutes on a cold layer cache, plus up to 10 more for the migration Job, plus up to 5 for the container update) can outlast a synchronous call outright. The only pattern that works: launch the script in the background with output to a log, then arm a **`Monitor`** that tails the log and emits a notification on each newly detected progress line. The Monitor exits automatically once it sees the final result line.

**1. Start the script in the background**

From the git repository root, run the block below with **`run_in_background: true`** in the `Bash` tool. Redirect stdout+stderr to `$LOG_FILE`, and echo the path BEFORE the redirection so it can be retrieved:

```bash
LOG_FILE="${TMPDIR:-/tmp}/deploy-$(date +%s).log"
echo "LOG_FILE=$LOG_FILE"
node "${CLAUDE_SKILL_DIR}/../../scripts/deploy.mjs" \
  --target <production|preview> \
  --project-name "<PROJECT_NAME>" > "$LOG_FILE" 2>&1
```

`--registry-namespace` defaults to the slugified project name - pass it explicitly only if this app's registry namespace was created under a different name.

The tool returns a `bash_id` (useful for `KillBash` in case of a hang) and an `output-file` (the harness's own capture of the background bash stdout - it contains just the `LOG_FILE=...` line, since the rest is redirected).

**2. Retrieve the LOG_FILE path**

`Read` the `output-file` returned by the Bash call. There you will find a single line `LOG_FILE=<absolute path>`. Remember this value - it is what the Monitor will tail.

**3. Announce to the user + arm the Monitor**

Tell the user briefly that the deploy is running and that progress will be relayed as it happens. Then launch the `Monitor` tool with the script below (replace `<LOG_FILE>` with the real path from step 2), `timeout_ms: 2400000` (40 min - the local build has no fixed timeout of its own, plus the 10-minute migration Job budget and the 5-minute container-update budget, with margin), `persistent: false`, and a short `description` like `"deploy progress"`:

```bash
export LC_ALL=C
LOG="<LOG_FILE>"
LAST=""
while true; do
  if grep -q '^{"success":true' "$LOG" 2>/dev/null; then
    echo "[DONE] success"
    break
  fi
  if grep -q '^{"success":false' "$LOG" 2>/dev/null; then
    echo "[DONE] failure"
    break
  fi
  # ^▸ [A-Z] = a real progress line - every one of deploy.mjs's own
  # messages is an English sentence, so a real line always starts with a
  # capital letter right after the marker. `docker build`/`push` write their
  # own (unprefixed, very verbose) output straight into the same log file -
  # this filter is what keeps that noise from ever becoming a notification.
  CUR=$(grep -E "^▸ [A-Z]" "$LOG" 2>/dev/null | tail -1)
  if [ -n "$CUR" ] && [ "$CUR" != "$LAST" ]; then
    echo "$CUR"
    LAST="$CUR"
  fi
  sleep 4
done
```

`scripts/deploy.mjs` always ends with one parseable JSON line - `{"success":true,...}` on success, `{"success":false,"failedStep":...,"error":...,"warnings":[...]}` on failure - printed right after its own handoff banner (see Step 4 below), so grepping for that line is a direct, unambiguous completion signal.

### During execution (notification handling)

You will receive a `task-notification` for each new `▸ <msg>` progress line. Translate each into one short French line for the user, following this skill's `## Communication` rules (plain language, never the script name) - e.g. `▸ Building + pushing the Docker image...` → `↳ Construction de l’image en cours (peut prendre quelques minutes)...`.

On `[DONE] success` or `[DONE] failure`: run a synchronous `Bash` - `tail -n 40 "<LOG_FILE>"` on success, `tail -n 200 "<LOG_FILE>"` on failure - to retrieve the handoff banner and the final JSON line, then proceed to Step 4. Optional cleanup: `rm -f "<LOG_FILE>"` once it is no longer needed.

**Safety net hang**: if the Monitor's `timeout_ms` fires without a `[DONE]` line, treat it as a real hang. Read `tail -n 200 "<LOG_FILE>"` to diagnose, and kill the background bash with `KillBash` on the remembered `bash_id`.

### What the script does

The script performs, in order, and aborts immediately (before the next step) on any failure:
1. **commitPush** - commits local changes if any, pushes the current branch
2. **buildPush** - starts the Docker daemon if it isn't already running (`ensureDocker()` - lazy on every platform, since a fresh Claude Code web session never has `dockerd` running at boot, CONTRACT.md §1/§7), then builds the image itself with `docker build --platform linux/amd64` and pushes it straight to the Scaleway Container Registry, tagged with the commit SHA - skipping the rebuild entirely when that exact tag already exists (a re-deploy of an unchanged commit does not pay for a second build). No GitHub Actions anywhere in this path (CONTRACT.md §5).
3. **migrate** - runs the dependency-light migration runner (`templates/deploy/migrate.mjs`, copied into the image alongside `drizzle/`) as a one-shot Serverless Job against the freshly built image, invoked with the overridden command `node migrate.mjs`, and waits for it to succeed (SDK polling, no external run to watch). This runner exists because the production image is Next's `standalone` output only - no devDependencies survive the build, so `drizzle-kit migrate` cannot run inside it (CONTRACT.md §1, §5). It runs **exclusively** inside this Job, exactly once per deploy - the container's own `CMD` stays `["node","server.js"]` and never references `migrate.mjs`, so a scaling app container can never trigger a migration on its own. **This never runs at container start** - `min_scale=0` lets several instances cold-start at once, and neither Serverless SQL's `pg_advisory_lock` nor the migration runner itself protects against concurrent runs. A Job is strictly sequential, so this is the one safe place for it. If the migration fails, the script stops here - **the container is never touched**, so the previous revision keeps serving traffic unaffected.
4. **updateContainer** - points the Serverless Container at the new image, waits until it reports ready (SDK polling). If the container doesn't exist yet (first deploy of a preview branch), it's created **access-restricted by default** (the office-VPN-only IP gate, CONTRACT.md §6) - a fresh preview is never born publicly reachable. There is no linkage file to update: `add-domain` and `_push-env-vars` find this same container again later by resolving the Project, namespace, and container all by name (CONTRACT.md §2).
5. **agentJobs** - if the project has any `apps/<name>/job-definition.json` (scaffolded by `/add-agent`), creates/updates that agent's Scaleway Serverless Job on the same freshly-built image and applies its schedule. Non-fatal by design: a broken agent Job definition is reported as a warning, never aborts the deploy - the web app has already updated and been smoke-tested by this point.
6. **pruneTags** - deletes old Container Registry tags beyond the 10 most recent (Container Registry has no retention policy on its own - this is the harness's only defense against unbounded storage cost)
7. **smokeTest** - fetches `<url>/api/healthz` and requires HTTP 200 with a `{"ok":true}` body. `src/proxy.ts` exempts that exact path from the IP gate (CONTRACT.md §6), so the probe must pass from ANY machine - VPN, web sandbox, or CI. A 403 there is a real failure: the exemption is missing from the project's `src/proxy.ts` (see the failure table below). After a green healthz the script fetches the homepage with the `ACCESS_BYPASS_TOKEN` header (CONTRACT.md §6) and requires HTTP 200 plus the stylesheet heuristic; any other status fails the deploy. Sole downgrade: a 403 despite the token means the app's `src/proxy.ts` predates the bypass check - the script warns with the migration path (copy `bypassTokenMatches()` from `templates/deploy/proxy.ts`) and the deploy still succeeds.

For a **preview** deploy on a branch that has never been deployed before, step 3 also transparently provisions a dedicated preview Serverless SQL database and IAM credentials for it - this is normal and only happens once per branch.

---

## Step 4 - Read the result

The script ends with one JSON line. Parse it.

### Success (`"success":true`)
Tell the user, in French, non-technical:
> ✅ Déployé avec succès en **<production|aperçu>**.
> - Adresse : <url>
> - La sonde de santé répond correctement.
> - Les anciennes images ont été nettoyées.

Then one line about the homepage, from the log's homepage probe: if it answered 200 with styling, add « Le site répond et affiche son style. » ; if the log shows the 403-despite-token warning, add « Le site reste protégé, mais son proxy date d’avant le jeton du harnais : la vérification complète reprendra après la mise à jour de src/proxy.ts. »

If `warnings` is non-empty, mention each one in plain language (e.g. a missing stylesheet detection isn't fatal, but worth a manual look).

For a preview, remind the user preview environments scale to zero and cost close to nothing while idle, and that this environment has its own database, isolated from production. Also tell the user their branch stays open for review - they can open the pull request from the Claude Code web interface whenever they are ready; this skill never opens one itself.

### Failure (`"success":false`)
Read the handoff banner printed just above the JSON line - it names the exact step that failed (`failedStep`) and lists what already completed. Translate the underlying error for the user in plain language, then:
- If the failure is at `preflight`: fix the reported issue (Scaleway credentials missing, wrong branch for the chosen target, or Docker could not be started - see `ensure-dockerd.mjs`'s own message) and re-run Step 3 as-is.
- If the failure is at `commitPush`: usually a git push rejection (e.g. branch protection on `main`) - fix and retry; nothing on Scaleway was touched yet.
- If the failure is at `buildPush`: the local `docker build` or `docker push` itself failed - read the raw Docker output in the log (it isn't `▸`-prefixed, so scroll past the progress lines) to see the actual build error, fix it, and re-run Step 3.
- If the failure is at `migrate`: the container was **never touched** - the site is unaffected. Read the migration error (likely a bad Drizzle migration file), fix it, and re-run Step 3. Do not attempt to manually patch the container to "get around" a failed migration.
- If the failure is at `updateContainer`, `pruneTags`, or `smokeTest`: the migration already ran. Re-running the whole script is safe for `updateContainer`/`pruneTags`/`smokeTest` (idempotent), but do NOT blindly re-run if you suspect the migration itself is not idempotent - check the database state first if in doubt. A 403 from `smokeTest` on `/api/healthz` means the project's `src/proxy.ts` lost its exact-path healthz exemption - restore the `pathname === HEALTHZ_PATH` check from the harness convention (`templates/deploy/proxy.ts`) and re-run. A failure at `smokeTest` happens after `pruneTags` already ran, so the pruning is not repeated by that re-run.
- `agentJobs` never appears as `failedStep` - it cannot fail the deploy. If an agent's Job couldn't be reconciled (e.g. a secret referenced in its `job-definition.json` isn't in Secret Manager yet), it shows up as a `warnings` entry instead; mention it to the user without treating the deploy itself as failed.

Never claim success if the JSON line says otherwise, and never silently retry a failed production deploy without telling the user what failed.
