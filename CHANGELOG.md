# Changelog

## v1.1.0 (2026-08-10)

Retires `/start`. `/bootstrap` is now the only documented entry point, and it
runs the preflight checks itself, so no separate first-run command is needed.

### Removed

- **The public `/start` skill.** `skills/start/` is deleted. Its three
  surviving checks move into the new internal `skills/_preflight/SKILL.md`
  (`user-invocable: false`), which `/bootstrap` invokes at its own Step 0.
  Internal `_`-prefixed skills are never named to the user, so the README no
  longer mentions `/start` anywhere.
- **The git-identity step and `scripts/audit-clis.mjs`.** The Claude Code web
  sandbox already commits as the `claude` user, so the harness configures no
  git identity of its own. `scripts/setup-git-identity.mjs` and
  `scripts/audit-clis.mjs` are gone, and `scripts/bootstrap-init.mjs` no
  longer calls either.
- **All references to the `baudrier-template` repository.** The team retired
  this GitHub repository. `README.md` now describes the current flow: the
  user opens a Claude Code web conversation on their own repository, with
  the « Baudrier » environment, then runs `/bootstrap`.
- **The `BAUDRIER_SCW_MODE` env var.** It gated one thing: whether
  `scwProject()` could create a Scaleway Project. `needsProjectIdError()`
  and its `"type":"poc_needs_project_id"` error contract are gone too, along
  with the variable. A Cas B user who already set `BAUDRIER_SCW_PROJECTS_IDS`
  needs no migration. A stale `BAUDRIER_SCW_MODE` left in a cloud environment
  is simply ignored.

### Changed

- **The Project scope now resolves by inference, not by a mode flag.** If a
  Project id is already configured - `--scw-project-id`, a matching
  `BAUDRIER_SCW_PROJECTS_IDS` entry, or `SCW_DEFAULT_PROJECT_ID` - the
  harness uses that Project and never creates one. If no id is configured,
  it lists the organization's Projects and creates one if needed; a 403
  still raises `"type":"needs_admin"`, which `/bootstrap` already recovers
  from by asking the user for a Project id and retrying with
  `--scw-project-id`.
- **`/bootstrap`'s preflight guard now refuses more than a JavaScript
  scaffold.** The old guard checked only for `package.json` or `src/`, so a
  Python or Go repository passed the check and got a Next.js app merged
  into it, then committed and deployed. The guard now also refuses any
  tracked file other than a README, a licence, `.gitignore`,
  `.gitattributes`, `CHANGELOG.md`, or anything under `.github/`.

## v1.0.1 (2026-08-09)

Removes the local review from `/deploy`. The harness runs on Claude Code web,
where `http://localhost:3000` is the ephemeral VM's own loopback address: the
user's browser can never reach it, and the platform offers no port forwarding
and no preview URL. The old menu therefore offered an option that could not
work, and three skills called preview tools that do not exist in a web session.

### Changed

- **`/deploy` asks a question the published state picks, and the answer also
  decides the branch.** The skill reads `ACCESS_RESTRICTED` before it asks
  anything. An unpublished site gets one confirmation, because its production
  site is already private and is therefore its own review. A published site
  gets a menu: a private preview first, or production. Choosing production
  merges the working branch into `main` and stops on a conflict; choosing the
  private preview leaves the branch alone. The harness never opens the pull
  request, because the session's GitHub token is read-only on pull requests.
- **The per-branch preview is proposed again, from one reused branch.** A
  preview needs a branch of its own, and `deploy.mjs` refuses `--target
  preview` on `main`, so a preview asked for from `main` moves the work onto
  a single stable branch named `revue`. One reused branch means one Serverless
  SQL database: the harness never deletes a database, so a new branch per
  review would leave one behind every time.
- **`pnpm dev` keeps exactly one job: the assistant's own check.** It is never
  offered to the user. `skills/bootstrap`, `skills/add-map` and the generated
  project's own `CLAUDE.md` all say which of the two it is.

### Fixed

- **`skills/add-map` no longer calls `preview_start`, `preview_eval` and
  `preview_resize`.** Those tools do not exist in a web session. The visual
  smoke test now fetches the server-rendered page from inside the VM, and the
  file records which three checks it dropped, because no browser can run them
  there.
- **The deploy and `/prof` documentation no longer credits GitHub Actions with
  the container build.** The machine that runs the harness builds the image
  itself and pushes it to the Scaleway Container Registry (CONTRACT.md §5).
- **`/prof` no longer teaches that the code lives on the user's computer.**
  Baudrier is web-only, which its own `DOC.fr.md` already stated one line
  further down.

## v1.0.0 (2026-08-08)

First stable release. Baudrier is a French-sovereign fork of
[hypervibe-harness](https://github.com/flavien-ia/hypervibe-harness) (Apache-2.0):
a non-technical French user describes a webapp in plain French, and the harness
builds and deploys it on Scaleway from Claude Code web. The 0.x line covered the
fork itself (Scaleway-only deploy target, web-only install, French README); this
release consolidates that state, removes the last vestigial code, and hardens the
error paths found in a full review pass.

### Added

- **`BAUDRIER_SCW_PROJECTS_IDS`: one cloud environment for several « Cas B »
  apps.** A member key that cannot list the organization's Projects no longer
  needs one environment per app: the variable maps each app to its Project
  (`app-un:id1,app-deux:id2`) and `resolveProjectId()` consults an entry
  before `SCW_DEFAULT_PROJECT_ID`. The lookup error now explains the fix
  (add the entry via « Edit environment », then a new session), and the new
  `cache-project` command of `scripts/scaleway/_scw-auth.mjs` seeds the
  session cache when the user gives the Project id in the chat instead.
  `setup-agent.mjs` resolves the app's Project through the same path, so a
  generated agent's TEM credentials stay correct without the global override.
  Verify check 54 guards the wiring, the priority order, and the docs.

### Removed

- **The per-project CI-key machinery, vestigial since GitHub Actions left the
  build pipeline.** The `rotate-ci` command in `scripts/rotate-secret.mjs`, the
  `swap-ci` command, `swapCiKey()` and `CI_KEY_ENTRY_NAME` in
  `scripts/scaleway/dev-credentials.mjs`, the « Recette clé CI » section in
  `docs/ADMIN-SCALEWAY.md`, and the `BAUDRIER_CI_KEY` references in
  `skills/publish/SKILL.md` and CONTRACT.md are deleted. Verify check 19 now
  guards against any piece of the machinery reappearing. `/delete-project` keeps
  its generic IAM scan, so a legacy `<slug>-ci` application on an old project is
  still found and cleaned up.
- **Dead code and stale references.** The unused `tokenMatchCount` export in
  `scripts/_match.mjs`, the phantom `get` subcommand in the `jobs.mjs` usage
  text, two references to the deleted `templates/deploy/manifest.json`, the
  stale GitHub Actions claim in `NOTICE`, and the upstream copyright line in the
  `LICENSE` appendix.

### Fixed

- **`/delete-project` memory scan matches on token boundaries.** The scan of
  `~/.claude/projects` used a substring match, so the deletion of a project
  named « art » could also delete the memory of « smart-app ». The scan now uses
  the same token matcher as the IAM and DNS scans.
- **Shell interpolation removed from `bootstrap-init.mjs`.** The two
  `git config --global` calls that interpolated the repository owner into a
  shell string now use an argv array, per the repo hygiene rule.
- **Agent template error paths.** `templates/agent/loop.ts` protects the
  circuit-breaker and invocation-creation calls, and a finalize failure no
  longer leaves an invocation row stuck at `running`. The send-email per-run
  cap now resets at each run instead of accumulating for the process lifetime.
  A failed `ROLLBACK` in `db-query.ts` destroys the connection instead of
  returning it to the pool. `http-fetch.ts` cancels the body stream when it
  abandons a response. `templates/db/safe.ts` degrades instead of rejecting
  when a fallback function throws.
- **Cleaner failures in the operator scripts.** The delete-project inventory
  parse and the Search Console token exchange now fail with a clean message and
  the documented exit code instead of a raw stack trace.
- **Documentation drift.** The `_generate-secret` and `_convert-to-turborepo`
  skill descriptions name their real callers. The plugin and marketplace
  manifests carry the same keyword list.

### Changed

- **Typography pass on the French text.** The typographic apostrophe (U+2019)
  replaces the ASCII apostrophe in the French prose of `README.md`,
  `templates/bootstrap/claude-md-core.md`, and the French comments and strings
  across `templates/`. The last user-facing em dash is gone.
