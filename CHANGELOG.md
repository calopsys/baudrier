# Changelog

## v1.5.0 (2026-08-18)

Dependency upgrade across the harness and the templates: Scaleway SDK v4,
Astro 7 for new vitrines, and a regenerated lockfile.

### Changed

- **Scaleway SDK 3.11.1 → 4.0.3, sdk-client 2.4.2 → 2.6.0.** Scaleway fixed
  its publish pipeline: both tarballs verified healthy on registry.npmjs.org
  on 2026-08-18 (all 53 per-product sub-packages ship `dist/`). SDK v4
  exports flat
  namespaces (`Containerv1`, not `Container.v1`), so `api()` in
  `_scw-auth.mjs` now joins `product + version`; every call site keeps the
  `api("Container", "v1")` convention. The pins stay exact by policy, and
  `check-deps-health.mjs` now probes `Containerv1`.
- **Landing template on Astro 7.** `templates/landing/package.json` moves to
  `astro ^7.0.0`, `tailwindcss`/`@tailwindcss/vite` `^4.3.0` and
  `typescript ^5.9.0`. Validated by scratch builds: plain landing, blog
  overlay on Astro 7, and a blog-overlay regression run on Astro 5 (existing
  vitrines stay on 5; `/add-blog` serves both).
- **Regenerated `package-lock.json`.** The AWS SDK and all transitive
  dependencies move to current releases inside their existing ranges.

## v1.4.2 (2026-08-18)

One fix on bootstrap Step 1: the description question and the style
question no longer share a turn.

### Changed

- **Bootstrap Step 1 asks one question at a time.** The description ask is
  now a standalone message that ends the turn; the style `AskUserQuestion`
  (Épuré, Chaleureux, Audacieux) moved after the description answer, into a
  vitrine-only subsection. The description question adapts to the stack
  (« votre site » / « votre application ») and tells the user the text
  becomes the Google summary (check 89 pins the order and the turn break).

## v1.4.1 (2026-08-14)

Three fixes on the vitrine path: the bootstrap IP question now stops the
turn, preview container names respect Scaleway's 34-char limit, and
`/blogpost` reviews on the preview instead of in chat, then tears the
preview down after publication.

### Changed

- **Bootstrap Step 3 breaks on the IP question.** The ip.me question now ends
  the message; Step 4's spec questions no longer bury it, so the allowlist
  gets filled before anything else happens (check 88 pins the break and its
  position).
- **One bounded resolver for preview container names.** Scaleway rejects
  container names over 34 chars (live-verified). `previewContainerName`
  (`_scw-auth.mjs`, re-exported by `container.mjs`) keeps the
  `<name>-preview-` discovery prefix whole and hash-truncates an overlong
  branch slug; `deploy.mjs`, `scale.mjs`, `rotate-secret.mjs`,
  `push-env-vars.mjs` and the `/publish`/`/unpublish` snippets all resolve
  through it, and `bootstrap-init.mjs` caps the deploy name at 20 chars so
  `<name>-preview-revue` always fits whole (check 87 pins all of it).
- **`/blogpost`: the preview is the review.** The blocking full-text approval
  in chat is gone - the article deploys straight to the private `revue`
  preview, the user reads the styled page there, and the verdict is the only
  blocking question (check 86 forbids the old approval-loop marker). After a
  production publish, the new `container.mjs#deletePreviewContainer` (refuses
  any name lacking `-preview-`, so production is unreachable) tears the
  preview container down; a pending article keeps its preview.

## v1.4.0 (2026-08-14)

The vitrine blog: `/add-blog` installs an Astro 5 content collection once on
an existing vitrine, `/blogpost` writes and publishes one French article at a
time from a chat description.

### Added

- **`/add-blog`.** Installs `templates/blog/` (content collection, blog
  listing, article page, RSS, `PostCard`) on an existing vitrine, once:
  `@astrojs/rss` + `@astrojs/sitemap` + `sharp`, an ensured `site:`, three
  anchored `BaseLayout.astro` Edits (`ogType?`/`canonical?` props, RSS/canonical
  `<link>`s), an IndexNow proof key, and CLAUDE.md updates. It never writes an
  article itself and never deploys - the empty `/blog` page ships with the
  next unrelated deploy.
- **`/blogpost`.** Writes one French article (600-1200 words, JSON-LD
  `BlogPosting`, `og:type article`, canonical, tags, `<time datetime>`,
  prev/next) from the user's description, always on the `revue` branch first.
  Mandatory approval loop shows the full text in chat, then a preview deploy,
  then an explicit verdict before a second deploy publishes to production.
  Create-only: modifying or removing a published article is an ordinary chat
  edit followed by `/deploy`. A successful, unrestricted production publish
  pings `api.indexnow.org` with the article, `/blog/` and `/` URLs.
- **No `draft:` frontmatter, by design.** `content.config.ts`'s schema has no
  draft field - the `revue` branch is itself the draft state, so a published
  article is exactly what merged into `main`.
- **A fourth gate class.** `add-blog` and `blogpost` are landing-only: they
  refuse `PROJECT_TYPE=application` with the mirrored French sentence, the
  opposite direction from every other gated skill (CONTRACT.md §1).
- **`/deploy`'s bootstrap-8b exception now also covers `/blogpost`'s two
  deploys** (preview then production) - its own approval flow already
  collects both consents, so it skips Step 0 and Step 1 and enters directly
  at Step 2 with the target fixed.
- **Checks 83, 86**: check 83 gains a fourth list (`GATE_LANDING_ONLY_SKILLS`)
  and the mirrored marker/sentence assertions; check 86 pins the
  `templates/blog/` manifest, forbids Google Fonts and
  `@tailwindcss/typography` under it, forbids a `draft` field, and cross-checks
  the deploy exception and both new SKILL.mds' required mentions.

## v1.3.0 (2026-08-13)

Second stack: sites vitrines (Astro 5 static + Caddy 2), the harness's first
project type besides the T3 application.

### Added

- **A vitrine stack, end to end.** `/bootstrap` asks one French question (or
  reads the literal first token `landing`/`application`) and never infers the
  stack from the description. A chosen vitrine gets a static Astro 5 site,
  hand-rolled from `templates/landing/` (26 files, no `create-astro`), one of
  three Tailwind v4 token presets (Épuré, Chaleureux, Audacieux), and deploys
  as a Caddy 2 image on the same Container Registry + Serverless Containers
  pipeline as an application - no database, no Serverless Jobs, no Object
  Storage. `LANDING_CONTAINER` (`scripts/scaleway/container.mjs`) fixes its
  resources: preset S, `maxConcurrency` 80, `min_scale` 1 in production
  (~6,40 EUR/month always-on), 0 on preview.
- **A Caddyfile gate with proxy.ts parity.** `templates/landing/Caddyfile` +
  `docker-entrypoint.sh` reproduce every invariant of
  `templates/deploy/proxy.ts`: only the literal `"false"` opens
  `ACCESS_RESTRICTED`, the ACME challenge and the exact `/api/healthz` path
  stay exempt regardless of state, and a bypass token shorter than 32
  characters mints no bypass line. Documented deviation: the Caddy header
  compare is not constant-time.
- **A landing deploy branch.** `scripts/deploy.mjs` detects the stack via the
  new `scripts/_stack.mjs#detectStack()` and skips the migration Job and the
  agent-Jobs reconciliation outright for a vitrine; the smoke test, the
  `revue` preview branch and the container-secret sync are unchanged, minus
  any database. `buildContainerSecretMap` gains an opt-in
  `allowMissingDatabaseUrl` flag, passed only by the landing call sites,
  since a vitrine never seeds a `DATABASE_URL` secret.
- **A shared refusal gate.** 15 skills support a vitrine (`deploy`, `publish`,
  `unpublish`, `add-domain`, `costs`, `save-project`, `delete-project`,
  `add-analytics`, `add-dark-mode`, `seo`, `seo-perf`, `geo`, `rotate-secret`,
  `scale`, `gsc`); every other project-scoped skill refuses through one shared French
  gate, wired through `PROJECT_TYPE` in `skills/_detect-project-root/SKILL.md`.
- **Checks 81-85**: gate parity (Caddyfile/entrypoint vs. proxy.ts), landing
  image shape (Dockerfile/Caddyfile/.dockerignore), gate coverage (every
  public skill classified exactly once), landing pipeline invariants (step
  order, no `DATABASE_URL` seed, container params), and the
  `templates/landing/` manifest + bootstrap stack/preset wording. Check 48
  (healthz consumers) now also covers the Caddyfile's `/api/healthz` handler.

## v1.2.4 (2026-08-13)

Cas B database self-service (wave D) and the residues of wave E. The D
report's second item and most of E were already shipped by v1.2.1-v1.2.3.

### Fixed

- **The Cas B database path self-serves.** A Cas B key cannot read its own
  IAM record (the shape probe defines Cas B by that 403), yet
  `devDbCredentials()` called `iam.getAPIKey` unguarded and `setup-db.mjs`
  swallowed the failure into a full admin escalation. Now:
  `SCW_DEFAULT_APPLICATION_ID` is accepted from the environment and
  short-circuits the IAM call entirely; when it is absent and the IAM read
  is denied, a typed `needs_application_id` error carries the cause and the
  four-click console path (the id is not a secret); the `needs_admin`
  escalation remains only for the genuinely-admin cases, with its cause
  preserved. Documented across CONTRACT.md, README, docs/ADMIN-SCALEWAY.md
  (which now hands over five values and contains the previously-missing
  `BAUDRIER_DB_KEY` recipe), and the add-db skill (three stale claims
  fixed). `_preflight` now checks `SCW_DEFAULT_PROJECT_ID`.
- **`sdb.mjs ensure` honors the cost defaults and explicit bounds.** The
  CLI defaulted `--max-cpu` to the API's 15 instead of the harness's 5, so
  the add-db monorepo path created databases at three times the intended
  cap; explicit `--min-cpu`/`--max-cpu` flags against an existing database
  now apply via `setDatabaseCpuBounds` instead of being silently ignored.
- **`tscOk` in every setup script.** `setup-auth-users.mjs` and
  `setup-2fa.mjs` gain the same non-fatal `tscCheck` + `tscOk`/`warnings`
  JSON fields `setup-role.mjs` already had, and their skills treat
  `tscOk: false` as work-not-done.

### Added

- **Checks 78-80**; check 66 now also bans `drizzle-kit migrate` and
  tsx/ts-node spawns in scripts (locks, proven against synthetic breakage);
  check 35 pins the CLI flag defaults. CONTRACT.md records why no
  end-to-end run is part of the gate, and that the destructive guard cannot
  intercept child processes (spawn-level enforcement is static, check 66).

### Declined or skipped by decision

- The deploy-time `/api/auth/csrf` probe (declined again).
- The fresh-scaffold end-to-end run (rationale recorded in CONTRACT.md §8).

## v1.2.3 (2026-08-12)

Bootstrap robustness: fixes six of the seven C-class defects from the live
1.2.0 run. C7 (the reserved role name `admin`) is deliberately kept as-is:
the guard prevents a future admin lockout.

### Fixed

- **The supply-chain age floor now precedes the first install.**
  `writeSupplyChainWorkspaceYaml()` runs in `scaffoldT3()` before
  `pnpm install`, so the lockfile never captures a version the floor later
  rejects. When pnpm still hits `ERR_PNPM_NO_MATURE_MATCHING_VERSION` (an
  exact pin under 3 days old; `strict: false` rescues only ranges),
  `recoverFromImmatureLockfile()` deletes `pnpm-lock.yaml` and re-resolves
  once. This also closes the documented gap where the first install ran
  under a looser floor.
- **The shadcn step cleans up after itself.** A leftover `components.json`
  is deleted before init and before the retry (it turned `--yes` into an
  unanswered overwrite prompt), the retry is captured like the first
  attempt, and both fallback writes create their parent directories first.
- **pnpm updates recover headless.** When `pnpm self-update` does not land,
  the preflight actually runs `npm i -g pnpm@latest`; the generated
  `.npmrc` pre-answers pnpm 11's modules-purge confirmation
  (`confirm-modules-purge=false`).
- **Registry namespaces survive global name collisions.** Names are unique
  across all of Scaleway, so the harness now creates `<slug>-<8 hex>` by
  default and both `/bootstrap` and `/deploy` discover the namespace by a
  name-prefix match within the app's own Project. A suffixed name is noted
  in the generated CLAUDE.md; a taken name fails with an actionable error;
  `--registry-namespace` overrides and fails loudly on `/deploy` when the
  name does not exist.
- **The name-collision guard no longer reports the checkout itself.** The
  in-place bootstrap made the project its own sibling; the scan now
  excludes the current checkout by real path.
- **Cockpit log queries authenticate.** The Loki gateway accepts only the
  `X-Token` header (live-verified); `queryLogs` now sends exactly that via
  a plain fetch instead of the header pair that got 403.

### Added

- **Checks 72-77 in `tools/verify.mjs`**, and check 52 rewritten to pin the
  new yaml placement (its old placement clause enforced the bug). Check 76
  is behavioral: it runs the collision guard against the repo's own parent.
  Each check failed on the pre-fix tree.

## v1.2.2 (2026-08-12)

Fixes five correctness bugs in generated code, found by the same live run
that produced the v1.2.1 fixes.

### Fixed

- **`setup-security.mjs` inserts the CSP block above the NextConfig JSDoc,
  not between the JSDoc and its const.** The old insertion made the JSDoc
  type the CSP string, and `pnpm build` failed with TS2559 inside the Docker
  build during `/deploy`. The empty T3 config also no longer produces `},};`.
- **`ensureImport` and the schema-shape regexes are line-anchored.** The
  bootstrapped `schema.ts` quotes an example import and an example table
  inside a `//` comment; the unanchored regexes merged import names into the
  comment instead of adding a real import, so every generated table symbol
  was undefined (TS2304). All three setup scripts are fixed.
- **`setup-role.mjs` patches `auth.ts` with explicit anchors.** The old lazy
  regex ended at the first `return token;`, which sits inside the jwt
  callback's `if (user)` early-return block, and mis-nested the insertion.
  The patch now walks to the callback, anchors on `if (user) {`, and fails
  loudly when the shape does not match. The Session-augmentation patch also
  fails loudly instead of silently doing nothing.
- **`/add-role` defends its own prerequisites and reports honestly.** The
  preflight fails when the admin page is requested without admin-mode auth
  (the generated router imports `isAdmin`, which only admin mode exports).
  The final JSON now carries `tscOk` and `warnings`; the skill treats
  `tscOk: false` as work-not-done instead of a green result.
- **scrypt cost fits the container.** N drops from 131072 to 32768 (still
  two times Node's default) at all four mint sites, in lockstep. The old
  working set was 128 MiB per hash; preset S allows 8 concurrent requests in
  512 MB, so an unauthenticated attacker could OOM-kill the container with
  no application log. Old hashes keep verifying: the cost travels inside the
  hash string, and `verifyPassword`'s `maxmem` stays at 256 MB.

### Added

- **Checks 67-71 in `tools/verify.mjs`** pin the five fixes, including a
  behavioral check that runs `setup-security.mjs` against a T3 fixture in a
  temporary directory, and a parsed budget check
  (`maxConcurrency x 128*N*r <= memoryLimit`). Each check failed on the
  pre-fix tree.

## v1.2.1 (2026-08-12)

Fixes the four defects that broke every fresh project on its first
auth-enabled deploy, found by a live run on 1.2.0.

### Fixed

- **`trustHost: true` in every generated `auth.ts`** (`templates/auth/users`,
  `templates/auth/admin`, `templates/2fa`). None of Auth.js's trustHost
  heuristics holds on a Scaleway Serverless Container, so every production
  auth request failed with `UntrustedHost`.
- **`AUTH_URL` now reaches the container.** `buildContainerSecretMap`
  derives it from the container's effective `APP_URL` on every secret sync.
  Without it, Auth.js built redirects from the request origin the container
  sees: `https://0.0.0.0:8080`. An explicit `AUTH_URL` secret or override
  wins over the derivation.
- **The addon schemas converge on plain `pgTable`.** Bootstrap resets
  `schema.ts` to the no-prefix convention, but the auth, role and 2FA
  preflights and templates still required T3's `createTable`/`pgTableCreator`,
  so `/add-auth users`, `/add-role` and `/add-2fa` aborted on every
  bootstrapped project. Templates, preflights and patch regexes now use
  `pgTable`.
- **The setup scripts no longer open a database connection.** `/add-auth`,
  `/add-role` and `/add-2fa` ran `drizzle-kit push --force` from the operator
  machine, and `/add-role` ran a live `UPDATE` through a temporary tsx
  script, against the contract in `skills/add-db`. All three now run
  `drizzle-kit generate` only; the migration Job applies the SQL on the next
  `/deploy`, and the role backfill ships as an `UPDATE` inside the generated
  migration file.

### Added

- **Checks 63-66 in `tools/verify.mjs`** pin the four fixes: `trustHost`
  present in the auth templates, `AUTH_URL` derived at the chokepoint, no
  `createTable`/`pgTableCreator` in templates, scripts or skill docs, and no
  `drizzle-kit push`/`db:push` instruction without a negation nearby. Each
  check failed on the pre-fix tree before the fixes landed.

## v1.2.0 (2026-08-10)

Splits the operator's Scaleway key into two explicit shapes instead of one
key that could drift through several states. Removes the delegation
machinery that used to bridge between them.

### Added

- **`operatorKeyAsAppCredential()`, the one chokepoint allowed to turn the
  environment key into an application credential.** It lives in
  `scripts/scaleway/app-credentials.mjs` (renamed from `dev-credentials.mjs`).
  It probes the key's own rights first and fails closed: it refuses any key
  that shows organization reach, and it refuses when the probe itself cannot
  decide. A successful probe confirms the key is Cas B (below); nothing else
  in the harness may perform this conversion.

### Changed

- **Two explicit credential shapes replace the old delegation ladder.**
  Cas A: the cloud environment's key belongs to an organization admin.
  `/bootstrap` creates the Project and mints one scoped IAM application plus
  key per service connection (database, Object Storage, Generative APIs,
  Transactional Email); the environment key never reaches the running app.
  Cas B: the key is a single IAM application scoped to one Project, created
  by the admin ahead of time (`docs/ADMIN-SCALEWAY.md`). The harness mints
  nothing; that same key serves every connection, permanently, before and
  after `/publish`. One key, one application, one cloud environment, one app.
- **`/publish` now does one thing: it removes the IP restriction.** The old
  gate that blocked publishing until every secret left the operator's
  personal key is gone, because the personal-key fallback it guarded no
  longer exists.
- **`docs/ADMIN-SCALEWAY.md` collapses six recipes into one.** The admin
  creates the Project, creates one IAM application scoped to it, attaches
  one policy carrying the service permission set, issues a non-expiring key,
  and hands the collaborator the key pair plus the Project id. That one
  recipe replaces the separate database, IA, emails, stockage and
  clé-applicative recipes.
- **`BillingReadOnly` leaves the Cas B permission set.** It is
  organization-scoped, and a Cas B key now reaches the running container -
  Cas A's environment key never does. `/costs` can no longer show the
  Scaleway spend figure for a Cas B app; it still shows Transactional Email
  consumption.
- **A Cas B key issued under the old admin guide will be refused.** It
  carries `BillingReadOnly`, which the new chokepoint reads as organization
  reach and rejects, fail-closed. An administrator who set up a collaborator
  before this release must re-issue that key without `BillingReadOnly`,
  following the single recipe in `docs/ADMIN-SCALEWAY.md`.

### Removed

- **`BAUDRIER_APP_KEY` and the adoption flow that consumed it.** There is no
  more "delegated" per-app state to migrate into: a cloud environment is
  Cas A or Cas B from its first session onward.
- **`BAUDRIER_SCW_PROJECTS_IDS`.** A Cas B key now names its one Project
  through `SCW_DEFAULT_PROJECT_ID` alone, mandatory for that shape since a
  Project-scoped key cannot list Projects. One cloud environment now serves
  exactly one app under Cas B; the per-app map is gone with it.
- **The dev-backed fingerprint tracking and `BAUDRIER_DEV_FINGERPRINTS`.** An
  operator's key is now always fully Cas A or fully Cas B; there is no
  middle state where a restricted app runs partly on the operator's own
  personal key, so there is nothing left to track.

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
