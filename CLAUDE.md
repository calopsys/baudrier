# baudrier

Claude Code plugin: a non-technical French user describes a webapp in plain French, and
the harness builds and deploys it on Scaleway. French-sovereign fork of
[hypervibe-harness](https://github.com/flavien-ia/hypervibe-harness) (Apache-2.0).
Two project stacks share this harness: a T3 (Next.js) application, or a static
vitrine (Astro + Caddy) - see CONTRACT.md §1 "Two stacks".

## Read this first

**[CONTRACT.md](CONTRACT.md) is the spine.** Constants, the canonical env-var table, Secret
Manager naming, the `scripts/scaleway/` API surface, skill conventions and the
code hygiene rules all live there. Read it before changing anything under `scripts/`,
`skills/` or `templates/`. It is also where verified platform quirks are recorded, so
check it before re-deriving a Scaleway behaviour from scratch.

## The gate

```bash
node tools/verify.mjs          # 87 checks, all must pass
node tools/verify.mjs --only 15,16
```

The harness cannot be end-to-end tested without live Scaleway credentials, so **this
script is the definition of "it works"**. Never edit a check to make it pass: if a check
fails, either the code is wrong or the check is wrong, and deciding which is the work.
When you fix a check, prove it still fails on the breakage it was written to catch -
a check that only ever passes is worse than no check.

## Hard rules specific to this repo

- **The operator never touches a database.** No REAL `DATABASE_URL` on this machine, ever -
  only a syntactically valid placeholder in the local `.env`, required so Zod validation and
  `drizzle-kit generate` keep working; deleting it breaks `pnpm db:generate`. Only the
  production container and the migration Serverless Job connect. `drizzle-kit generate`
  is fine locally (it only writes SQL files); `migrate` is not.
- **Destructive operations are guarded.** `scripts/scaleway/_destructive-guard.mjs` refuses
  by default. Never delete a Serverless SQL database or an Object Storage bucket, never
  weaken the guard, and never widen `BAUDRIER_ALLOW_DESTRUCTIVE`. Buckets carry versioning
  plus a 90-day noncurrent-version lifecycle rule and are the only backup of S3 data.
- **Access control fails closed.** `templates/deploy/proxy.ts` must treat an unset
  `ACCESS_RESTRICTED` as restricted, and must always exempt `/.well-known/acme-challenge/`
  and the health check. Both exemptions are load-bearing: a blocked ACME challenge puts a
  custom domain into an unrecoverable `error` state.
- **Scaleway access goes through the SDK**, never hand-rolled REST. `scw` the binary is
  used only for credential setup. The non-SDK exceptions are documented in CONTRACT.md.
- **Dependencies resolve through `tools/deps-dir.mjs`.** Nothing else may compute the
  plugin data directory: `CLAUDE_PLUGIN_DATA` reaches hook processes but *not* Bash tool
  calls, which is why the two sides must share one resolver.
- **Code hygiene**: `spawn(cmd, argsArray)`, never `exec`/`execSync` with an interpolated
  string — an argv array prevents shell injection. Keep the
  `import.meta.url === pathToFileURL(process.argv[1] ?? "").href` main-module guard
  exactly as written; it is the one canonical form. LF everywhere protects shebangs in
  the Linux VM and the containers.
- **Typography**: no em dashes in user-facing text; the typographic apostrophe `’` (U+2019)
  in French JSX and prose, never ASCII `'`.

## Where things stand

Baudrier is web-only as of 2026-08-07: the harness runs on Claude Code web
(claude.ai/code) only, and the native-OS install paths are gone. For the record: the
first live `/start` (now retired) + `/bootstrap` run happened on 2026-07-30 on Debian 13, headless,
root, and created a real GitHub repository and real Scaleway resources - that Linux
path is history now, not a supported install path. Live-verified platform facts get
recorded in CONTRACT.md as the team confirms them.

## Testing this plugin locally

```bash
claude plugin validate .
/plugin marketplace add /absolute/path/to/baudrier
/plugin install baudrier@baudrier
/reload-plugins
```

Marketplace plugins are **copied** into `~/.claude/plugins/cache`, so edits to the working
tree do not take effect until `/plugin marketplace update` + `/plugin install` again. For
a fast edit-test loop use `claude --plugin-dir /absolute/path/to/baudrier`, which
loads in place for the session.
