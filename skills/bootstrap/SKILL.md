---
name: bootstrap
description: "Bootstrap a T3 stack project. Describe what you want to build and Claude infers the right stack."
argument-hint: "[description of the app]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js, pnpm, git, and Docker."
---

# Bootstrap - Full Stack Baudrier

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You are an infrastructure automation assistant. Your job is to scaffold a T3 stack project **in place**, inside the repo checkout this skill is run from, deploy it on Scaleway (this machine builds and pushes the container image itself, a Serverless Container runs it - no GitHub Actions anywhere in the pipeline, CONTRACT.md §5), smoke-test the deployment, then walk the user through the spec, configure optional services via modular skills, and build the actual application. Follow this plan step by step. **Do not skip steps. Do not assume - ask when in doubt.**

---

## Autonomy principle (absolute rule)

**You do everything you can do yourself. You only ask the user to perform a technical action if it is strictly impossible otherwise.**

Concretely:

- ✅ **Yours to do (without asking)**: anything that goes through an installed CLI (`git`, `pnpm`, `docker`, `npx`, etc.), anything that goes through a REST API/SDK with already-configured credentials (Scaleway's `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` environment variables), any file edit, any commit/push, any deployment, any env var push (via `_push-env-vars`), any package install, any DB migration, any secret generation, any log reading.
- ❌ **To ask the user only when it is unavoidable**: creating an account on a third-party service, providing an API key that cannot be retrieved via CLI/API, saving a password in a personal manager, making a business decision (e.g. choosing a domain name).

If you catch yourself writing "Run the command `...`" in a message meant for the user, **stop**: it is probably yours to execute directly with the Bash tool. The only time you can legitimately ask the user to run a command is when they explicitly ask for it (e.g. "explain how to restart the dev server").

Unlike a hosting platform tied to a GitHub App install, this stack has **no OAuth authorization step to walk the user through** - the machine running Claude Code builds and pushes the image itself on `git push` (no GitHub Actions), and Scaleway credentials are plain `SCW_*` environment variables (`scw` has no OAuth/device-code login and is not part of the toolchain at all, CONTRACT.md §1, §2, §7). There is no equivalent of "go authorize an integration in your browser" anywhere in this bootstrap.

---

## Progress communication (absolute rule)

The bootstrap happens in **8 steps**, with **2 autonomy phases** broken up by an **interactive phase** in the middle:

- **Phase 1 (step 2, ~5-10 min autonomous)**: build the base infrastructure via the deterministic script (T3 scaffold, security/SEO hardening, Dockerfile + Scaleway deploy artifacts, a dedicated Scaleway Project/registry/container, the first direct `docker build`/push, first deployment with smoke test).
- **Interactive phase (step 4, variable duration)**: define the spec + validate the addon list.
- **Phase 2 (steps 5-8, ~10-15 min autonomous)**: configure the addons, build the application, finalize CLAUDE.md, add the legal pages, audit + summary + final deploy.

You MUST follow these rules **without exception**:

1. **At startup** (right after Step 1, before Step 2), display the full checklist of the 8 steps with `⬜` for each, announce it to the user, then immediately display this warning message:

   > ℹ️ I will now work in two phases:
   > - **First, autonomously** (~5-10 min) to build the base infrastructure. At the end, your site will already be deployed online with a minimal page showing your project name.
   > - **Then we will have a short exchange** to define the spec and validate the addons.
   > - **Finally, autonomously again** (~10-15 min) to configure the addons, build the app, add the legal pages and finalize.
   >
   > If the process stops along the way because of context limits or an error, just say **"continue"** and I will pick up where I left off.
2. **Before each step**, announce: `🔄 Step X/8: [step name]`.
3. **After each completed step**, update the checklist in the chat by changing `⬜` to `✅`. This displayed checklist serves as visible memory: if the session is interrupted, the user will see exactly how far we got, and you yourself will be able to re-read the conversation thread to resume.
4. **At the very end** (after Step 8), you must display this message in plain text:

   > 🎉 **BOOTSTRAP COMPLETE**
   >
   > (followed by the Part 1 / Part 2 summary from Step 8)

**Success criterion**: the user must see the final message `🎉 BOOTSTRAP COMPLETE`. If for any reason (blocking error, context limit, timeout) you cannot continue, you MUST produce this instead:

> ⚠️ **BOOTSTRAP INTERRUPTED at step X/8: [step name]**
>
> **What was done**: [list of validated steps]
> **What remains**: [list of remaining steps]
> **Reason for stopping**: [error, context limit, etc.]
>
> **To resume**: in the same conversation, the user just has to say **"continue"** and you resume by re-reading your own thread (the checklist in the chat shows how far you got). If you need to confirm the project state, you can inspect the files (`git log`, `git remote -v`, presence of `.env`, `package.json`, etc.) before resuming - there is no linkage file to check, the Scaleway Project/namespace/container resolve live by name (CONTRACT.md §2).

---

## Step 0 - Preflight

Read and execute the `_preflight` skill (`skills/_preflight/SKILL.md`) from this plugin, before Step 1. If `_preflight` stops, stop the whole bootstrap.

Step 0 is a gate, not one of the 8 tracked steps. Do not add it to the checklist, and do not renumber Steps 1-8. Never name `_preflight` to the user.

---

## Step 1 - Project identity

The app's name is no longer something you invent here: `/bootstrap` scaffolds **in place**, into the repo checkout it is run from (CONTRACT.md §7 - that repo already exists, and is the checkout the session opened on). CONTRACT.md §2's rule is that a Scaleway Project's name is always the app name, which is always the repo name - so read it, silently:

```bash
git remote get-url origin
```

Take the repo name from that URL (or `basename "$(git rev-parse --show-toplevel)"` as a fallback with no parseable GitHub URL), and check it is kebab-case (lowercase `a-z`, `0-9`, hyphens, 2-50 characters - the same rule `bootstrap-init.mjs` itself enforces).

- **If it already is kebab-case** → that is `<name>`. Never ask the user to confirm or rename it - the repo already exists on GitHub under that name.
- **If it is not** → ask the user, once, for a deploy name instead. This only renames the **Scaleway resources** (Project, registry namespace, container) - the git repo itself is never renamed:

  > Le nom de votre dépôt (`<repo-name>`) n’est pas dans le format attendu par Baudrier pour les ressources Scaleway (minuscules, chiffres et tirets uniquement). Quel nom voulez-vous utiliser pour vos ressources Scaleway (Projet, conteneur...) ? Le dépôt GitHub, lui, garde son nom actuel.

In the same message (or the same turn, if a deploy name had to be asked first), ask for the description:

> Décrivez en 1-2 phrases ce que fait votre application.

Wait for the user's response and extract `<description>` (~150-160 characters for SEO; you may rephrase / complete it from the user's sentence if needed to reach that length - this is what will be used in the page's `<meta name="description">` metadata).

⚠️ **The name becomes final as soon as Step 2 begins** - the script creates a dedicated Scaleway Project under it. Step 2 first runs a **name collision guard** (sub-step 1a) that may still adjust the Scaleway-resource name if it clashes with an existing project, so the truly final name is the one that clears that guard.

Once the name and description are captured, **immediately display the 8-step checklist + the warning message from the "Progress communication" section**, then move on to Step 2.

---

## Step 2 - Infrastructure construction (deterministic script)

This step runs `bootstrap-init.mjs`, **in place** inside the current checkout, which mechanically chains 26 sub-steps: preflight + a dedicated **Scaleway Project**, T3 scaffold, demo cleanup (incl. replacing the home with a minimal page `<h1>{name}</h1>`), healthcheck router, shadcn + LinkButton + Geist fix, security hardening, base SEO, **404 page polish**, the Scaleway **deploy artifacts** (Dockerfile, `output: 'standalone'`, `copy-assets.js`, the IP-allowlist proxy), **CLAUDE.md core**, the privacy-policy page, commit, a push to the pre-existing `origin`, a **Container Registry namespace**, a **Serverless Containers namespace**, a direct **`docker build` + push** of the image (no GitHub Actions anywhere, CONTRACT.md §5), the **container** itself pointed at that freshly-pushed image, and a **smoke test** (fetch the URL, check 200 + that the stylesheet actually loads).

### Invocation (background + narration via Monitor)

The script takes several minutes (a cold Next.js image build with no warm layer cache is the long pole). Two Claude Code harness constraints to know about:
- **Synchronous `Bash` buffers everything** until the end → the user would wait blind for several minutes.
- **Long `sleep`s at the start of a command (≥ ~30s) are blocked** by a harness safety rail ("Blocked: sleep 45 ..."). No manual `sleep 45 && tail` pattern. It is locked.

The only solution that works: launch the script in the background with output to a log, then arm a **`Monitor`** that tails the log and emits a notification on each newly detected sub-step. The Monitor exits automatically when it sees the final banner.

**1. Guard the project name against collisions**

Before touching anything, check that the chosen name does not clash with an existing project. From the repo root, run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-name-collision.mjs" --name "<project-name>" --parent-dir "$(dirname "$(pwd)")"
```

The script reads the project's `status` in the returned JSON (it scans your existing projects: local sibling folders next to this checkout, the shared background clock, and your Scaleway Projects). React based on `status`:

- **`ok`** → no clash, go straight to step 2 with this name.
- **`exact`** → a project with this exact name already exists. It cannot be reused. Present the `suggestions` (they are safe, non-colliding names) via `AskUserQuestion` and let the user pick one or type their own. **Re-run this guard** on the chosen name until it returns `ok`.
- **`subset`** → the chosen name is contained inside an existing project's name (e.g. `street` while a `street-cool` already exists). This is the dangerous case: later, a cleanup of `<name>` could also sweep the other project's data. **Strongly recommend** one of the `suggestions` (which are built to avoid the overlap). Present them via `AskUserQuestion`, adding an explicit "keep `<name>` anyway" choice for the user who really wants it. If they pick a suggestion or type a new name, re-run the guard on it; if they explicitly keep the colliding name, proceed (their informed choice).
- **`superset`** or **`both`** → the chosen name *contains* an existing shorter project's name (e.g. `street-cool` while a `street` already exists). Warn plainly that the two overlap and that a future cleanup will need extra care to tell them apart. Here `suggestions` is usually empty (a name that wraps another cannot be auto-fixed by adding a word), so **ask the user** to either pick a clearly different name (re-run the guard on it) or confirm they want to keep it.

Always phrase this to the user in plain, non-technical language: talk about "another of your projects with a similar name" and "avoiding confusion when you later delete one of them", never about "tokens" or "subset/superset". If the JSON `notes` mention a source that could not be checked (Scaleway credentials missing), you may still proceed, but if `status` is `ok` **only** because a source was skipped, mention that the check was partial.

Whatever name clears this guard is the one you pass to `--name` at step 2 (and everywhere afterwards) - only when Step 1 needed a deploy-name override; if the repo name was already kebab-case, `--name` can be omitted entirely (the script derives it from `origin` on its own).

**2. Start the script in the background**

Run the block below, **from the repo root**, with **`run_in_background: true`** in the `Bash` tool. We redirect stdout+stderr to `$LOG_FILE`, and we echo the path BEFORE the redirection so we can retrieve it.

```bash
LOG_FILE="${TMPDIR:-/tmp}/bootstrap-init-$(date +%s).log"
echo "LOG_FILE=$LOG_FILE"
node "${CLAUDE_SKILL_DIR}/../../scripts/bootstrap-init.mjs" \
  --name "<project-name>" \
  --description "<150-160 char description from Step 1>" \
  --locale fr_FR > "$LOG_FILE" 2>&1
```

The tool returns a `bash_id` (useful for `KillBash` in case of a hang) and an `output-file` (the file where the harness captures the background bash stdout - it contains just the `LOG_FILE=...` line since the rest is redirected).

**If the operator's key lacks `ProjectManager`** (per-request delegation, CONTRACT.md §1): the `scwProject` sub-step fails with a JSON line carrying `"type":"needs_admin"` and `details.recipe: "project"`. Relay the script's French message to the user as-is - it is already a forwardable request, and points at `docs/ADMIN-SCALEWAY.md`, section Recette unique. Wait for the user to come back with the Project ID the admin created. Then re-run the same command from step 2, adding the flag:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/bootstrap-init.mjs" \
  --name "<project-name>" \
  --description "<150-160 char description from Step 1>" \
  --locale fr_FR \
  --scw-project-id "<Project ID from the admin>" > "$LOG_FILE" 2>&1
```

**If a Project already holds another Baudrier app's secret**: the sub-step fails with `"type":"project_already_used"` and `details.secretName`. Relay the script's French message as-is - reusing a Project would collide two apps' secrets, breaking the rule that a secret's name is the env var name (CONTRACT.md §2). Ask the user for a different Project id, then re-run with the new `--scw-project-id`.

The rest of the flow (Monitor, notifications, handoff banner) is unchanged.

**3. Retrieve the LOG_FILE path**

`Read` the `output-file` returned by the Bash. There you will find a single line `LOG_FILE=<absolute path>`. Remember this value - it is what the Monitor will tail.

The script scaffolds **directly into the current directory** - never a new subfolder. `/bootstrap` now **requires** being run at the root of the app's own pre-existing git checkout (the checkout the session opened on): it refuses and exits non-zero if `git rev-parse --show-toplevel` does not match the current directory, or if a scaffold already looks present (`package.json`/`src/`). It also refuses if the repository already tracks files other than a README, a licence, `.gitignore`, `.gitattributes`, `CHANGELOG.md`, or anything under `.github/`: `/bootstrap` scaffolds in place, so an existing codebase would get merged into rather than replaced. This is the opposite of the old sibling-directory model - there is no parent folder to `cd` into any more.

**4. Announce to the user + arm the Monitor**

Announce to the user:

> Script launched in the background. Several minutes, 26 sub-steps (the longest part is waiting for the image build). I will relay each new step as it goes.

Then launch the `Monitor` tool with this script (replace `<LOG_FILE>` with the real path remembered at step 3), `timeout_ms: 1200000` (20 min - the local `docker build`/push has no fixed timeout of its own but this is a generous margin for a cold layer cache), `persistent: false`, and a short `description` like `"bootstrap progress"`:

```bash
# LC_ALL=C forces grep into byte-mode, so it reliably matches the 4-byte UTF-8 🎉 marker below.
export LC_ALL=C
LOG="<LOG_FILE>"
LAST=""
while true; do
  if grep -q "🎉 bootstrap-init complete." "$LOG" 2>/dev/null; then
    echo "[DONE] success"
    break
  fi
  if grep -q "❌ Failed at:" "$LOG" 2>/dev/null; then
    echo "[DONE] failure"
    break
  fi
  # ^▸ [A-Z] = main steps only. `docker build`/`push` write their own
  # (unprefixed, very verbose) output straight into the same log file - this
  # filter is what keeps that noise from ever becoming a notification.
  CUR=$(grep -E "^▸ [A-Z]" "$LOG" 2>/dev/null | tail -1)
  if [ -n "$CUR" ] && [ "$CUR" != "$LAST" ]; then
    echo "$CUR"
    LAST="$CUR"
  fi
  sleep 4
done
```

⚠️ **The regex `^▸ [A-Z]` is crucial.** `docker build`'s own console output is extremely verbose and lands unprefixed in the same log file. Without the `[A-Z]` filter, that raw noise could otherwise be mistaken for real progress lines.

⚠️ **`export LC_ALL=C` at the start of the script is just as crucial.** Without it, `grep` can fail to recognize the 4-byte UTF-8 `🎉` marker in some locales, and the Monitor stays stuck until its timeout even though the script finished.

### During execution (notification handling)

You will receive `task-notification`s as they come. For each:

**Notif `▸ <Step>`** → post **one short sentence** to the user, in the format `↳ <translated/contextualized step> ...`. Examples:
- `▸ Installing with pnpm` → `↳ Installing pnpm dependencies...`
- `▸ Creating dedicated Scaleway Project "<name>"` → `↳ Creating your dedicated Scaleway space`
- `▸ Creating Scaleway Container Registry namespace` → `↳ Setting up image storage on Scaleway`
- `▸ Pushing <branch> to origin` → `↳ Pushing your code to GitHub`
- `▸ Building + pushing the Docker image (tag ...)` → `↳ Building and pushing your app's image (~2-5 min)`
- `▸ Creating Scaleway Serverless Container (scale S: ...)` → `↳ Creating your web server (Scaleway container)`
- `▸ Smoke-testing https://...` → `↳ Checking that your site is really online and styled correctly`

**Notif `[DONE] success`** → success. On the same turn or the next:
- Synchronous `Bash`: `tail -n 40 "<LOG_FILE>"` to retrieve the full handoff banner.
- Count the number of warnings (`⚠️  N warning(s) during the run`).
- If 0 warnings → move on to the sub-section "If the script finishes successfully WITHOUT warnings".
- If ≥1 warning → "If the script finishes successfully WITH warnings" → Step 3.
- Optional cleanup: `rm -f "<LOG_FILE>"`.

**Notif `[DONE] failure`** → failure:
- Synchronous `Bash`: `tail -n 200 "<LOG_FILE>"` to get the full context.
- Proceed according to "If the script fails" below.

**Safety net hang**: the `Monitor` has a `timeout_ms: 1200000` (20 min). If the timeout fires without us having seen `[DONE]`, it is a real hang. Read `tail -n 200 "<LOG_FILE>"` to diagnose. Kill the background bash with `KillBash` on the remembered `bash_id` (or `pkill -f bootstrap-init.mjs`).

The script writes to `$LOG_FILE`:
- `▸ <step>` when it starts each sub-step (26 main steps)
- `✅ <result>` at the end of each
- At the very end, a **handoff banner**:
  ```
  ────────────────────────────────────────────────────────
  Bootstrap-init handoff state
  ────────────────────────────────────────────────────────
  ✅ Completed (X/26): preflight, scwProject, scaffoldT3, ...
  ❌ Failed at: <step>           (if failure)
  ⏸  Not attempted: ...           (if failure)
  ⚠️  N warning(s) during the run: ... (if applicable)
  ────────────────────────────────────────────────────────
  ```

### If the script finishes successfully WITHOUT warnings

The smoke test confirmed that the site responds 200 and that its stylesheet actually loads (not just an unstyled page passing its health check). **Everything is ready.**

Announce to the user:

> 🎉 **Infrastructure ready!**
>
> - GitHub repo: `https://github.com/<gh-user>/<name>`
> - Scaleway: a dedicated Project, a container registry, and a Serverless Container are provisioned
> - Live site: `https://<container-domain>` ✅ (tested, responds 200, styling loads)
>
> Now let's move on to defining your project.

Mark Step 2 ✅, **skip Step 3** (nothing to handle) and go straight to Step 4.

### If the script finishes successfully WITH warnings

Mark Step 2 ✅, move on to Step 3 to handle the warnings.

### If the script fails

1. **Read the detailed error**: it is in the log JUST ABOVE the handoff banner (not in the banner itself).
2. **Identify the failed step** in the banner (`❌ Failed at: <step>`). The name maps 1:1 to a function in `scripts/bootstrap-init.mjs` - open that file and read the `<step>()` function to know exactly what it is supposed to do.
3. **Diagnose the cause**:
   - **T3 / shadcn drift** (regex sanity check warn) → patch the project manually drawing on the script + flag it to the user so they can patch the script afterward.
   - **CLI changed** (invalid flag for shadcn / T3 / docker) → fix manually then likewise flag it.
   - **External problem** (Scaleway credentials/network/quota, a `docker build`/`push` failure) → fix and re-run the script. If the failure is at `dockerBuildPush`, the actual Docker error is right there in the log (unprefixed, above the handoff banner) - no external run URL to fetch, unlike the old GitHub Actions model.
4. **Continue the remaining steps manually** (`⏸ Not attempted`) drawing on the script functions. Do not skip any of the banner steps - the smoke test in particular must confirm the site is live and styled before moving on. `scwProject` now runs right after `preflight`, before any local file exists - a failure there leaves nothing on disk to clean up, and a re-run with `--scw-project-id` starts clean. A failure at any later step may leave local files on disk AND partial Scaleway resources behind (a Project, a registry namespace, a container namespace, a container) - the Scaleway side is safe to re-run, every `scripts/scaleway/*` helper used is find-or-create / idempotent-PATCH. Unlike the old sibling-directory model, there is no "fresh folder" to retry into either way - the repo checkout is the one and only project directory (in-place bootstrap, CONTRACT.md §7).

### Notes on the script's choices (which you do not have to redo if successful)

- **`--dbProvider postgres`** (not `postgresql` - T3 bug).
- **No `--nextAuth` flag** in the T3 command → NextAuth is NOT scaffolded. So the script does NOT push a placeholder for `AUTH_SECRET`. It is `/add-auth` that handles all that later when the user wants auth.
- **drizzle-orm bumped to 0.45.2+** right after scaffold (SQL injection CVE fix).
- **Demo cleanup**: removal of `src/server/api/routers/post.ts`, of the orphan component `src/app/_components/post.tsx`, of the obsolete JSDoc in `root.ts` that references `trpc.post.all()`, of `src/server/db/schema.ts`'s multi-project table-prefix helper (each app gets its own dedicated Scaleway database, so there is nothing to prefix), and **replacement of the T3 home with a minimal page showing `<h1>{name}</h1>`**.
- **Healthcheck router** injected into `src/server/api/routers/healthcheck.ts` + wired in `root.ts` - otherwise an empty `appRouter` would crash the TS build. The gate-exempt endpoint is separate: a plain `/api/healthz` route (`src/app/api/healthz/route.ts`), which `src/proxy.ts` exempts with an exact pathname match - a tRPC prefix exemption would reopen the batching bypass. The keep-warm Job pings `/api/healthz`.
- **shadcn init via `npx`** (not `pnpm dlx` which crashes with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`).
- **`LinkButton`** created in `src/components/ui/link-button.tsx` because shadcn v4 does not expose `asChild` on `Button`.
- **globals.css patch**: strip of `--font-sans: var(--font-sans);` injected by shadcn init, which clobbers the T3 Geist mapping (without this fix the app renders in Times New Roman).
- **Security headers** + `rate-limit.ts` + `rateLimitedProcedure` via `setup-security.mjs`.
- **SEO metadata** + sitemap + robots + JSON-LD via `setup-seo.mjs`.
- **404 page polish**: `src/app/not-found.tsx` with a clean design (gradient on the 404, `LinkButton` back to home, fade-in animation).
- **Deploy artifacts**: `Dockerfile` (multi-stage, `node:24-alpine`), `next.config.*` patched (not overwritten - security headers survive) for `output: 'standalone'` + `images.remotePatterns` on `**.scw.cloud`, `copy-assets.js` (restores `.next/static/` + `public/` into the standalone output - the #1 way this setup would silently ship an unstyled site), `src/proxy.ts` (the IP-allowlist gate).
- **CLAUDE.md core**: project name + description + stack + structure + commands + T3-specific conventions (Geist, LinkButton, shadcn, tRPC patterns, IP-restriction, etc.), plus the cross-project conventions (TypeScript no-any, responsive mobile-first, etc.). This file is the only carrier: the web sandbox has no persistent home, so nothing survives in `~/.claude/`.
- **Placeholder env vars**: only `DATABASE_URL` (`postgresql://placeholder...`) to pass Drizzle's Zod validation. `APP_URL` is set to the container's real Scaleway domain right after creation, and `ACCESS_RESTRICTED` to `"true"`. All three go through the container's **secret** channel, even though the last two are not secret: `environment_variables` replaces the whole map on update while `secret_environment_variables` merges per key, so the plain channel would silently drop values written by a later step. The proxy also fails **closed** - anything other than the literal `"false"` means restricted - so a lost variable cannot accidentally publish an app.
- **No linkage file of any kind is written** (CONTRACT.md §2, §7): `deploy`, `add-domain` and `_push-env-vars` all find this app's Scaleway Project, namespace, and container again by resolving them **by name** - the app name, which is always the repo name - never from a file this script wrote earlier.
- **Direct build + push, then the container**: once the registry namespace exists, this machine itself runs `docker build --platform linux/amd64` and pushes the image straight to it, tagged with the commit SHA - no GitHub Actions anywhere in the pipeline (CONTRACT.md §5). The container is created only after that push succeeds (Scaleway validates the image against the registry at container-creation time, so a tag that does not exist yet would be rejected outright) and is then waited on until ready.
- **Smoke test**: fetches the container's URL with the `ACCESS_BYPASS_TOKEN` header (minted by `scwContainer()`, checked by the generated `src/proxy.ts`, CONTRACT.md §6), so HTTP 200 is expected from any machine, web sandbox included. Checks 200, extracts the page's own stylesheet `<link>` and fetches THAT too - a bare 200 check would miss the Geist-font/copy-assets regressions. A 403 despite the token is a real warning (token not synced, or the proxy check is missing), never an expected outcome.

---

## Step 3 - Warning handling (conditional)

⚠️ **This step only exists if the script reported warnings in its handoff banner**. If the output contains no warning, mark this step ✅ right away and go to Step 4 without saying anything to the user.

Warnings at this stage are almost always **T3/shadcn drift** picked up by the script's `expect()` sanity checks (T3 or shadcn changed their output since this script was written), a Scaleway-side hiccup during provisioning, or the **IP-gate warning** below. For each warning:

1. Inspect the mentioned file/resource to see what drifted.
2. Patch manually if the consequence is visible (e.g. font in Times New Roman → fix the `--font-sans` mapping in `globals.css`; a Scaleway resource not created → re-run the corresponding step function's logic manually, they are all idempotent find-or-create calls).
3. Note what should be fixed in `bootstrap-init.mjs` for next time (to mention in the final summary if you do not have time to fix it yourself).

There is no GitHub-App-authorization class of warning in this pipeline (unlike platforms that need a separate "connect your GitHub" step) - this machine builds and pushes the image itself on `git push`, no GitHub Actions and no browser authorization involved anywhere (CONTRACT.md §5).

### The IP-gate warning (`ACCESS_ALLOWED_IPS`)

`detectEgressIps()` / `smokeTest()` warn when the app's IP allowlist ends up empty or wrong for this machine - the two shapes to recognize in the banner:

- **"Could not detect this machine's public IP address. `ACCESS_ALLOWED_IPS` stays unset..."** (a non-web machine whose egress-IP lookup failed), or **"Running in a Claude Code web sandbox: ... `ACCESS_ALLOWED_IPS` is not seeded from it..."** (expected on web - the sandbox's own address is never the operator's, so it is never auto-allowlisted).
- A `smokeTest` 403-despite-token warning naming the address the gate saw (the harness token bypass did not work; the operator's browser access is a separate question).

**Handle this once, never re-ask while the secret already exists**: check first whether `ACCESS_ALLOWED_IPS` is already set (`node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" get ACCESS_ALLOWED_IPS`, or infer it from the warning text itself). If it genuinely does not exist yet, ask the user exactly once, in French:

> Pour que vous puissiez voir votre site (il est restreint par défaut), ouvrez https://ip.me dans votre navigateur et collez-moi l’adresse affichée.

Once they reply, store it and sync the container:

```bash
printf '%s' "<adresse collée>" | node "${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" put ACCESS_ALLOWED_IPS --stdin
```

then sync the container so it actually picks up the new value (the same `syncContainerSecrets` call `scwContainer()` itself makes):

```bash
CONTAINER_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" \
PROJECT_NAME="<project-name>" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { ensureNamespace, findContainerByName, syncContainerSecrets } = await import(pathToFileURL(process.env.CONTAINER_MJS).href);
const ns = await ensureNamespace(process.env.PROJECT_NAME);
const container = await findContainerByName(ns.id, process.env.PROJECT_NAME);
const ready = await syncContainerSecrets(container.id, {});
console.log(JSON.stringify({ ok: true, status: ready.status }));
'
```

The smoke test itself authenticates with `ACCESS_BYPASS_TOKEN` and does not depend on `ACCESS_ALLOWED_IPS` at all - this warning is only about the USER reaching their own site from a browser. Ask for the ip.me address when the allowlist is genuinely empty or the user reports a 403, never because of the smoke test.

---

## Step 4 - Spec & confirmation

The infrastructure is ready and deployed. Now we define what we are going to build in it.

### 4a - Mode choice

**Use the askUser tool** to present the three options:

Ask with `askUserQuestion` tool:
- Question: "How do you want to define your project?"
- Suggestions: ["A - Build a spec together (guided, step by step)", "B - I already have a spec (.md file)", "C - No spec, let's go from the description"]

---

**If the user chooses A (build a spec together):**

Read and execute the `spec` skill from this plugin. The spec skill will:
- Guide the user through a structured conversation to define pages, design, features, and integrations
- Produce a `cahier-des-charges.md` file in the project folder
- Return a list of infrastructure decisions (which addons to activate) already answered during the conversation

After the spec skill completes, you have the spec file AND the infrastructure answers. Skip directly to 4b (Confirmation) below.

---

**If the user chooses B (provide an existing spec):**

Ask: "Place the .md file in the current folder and give me its name."

Read the spec file entirely. Silently infer the infrastructure needs from its content (DB, auth, email, storage, analytics, map) using the inference rules below. Do NOT ask the user for confirmation at this stage - the 4b loop is the single confirmation point.

If some decisions are genuinely ambiguous, ask ONE targeted question via the askUser tool to resolve. Don't batch multiple questions - resolve the hardest one first, the rest will surface at 4b if needed.

Then go to 4b.

---

**If the user chooses C (no spec, short description only):**

Tell the user: "OK, I will create a simple app based on your description. You can then enrich it with vibe coding." Then silently infer addons from the description using the rules below. No intermediate confirmation - go straight to 4b.

**Inference rules (applies to branches B and C):**

- Users, accounts, data, content management → add-db + add-auth (credentials)
- Admin, backoffice, protected pages → add-auth (credentials)
- Login, registration → add-auth (credentials). Do NOT ask which OAuth provider - bootstrap always uses Credentials; extend later if the user wants social login.
- Emails, contact form, notifications, confirmations → add-email
- File uploads, images, documents → add-storage
- Analytics, tracking, statistics, audience measurement → add-analytics (Matomo). ⚠️ **STRICT OPT-IN**: only propose `add-analytics` IF the user explicitly wrote words like "analytics", "tracking", "statistics", "audience measurement" in their spec or short description. **Never as a "useful" default**: a site about marketing or SaaS does NOT trigger analytics on its own. When in doubt → no, the user can add `/add-analytics` later.
- Map, interactive map, agencies, stores, points of sale, locations, "find", "where to find us", route, map-first app, geolocation → add-map. Also infer the `usage` (single / multi / route / mapfirst) and the `placement` (existing contact page / dedicated page to create / home) from the spec to pass these hints to the skill - it will then be able to skip its discovery question.
- Any app that stores data implicitly needs add-db (e.g., "booking app" → needs a DB).

---

### 4b - Confirmation (loop)

This is **the single confirmation point** before configuring the addons. Present this summary to the user:

> **Summary before configuring the addons:**
>
> **Project:** <name> - <description> *(already created on GitHub + Scaleway ✅)*
> **Spec:** <yes (filename) / no>
> **Addons to configure:**
> - Database: <yes/no>
> - Authentication: <yes (credentials mode) / no>
> - Email: <yes/no>
> - Storage: <yes/no>
> - Analytics: <yes/no>
> - Interactive map: <yes (inferred usage: single / multi / route / mapfirst) / no>
>
> **Shall I launch the configuration, or do you want to change the list?**

Then, two possible cases:

- **Validation** (OK / go / launch / it's good / perfect / sure / etc.) → move **immediately on to Step 5**. Do NOT re-present the summary. Do NOT write an intermediate message.
- **Change request** (e.g. "remove storage", "add analytics") → apply the change to your internal list, then **re-present the SAME summary block with the updated values** and the same final question. Loop like this until explicit validation - with no iteration limit.

If the requested change is ambiguous (e.g. "can we remove stuff?"), ask **one single** short clarification question, then loop again.

⚠️ The project name is no longer changeable at this stage (the Scaleway resources are already created under it, and the GitHub repo it lives in was already named before this run started). If the user asks to change the name, explain that the Scaleway side would require starting over from scratch and propose to continue with the current name.

---

## Step 5 - Addon configuration

Configure each optional service that the user requested at Step 4. For each, **read the corresponding skill file** from this plugin and follow its instructions step by step.

**Important:** Read the skill's SKILL.md content and execute the steps described in it as if you were following the instructions yourself.

Run them **in this order** (dependencies matter):

1. `add-db` (if database was requested) - must run before auth (auth needs DB tables)
2. `add-auth` (if authentication was requested)
3. `add-email` (if transactional email was requested)
4. `add-storage` (if file storage was requested)
5. `add-analytics` (if analytics was requested)
6. `add-map` (if an interactive map was requested) - pass the inferred usage + placement as context so the skill can skip its discovery question. If the markers need to live in DB (mapfirst with > 30 points or admin-editable), add-map will require add-db to have run first (handled by the skill's own preflight, but the ordering above already ensures it).

For each addon, the skill file handles its own prerequisites check, installation, configuration, env var push, and CLAUDE.md update (via `_update-claude-md`). Follow each skill's steps completely before moving to the next addon.

**Do not skip addons.** If an addon fails, stop and report the error before continuing to the next one.

### Progress communication during the addons

⚠️ **Important rule**: the addon SKILL.md files have their own internal structure in `## Step 1`, `## Step 2`, etc. This structure is **for Claude's internal use** to organize its work, **not to display to the user**. NEVER show the "Step 1", "Step 2" numbers of an addon in the chat - that would create a double numbering with the main `Step X/8` numbering of the bootstrap. **Likewise, NEVER mention the names of internal skills prefixed with `_`** (like `_push-env-vars`, `_update-claude-md`, `_detect-project-root`, etc.) - that is internal mechanics. Describe the action in plain language instead (e.g. "I am saving your keys" rather than "I am invoking `_push-env-vars`").

Communication pattern to follow instead:

1. **At the very start of Step 5**, announce the list of addons requested by the user:

   > I am going to configure 2 addons: your database, and email.

   (Adapt: number and list according to what was requested at Step 4.)

2. **Before each addon**, display a header like:

   > 📦 **1/2 - Database addon**

   Use a short descriptive name for the addon (Database / Authentication / Email / Storage / Analytics / Map).

3. **During each addon**, describe your actions in plain language, with a `↳` to show they are part of the current addon. Examples:

   > ↳ I am creating your database on Scaleway...
   > ↳ I am installing Drizzle ORM... ✅
   > ↳ I am applying the schema... ✅

   **Never show "Step 1", "Step 2", etc. to the user.** Just describe what you are doing.

4. **After each completed addon**, display:

   > ✅ **Database addon configured**

5. **After all the addons are done**, mark step 5/8 as `✅` in the main checklist and move on to Step 6.

---

## Step 6 - Building the application

The infrastructure and the addons are in place. Now we build the real application.

### If a spec (.md) was provided:

1. **Re-read the spec file** to refresh context on what needs to be built.

2. **Plan the implementation order.** Work section by section through the spec. Prioritize in this order:
   - Database schema (if the spec defines tables beyond what the addons already created)
   - Layout and navigation (header, footer, shared components)
   - Pages, in the order they appear in the spec
   - Integrations (email triggers, form submissions, etc.)
   - Design refinements (animations, responsive adjustments, visual polish)

3. **Implement each section.** For each page or feature described in the spec:
   - Create the page/component files
   - Wire up the tRPC routes, database queries, or API calls needed
   - Style with Tailwind CSS and shadcn/ui components

4. **If the spec is ambiguous or incomplete on a point**, ask the user for clarification before proceeding. Do not guess.

### If only a short description was provided:

**You MUST still build a complete, functional, beautiful application.** Do not leave a placeholder page. The user expects a working app they can use immediately.

1. **Interpret the description** and make smart decisions about what pages, features, and database schema the app needs. Think like a product designer: what would make this app genuinely useful?

2. **Design the database schema** based on the description. Create the Drizzle tables (directly with `pgTable` - no table-name-prefix hack, this app has its own dedicated database), push them to the Scaleway Serverless SQL database.

3. **Build the full application:**
   - A polished layout with header/navigation and footer
   - All the pages the app logically needs (landing, dashboard, detail views, forms, etc.)
   - tRPC routers for all CRUD operations
   - Functional forms, lists, filters, and interactions
   - Responsive design with Tailwind CSS and shadcn/ui components
   - **If the app has data that needs to be managed** (reservations, orders, products, users, content, etc.), build an `/admin` section with Credentials auth and a dashboard to manage that data (list, create, edit, delete). This is the case for most apps.

4. **Make it beautiful.** Choose a coherent color palette and design system. Use modern UI patterns: cards, badges, gradients, hover effects, transitions. The app should look professional, not like a tutorial exercise.

5. **Use real images, never gray boxes or invented local paths** (e.g. `/images/hero.jpg` without the file → 404). **Default: the local placeholders in `public/placeholders/`** - 8 SVG files (`placeholder-01.svg` to `placeholder-08.svg`, gradient + geometric compositions, no text) written by `bootstrap-init.mjs` at scaffold time. Pick whichever file suits each section's tone (a warm palette for a hero, a cooler one for a feature grid) and reference it as a normal local asset:
   ```tsx
   <Image src="/placeholders/placeholder-03.svg" alt="Description descriptive" fill unoptimized />
   ```
   `unoptimized` is required for SVG (Next.js does not rasterize vector images - see `next.config.js`'s `dangerouslyAllowSVG`). Because these are real committed files, not a generated-per-request URL, there is no seed/determinism concern the way there was with a remote service.
   - **Real photos** (a specific product, a team portrait, a real storefront) come from the user's own uploads, stored in the project's own Scaleway Object Storage bucket (`/add-storage`) - never from a third-party photo service. Loading a stock-photo URL sends every visitor's IP address to a US company (Lorem Picsum/Cloudflare, Unsplash) on every page load; this product's whole premise is not doing that. Do not use `https://picsum.photos/...` or `https://images.unsplash.com/...` in generated code.
   - If the user explicitly wants a specific real photo before storage is wired up, ask them to send the file and save it under `public/` directly - do not fall back to a remote placeholder service.
   Always wrap in the `<Image>` component from `next/image` with a descriptive `alt`.

6. **Be generous with features.** If the description says "a restaurant app", build: a landing page with hero + menu sections, a reservation form that saves to DB, an admin dashboard to manage reservations, and a contact section. Go beyond the minimum.

   **⚠️ Admin dashboard - mandatory pattern to avoid the redirect loop**: if you generate an admin with a custom login page (`/admin/signin`), NEVER ADD a gate (`if (!isAdmin) redirect("/admin/signin")`) in `app/admin/layout.tsx`. This layout also wraps `/admin/signin/page.tsx` → infinite loop. Correct pattern:
   ```
   app/admin/
     signin/page.tsx          ← outside the gate
     (protected)/
       layout.tsx             ← gate HERE only
       page.tsx               ← /admin
       <other pages>
   ```
   The `(protected)` is a route group (parentheses, does not appear in the URL). Simpler alternative if you want to avoid the route group: no layout-gate, gate page-by-page with `if (!await isAdmin()) redirect("/admin/signin")` at the start of each protected `page.tsx`.

### For both cases:

- **After each major section**, commit the progress:
  ```bash
  git add .
  git commit -m "feat: implement [section name]"
  ```
- **Do NOT deploy after each section.** Wait until the full implementation is complete (Step 8 will handle the final push + deploy).
- The spec/description takes priority over defaults. If it says "dark theme with purple accents", follow that, not the T3 defaults.
- Read `src/app/globals.css` (or `src/styles/globals.css` depending on what T3 scaffolded) before creating any component to stay consistent with the palette and design tokens already defined.
- Always use shadcn/ui components from `~/components/ui/` before creating custom ones.
- ⚠️ **IMPERATIVELY PRESERVE the T3 Geist font setup.** NEVER remove/modify in `src/app/layout.tsx` the `Geist` import from `next/font/google`, the `const geist = Geist({...})` instance, nor the `geist.variable` className on `<html>`. NEVER remove the `--font-sans: var(--font-geist-sans)` rule (or equivalent `font-family: var(--font-geist-sans)`) in the global CSS. If you rewrite `layout.tsx` or the CSS to change the design, copy these blocks back intact. **Otherwise the app falls back to the browser's default Times New Roman - unacceptable.** If you really want to change the font, replace Geist explicitly with another Google Font via `next/font` while keeping the same structure (import → instance → variable on html → CSS rule).

---

## Step 7 - Finalization: CLAUDE.md, legal pages

The Step 2 script already created a CLAUDE.md core and a 404 page polish. The Step 5 addons already added their sections in `CLAUDE.md` via `_update-claude-md`. This step completes the remaining elements: the spec mention if provided, the non-technical communication convention (specific to baudrier), the favicon, and the legal pages.

### 7a - Complete `CLAUDE.md`

**If a spec was provided (option A or B at Step 4)**, add this line right after the project title + description, before the `## Stack` section:

```
**Spec**: `<filename>.md` - read this file for the full project context.
```

Use a direct Edit (the `_update-claude-md` helper does not handle insertion at a specific spot outside a section).

**Non-technical communication (specific to baudrier)**: invoke `_update-claude-md` with section `conventions` + this single line:

> `- Communication: the user of this app is NON-TECHNICAL. In all your summaries (what was done, what remains, problems encountered, manual steps), explain in clear and understandable language, **with the corresponding technical term in parentheses when possible** - the user learns the vocabulary along the way. Instead of "I patched the middleware", say "I modified the part of the site that decides who sees what (the \"middleware\")". Instead of "I added an index on the users table", say "I sped up the user search (added an \"index\" in the database)". Keep the bare jargon only in the code and the code comments.`

(The helper is idempotent - re-runs will not duplicate.)

### 7b - Legal pages

Any site published in France needs at minimum **Legal Notice** and **Privacy Policy**. We create them systematically.

#### 7b.1 - Gather the info from the user

Before generating the pages, ask the user for the following info (if not already known):

**For the Legal Notice:**
- Company name (company name or personal name if sole trader)
- Legal form (SASU, SAS, SARL, sole trader, etc.)
- SIRET number
- Address of the registered office
- Intra-community VAT number (if liable)
- Name of the publication manager
- Contact email
- Phone number (optional but recommended)

**For the Privacy Policy:**
- Which personal data is collected (email, name, address, etc.) - Claude Code can deduce this from the project config (auth = email/name, analytics = browsing data)
- Use of cookies (if analytics is configured)
- Data retention period
- Whether a DPO (data protection officer) is appointed - for a small structure, generally not

**The host is Scaleway.** Claude Code should look up Scaleway's current legal-entity details (company name, registered office, SIRET/RCS) directly from Scaleway's own published legal notice (https://www.scaleway.com) before finalizing the client's Mentions Légales, rather than relying on a fixed value here - registered-company details can change and must be accurate in a legal document.

#### 7b.2 - Generate the Legal Notice page

Create `src/app/mentions-legales/page.tsx`.

The page must include:
- Publisher identity (company name, legal form, SIRET, VAT, address, contact)
- Name of the publication manager
- Host information (Scaleway, France - see 7b.1 for sourcing the exact legal-entity details)
- Site terms of use
- Intellectual property

Style: clean, readable, Tailwind prose. Include a link back to home.

#### 7b.3 - Privacy Policy page (already generated)

The Step 2 bootstrap script (privacyPolicy step) already generated a data-driven Privacy Policy page at `src/app/politique-de-confidentialite/page.tsx`, rendered from a subprocessors registry that each `/add-*` skill keeps up to date. **Do not create a second privacy page** (no `src/app/confidentialite/page.tsx`).

Just verify the generated page exists and renders, and make sure the footer (Step 7b.4) links to `/politique-de-confidentialite`.

#### 7b.4 - Footer links

Add the links to "Legal notice" and "Privacy policy" in the site footer or layout. If there is no footer yet, create a minimal one.

### 7c - Favicon

The T3 starter ships a generic Next.js `favicon.ico` (the Next logo). We replace it with a project-specific favicon, **without asking a question** (autonomy): we derive it from the project name and palette.

**Approach**: a `src/app/icon.svg`. The Next.js App Router automatically detects an `icon.svg` file (or `icon.png`, `favicon.ico`...) placed at the root of `src/app/` and generates the `<link rel="icon">` tags on its own, with no code to write in the layout or in `metadata`. The SVG is crisp at all sizes and weighs nothing.

**Steps:**

1. **Choose the initials.** 1 letter by default (first letter of the project name, uppercase), or 2 letters if the name is made of several words (e.g. "Mon Super Projet" → "MS", "baudrier" → "B"). Keep it short and readable at 16x16 px.

2. **Choose the gradient colors.** Read `src/app/globals.css` and retrieve the project's primary / accent color (typically a CSS var `--primary`, `--accent`, or the brand color defined at bootstrap). Build a gradient from that color (from the primary color toward a slightly darker/more saturated variant, or toward a 2nd accent color if the palette has one). If no usable color is found, use an elegant neutral gradient (e.g. `#1A1410` → `#4B4036`). Choose a text color (white `#FFFFFF` or cream) that contrasts sufficiently with the background.

3. **Write `src/app/icon.svg`** on this template (replace the `<...>`):

   ```svg
   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
     <defs>
       <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="<COLOR1>"/>
         <stop offset="1" stop-color="<COLOR2>"/>
       </linearGradient>
     </defs>
     <rect width="32" height="32" rx="7" fill="url(#bg)"/>
     <text x="16" y="22" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="<18 if 1 letter, 13 if 2 letters>" font-weight="700" fill="<TEXT_COLOR>"><INITIALS></text>
   </svg>
   ```

4. **Delete the default T3 favicon** if it exists, to prevent it from taking priority over `icon.svg`:

   ```bash
   rm -f "<webDir>/src/app/favicon.ico"
   ```

   (`<webDir>` = root of the app detected at Step 2; in a monorepo it is `apps/web`.)

Do **not** launch the dev server nor the preview to check the rendering (see the important rules at the end of the skill). The favicon will be committed and deployed with the rest at Step 8b.

---

## Step 8 - Final audit, commit, deploy, summary

### 8a - Audit dependencies

Run a security audit silently via `pnpm audit`. The preflight (Step 2) guarantees pnpm 11+, on which `pnpm audit` reaches the current `advisories/bulk` endpoint (only pnpm 10 and older hit the deprecated `/audits/quick` endpoint that 410s). `--prod` restricts the audit to production dependencies.

```bash
pnpm audit --prod --json 2>&1
```

Analyze the JSON output (npm-audit-compatible shape: `advisories` / `metadata.vulnerabilities`). For each vulnerability found, determine if it affects a production dependency (`--prod` already excludes devDependencies).

> ℹ️ If `pnpm audit` itself errors (offline, or an older pnpm slipped through), don't block the bootstrap - note it and move on. The deploy in 8b is the real gate.

- **Production vulnerability, critical or high**: parse the JSON output to identify the offending packages + their `fixAvailable.version`. `pnpm update <package>@<safe-version>` only fixes a DIRECT dependency - it cannot move a transitive one (e.g. `postcss`, `sharp` pulled in by another package). For a transitive advisory, add or extend the `overrides:` block in `pnpm-workspace.yaml` (pnpm 11 reads workspace-level overrides from there, not from `package.json`), then run `pnpm install`. Do not ask the user - just fix it.
- **Moderate or low severity**: ignore silently.
- **If nothing needs fixing**: move on without saying anything.

Only mention the audit to the user if a production vulnerability was found AND could not be fixed automatically.

### 8b - Final deploy

Read and execute the `deploy` skill (`skills/deploy/SKILL.md`) from this plugin, **targeting production directly - skip its own Step 0 ("deploy wanted at all?") and Step 1 (target) confirmations here**. This is the one documented exception to the global "never deploy without explicit consent" rule (the user already consented to the whole bootstrap, which always ends with a working, live app), so there is no need to ask again. `deploy` skill's own Step 0 already names this exception.

The `deploy` skill's own script (`scripts/deploy.mjs`) commits any remaining local changes, pushes, builds and pushes the image directly (`docker build --platform linux/amd64`, starting the daemon lazily if needed - no GitHub Actions, CONTRACT.md §5), runs the (empty, at this point) migration Job, updates the container, smoke-tests the live URL, and prunes old registry images. It ends with one JSON line - parse it exactly as the `deploy` skill's own Step 4 describes.

⚠️ **This verification step is NON-NEGOTIABLE**. A failed deployment that is not surfaced to the user is worse than a visible error: the site is broken in prod without anyone knowing. If the JSON line does not say `"success":true`, the bootstrap is not done - follow the `deploy` skill's own failure-diagnosis table (preflight/commitPush → fix and retry; buildPush → read the raw Docker build error in the log, fix, retry; migrate → the container was never touched, fix the migration and retry; updateContainer/smokeTest/pruneTags → safe to retry the whole thing).

### 8c - Mandatory final announcement

Display this exact message to the user (bootstrap closing message - this is what confirms to them that everything went all the way through):

> 🎉 **BOOTSTRAP COMPLETE**
>
> Your project is scaffolded, deployed, and the application is built. Here is the summary below.

Then present a **two-part summary** to the user:

#### Part 1 - What was done

List everything that was configured during bootstrap, grouped by category. Only include what actually applies:

> **Project - Summary**
>
> **Infrastructure:**
> - GitHub repo: `https://github.com/<user>/<project-name>`
> - Scaleway Serverless Container (region Paris - fr-par): `<deployment-url>`
> - Scaleway Serverless SQL database: provisioned and connected
> (etc.)
>
> **Application:**
> - T3 Stack scaffolded (Next.js + tRPC + Drizzle + Tailwind + shadcn)
> - Home page + (other pages built)
> - Legal pages: mentions-legales, politique-de-confidentialite
> - 404 page polish
> - (list each module that was configured)
>
> **Generated files:**
> - `CLAUDE.md` - project context for Claude Code (future sessions will read it automatically)
> - `.env` - local variables (dev)

#### Part 2 - Actions that ONLY the user can do

⚠️ **Strict rule**: only put here actions that you cannot do yourself (CLI/API not available, third-party account creation, saving a secret in a password manager, business decision). If an action can be done via a CLI or an API you master (`git push`, `docker`, `_push-env-vars`, the Scaleway SDK, etc.), it must already have been done - and appear in Part 1, not here.

For the actions that remain (genuinely manual), give **step-by-step** instructions. Number them in priority order. Only include what applies.

**If Credentials auth was configured:**

> **1. Save the prod admin password**
> The admin password for production is: `<generated password>`
> It is stored nowhere in the code - only the hash. Note it somewhere secure (password manager).

**If Email was configured:**

> **2. Verify the sender domain**
> Scaleway Transactional Email requires the sender domain to be verified (SPF/DKIM/DMARC records) before it can send to recipients outside your own account. If this wasn't finished during the addon configuration, ask Claude Code to check the domain status and finish the DNS setup.

**Always include as the last item:**

> **Last step - See the result**
> Your project is already live. Open the URL listed above, in the Infrastructure section, to see it.

Step 8b already deployed the project to production as part of this run, so there is nothing left to launch and no question to ask. Never offer to start a local server for the user to open: `http://localhost:3000` is this machine's own loopback address, and the user's browser cannot reach it.

Adapt the content and numbering based on which options were actually selected. Do not include sections for services that were not configured. Use the actual domain and URLs from the project.

---

## Important rules

- **You do, you do not delegate.** Anything that can be executed via a CLI or an API (git, pnpm, docker, the Scaleway SDK, `_push-env-vars`, etc.) must be executed by you, without asking the user. See the "Autonomy principle" at the top of the file. This rule overrides all others in case of conflict.
- **Always use pnpm.** Never use npm or yarn. Use `pnpm add` to install packages, `pnpm dev` / `pnpm build` to run scripts, and `pnpm dlx` instead of `npx` when possible (except for `shadcn` which requires `npx`).
- **Env vars always go through `_push-env-vars`** (never edit `.env` by hand for anything that should also reach the live container). The helper handles the local `.env` update + Scaleway Secret Manager + the container's `secret_environment_variables` (resolving the container by name, never from a linkage file) + idempotency in a single call.
- **Never commit secrets.** Always use `.env` + `.gitignore`.
- **Stop and ask** if any CLI command fails. Do not retry blindly.
- **Explain each step** briefly as you go, so the user knows what's happening.
- **If a service requires manual action** (e.g., creating an account, generating an API token in a third-party dashboard), clearly tell the user what to do and wait for confirmation before continuing.
- **NEVER INVOKE `pnpm dev` DURING THE BOOTSTRAP RUN itself.** This is scoped to the run, and for a mechanical reason: Step 2 through Step 8 execute as one long unattended sequence with no user turn in between, and a dev server never exits on its own - starting one mid-sequence would hang the skill waiting on a process that was never going to finish. No "let me quickly check that it compiles by starting the dev server" between 2 steps, no "let me test that the page renders well" during the bootstrap. During the run, validate with `pnpm tsc --noEmit` (typecheck) and `pnpm lint` - **never** `pnpm dev` - but treat these as a floor, not a substitute for actually running the app: they catch type errors and style issues only, never a runtime bug, a broken layout, or wrong data on the page. The real check happens at Step 8b's deploy, or in the normal dev loop described below.
- **After bootstrap, the default loop is local, and it is the assistant's own check, never the user's.** Once `🎉 BOOTSTRAP COMPLETE` has been shown, the run-scoped prohibition above no longer applies: the assistant can start `pnpm dev` in the background and fetch `http://localhost:3000` from inside this same machine to check a change before it reaches the user. That address is this machine's own loopback address - it is never reachable from the user's browser, so never present it to the user as a way to see the app, and never ask the user to open it. The generated project's own `CLAUDE.md` documents this loop (including the `tryDb` database-resilience helper, `src/server/db/safe.ts`, once a database is configured). A deploy is not the default next action after a later change - reserve it for when the user explicitly asks to see something live, always confirm before deploying, and steer to a private preview first if production is already published (see `skills/deploy/SKILL.md`).
