# Baudrier - internal contract

**Every agent working on this repo must read this file first and code against it
exactly.** It exists so that work done in parallel composes instead of diverging.
If you believe something here is wrong, say so in your report — do **not** quietly
invent a different convention.

---

## 1. Architecture

A Claude Code plugin that scaffolds and deploys webapps entirely on Scaleway,
for non-technical French users. Two project stacks share this harness (see
"Two stacks" below): a T3 application, or a static vitrine.

| Concern | Implementation |
|---|---|
| App stack | Next.js 16 App Router (T3), TypeScript, tRPC v11, Drizzle, Tailwind v4, shadcn/ui |
| Vitrine stack | Astro 5 (static output), TypeScript, Tailwind v4, three token presets, served by Caddy 2 |
| Hosting | Scaleway Serverless Containers, region `fr-par` |
| Image build | Direct `docker build`/`push`, run by the harness itself (no CI) → Scaleway Container Registry |
| Deploy orchestration | `/deploy` skill (direct build+push, runs migration Job, updates container via SDK) |
| Database | Scaleway Serverless SQL Database (PostgreSQL 16), `pg` + `drizzle-orm/node-postgres` (application only, §1 "Two stacks") |
| Cache/sessions | PostgreSQL (no Redis) |
| Object storage | Scaleway Object Storage (S3-compatible, `@aws-sdk/client-s3`) |
| DNS | Scaleway Domains & DNS — **external domains only** |
| Email | Scaleway Transactional Email (TEM) |
| Scheduling, agents | Scaleway Serverless Jobs |
| LLM + embeddings | Scaleway Generative APIs (OpenAI-compatible) |
| Analytics | Matomo |
| Secrets | Scaleway Secret Manager |
| Logs | Scaleway Cockpit (Loki-compatible, LogQL) |

The product is **French-only**. There is no i18n. All user-facing strings in
templates are hardcoded French.

### Two stacks

Two project stacks share this harness, detected from `package.json` only,
never from a marker file (`scripts/_stack.mjs#detectStack`, called by
`skills/_detect-project-root/SKILL.md`): `astro` in dependencies means a
landing site (vitrine); `next` means the T3 application; neither means
`unknown`, a hard failure. `/bootstrap`'s first argument token picks the
stack explicitly — the literal `landing` or `application`, or one French
`AskUserQuestion` when the token is absent or unrecognised
(`skills/bootstrap/SKILL.md`). The description text is never used to infer
the stack.

A vitrine has no database, no Serverless Jobs and no Object Storage: it is a
static Astro 5 build served by Caddy 2, on the same Container Registry +
Serverless Containers pipeline as an application (`templates/landing/`,
hand-rolled, no `create-astro` scaffolder). `LANDING_CONTAINER`
(`scripts/scaleway/container.mjs`, imported by both `bootstrap-init.mjs` and
`deploy.mjs`) fixes its resources: preset S, `maxConcurrency` 80, `min_scale`
1 in production (a static Caddy response is cheap enough per request that one
always-on instance absorbs more load, and there is no backend to warm) and 0
on preview. The always-on production container costs roughly 6,40 EUR/month;
`/bootstrap`'s closing summary and `/costs` both state this line.

Because a vitrine never seeds a `DATABASE_URL` secret,
`buildContainerSecretMap` (`container.mjs`) takes an opt-in
`allowMissingDatabaseUrl` flag (default `false`): only when a caller passes
`true` does the function treat a missing `databaseUrlFrom` secret as valid
state and skip the key instead of throwing. The flag defaults closed because
`setContainerSecrets` replaces the WHOLE map — silently skipping the key for
every caller once let `rotate-secret`/`publish` delete a running preview's
`DATABASE_URL` by targeting a preview secret that did not exist. Only the
landing call sites pass `true`: `bootstrap-init.mjs`'s `scwContainer()` (gated
on `isLanding`) and `deploy.mjs`'s container-secret syncs when `STACK ===
"landing"`. The same function still derives `AUTH_URL` from `APP_URL` for a
landing container (§2's derivation applies unconditionally); the value is
simply never read, since a static site runs no Auth.js.

Four gate classes partition every public skill (`tools/verify.mjs` check 83
pins all four lists and requires every public skill to sit in exactly one of
them, so a future skill that forgets to pick a list fails loudly instead of
silently shipping ungated):

1. **15 skills support a vitrine**: `deploy`, `publish`, `unpublish`,
   `add-domain`, `costs`, `save-project`, `delete-project`, `add-analytics`,
   `add-dark-mode`, `seo`, `seo-perf`, `geo`, `rotate-secret`, `scale`, `gsc`.
2. **20 skills refuse a vitrine** through one shared gate
   (`skills/_detect-project-root/SKILL.md`'s `PROJECT_TYPE`, checked by each
   refusing skill's own Step 0, greppable marker `PROJECT_TYPE=landing`) with
   one French refusal sentence (« n’est pas disponible pour un site
   vitrine »): `add-2fa`, `add-agent`, `add-agent-dashboard`, `add-auth`,
   `add-automation`, `add-cron`, `add-db`, `add-email`, `add-map`,
   `add-notification-center`, `add-push-notification`, `add-pwa`, `add-role`,
   `add-routine`, `add-storage`, `add-workflow`, `clean`, `eco-audit`,
   `rgpd-audit`, `security`.
3. **3 skills are not project-scoped** and carry no gate either way:
   `bootstrap`, `prof`, `spec`.
4. **2 skills invert the gate and refuse an application instead**:
   `add-blog`, `blogpost` (the vitrine blog, below). They check the same
   `PROJECT_TYPE` marker but the mirrored value `PROJECT_TYPE=application`,
   and answer with the mirrored French sentence « n’est pas disponible pour
   une application ».

### Vitrine blog

`/add-blog` installs an Astro 5 content collection once on an existing
vitrine; `/blogpost` writes and publishes one article at a time from a chat
description. Both are landing-only (class 4 above) and never touch an
application. `templates/blog/` (6 files, `tools/verify.mjs` check 86 pins the
exact inventory - a missing or unexpectedly extra file fails) is copied in by
`/add-blog` Step 4: `src/content.config.ts` (the collection schema),
`src/pages/blog/index.astro` (listing), `src/pages/blog/[slug].astro`
(article page), `src/pages/rss.xml.ts` (`@astrojs/rss` endpoint),
`src/components/PostCard.astro`, and `src/content/blog/.gitkeep`.

**The `revue` branch is the draft state - there is no `draft:` frontmatter
field.** `content.config.ts`'s zod schema deliberately has none (check 86
greps for it); `/blogpost` always writes the article on `revue` first, shows
the full text in chat for approval, deploys a preview there, and only a
second explicit verdict merges `revue` into `main` and deploys production.
An article that is not yet approved simply does not exist on `main`.

**Two deploys per published post, both routed through `/deploy` at Step 2.**
`/blogpost` collects both consents itself (the approval loop before the
preview, the verdict before publishing), so it enters `skills/deploy/SKILL.md`
directly at Step 2 - preview target the first time, production target the
second - skipping Step 0 and Step 1's target question (`skills/deploy/SKILL.md`'s
own exception sentence, extended for this; check 86 pins the mention).

**IndexNow is a harness-side `curl`, not an SDK call.** After a successful
production publish, `/blogpost` Step 11 POSTs to `api.indexnow.org` (already
in the web-session network allowlist, §1's web-sessions block) with the site's
host, the proof key, and the three changed URLs (article, `/blog/`, `/`) -
plain `fetch`/`curl` is legitimate here the same way Cockpit's Loki queries
are (§3 "documented non-SDK exceptions"): IndexNow is not a Scaleway product,
so there is no SDK to route through. The ping is skipped, with a note to the
user, whenever `ACCESS_RESTRICTED` is not the literal `"false"` - a restricted
site 403s every crawler, so the ping would only be rejected.

**The IndexNow key file is public by design.** `/add-blog` Step 8 drops a
random 64-hex-character `<key>.txt` under `public/`, served as a plain static
file and committed with the rest of the project - it exists to prove site
ownership to IndexNow, not to guard anything, and must never be treated as a
secret or excluded from the repo.

### Constants

```
REGION                = "fr-par"          // everything, always
DEFAULT_CPU_LIMIT     = 250               // mvCPU
DEFAULT_MEMORY_LIMIT  = 512               // MB
DEFAULT_MAX_CONCURRENCY = 8
DEFAULT_MIN_SCALE     = 0                 // scale to zero
DEFAULT_MAX_SCALE     = 5
CONTAINER_PORT        = 8080
DB_CPU_MIN_DEFAULT    = 0                 // Serverless SQL autoscaling floor (sleeps when idle)
DB_CPU_MAX_DEFAULT    = 5                 // Serverless SQL autoscaling cap (API's own default is 15);
                                          // /scale db-apply changes both, bounded 0 <= min <= max <= 15
```

There is no built-in IP allowlist constant. `bootstrap-init.mjs` detects the
operator's egress address at container creation and writes it into
`ACCESS_ALLOWED_IPS`; a hardcoded default shipped every new project reachable
only from the original author's VPN (verified on a live run).

### Hard platform facts you must respect

- Serverless Containers accept **`amd64` images only**. Every `docker build`
  must pass `--platform linux/amd64` unconditionally.
- The container must listen on `0.0.0.0:8080`. Binding `127.0.0.1` breaks
  Scaleway's health probes.
- **Auth.js on a Serverless Container fails `UntrustedHost` by default.** None
  of `@auth/core`'s trustHost heuristics (`AUTH_URL`, `AUTH_TRUST_HOST`, the
  removed-provider env vars, `NODE_ENV !== "production"`) holds here, and the
  request origin the app sees is `0.0.0.0:8080`, not the public host. Both
  measures are required: every generated `auth.ts` sets `trustHost: true`,
  and `buildContainerSecretMap` derives `AUTH_URL` from the container's
  effective `APP_URL` (§2). Without the first, every production auth request
  fails `UntrustedHost`; without the second, redirect-carrying auth flows
  point at `https://0.0.0.0:8080`. `tools/verify.mjs` pins both (checks 63
  and 64).
- **Health checks do not wake a scaled-to-zero container.** Only real traffic
  does. Keep-warm must be a Serverless Job issuing a real HTTP request.
- Serverless Containers **cannot reference Secret Manager**. The harness reads
  from Secret Manager and writes values into the container's
  `secret_environment_variables`. Rotation therefore requires a redeploy.
- **A container's secrets cannot be read, only written — Secret Manager is
  the single readable source of truth.** Live-verified against Containers
  **v1**: `GET` on a container returns each `secret_environment_variables`
  entry as an argon2 hash, never plaintext, e.g.
  `{"key":"ACCESS_ALLOWED_IPS","value":"$argon2id$v=19$m=65536,t=1,p=64$H1X/8Dyn..."}`
  (an array of `{key,value}` pairs on read, not the `Record<string,string>`
  the SDK's field doc implies). No client-side read-modify-write is possible:
  there is nothing plaintext to merge with. `PATCH` still **replaces the
  whole map** — an earlier revision of this file claimed `container.mjs` did
  a read-merge-write that "gives callers merge semantics"; that was wrong,
  because the "read" half returns hashes, not values, so any earlier code
  that treated a GET result as plaintext and wrote it back destroyed the
  secret it thought it was preserving (this happened live: `ACCESS_ALLOWED_IPS`
  got hashed over its real value and every operator was locked out with a
  403).
  The fix: `container.mjs#syncContainerSecrets(containerId, {overrides,
  databaseUrlFrom, projectId})` is now the **only** sanctioned way to update a
  container's secrets. It builds the complete map from Secret Manager
  (`buildContainerSecretMap`, skipping `CONTAINER_EXCLUDED_SECRETS`), applies
  `overrides` for container-only values never persisted to Secret Manager,
  and writes that full map with `setContainerSecrets` (still available, but
  now documented as taking the COMPLETE desired map — a key it omits is
  deleted, `null`/`undefined` in the map also deletes a key). Nothing outside
  `container.mjs` may call `setContainerSecrets` directly for a container's
  app-facing secrets; `tools/verify.mjs` enforces this.
  Preview containers fail closed: `ACCESS_RESTRICTED` and `APP_URL` are
  never written to Secret Manager for a preview (that would clobber
  production's canonical value) — they are `syncContainerSecrets` overrides,
  reapplied by `/deploy` on every preview deploy. A preview a human published
  by hand therefore reverts to restricted the next time that branch deploys;
  this is deliberate, not a bug.
- **The harness never deletes a database or an Object Storage bucket.** Both are
  behind `scripts/scaleway/_destructive-guard.mjs`, which refuses unless a human
  sets `BAUDRIER_ALLOW_DESTRUCTIVE="<kind>:<exact-resource-name>"` in their own
  shell. A generic value is rejected by design. `/delete-project` has no code
  path to either function and hands the user console links instead. Rationale:
  the bucket's version history is the only backup of file data, and Serverless
  SQL has no on-demand backup *creation* API.
- **Buckets are created with versioning enabled** plus a lifecycle rule
  expiring noncurrent versions. Scaleway does **not** support S3's
  `NewerNoncurrentVersions` (count-based) field — only time-based
  `NoncurrentDays` — so the retention bound is temporal, not a version count.
- Serverless **Jobs can** reference Secret Manager natively.
- **Serverless Jobs definitions require `local_storage_capacity > 0`** -
  live-verified: the API rejects a definition with no local storage
  (`"local_storage_capacity does not respect constraint, value must be
  greater than 0"`). The harness default is **1024 MiB**
  (`jobs.mjs`'s `ensureJobDefinition`, passed to both `createJobDefinition`
  and `updateJobDefinition`). Job secrets do not merge either: re-adding an
  existing `env_var_name`/`path` 409s (`"secret path or env_var_name is
  duplicated"`), so `ensureJobDefinition` lists and deletes every existing
  secret on the definition before it calls `createSecrets` again.
- Secret Manager is **region-scoped**; a Job can only read secrets in its own
  region. Pin everything to `fr-par`.
- Custom-domain TLS uses an HTTP-01 challenge with a hard **3-minute window**;
  failure is an unrecoverable `error` state. Always verify DNS propagation
  **before** calling the add-domain endpoint.
- Container Registry has **no retention policy**. Prune old tags explicitly.
- **Scaleway validates the registry image at container-creation time** -
  verified on a live run. `createContainer({registryImage})` with a tag that
  does not exist yet fails outright (`ScwError: resource registry image with
  ID <slug> is not found`); a container cannot be created against a
  placeholder tag and repointed at the real one later. `bootstrap-init.mjs`
  therefore runs `firstBuild` (pushes the image under its commit-SHA tag via
  the direct `docker build`/`push` pipeline, §5) before `scwContainer`
  (creates the container against that real tag).
- **A container in a transient state refuses writes** (`409
  TransientStateError` while `creating`/`deploying` - verified on a live
  run), and a secret write itself triggers a new deployment. The rhythm for
  every container mutation is wait-write-wait:
  `waitForContainerReady` before the write, and again after it before the
  next write or check.
- **The production image is Next's `standalone` output only** - no
  devDependencies, no `drizzle-kit`, no `package.json` scripts survive the
  runner stage - live-verified via a truncated OCI start error when the
  migration Job tried to run `drizzle-kit migrate` on it. Migrations
  therefore ship as `templates/deploy/migrate.mjs`, a dependency-light
  runner (node builtins + `pg` only) copied into the image alongside
  `drizzle/`. It executes **exclusively** inside the `/deploy` Serverless
  Job, exactly once per deploy - the Dockerfile `CMD` stays
  `["node","server.js"]` and must never reference `migrate.mjs`, so a
  scaling app container can never trigger a migration.
- Serverless SQL: `pg_advisory_lock` is **not guaranteed**, and a migration
  runner has no concurrency protection of its own without care. Migrations
  run in exactly one place: a Serverless Job invoked by `/deploy`, never at
  container start.
- Serverless SQL: session `SET` / `search_path` leak across the shared
  connection pool — wrap in a transaction. 1 MB max SQL statement size.
  No temp tables. No `CREATE DATABASE` / `CREATE ROLE` via SQL.
- `scw` has **no OAuth or device-code login**. The user pastes an API key.

### Claude Code web sessions (live-verified 2026-08-05)

Claude Code web (claude.ai/code) is a primary platform for this harness, not
a fallback: each session is a **fresh, ephemeral, root Ubuntu 24.04 VM** with
no persistent home directory, the repo already cloned from GitHub.
`CLAUDE_CODE_REMOTE=true` and `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` (e.g.
`cloud_default`) identify it; `scripts/_platform.mjs#isRemoteSandbox()` is
the single place that checks this (`BAUDRIER_FORCE_REMOTE=1` overrides it
for tests).

- **No port forwarding and no preview URL.** `http://localhost:3000` is
  that VM's own loopback address; the user's own browser has no route to
  it. This is why the review path runs through a deploy, never through the
  local dev server (§5).
- **The proxy network allowlist is Custom-level, not additive.** A Custom
  domain list **replaces** the Trusted defaults outright, unless the
  environment dialog's "Also include default list of common package
  managers" box is checked - leaving it unchecked breaks `npm`/`pnpm`
  entirely. The README's `## Installation` chapter must name the checkbox
  explicitly.
- **The shell GitHub token is narrowly scoped:**

  | Scope area | Shell `git`/`gh` token |
  |---|---|
  | repo metadata, contents | read/write (clone, push) |
  | Issues, PRs | read |
  | Actions - workflows, runs, secrets, variables | 403 |
  | environments, deployments, webhooks | 403 |
  | ref create | allowed |
  | ref delete | 403 |

  `gh auth status` exits 1 even when this token works end-to-end
  (live-verified) - never gate anything on it (§7).
- **MCP sees more than the shell does.** The session's own GitHub MCP
  tooling CAN read Actions (the workflow file and its runs) - that
  capability exists model-side only. A `scripts/*.mjs` file runs as a
  plain shell subprocess and can never call MCP, so it can never reach
  what MCP can.
- **`CLAUDE_ENV_FILE` is unset in every Bash tool call** (round-trip
  verified: a variable written there never comes back). That persistence
  route is unusable on web; use a session-scoped `/tmp` file instead - the
  VM lives for the whole session, so `/tmp` is a safe cache (§2, §7).
- **`dockerd` exists but is not started at session boot.** The binaries are
  present; nothing launches the daemon (live-verified on a fresh session).
  `scripts/ensure-dockerd.mjs` starts it lazily, on first need, and polls
  the socket - a snapshot cannot preserve a running process, so this must
  happen every session.
- **`docker pull` is blocked by the default network policy** until the
  Docker Hub domain family is reachable. The README's `## Installation`
  chapter recommends the **Full** network access level, « Complet » in the
  French doc (live experience: the set of domains a real build touches
  keeps growing - Alpine's `dl-cdn.alpinelinux.org`, npm, Docker Hub,
  fonts - and every missing domain breaks a step with a hard-to-read
  error). A hardened Custom allowlist works but is deliberately NOT in the
  user-facing README (decision 2026-08-08: one recommended setting, no
  menu); this table is its documentation of record. Check the
  `"Also include default list of common package managers"` box (an
  unchecked box REPLACES the default list and npm dies), then allow at
  least: `api.scaleway.com`, `rg.fr-par.scw.cloud`, `s3.fr-par.scw.cloud`,
  `logs.cockpit.fr-par.scw.cloud`, `api.scaleway.ai`,
  `registry-1.docker.io`, `auth.docker.io`,
  `production.cloudfront.docker.com`, `docker.io`,
  `dl-cdn.alpinelinux.org`, `*.fnc.fr-par.scw.cloud`,
  `www.googleapis.com`, `api.indexnow.org`.
- **The egress proxy re-terminates TLS, and docker builds do not trust it**
  (live-verified 2026-08-06). All outbound HTTPS goes through the agent
  proxy at `$HTTPS_PROXY` (a `127.0.0.1:<port>` address); host tools trust
  its CA via `/root/.ccr/ca-bundle.crt`. Processes INSIDE a `docker build`
  can neither reach `127.0.0.1:<port>` nor trust that CA - `apk add` fails
  with "server certificate not trusted". The pipeline therefore does three
  things on web (`scripts/_docker-build.mjs` + the Dockerfile template):
  build with `--network host`, pass the proxy env through the predefined
  `--build-arg`s, and ship `proxy-ca.crt` into the build context where the
  Dockerfile's network-active stages append it to the system CA bundle
  (`NODE_EXTRA_CA_CERTS` points at that bundle for node-based fetchers).
  Off web the file is empty and every part of this is a no-op. The runner
  stage never inherits the appended bundle.
- **Plugin auto-install from `settings.json` is half-broken** (live-verified
  across three consecutive startups: install-nothing, then
  installed-but-empty-folder, then empty-folder-no-skills). Explicit
  `claude plugin marketplace add` + `claude plugin install` works reliably
  and is the only install path this harness relies on. It only *persists*
  when run from the environment's **setup script**
  (`scripts/setup-clis-web.sh`), since that script's result is what gets
  baked into the environment's filesystem snapshot; a mid-session install
  dies with the container.

- **Node ignores the egress proxy by default, and the two routes have two
  identities** (live-verified 2026-08-08). Bare node `fetch()` leaves the
  sandbox DIRECTLY and still works (`api.scaleway.com` answers 200), but it
  egresses from the sandbox host's own pool (a Google Cloud address,
  `34.x.x.x`, changing). `curl` and everything honoring `$HTTPS_PROXY`
  egresses from the Anthropic proxy pool (`160.79.106.x`, also changing per
  request). IP-gate reasoning must never assume node traffic and curl
  traffic present the same address. `scripts/setup-clis-web.sh` exports
  `NODE_USE_ENV_PROXY=1` in the profile (supported since node 22.18) so
  node `fetch()` takes the proxy route too; the platform already sets
  `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` globally, so the proxy's
  re-terminated TLS is trusted with no extra step. Neither pool can be
  allowlisted meaningfully in `ACCESS_ALLOWED_IPS` - that is what
  `ACCESS_BYPASS_TOKEN` (§6) exists for.

Toolchain in a fresh session (live-verified 2026-08-05): root, node
v22.22.2, pnpm 10.33.0, git 2.43.0, docker 29.3.1.

### IAM permission sets the operator's key must carry

An account **owner** implicitly has every permission below. For anyone else,
the environment key (§2) must be one of exactly two shapes, never a mix and
never a third shape:

- **Cas A** - the key belongs to an organization admin. `/bootstrap` creates
  the Scaleway Project itself and mints one scoped IAM application plus API
  key per service connection (database, Object Storage, Generative APIs,
  Transactional Email), each stored in Secret Manager. The environment key
  itself never reaches a running container.
- **Cas B** - the key is a single IAM application scoped to one Project,
  created ahead of time by the organization admin (`docs/ADMIN-SCALEWAY.md`).
  The harness mints nothing: that same key serves every service connection,
  permanently, before and after `/publish`. One key, one application, one
  cloud environment, one app.

`operatorKeyAsAppCredential()` (`scripts/scaleway/app-credentials.mjs`, §3) is
the one place that tells the two shapes apart - see "The chokepoint" below.
Verify the exact permission-set names against
https://www.scaleway.com/en/docs/iam/reference-content/permission-sets/ at
the first live run; Scaleway can rename or split a set.

| Permission set | Scope | Cas A | Cas B | Called by |
|---|---|---|---|---|
| `ProjectManager` | organization | yes | never | `bootstrap-init.mjs` (per-app Project creation), `check-name-collision.mjs` |
| `IAMManager` | organization | yes | never | `iam.mjs` callers: `setup-db.mjs`, `deploy.mjs`, `setup-agent.mjs`, `rotate-secret.mjs`, skills `add-db`, `add-storage`, `add-workflow` |
| `SecretManagerFullAccess` | project | yes | yes | `secrets.mjs` |
| `ContainersFullAccess` | project | yes | yes | `container.mjs` |
| `ContainerRegistryFullAccess` | project | yes | yes | `registry.mjs` |
| `ServerlessSQLDatabaseFullAccess` | project | yes | yes | `sdb.mjs` |
| `ServerlessJobsFullAccess` | project | yes | yes | `jobs.mjs` |
| `ObjectStorageFullAccess` | project | yes | yes | `object-storage.mjs` |
| `DomainsDNSFullAccess` | project | yes | yes | `dns.mjs` |
| `TransactionalEmailFullAccess` | project | yes | yes | `tem.mjs` |
| `GenerativeApisFullAccess` | project | yes | yes | `setup-agent.mjs` policy target |
| `BillingReadOnly` | organization | yes | never | `billing.mjs` |
| `ObservabilityFullAccess` | project | yes | yes | `cockpit.mjs` |

`ProjectManager` and `IAMManager` stay Cas A only because both are
organization-scoped: a Project-scoped Cas B key cannot hold either one by
definition, and the harness must never ask a Cas B admin to widen the key
past its one Project (`docs/ADMIN-SCALEWAY.md` says so explicitly).

`BillingReadOnly` is Cas A only for a related but distinct reason: it is
organization-scoped (above), and a Cas B key reaches the running
container - Cas A's environment key never does. Granting `BillingReadOnly`
to a Cas B key would let a leaked container expose organization-wide spend
figures. The user-visible consequence: `/costs` cannot show the Scaleway
spend figure for a Cas B app; it still shows Transactional Email
consumption, since `TransactionalEmailFullAccess` stays in the Cas B set.

**The chokepoint.** `operatorKeyAsAppCredential()` is the only code allowed
to turn the environment key into an application credential - a value that
ends up in a container's `secret_environment_variables`. It probes the
key's own rights before doing so (`probeOrgReach()`, §3), and:
- refuses outright any key that shows organization reach and can mint
  (`ProjectManager`/`IAMManager` together) - that key is Cas A, and Cas A's
  environment key must never reach a container;
- refuses a key with organization reach but no `IAMManager` too - stuck
  between shapes, it can neither mint as Cas A nor be adopted as an app
  credential, and the admin must fix the key rather than the harness
  guessing around it;
- refuses when the probe itself is inconclusive - an ambiguous answer is
  treated as "could be Cas A", never as "assume Cas B";
- fails closed in every case above: refusal blocks the operation, it never
  falls back to a weaker check.

The probe result is what decides which shape the harness is running under.
There is no mode flag and no user-facing setting to pick a shape by hand -
the key itself carries the answer.

**Project scope resolution, Cas A.** `bootstrap-init.mjs` calls
`ProjectManager` whenever no Project id is already configured - a
`--scw-project-id` flag or `SCW_DEFAULT_PROJECT_ID` (§2) - so `scwProject()`
lists the organization's Projects and creates one if needed. It also refuses
a Project that already holds a known Baudrier secret name - accepting it
would break the name-equals-var invariant (§2) by colliding two apps'
secrets in one Project. A 403 on that list-or-create call raises `ScwError
type "needs_admin"`, which `/bootstrap` already recovers from: it asks the
user for an existing Project id and retries with `--scw-project-id`.

**Project scope resolution, Cas B.** There is no list-or-create call: a
Project-scoped key cannot list Projects at all. `SCW_DEFAULT_PROJECT_ID` is
therefore not optional for Cas B - it is the only way the key declares which
Project it owns (§2), and the admin hands it over alongside the key pair
(`docs/ADMIN-SCALEWAY.md`).

**Minting service credentials.** Cas A's `/bootstrap` mints every service
credential itself: a scoped IAM key per capability (`SCW_GENERATIVE_API_KEY`,
`TEM_API_SECRET_KEY`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, the
database pair). Cas B mints nothing - `operatorKeyAsAppCredential()` reshapes
the one environment key into each of those same variables instead.
`check-scw-permissions.mjs` is a read-only advisory probe for
`ProjectManager`/`IAMManager`; it recommends setting `SCW_DEFAULT_PROJECT_ID`
when it is missing, and persists nothing.

**Known 1.x trade-off, Cas A only: there is no per-project harness
control-plane key.** Every harness-side mint and every `createProject` call
runs under the operator's own, human-held admin key - never under a
separate, narrower credential scoped to one project. A control-plane key of
that shape would need `ProjectManager` and `IAMManager`, and both are
organization-scoped by construction (above): granting them to anything still
means granting org-wide rights, this time to a non-human credential sitting
in Secret Manager, which is the exposure the harness exists to avoid, not a
way around it. A second, technical constraint reinforces the same choice:
`_scw-auth.mjs#api()` memoises one SDK instance per `(product, version,
cls)` for the process's one active identity, so juggling a second,
per-project identity alongside the operator's own inside a single script
run is not something the current code supports. Cas B sidesteps the problem
rather than solving it: its key already is a narrow, per-project credential,
handed to the collaborator by the admin ahead of time, so the harness never
mints anything and never juggles a second identity.

---

## 2. Environment variables — canonical names

### Operator machine (harness credentials, never in a PUBLISHED app)

**Environment variables are the only credential mechanism, on every
platform.** There is no repo-local credentials file, no `scw` config-file
fallback, and no multi-tier resolution: the harness reads `SCW_*` straight
from `process.env` (§7). On Claude Code web the operator sets them once in
the "Baudrier" cloud environment's own env-var dialog; on Linux the operator
keeps them in a **gitignored** env file they maintain themself and source
before running Claude Code. The harness never writes a credential to disk on
any platform.

| Var | Meaning |
|---|---|
| `SCW_ACCESS_KEY` | IAM API key access key |
| `SCW_SECRET_KEY` | IAM API key secret key |
| `SCW_DEFAULT_ORGANIZATION_ID` | Scaleway Organization |
| `SCW_DEFAULT_REGION` | always `fr-par`; this is the default applied when unset |
| `SCW_DEFAULT_PROJECT_ID` | Cas A: optional override, skips the by-name Project lookup and targets this Project id directly. Cas B: mandatory - a Project-scoped key cannot list Projects, so this is the only way it declares which Project it owns (§1) |
| `SCW_DEFAULT_APPLICATION_ID` | Cas B: the id of the IAM application that bears the key (not a secret). Optional but recommended: it removes the only IAM read the database path needs - a Cas B key cannot read its own IAM record (§1: the shape probe defines Cas B by that 403), and Serverless SQL uses the principal id as the database username (§4). Absent, `/add-db` raises `needs_application_id` with self-service console steps. Cas A: ignored (check 78) |

**Per-app scope resolves by Scaleway Project id or name, never by a stored
file.** App repos carry **no Scaleway metadata at all** -
`.scaleway/container.json` does not exist. `_scw-auth.mjs` resolves the
active Project in this order: the `SCW_DEFAULT_PROJECT_ID` env override → a
session-scoped `/tmp` cache keyed by app name → an SDK `listProjects` call
filtered by the app's name, which then writes that cache (`ProjectManager`,
§1, Cas A only). A Cas B key cannot take that last path at all, which is
exactly why `SCW_DEFAULT_PROJECT_ID` is mandatory for it, not optional
(§1). This is also why one Cas B cloud environment serves exactly one app:
there is no per-app map any more, so a second app under the same key would
have no way to pick a different Project. An env-var edit only reaches a NEW
session; for the current session the `cache-project` command of
`_scw-auth.mjs` (§3) seeds the session cache from a Project id the user
gives in the chat - an id is an identifier, not a secret, so the chat is an
acceptable channel for it. Containers and registry namespaces are likewise
found by name, never by a stored id.

One exception on the registry axis: Container Registry namespace NAMES are
globally unique across ALL of Scaleway — every organization, not just this
Project (live-verified 2026-08: an unrelated organization owned an app's
plain slug). The harness therefore creates namespaces as `<slug>-<8 hex>`
by default, and both `/bootstrap` and `/deploy` resolve them with
`findRegistryNamespace()` — a name-prefix match
(`/^<slug>(-[0-9a-f]{8})?$/`) within the app's own Project. This is still
discovery by name: no ids, no linkage file. A suffixed name is also
recorded as a name-only `Registry namespace:` line in the generated
CLAUDE.md, for humans. Only `/bootstrap` creates namespaces;
`--registry-namespace` overrides the name and fails loudly on `/deploy`
when the named namespace does not exist (check 75).

**Runtime credentials are always scoped to the app's own Project, never to
the whole organization - but how they get there differs by shape (§1).** In
Cas A each capability gets its own IAM-scoped key, minted by `/bootstrap`:
`TEM_API_SECRET_KEY` for email, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`
for Object Storage, `SCW_GENERATIVE_API_KEY` for Generative APIs, and the
IAM application id + secret embedded in `DATABASE_URL` for the database. In
Cas B there is only one key: `operatorKeyAsAppCredential()` (§1, §3) reshapes
the environment key itself into every one of those same container
variables, since the admin already scoped it to exactly this Project and
nothing wider. In neither shape does a generated app ever receive
`SCW_ACCESS_KEY`/`SCW_SECRET_KEY` under those names.

### Generated app (`.env` locally, `secret_environment_variables` in the container)

Secret Manager is the canonical, readable store for every one of these
(§1: a container's `secret_environment_variables` can only be written, never
read back). `container.mjs#buildContainerSecretMap` projects the whole
Secret Manager set into a container, **except** `CONTAINER_EXCLUDED_SECRETS`
(the `BAUDRIER_*` and `DATABASE_URL_PREVIEW_*` prefixes, plus
`MATOMO_TOKEN`, `PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT` — operator-side
values a generated app must never receive).

`ACCESS_RESTRICTED` and `APP_URL` are Secret-Manager-canonical for
**production** only (`bootstrap-init.mjs` seeds both, plus
`ACCESS_ALLOWED_IPS` and a `DATABASE_URL` placeholder, at project creation).
A **preview** container's `ACCESS_RESTRICTED`/`APP_URL` are container-only
`syncContainerSecrets` `overrides` — deliberately never written to Secret
Manager, since that value is production's — reapplied by `/deploy` on every
preview deploy (§1: fails closed).

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Serverless SQL connection string (see §4); `bootstrap-init.mjs` seeds a placeholder in Secret Manager before a database exists, `/add-db`/`/deploy` overwrite it with the real value |
| `APP_URL` | public URL of the app (replaces the old Vercel URL var); Secret-Manager-canonical for production, a container-only override for preview |
| `AUTH_URL` | Auth.js canonical origin (§1: `UntrustedHost`). Never stored: `container.mjs#buildContainerSecretMap` derives it from the container's effective `APP_URL` (the Secret Manager value for production, the preview override otherwise) on every sync. An explicit `AUTH_URL` secret or override wins over the derivation |
| `AUTH_SECRET` | NextAuth/Auth.js secret |
| `ACCESS_RESTRICTED` | `"true"` \| `"false"` — the VPN IP gate; Secret-Manager-canonical for production, a container-only override for preview |
| `ACCESS_ALLOWED_IPS` | comma-separated CIDRs; no default - unset means nobody passes the gate while `ACCESS_RESTRICTED` is on; `bootstrap-init.mjs` seeds it in Secret Manager with the operator's detected egress address |
| `ACCESS_BYPASS_TOKEN` | pre-shared harness token (hex, 64 chars); a request carrying it in `x-baudrier-access-token` passes the IP gate for every method (§6); `bootstrap-init.mjs` mints it, `deploy.mjs` mints it when absent (pre-token app) |
| `STORAGE_ENDPOINT` | `https://s3.fr-par.scw.cloud` |
| `STORAGE_REGION` | `fr-par` |
| `STORAGE_BUCKET` | bucket name |
| `STORAGE_ACCESS_KEY` | IAM key for Object Storage |
| `STORAGE_SECRET_KEY` | IAM secret for Object Storage |
| `STORAGE_PUBLIC_URL` | public base URL for public buckets |
| `TEM_SENDER_EMAIL` | verified TEM sender |
| `TEM_SENDER_NAME` | display name |
| `TEM_API_SECRET_KEY` | IAM-scoped key for the TEM send API (**not** the operator's key) |
| `SCW_GENERATIVE_API_KEY` | Generative APIs key |
| `SCW_GENERATIVE_BASE_URL` | `https://api.scaleway.ai/v1` |
| `SCW_GENERATIVE_MODEL` | chat model id |
| `SCW_EMBEDDING_MODEL` | `qwen3-embedding-8b` (2000 dims) |
| `NEXT_PUBLIC_MATOMO_URL` | Matomo instance URL |
| `NEXT_PUBLIC_MATOMO_SITE_ID` | Matomo site id |
| `CRON_SECRET` | shared secret protecting `/api/cron/*` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push |

**A vitrine container receives a narrow subset.** Only `APP_URL`,
`ACCESS_RESTRICTED`, `ACCESS_ALLOWED_IPS` and `ACCESS_BYPASS_TOKEN` apply to a
landing site — no `DATABASE_URL`, no `AUTH_*`, no storage/email/generative
keys, since a static Astro build integrates with none of them (§1 "Two
stacks"). Matomo is the one exception, and its mechanism inverts:
`/add-analytics`'s landing branch bakes the Matomo URL and site id straight
into `src/components/Matomo.astro` at build time (a static page cannot read a
runtime env var, and both values are already public in the page source
either way), so a vitrine never receives `NEXT_PUBLIC_MATOMO_URL` /
`NEXT_PUBLIC_MATOMO_SITE_ID` as container secrets at all — changing them
needs a rebuild, never a redeploy alone.

**Never introduce a variable not listed here without saying so in your report.**
Banned (removed providers): anything matching `VERCEL_*`, `NEON_*`,
`CLOUDFLARE_*`, `CF_*`, `R2_*`, `RESEND_*`, `BREVO_*`, `RENDER_*`, `STRIPE_*`,
`ANTHROPIC_API_KEY`, `NEXT_PUBLIC_GA_*`.

### Secret Manager naming

One Scaleway Project per app, so a secret's name **is** the env var name
(`DATABASE_URL`, `AUTH_SECRET`, …). `MATOMO_TOKEN`, `PAGESPEED_API_KEY` and
`GSC_SERVICE_ACCOUNT` are per-app secrets like every other one: each app's own
Project holds its own copy, and the user pastes the value again for a new
project. `GITHUB_TOKEN` is **not stored at all** — the harness holds no
GitHub credential of its own. Repo access is native git auth (the web
session's own git credential, or the operator's git auth on Linux, §7); the
repo-access gate is `git ls-remote origin`, never `gh auth status` or
`gh api /user` (§1, §7). No script in this repo reads a `GITHUB_TOKEN`
secret, and `gh` is no longer part of the toolchain at all (§5, §7).

Two exceptions to the name-equals-var rule:

1. Preview environments each need their own database, so `/deploy` stores
   preview connection strings as `DATABASE_URL_PREVIEW_<BRANCH_SLUG>` and maps
   them onto the literal `DATABASE_URL` at point of use (the Job's
   `secretRefs` and the container's `secret_environment_variables`).
2. `BAUDRIER_DB_KEY`: its body is JSON with two fields (`application_id`,
   `secret_key`) - the IAM Application id and API secret key backing the
   database connection, one pair per app Project. In Cas A `/bootstrap` mints
   this pair itself (§1); in Cas B it is derived from the environment key by
   `operatorKeyAsAppCredential()` instead (§1, §3) - no separate database
   application exists. It lives in the app's own Project, like every other
   secret, but is read **in-process only** by `setup-db.mjs`, `deploy.mjs`
   (preview databases - same pair) and `rotate-secret.mjs` - never via the
   `secrets.mjs` CLI `get` command, which would print it. Its name is
   exported as `DELEGATED_DB_KEY_SECRET_NAME` from `scripts/scaleway/iam.mjs`.

`BAUDRIER_DB_KEY` is covered by the existing `BAUDRIER_*` container-exclusion
prefix (`CONTAINER_EXCLUDED_SECRETS`, §1) like every other operator-side
secret - it is never projected into a container under that name.

### Additional app vars set by addon skills

Not every generated app has these; each is written only by the skill that owns
it. Listed so `/delete-project` and `/clean` do not misreport them as
user-added: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_DEV`, `ADMIN_PASSWORD_HASH_PROD`,
`ADMIN_TOTP_SECRET`, `ADMIN_2FA_BACKUP_HASHES`, `ADMIN_EMAIL`,
`CONTACT_RECIPIENT_EMAIL`, `VAPID_SUBJECT`, `AGENT_TRIGGER_MODE`,
`AGENT_CRON_PROMPT`, `AGENT_DAILY_BUDGET_EUR`, `AGENT_MONTHLY_BUDGET_EUR`,
`AGENT_EMAIL_ALLOWED_RECIPIENTS` (comma-separated allowlist for the agent's
`send_email` tool; unset falls back to `ADMIN_EMAIL`, absent both the tool
refuses to send).

---

## 3. `scripts/scaleway/` module API

**These modules are thin adapters over the official `@scaleway/sdk`.** They are
not hand-written REST clients any more. Their exported signatures are frozen —
~80 call sites across `skills/` and `scripts/` depend on them — but the bodies
delegate to the SDK.

### How dependencies reach the code

A plugin's own directory (`${CLAUDE_PLUGIN_ROOT}`) is a **read-only cache**, so
`node_modules` cannot live there. Dependencies are installed into
`${CLAUDE_PLUGIN_DATA}` (writable, survives plugin updates) by
`tools/bootstrap-deps.mjs`, run from the `SessionStart` hook in `hooks/hooks.json`.

**`${CLAUDE_PLUGIN_DATA}` only exists for hooks and MCP/LSP subprocesses.** A
**Bash tool call does not get it** — verified empirically: a Bash call sees
`CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT` and no `CLAUDE_PLUGIN_DATA`. The
installer is a hook and knows the directory; every `scripts/scaleway/*.mjs` runs
under Bash and does not. Nor can the directory be hardcoded: its name is the
plugin identifier with characters outside `[a-zA-Z0-9_-]` replaced by `-`, so
`baudrier@<marketplace>` becomes `baudrier-<marketplace>` and the marketplace half
is chosen by whoever installs the plugin.

**`tools/deps-dir.mjs` is the one resolver**, imported by both sides. Reading
order, first hit wins (a candidate counts only if `<dir>/node_modules` exists):

| # | Source | Where it comes from |
|---|---|---|
| a | `env-override` | `BAUDRIER_DEPS_DIR` — **authoritative**: when set it is the only candidate, so a typo fails loudly instead of silently loading some other install |
| b | `plugin-data-env` | `${CLAUDE_PLUGIN_DATA}` (hooks, MCP) |
| c | `pointer` | `~/.claude/baudrier/deps-dir.txt` |
| d | `scan` | any `~/.claude/plugins/data/*` whose `package.json` has `"name": "baudrier"` — best match first: byte-identical to the plugin's own manifest, then most recently modified |
| e | `repo` | the plugin root itself, for dev checkouts |

The **pointer file** is the bridge: `bootstrap-deps.mjs` runs as a hook, so it is
the one process that knows the truth, and it writes the absolute directory to
`~/.claude/baudrier/deps-dir.txt` after both the install and the already-up-to-date
path. It lives outside `plugins/data` so a plugin update or marketplace rename
cannot take it with it. Failing to write it is non-fatal — resolution falls back
to the scan, which is the reason the scan exists.

`installTargetDir()` picks where to install *into*: `BAUDRIER_DEPS_DIR`,
`${CLAUDE_PLUGIN_DATA}`, an existing scan hit, then
`~/.claude/plugins/data/baudrier-fallback`, then the repo root. It never
invents `~/.claude/plugins/data/baudrier` — that was the old wrong guess.

`bootstrap-deps.mjs --json` prints exactly one JSON line on stdout (human logs go
to stderr) and exits non-zero on failure, for the `_preflight` skill to parse:

```json
{"ok":true,"dir":"...","source":"scan","action":"installed|up-to-date|failed|check",
 "pointerWritten":true,"nodeVersion":"v22.x.x","health":"ok|broken|skipped","error":null}
```

`--check` implies `--json`, resolves and health-checks only, installs nothing and
writes nothing (its `pointerWritten` reports whether the pointer already agrees) —
it is the cheap gate. Without `--json`, failure still exits 0: a dependency problem
must never block a session from starting. The `engines.node` floor is enforced
before any install, because a doomed `npm install` failing with `EBADENGINE` reads
like a harness bug rather than "update Node".

**`NODE_PATH` does not work for this.** Node honours it only for CommonJS
`require`, never for ESM `import`, and every script here is ESM. There is no
documented alternative, so `scripts/scaleway/_deps.mjs` resolves explicitly:
`createRequire` rooted in the resolved directory → `require.resolve(spec)` →
`import(pathToFileURL(abs))`. **Always import dependencies through `_deps.mjs`**
(`loadScalewaySdk`, `loadScalewayClient`, `loadS3`, `loadS3Presigner`) — never a
bare specifier, which would fail at runtime.

### Pinned versions, and why exactly

`package.json` pins `@scaleway/sdk@3.11.1` and `@scaleway/sdk-client@2.4.2`
**exactly, not as ranges**. Scaleway's npm release pipeline is currently
publishing packages with no `dist/` directory while still declaring `exports`
that point into it — verified against `registry.npmjs.org` (`fileCount: 3`).
3.11.2, 4.0.0 and `sdk-client` 2.5.0 are all broken this way. A caret range
resolves to a broken release and fails with a confusing `ERR_MODULE_NOT_FOUND`
inside `node_modules`. `tools/check-deps-health.mjs` detects exactly this and
must pass before relaxing a pin.

### Supply chain: the two install paths

The harness installs its own runtime deps from the committed lockfile, with
`npm ci --ignore-scripts` (`tools/bootstrap-deps.mjs`), so a dependency's
install script never runs here.

A generated project cannot use that mechanism: `/bootstrap` and every `add-*`
skill run `pnpm add <pkg>@latest`, and `bootstrap-init.mjs` passes
`--config.dangerously-allow-all-builds=true` on pnpm ≥ 11, so build scripts do
run there. The age floor is the guard instead.
`writeSupplyChainWorkspaceYaml()` (called by `scaffoldT3()` **before the
first `pnpm install`**) writes `minimumReleaseAge: 4320` (3 days, in
minutes) and `minimumReleaseAgeStrict: false` into the project's
`pnpm-workspace.yaml`, so every dependency resolution in the project's life
runs under the floor. Two facts are deliberate and must stay understood,
not silently "fixed":

- **`minimumReleaseAgeStrict` stays `false`.** pnpm flips it to `true` by itself
  as soon as `minimumReleaseAge` is set explicitly. Strict turns "the only
  version matching the range is too new" into a failed install in front of a
  non-technical user; false makes pnpm pick an older qualifying version instead.
- **`strict:false` rescues ranges, never exact pins** (live-verified 2026-08:
  esbuild pins its `@esbuild/<platform>` packages to an exact version, so a
  <3-day-old pin has no older *matching* version and pnpm fails with
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The recovery is
  `recoverFromImmatureLockfile()`: delete `pnpm-lock.yaml`, re-resolve once
  under the floor (a fresh resolve picks mature parents whose exact platform
  pins are mature too). Safe pre-commit only; every call site precedes the
  git commit step.

Check 52 guards the values and the write-before-first-install placement;
check 72 guards the recovery. `skills/security/SKILL.md` §1g carries the
lockfile sweep for a named-advisory check.

### Getting an API instance

```js
import { api, sdkCall, ScwError } from "./_scw-auth.mjs";
const containers = await api("Container", "v1");
const result = await sdkCall(() => containers.listNamespaces({ projectId }));
```

`api(product, version, cls = "API")` returns a memoised SDK API. `sdkCall()`
wraps a call to translate the SDK's typed errors into `ScwError` and to apply
backoff on `TooManyRequestsError`/5xx — the SDK does **not** retry on its own.

Version choices that matter: **Container `v1`** (v1beta1 was deprecated
2026-07-09; the SDK exposes both, so there is no reason to stay on it),
**Jobs `v1alpha2`**, **Billing `v2beta1`** (v2 has only budgets; consumption is
in v2beta1), and **Cockpit** uses `GlobalAPI`/`RegionalAPI` rather than `API`.

Prefer the SDK's **built-in waiters** (`waitForContainer`, `waitForNamespace`,
`waitForDomain`) over hand-rolled polling — they also remove the need to
hard-code status enums, which is where a previous revision guessed wrong.

### The documented non-SDK exceptions

Raw HTTP (plain `fetch`, or `scwFetch`/`scwPaginate` surviving in
`_scw-auth.mjs` as an escape hatch) is legitimate **only** for:
1. **Cockpit log queries** — a Loki-compatible endpoint on a different host,
   with no SDK method; `cockpit.mjs` uses plain `fetch` with the `X-Token`
   header (see its section below).
2. **Object Storage** — not raw fetch at all: S3-protocol only, so it uses
   `@aws-sdk/client-s3` (see `object-storage.mjs`), not the Scaleway SDK.
   Listed here as the other non-SDK path.
3. Any API Scaleway ships before the SDK catches up.

Anything else must go through the SDK.

### `_scw-auth.mjs` (already written — read it, do not change its exports)

```js
export const REGION;                       // "fr-par"
export class ScwError extends Error {}     // .status .type .details
export function loadCredentials();          // {accessKey,secretKey,projectId,organizationId,region}
export function requireCredentials();       // same, throws a friendly error if absent
export async function scwFetch(apiPath, {method, body, query, headers, raw});
export async function scwPaginate(apiPath, {query, key});  // yields all pages of key
```

The file also carries one CLI command:
`node scripts/scaleway/_scw-auth.mjs cache-project <project-id> [app-name]`
writes the session-scoped Project cache. It exists for one flow only: a
« Cas B » user gave a Project id in the chat, and the current session cannot
reread the environment variables (§2).

### `secrets.mjs` — Secret Manager

```js
export async function getSecret(name, opts?);        // -> string (latest enabled version)
export async function putSecret(name, value, opts?); // create-or-new-version -> {id,revision}
export async function secretExists(name, opts?);     // -> boolean
export async function listSecrets(opts?);            // -> [{id,name,versionCount}]
export async function deleteSecret(name, opts?);
```

### `iam.mjs` — IAM applications, policies, API keys

```js
export const DELEGATED_DB_KEY_SECRET_NAME;                     // "BAUDRIER_DB_KEY"
export async function ensureApplication(name, opts?);          // -> {id,name}
export async function ensurePolicy({applicationId, projectId, permissionSetNames});
export async function createApiKey({applicationId, projectId, description});
                                                               // -> {accessKey,secretKey}
export async function listApiKeys(applicationId);
export async function deleteApiKey(accessKey);
```

A 403 on a mint operation (`ensureApplication`, `ensurePolicy`, `createApiKey`)
maps to `ScwError type "permission_denied"`. Cas A's key always carries
`IAMManager` by construction (§1), so this is an unexpected-failure path, not
a routed fallback.

### `app-credentials.mjs` - the operator-key-to-app-credential chokepoint (§1)

```js
export async function devDbCredentials();
                                    // -> {principalId, secretKey}: the IAM
                                    // user/application id behind the operator's
                                    // own key, for a Cas B database connection
export async function credentialShape();
                                    // -> "org" | "project" | "unknown"
                                    // throws ScwError type "shape_deadlock"
export async function operatorKeyAsAppCredential({purpose});
                                    // -> {accessKey, secretKey}
                                    // throws ScwError type "shape_unknown" |
                                    // "shape_deadlock" | "org_key_refused"
```

Renamed from the module's earlier name and earlier job: tracking which
secrets were still backed by the operator's personal key, for `/publish` to
gate on. That job is gone along with the fallback chain it tracked (§1). Its
new job is narrower and stricter: `operatorKeyAsAppCredential()` is the
**only** code allowed to turn the environment key (§2) into a credential that
reaches a container's `secret_environment_variables`. It delegates the actual
probe to `probeOrgReach()` (`check-scw-permissions.mjs`, below), memoised for
the lifetime of the process only - never written to disk (§7) - and refuses,
fail-closed, in every case but one:
- `shape_unknown` - the probe itself was inconclusive (a probe call failed
  for a reason other than a clean 403/401): never guess Cas B from a probe
  that could not finish;
- `shape_deadlock` - the key has organization reach (`ProjectManager` and/or
  `BillingReadOnly`) but not `IAMManager`: it can neither mint a scoped key
  as Cas A, nor be adopted as an app credential, since it does have
  organization reach. The admin must either add `IAMManager` or reissue a
  Project-scoped key;
- `org_key_refused` - the key has organization reach and `IAMManager` too:
  a genuine Cas A key, refused outright as an app credential.

Only when none of these fire - no organization reach at all - does it return
the credential pair, confirming the key is Cas B (§1). Callers use it to
build `DATABASE_URL` (via `devDbCredentials()` for the connection string's
IAM principal), `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`,
`SCW_GENERATIVE_API_KEY` and `TEM_API_SECRET_KEY` directly from the
environment key, instead of minting a separate scoped key the way Cas A
does.

### `registry.mjs`

```js
export async function ensureRegistryNamespace(name, opts?);  // -> {id,name,endpoint}
export async function listImages(namespaceId);
export async function listTags(imageId);
export async function pruneTags(imageId, {keep});            // -> {deleted:[tag]}
```

### `container.mjs`

```js
export const SCALE_PRESETS;  // {S:{cpuLimit,memoryLimit,maxConcurrency}, M, L, XL}
export const CONTAINER_EXCLUDED_SECRETS;  // Secret Manager names never projected into a container
export async function ensureNamespace(name, opts?);       // -> {id,name}
export async function findContainerByName(namespaceId, name);
export async function createContainer({namespaceId, name, registryImage, ...});
export async function updateContainer(containerId, patch);
export async function deployContainer(containerId);
export async function getContainer(containerId);
export async function waitForContainerReady(containerId, {timeoutMs});
export async function setContainerSecrets(containerId, obj);  // low-level PATCH; obj MUST be the
                                                                // complete desired map - a key it
                                                                // omits is DELETED (§1). Do not call
                                                                // this from outside container.mjs.
export async function buildContainerSecretMap({overrides, databaseUrlFrom, projectId, allowMissingDatabaseUrl});
                                                                // -> complete map, from Secret
                                                                // Manager, minus CONTAINER_EXCLUDED_SECRETS,
                                                                // plus overrides (§1, §2).
                                                                // allowMissingDatabaseUrl defaults
                                                                // false (throws on a missing
                                                                // databaseUrlFrom secret); only the
                                                                // landing call sites pass true.
export async function syncContainerSecrets(containerId, {overrides, databaseUrlFrom, projectId, allowMissingDatabaseUrl, timeoutMs});
                                                                // THE canonical entry point (§1):
                                                                // wait-ready, write the full map,
                                                                // wait-ready. Every caller outside
                                                                // this module goes through this,
                                                                // never setContainerSecrets directly.
export async function addCustomDomain(containerId, hostname);
export async function listCustomDomains(containerId);
export async function deleteCustomDomain(domainId);
```

### `jobs.mjs`

```js
export async function ensureJobDefinition({name, imageUri, command, env, secretRefs,
                                           cpuLimit, memoryLimit, timeout, opts});
export async function startJob(definitionId, {env, command, replicas});  // -> runId
export async function waitForJobRun(runId, {timeoutMs});   // -> {state, exitCode}
export async function setSchedule(definitionId, {cron, timezone});
export async function listJobDefinitions(opts?);
export async function deleteJobDefinition(definitionId);
```

### `sdb.mjs` — Serverless SQL Database

```js
export async function ensureDatabase(name, {minCpu, maxCpu, opts});  // -> {id,name,endpoint,port,dbName}
export async function getDatabase(name, opts?);
export async function waitForDatabaseReady(id, {timeoutMs});
export async function deleteDatabase(id);
export function buildConnectionString({endpoint, port, dbName, applicationId, secretKey});
       // -> postgres://<applicationId>:<secretKey>@<endpoint>:<port>/<dbName>?sslmode=require
```

### `dns.mjs`

```js
export async function zoneExists(domain);
export async function isDelegatedToScaleway(domain);  // NS lookup -> boolean
export async function listRecords(domain);
export async function upsertRecords(domain, records);  // [{name,type,data,ttl}]
export async function deleteRecords(domain, records);
export async function waitForPropagation(fqdn, {type, expect, timeoutMs});
```

### `tem.mjs`

```js
export async function ensureDomain(domain, opts?);   // -> {id,status}
export async function getDomainRecords(domainId);    // -> [{name,type,value}] SPF/DKIM/DMARC/MX
export async function checkDomain(domainId);
export async function sendEmail({from, to, subject, text, html, opts});
export async function getConsumption(opts?);
```

TEM constraints to enforce in code and surface to the user: subject **≥ 10
characters**, **max 10 recipients** per email (Scaleway's documented default;
raisable on request), and no templating engine — you render HTML yourself.

Quotas are **plan-based, not KYC-gated**: Essential gives 300 free emails/month
and up to 5 sending domains, pay-as-you-go beyond; Scale is fixed-price with
100k emails/month and unlimited domains. An earlier revision of this contract
claimed a KYC-gated 500/2 → 5,000/5 tier system; that was not supported by any
Scaleway documentation and has been removed.

### `object-storage.mjs` — S3-compatible Object Storage

Object Storage has no bearer-token REST API, only the S3 API with AWS SigV4, so
this module carries a hand-rolled signer (verified against botocore's
`aws4_testsuite` fixtures). Always uses path-style addressing, because bucket
names containing a dot break the non-recursive `*.s3.<region>.scw.cloud`
wildcard certificate.

```js
export function endpointFor(opts?);                          // https://s3.<region>.scw.cloud
export async function bucketExists(name, opts?);
export async function ensureBucket(name, opts?);
export async function deleteBucket(name, opts?);             // bucket must be empty first
export async function setBucketPolicy(name, policy, opts?);
export function buildPublicReadPolicy(name);
```

Scope: **provisioning only.** Object-level work (listing, uploading, emptying a
bucket before deletion) is done with `@aws-sdk/client-s3` from the generated
app, which already depends on it once `/add-storage` has run — do not duplicate
an object API here.

Not supported by Scaleway: bucket notifications (`PutBucketNotification`). Any
"on upload" behaviour must live in application code, never a bucket-side trigger.

### `billing.mjs`

```js
export async function getProjectCosts({projectId, from, to});
export async function getConsumption();
```

### `cockpit.mjs`

```js
export async function ensureToken(opts?);            // -> {token, logsUrl}
export async function queryLogs({query, since, limit, opts});  // LogQL via Loki API
```

Loki gateway auth (live-verified 2026-08): `/loki/api/v1/query_range`
accepts **only** the `X-Token: <cockpit token>` header. `X-Auth-Token` plus
the OAuth-style bearer header got 403; a bare `X-Token` got 200.
`queryLogs` therefore uses a plain `fetch` (raw-fetch exception #1), never
`scwFetch`, whose default `X-Auth-Token` cannot be suppressed. Check 77
pins the header.

### Operator credential scripts (top-level `scripts/`, not `scripts/scaleway/`)

The `_preflight` skill validates the operator's env-only credentials (§2, §7)
and prints platform-specific instructions when one is missing: the cloud
environment dialog on web, or the gitignored env file example on Linux - it
never prompts for a secret in chat. The credential-writing scripts this
section used to describe (`_persist-scw-credentials.mjs`,
`collect-scw-credentials.mjs`, `persist-scw-mode.mjs`) are gone along with
the tiers they wrote (§7): there is nothing left for `_preflight` to persist.

| Script | Role |
|---|---|
| `scripts/check-scw-permissions.mjs` | read-only probe for the three organization-scoped permission sets: `ProjectManager`, `IAMManager`, `BillingReadOnly`. Exports `probeOrgReach({organizationId?})` -> `{orgReach, canMint, conclusive, probes}` - `orgReach` is true when any of the three succeeds, `canMint` mirrors `IAMManager` alone, `conclusive` is false on anything other than a clean success or a clean 403/401. This is what `operatorKeyAsAppCredential()` (`app-credentials.mjs`, §1) calls to decide the shape. Run directly it is advisory only - it recommends setting `SCW_DEFAULT_PROJECT_ID` (§1, §2), it does not set it itself. |

Credential adoption exists in exactly one place: `operatorKeyAsAppCredential()`
(§1, `app-credentials.mjs` above). It runs automatically, on every script that
needs an app-facing credential - there is no separate admin-initiated step
and no secret an admin provisions after the fact. The admin's one action is
upstream of all of this: provisioning the Cas B key itself, scoped to one
Project, per `docs/ADMIN-SCALEWAY.md`. The chokepoint never grants
organization-wide rights - it refuses outright rather than adopt a key it
cannot confirm is Project-scoped (§1). See `docs/ADMIN-SCALEWAY.md`.

---

## 4. Database connection

```
postgres://<IAM_APPLICATION_ID>:<IAM_API_SECRET_KEY>@<endpoint>:5432/<db>?sslmode=require
```

Auth is IAM: the "user" is an IAM **Application** id, the "password" is that
application's API **secret key**. Create the key with **no expiry** so the
connection string is stable.

Do **not** ship `ssl: { rejectUnauthorized: false }` in generated code, even
though Scaleway's own tutorial does. Use proper CA verification.

Drizzle wiring: `pg` + `drizzle-orm/node-postgres`. No `pgTableCreator` prefix
hack — each app has its own database. Addon schema templates declare tables
with plain `pgTable`, and `bootstrap-init.mjs` resets the scaffolded
`schema.ts` to that convention (`tools/verify.mjs` check 65).

**The operator never connects to a database.** `drizzle-kit generate` (writes
SQL files, no connection) runs locally; the migration Serverless Job applies
them with `templates/deploy/migrate.mjs` (§1), not `drizzle-kit migrate` -
the production image carries no devDependencies to run it. No REAL
`DATABASE_URL` ever exists on the operator's machine - the local `.env`
carries a syntactically valid placeholder
(`postgresql://placeholder:placeholder@localhost:5432/placeholder`) that
satisfies Zod validation and `drizzle.config.ts`'s import chain without
opening a connection. The placeholder is required, not a leftover: deleting
it breaks `drizzle-kit generate`. The real value lives only in Secret
Manager and the containers it is synced into. `/add-auth`, `/add-role` and
`/add-2fa` follow the same rule: their setup scripts run `drizzle-kit
generate` only, and the role backfill ships as an `UPDATE` appended to the
generated migration file, never as a live statement from this machine
(`tools/verify.mjs` check 66). Enforcement of this rule is static, in
check 66 (`drizzle-kit push|studio|migrate` and tsx/ts-node spawns are
banned in scripts): `_destructive-guard.mjs` cannot help here - it guards
Scaleway API calls inside the SDK wrappers and has no way to intercept a
child process.

**Stored data is an optimisation, not a dependency.** Because there is no
REAL `DATABASE_URL` on the operator's machine (only the harmless
placeholder above), every DB-reading page in local dev has always had to
survive a missing database — the same failure shape a live
database outage produces in production. `templates/db/safe.ts` generalises
the pattern: `tryDb(fn, fallback)` runs `fn` and, on any error, logs one
`console.warn` line (never the connection string) and returns `fallback`
(calling it if it is a function) instead of throwing. `scripts/setup-db.mjs`
writes it alongside the Drizzle client swap, so every app with a database has
it from `/add-db` onward. Route a read whose value can be recomputed or
defaulted (a list, a counter, a recommendation) through `tryDb`; a genuine
hard dependency (an auth lookup) may stay a direct call but must render a
clear error, never crash the page - see `skills/add-db/SKILL.md`.

---

## 5. Deploy pipeline

**The pipeline is direct: no GitHub Actions, no `build.yml`, no repo
secrets.** The machine running the harness - the Claude Code web VM or the
operator's own Linux box - builds the image itself and pushes it straight
to the registry: `docker login rg.fr-par.scw.cloud` with the operator's own
`SCW_SECRET_KEY`, `docker build --platform linux/amd64` (Serverless
Containers accept `amd64` only, §1's hard facts), then `docker push` tagged
with the commit SHA. `scripts/ensure-dockerd.mjs` starts `dockerd` first
when it is not already running (live-verified on web: the daemon exists but
nothing starts it at session boot, §1). `/deploy` and `/bootstrap` both skip
the rebuild when that exact SHA tag already exists in the registry, so
re-running `/deploy` on an unchanged commit does not pay for a second image
build. This is the same pipeline on every platform - Linux needs Docker
installed, web has it preinstalled. GitHub is code hosting only in the build
path: no build or deploy workflow is generated into a new app, and no
Scaleway credential is ever written to a GitHub secret.

**One workflow exists outside the build path:**
`.github/workflows/clean-merged-branches.yml`, a maintenance workflow that
the repository owner starts by hand (`workflow_dispatch` only, guarded by
`github.actor == github.repository_owner`). It deletes remote branches that
are already merged into the default branch, because a session's git
credential cannot delete a remote ref (§7). It reads no repo secret - it
uses only the default `GITHUB_TOKEN` through `permissions: contents:
write`. New projects get it from `bootstrap-init.mjs`; existing projects
get it from `scripts/add-cleanup-workflow.mjs` (the `/deploy` skill runs it
when the file is missing). Check 60 pins its shape; checks 31, 38, 44 and
56 keep the build pipeline free of Actions.

**Development loop, and when a deploy happens at all.** `pnpm dev` on
`http://localhost:3000` keeps exactly one job: the assistant's own in-VM
checks, on top of `pnpm tsc --noEmit`/`pnpm lint` - typecheck and lint alone
catch types and style, never a runtime or logic bug, so the assistant fetches
the running app itself before calling a change done. It is never offered to
the user as a way to see the app: a Claude Code web session gives the user's
own browser no route to that address at all (§1). A deploy is never the
silent automatic next step after a change; it is for **review** or an
**explicit user request**, and it costs a full image build, so
`skills/deploy/SKILL.md` confirms one is wanted at all before proceeding,
unless the user's own message already asked for it.

**`/deploy` reads `ACCESS_RESTRICTED` first, then branches on state and
branch.** Before it asks anything, `/deploy` reads the canonical
`ACCESS_RESTRICTED` value from Secret Manager (`getSecret`; a failed read
falls closed and counts as `"true"`, restricted). That value plus the
current branch decide the menu:

| Branch | `ACCESS_RESTRICTED` | What the skill offers |
|---|---|---|
| `main` | `"true"` (not published) | One confirmation, target `production` |
| `main` | `"false"` (published) | A menu: private preview, or production |
| any other | any | The same menu; production merges the branch into `main` first, preview leaves the branch alone |

Row 1's reason: an unpublished production site is already private - only the
addresses in `ACCESS_ALLOWED_IPS` reach it, so a separate review environment
adds cost and gives the user nothing. Row 3's production choice merges the
current branch into `main`, then deploys `main`; a merge conflict stops the
deploy, and nothing is pushed or built. `scripts/deploy.mjs` still refuses
`--target production` on any branch except `main` (the reason row 3 needs a
merge at all) - the merge, not a relaxed target check, is what lets a
feature branch reach production.

Row 2's private-preview choice needs one more step: `scripts/deploy.mjs`
refuses `--target preview` on the `main` branch itself, so that option
would otherwise be unreachable from a published `main`. When the user
picks private preview while standing on `main`, `/deploy` moves the work
onto one stable, reused branch named `revue` and deploys the preview from
there - it never generates a per-review branch name. The skill announces
this branch switch to the user before it happens, since the user is
non-technical and did not ask for a branch. The name stays fixed for a
cost reason, not a style preference: every preview branch creates its own
Serverless SQL database, and `_destructive-guard.mjs` never deletes one -
one reused branch name means one database, not one per review.

The private-preview environment IS now proposed, in the two cases above
where the menu appears. Its cost: one Serverless Container and one
Serverless SQL database per branch, and `_destructive-guard.mjs` never
deletes either - state that cost once, before the first preview deploy of a
branch, never again on a later deploy of the same branch. A preview
container inherits `ACCESS_ALLOWED_IPS` from the project's whole Secret
Manager set (`buildContainerSecretMap` projects it into every container),
so the user's own address already reaches a preview - **no preview flow,
and no per-branch environment built on top of this harness, writes
`ACCESS_ALLOWED_IPS`** (§6 has the full rule).

After a preview deploy the skill pushes the branch and stops there - it
never opens a pull request itself. The session's GitHub token is read-only
on Issues and PRs (§1's scope table); the user opens the pull request from
the Claude Code web interface. No branch is ever deleted as part of this -
the web git credential 403s on ref delete regardless (§7).

`/bootstrap`'s own closing deploy (its Step 8b) is the one documented
exception to all of the above - the user's initial request to build the
whole app already is that consent.

**`/deploy`**:
0. Confirm a deploy is actually wanted (see above), unless the user's own
   message this turn already asked for one.
1. Read `ACCESS_RESTRICTED` (see above), then ask the target with the menu
   or confirmation the table selects - always ask, never infer.
2. If production was chosen from a branch other than `main`, merge that
   branch into `main` first and stop on conflict. Commit and push the
   branch that will be built (`main` after a merge, or the current branch
   for a preview).
3. Build the image (`docker build --platform linux/amd64`) and push it to
   `rg.fr-par.scw.cloud` tagged with the commit SHA; skip the build when
   that tag already exists in the registry.
4. Start the migration Job on the new image with an overridden command
   (`node migrate.mjs`, `templates/deploy/migrate.mjs` - see §1), wait for success.
5. Update the container's `registry_image`, wait until ready.
6. Prune old registry tags.
7. Smoke-test `<url>/api/healthz` - the exact path `src/proxy.ts` exempts
   from the IP gate (§6), so it must answer `200 {"ok":true}` from any
   machine; a 403 there means the exemption is broken. Then fetch the
   homepage with the `ACCESS_BYPASS_TOKEN` header (§6) and require `200`.
   Sole downgrade: a 403 despite the token means the app's `src/proxy.ts`
   predates the bypass check - warn with the migration path, do not block
   the deploy of a pre-token app.

`main` → production. Any other branch, when preview is chosen → its own
preview container **and its own preview Serverless SQL database**, named
from a sanitised branch slug. When production is chosen on any other
branch → merged into `main` first, then the `main` row above applies.

**Landing branch.** `scripts/deploy.mjs` detects the stack with
`detectStack()` (`scripts/_stack.mjs`) and skips step 4 (the migration Job)
and the agent-Jobs reconciliation entirely for a vitrine — `LANDING_STEPS`
excludes `migrate` and `agentJobs` outright, not merely as no-ops, so neither
ever touches Secret Manager or Serverless Jobs. The smoke test (step 7) is
unchanged: Caddy answers `/api/healthz` with the same `{"ok":true}` body a
Next.js app does, so one probe works against either stack. A vitrine preview
never gets its own database (the whole `resolveDatabaseSecret()` path never
runs) — the `revue` branch preview is code + secrets only, with the same
container-creation and `syncContainerSecrets` overrides
(`ACCESS_RESTRICTED: "true"`, `APP_URL`) as an application preview, minus
`databaseUrlFrom`.

---

## 6. Access control

Every app ships IP-restricted. Implemented in `src/proxy.ts`: read
`X-Forwarded-For`, take the **first** CSV entry, match against
`ACCESS_ALLOWED_IPS`, else `403`. Gated by `ACCESS_RESTRICTED`. Next 16
renamed Next.js `middleware.ts` to `proxy.ts`, with the export named
`proxy` - same `NextRequest` signature, same `config.matcher`.

**Always exempt** `/.well-known/acme-challenge/*` and the health-check path,
regardless of state. A blocked ACME challenge makes the custom domain
unrecoverable; a blocked health probe kills all traffic.

**`ACCESS_BYPASS_TOKEN` is the harness's own pass through the gate.** The
web sandbox egresses from shared, changing address pools (§1), so the smoke
tests can never be allowlisted by IP. A request carrying the token's exact
value in the `x-baudrier-access-token` header passes for **every method**,
exactly like an allowed IP - treat the token accordingly (it is a container
secret, auto-projected like the rest, rotatable via `/rotate-secret`,
category « interne »). Fail closed: `proxy.ts` refuses the bypass when the
env var is unset or shorter than 32 characters, and compares with a
constant-time XOR loop (no `node:crypto` import - the file must stay
runtime-agnostic). `bootstrap-init.mjs` mints it at project creation;
`deploy.mjs` mints it for pre-token apps and downgrades their
403-despite-token homepage probe to a warning.

This is a **soft boundary**, not a firewall — Scaleway has no network-level IP
filtering for Serverless Containers. Do not describe it as one in user-facing
text. `seo-perf`, `eco-audit` and `gsc` cannot work while restricted; each must
detect the state and say so rather than reporting a spurious failure.

**`ACCESS_ALLOWED_IPS` is production's list, and only `bootstrap-init.mjs`
writes it.** One Secret Manager entry per project feeds every container
(`buildContainerSecretMap` projects the whole set), so an address added for
any other purpose also passes **production's** gate. That grant is permanent
and invisible, and it arms itself again the moment `/unpublish` restores the
gate — a published production ignores the list, which is exactly what makes
the write look free at the time. Therefore: no preview flow, and no
per-branch environment built on top of this harness, may write this secret.
Changing who can reach production is a `/publish`-level decision, never a
side effect of deploying something else. Check 30 enforces the write scope.

**scrypt cost is bounded by the container, not by the crypto.** scrypt's
working set is `128 * N * r` bytes per in-flight hash, and an
unauthenticated request can force one (signup, signin, and the deliberate
timing-equalization hashes on the reset router's failure paths). Preset S
(512 MB, `maxConcurrency` 8) therefore bounds N:
`maxConcurrency × 128·N·r` must leave room for Next.js inside
`memoryLimit`. A breach OOM-kills the container with **no application
log** - a SIGKILLed process writes nothing, so the symptom is an empty
server log and a browser-side network error. The four mint sites
(`templates/auth/users/password.ts`, `templates/auth/admin/password.ts`,
`scripts/hash-password.mjs`, `scripts/setup-2fa.mjs`) stay in lockstep at
N=32768; check 71 enforces the lockstep and the budget. Cost params travel
inside the hash string, so lowering N never breaks a stored hash - and for
the same reason `verifyPassword`'s `maxmem` stays at 256 MB: hashes minted
under the old N=131072 still need 128 MiB to verify.

**The Caddyfile gate (vitrine) mirrors these exact invariants.**
`templates/landing/docker-entrypoint.sh` writes `/etc/caddy/gate.caddy` at
container start from the same three rules as `proxy.ts`: only the literal
`"false"` opens `ACCESS_RESTRICTED`; `/.well-known/acme-challenge/*` and the
exact `/api/healthz` path stay exempt regardless of state
(`templates/landing/Caddyfile`); and a bypass token shorter than 32
characters (`MIN_BYPASS_TOKEN_LENGTH`, mirrored as the entrypoint's `-ge 32`)
mints no bypass line at all - the placeholder `{$ACCESS_BYPASS_TOKEN}` is
what reaches the gate file, never the token's own value, so the secret never
touches disk. `tools/verify.mjs` check 81 extracts the literals from
`proxy.ts` itself and requires the same ones in both landing files, so the
two gates cannot silently drift apart. Documented deviation: the Caddy
header compare (`not header x-baudrier-access-token {$ACCESS_BYPASS_TOKEN}`)
is Caddy's own string match, not the constant-time XOR loop `proxy.ts` uses
- Caddy exposes no constant-time primitive at the Caddyfile level, and this
is accepted as a lower-severity timing side-channel on a bearer token, not a
password.

---

## 7. Skill authoring conventions

Preserve upstream's structure — it works and users rely on it.

- **Frontmatter**: `name`, `description`, `argument-hint` (public skills),
  `compatibility`. Internal skills add `user-invocable: false` and may add
  `allowed-tools`.
- Internal skills are prefixed `_` and have **no** `DOC.md`. Public skills ship
  `DOC.md` **and** `DOC.fr.md`.
- Every skill opens with the standard `## Communication` block (detect the
  user's language, plain language, no jargon, never name scripts or `_`-prefixed
  skills to the user). Copy it verbatim from a surviving skill.
- Body is `## Step N - ...` sections. Step numbers are internal bookkeeping and
  must never be shown to the user.
- Invoke scripts as:
  `node "${CLAUDE_SKILL_DIR}/../../scripts/<name>.mjs" --flag value`
- Scripts print `▸ step`, `✅ result`, `⚠️ warning` and end with a parseable
  JSON line or a handoff banner.
- **Autonomy principle**: do everything you can yourself; ask the user only when
  genuinely impossible.
- All user-facing copy is **French**.

### Code hygiene rules

- Shell out with `spawn(cmd, argsArray)` — **never** `exec`/`execSync` with an
  interpolated string. An argv array prevents shell injection.
- Keep the `import.meta.url === pathToFileURL(process.argv[1] ?? "").href`
  main-module guard exactly as written; it is the one canonical form.
- Any generated shell script must be written with **LF only**. A CRLF shebang
  produces `exec /entrypoint.sh: no such file or directory` while the file
  visibly exists — LF everywhere protects the shebang in the operator's Linux
  VM and in the containers the harness builds.
- Use `COPY --chmod=755` in Dockerfiles rather than trusting the build context's
  executable bit.
- Dockerfile `COPY` paths always use forward slashes.
- Environment variables are the **only** Scaleway credential mechanism (§2)
  - the harness never reads the `scw` config file.
- `operatorKeyAsAppCredential()` (`scripts/scaleway/app-credentials.mjs`, §1)
  is the only code allowed to turn the environment key into an app-facing
  credential. It must refuse a key with organization reach and refuse an
  inconclusive probe - fail closed, never guess Cas B.

### Web session rules (Claude Code web, added 2026-08-05)

- **No persistence outside `/tmp`.** The harness never writes a credential
  or any piece of state to disk on web outside a session-scoped `/tmp` file
  (§2's Project-id cache is the only example). Nothing is meant to survive
  to the next session - the VM itself does not.
- **`CLAUDE_ENV_FILE` does not reach a Bash tool call** (§1, live-verified).
  Never rely on it for anything; a session-scoped `/tmp` file is the only
  cache mechanism that actually works.
- **Bootstrap is in-place only.** `/bootstrap` scaffolds into the checkout
  it is run from; there is no sibling-directory mode and no `gh repo create`
  path - the repo pre-exists (§1's architecture, §4 below describes pushing
  into it).
- **The preflight guard refuses a non-empty repository, not just a
  JavaScript one.** Because bootstrap scaffolds in place, it must never
  merge into an existing codebase. The old check only caught `package.json`
  or `src/`, so a Python or Go repository passed and got a Next.js app
  merged on top. The guard now also refuses any tracked file other than a
  README, a licence, `.gitignore`, `.gitattributes`, `CHANGELOG.md`, or
  anything under `.github/`.
- **Never gate GitHub auth on `gh auth status` or `gh api /user`.** Both are
  unreliable on web (§1: `gh auth status` exits 1 even against a working
  token) and `gh` is no longer part of the toolchain at all. Use
  `git ls-remote origin` as the repo-access gate everywhere.
- **Never delete a remote ref.** The web git credential 403s on ref delete
  (§1, live-verified); treat that as a hard platform limit, not a bug to
  route around. The one sanctioned cleanup path is the
  `clean-merged-branches.yml` maintenance workflow (§5): the owner
  dispatches it on GitHub, where the deletion runs with GitHub's own token,
  outside the session credential.
- **Every `docker build` passes `--platform linux/amd64` unconditionally**
  (already a hard fact, §1) - this covers the web VM's own build too, not
  only a generated app's old CI.
- **The direct build pipeline (docker build + push, SDK container
  create/deploy, SDK status polling, §5) is canonical on every platform,**
  not a web-only shortcut. GitHub Actions is not part of the build pipeline
  anywhere; the only workflow a generated app carries is the dispatch-only
  branch-cleanup maintenance workflow (§5).
- **The host's Node major may trail the Dockerfile's base image.** A
  production build runs `pnpm build` inside the image, on the image's own
  Node - only host-side checks (`tools/verify.mjs`, `engines.node`) ever see
  a version skew between the two.
- **`/bootstrap` is the only documented entry point.** The old standalone
  first-run skill is gone; its three surviving checks now live in the
  internal `_preflight` skill, which `/bootstrap` runs itself at Step 0.
- **The web sandbox commits as the `claude` user.** The harness configures
  no git identity and ships no `setup-git-identity.mjs` - the sandbox's own
  git identity is already correct for every commit.

### Credential resolution (env-only)

`_scw-auth.mjs#loadCredentials()` reads `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`,
`SCW_DEFAULT_ORGANIZATION_ID`, `SCW_DEFAULT_REGION` (default `fr-par`), and
`SCW_DEFAULT_PROJECT_ID` straight from `process.env` (§2).
`resolveProjectId()` reads that same `SCW_DEFAULT_PROJECT_ID`, also straight
from `process.env` - a Cas B key has no other source, since it cannot list
Projects (§1). **There is no other tier.** The old three-tier system - a repo-local
`<repo>/.baudrier/credentials.json`, then env vars, then the `scw` config
file - is gone, along with the scripts that wrote it
(`_persist-scw-credentials.mjs`, `collect-scw-credentials.mjs`,
`persist-scw-mode.mjs`). A generated app repo carries no Scaleway metadata
of any kind: no `.scaleway/container.json`, no repo-local credentials file.
(The name-only `Registry namespace:` line in the generated CLAUDE.md is the
one documented exception — a note for humans and the agent, never an id;
§2.)
The active Project resolves at call time, by name, as described in §2 -
never from a file the harness wrote earlier.

Project scope resolution is likewise read fresh on every run, from
`SCW_DEFAULT_PROJECT_ID` (§1, §2). There is no persisted operator-level
default file (`~/.claude/baudrier/defaults.json` is gone) and no
mode-selection fallback chain: a configured Project id wins outright, and
its absence is what makes `scwProject()` fall through to the org-level
list-or-create call - available to Cas A only (§1). `check-scw-permissions.mjs`
remains as a read-only advisory probe - it recommends setting
`SCW_DEFAULT_PROJECT_ID`, it never sets it itself.

**Every consumer resolves through `loadCredentials()`.** A script must not
read `SCW_ACCESS_KEY`/`SCW_SECRET_KEY` from `process.env` directly: going
through the resolver is what keeps `SCW_DEFAULT_REGION`'s default and the
by-name Project lookup in one place. A dedicated pair such as
`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` can win over the resolver, but only
as a complete pair — one half of it signed with the other tier's secret
produces a `SignatureDoesNotMatch` that reads like a permission problem
(`object-storage.mjs`'s CLI block; check 26 guards the same rule for
`check-name-collision.mjs`).

**Leak guards.** No script writes a credential to disk, so there is no
repo-local file to guard. `.baudrier/` does not exist in the env-only model
and the templates no longer list it.

---

## 8. Definition of done

**Why there is no end-to-end run in the gate** (decided 2026-08-13, after
the live-run defect waves): a fresh-scaffold run of
`bootstrap → add-db → add-auth → add-role → add-2fa` needs a reachable git
remote even with `--skip-deploy` (the preflight `ls-remote` gate), the npm
registry at several stages, and live Scaleway credentials for every `scw*`
step - none of which the gate may depend on. The setup scripts also execute
their pipeline at import time, so nothing is importable for a lighter
harness. The substitute is deliberate: static pins for every past
regression class, plus fixture-spawn behavioral checks (67, 76) where a
script can run against a synthetic directory.

`node tools/verify.mjs` must exit 0 (85 checks). It checks: every `.mjs` parses, every
relative import resolves, every `scripts/...` path named in a `SKILL.md` exists,
every referenced skill exists and no deleted skill is referenced, template
manifests are valid, and no removed-provider token or env var survives outside
allowlisted attribution docs. It also checks: Project scope resolves from
the environment only, with no persisted default file (§1, §2, §7); agent
tools fail safe (`db-query.ts`'s read-only transaction and timeout,
`http-fetch.ts`'s manual-redirect re-validation); no plaintext secret reaches
argv or a script's default stdout (`secrets.mjs`, `iam.mjs`, the persist
scripts); and version agreement across the three manifests
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`package.json`) plus a matching `CHANGELOG.md` heading.

Run it before you report done. If you cannot get your slice to pass, say exactly
what is still failing and why — do not claim success.
