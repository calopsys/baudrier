# Changelog

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
