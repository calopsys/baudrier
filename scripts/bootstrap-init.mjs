#!/usr/bin/env node
// bootstrap-init.mjs - Deterministic early-phase bootstrap for a new T3 project.
//
// Runs all mechanical steps of /bootstrap without LLM involvement, from an
// empty pre-existing repo checkout to a live Scaleway Serverless Container
// deployment (region fr-par, CONTRACT.md §1/§5). The harness itself builds
// and pushes the Docker image - no GitHub Actions anywhere in this pipeline.
//
// IN-PLACE ONLY (CONTRACT.md §7): the repo pre-exists (created from a GitHub
// template, or already cloned) and this script scaffolds INTO the checkout
// it is run from - PROJECT_DIR is always the current directory. There is no
// sibling-directory mode and no repo-creation step.
//
// Sequence (all idempotency caveats below):
//   1. preflight checks tooling, the repo-access gate (`git ls-remote
//     origin` - never a `gh`-based auth check, CONTRACT.md §7) and Scaleway
//     credentials.
//   2. scwProject creates (or reuses) the dedicated Scaleway Project for
//     this app - right after preflight, before scaffoldT3 writes a single
//     local file. check-scw-permissions.mjs is a denial-only probe by
//     design: a clean read cannot prove the create right, only a missing
//     right. Running the real find-or-create here both proves the right and
//     does the required work in one step. A 403 raises the existing
//     needs_admin error (recipe "project", docs/ADMIN-SCALEWAY.md) before a
//     single local file exists, so nothing needs cleanup - re-run with
//     --scw-project-id and the run starts clean, instead of a ~5-minute
//     scaffold-then-discover detour through create-t3-app + pnpm install.
//     In poc mode (readScwMode(), CONTRACT.md §1) this step never calls
//     createProject: it requires --scw-project-id instead, and refuses a
//     Project that already carries another app's secret.
//   3-13. Scaffold + harden the T3 app (unchanged in spirit from earlier
//     iterations of this script): create-t3-app scaffold under a scratch
//     directory then moved into place, .gitattributes + stage (the repo
//     already exists - no `git init`), drizzle bump (SQL injection CVE),
//     demo cleanup, ESLint CLI normalization, healthcheck router, shadcn +
//     LinkButton + Geist fix, security headers, base SEO, local image
//     placeholders, polished 404 page.
//   14-17. Copy the Scaleway deploy artifacts from templates/deploy/ into the
//     project: Dockerfile (multi-stage, node:24-alpine, output:'standalone'),
//     a PATCH (not overwrite) of next.config.* for `output:'standalone'` +
//     image remotePatterns (security() already patched next.config.js with
//     headers by this point - see nextConfigStandalone() for why this step
//     patches instead of copying templates/deploy/next.config.js verbatim),
//     copy-assets.js (restores .next/static + public/ into the standalone
//     output - skipping this ships an unstyled site that still passes its
//     health check), src/proxy.ts (the IP-allowlist gate, CONTRACT.md §6).
//   18-19. claudeMdCore (project CLAUDE.md - addons extend it later via
//     _update-claude-md), privacyPolicy (RGPD page + subprocessors registry).
//   20. cleanupWorkflow writes .github/workflows/clean-merged-branches.yml,
//     the dispatch-only branch-cleanup maintenance workflow (CONTRACT.md §5
//     exception - NOT a build workflow, the pipeline stays direct).
//   21-22. One commit capturing the whole scaffolded state, then
//     `git push -u origin <branch>` (the repo already exists - see
//     pushToOrigin()'s comment for what happens when the push is rejected).
//   23-24. Provision the remaining Scaleway resources (the Project itself
//     already exists from step 2, CONTRACT.md: one Project per app): a
//     Container Registry namespace, a Serverless Containers namespace.
//   25. dockerBuildPush starts the Docker daemon if needed (ensureDocker()),
//     then builds and pushes the image directly (scripts/_docker-build.mjs)
//     tagged with the commit SHA - the same tag format the removed GitHub
//     Actions workflow used (`${{ github.sha }}`, templates/deploy/build.yml,
//     now deleted).
//   26. scwContainer creates the Serverless Container (scale preset S:
//     250mvCPU/512MB/maxConcurrency 8, min_scale 0, max_scale 5, port 8080 -
//     see SCALE_PRESETS.S in scripts/scaleway/container.mjs) pointed at THAT
//     real, already-pushed tag and waits for it to become ready: Scaleway
//     validates the registry image at container-creation time, so a
//     placeholder tag that does not exist yet is rejected outright
//     (verified on a live run - see scwContainer()'s comment, and
//     CONTRACT.md §1). dockerBuildPush therefore always runs before this step.
//   27. smokeTest fetches the container's URL from the operator's machine
//     (on the VPN, so it passes the IP gate) and asserts both HTTP 200 AND
//     that the linked stylesheet actually loads - a naive 200-check misses
//     the copy-assets.js / Geist regressions documented in
//     templates/deploy/README.md. On a Claude Code web sandbox
//     (isRemoteSandbox()), a 403 is the EXPECTED outcome (the gate is up,
//     the sandbox is not allowlisted) - see that function's comment.
//
// After a successful run, control returns to the caller (typically Claude via
// /bootstrap) for the cahier-des-charges conversation, addon invocations
// (add-db, add-auth, add-email, add-storage, add-analytics, add-map), and the
// application build.
//
// Usage (run from the repo root - the checkout the app already lives in):
//   node bootstrap-init.mjs --description "Short SEO description, ~150 chars" \
//     [--name deploy-name-override] [--locale fr_FR] [--skip-deploy]
//
// --name overrides only the Scaleway resource name (Project/registry
// namespace/container namespace/container); by default that name is the repo
// name itself (deriveAppName()). Use it when the repo name is not kebab-case.
//
// Idempotency: NOT idempotent. It's a one-shot from an empty checkout to
// deployed. If any step fails, the partial state is left on disk (and
// possibly partially provisioned on Scaleway) for inspection; fix the cause
// and have Claude continue from where it died.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, rmdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./_render.mjs";
import { isRemoteSandbox } from "./_platform.mjs";
import { ensureDocker } from "./ensure-dockerd.mjs";
import { buildAndPushImage } from "./_docker-build.mjs";
import { requireCredentials, readScwMode, deriveAppName, cacheProjectId, api, sdkCall, slugify, ScwError } from "./scaleway/_scw-auth.mjs";
import { ensureRegistryNamespace } from "./scaleway/registry.mjs";
import { SCALE_PRESETS, ensureNamespace, findContainerByName, createContainer, updateContainer, syncContainerSecrets, waitForContainerReady } from "./scaleway/container.mjs";
import { getSecret, putSecret, listSecrets } from "./scaleway/secrets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
// Pure CLI-usage errors (bad/missing flags) use this lightweight exit instead
// of the real fail() defined in the "helpers" section below: fail() drives
// dumpHandoff(), which reports against STEPS/PROJECT_DIR/completed - none of
// which exist yet this early, so calling it here would throw a confusing
// "Cannot access 'STEPS' before initialization" instead of the usage message.
function usageError(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

/** 8-4-4-4-12 hex, case-insensitive - the shape of every Scaleway id. */
function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

const args = process.argv.slice(2);
let nameOverride = "";
let description = "";
let locale = "fr_FR";
// --private/--public are accepted (kept as no-ops) rather than rejected: the
// repo already exists (in-place bootstrap, CONTRACT.md §7), so there is no
// repo-creation step left to apply them to. Kept out of usageError's
// unknown-arg rejection purely so an unchanged caller still passing this flag
// does not crash on an "Unknown arg" error before the SKILL that calls this
// script catches up with the new model.
let skipDeploy = false;
let scwProjectIdArg = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) nameOverride = args[++i];
  else if (a === "--description" && args[i + 1]) description = args[++i];
  else if (a === "--locale" && args[i + 1]) locale = args[++i];
  else if (a === "--private" || a === "--public") continue;
  else if (a === "--skip-deploy") skipDeploy = true;
  else if (a === "--scw-project-id" && args[i + 1]) scwProjectIdArg = args[++i];
  else usageError(`Unknown arg: ${a}`);
}

if (!description) {
  usageError(
    'Usage: node bootstrap-init.mjs --description "DESC" ' +
      "[--name deploy-name-override] [--locale fr_FR] [--skip-deploy] [--scw-project-id <uuid>]",
  );
}

const KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
if (nameOverride && !KEBAB_RE.test(nameOverride)) {
  usageError(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${nameOverride}`);
}
if (scwProjectIdArg && !isUuid(scwProjectIdArg)) {
  usageError(`--scw-project-id must be a UUID. Got: ${scwProjectIdArg}`);
}

// App name: the repo name itself (deriveAppName - CONTRACT.md §2, a
// Project's name is always the app name, which is always the repo name),
// unless --name overrides the SCALEWAY RESOURCE name only (the git repo
// keeps its own name either way - there is no repo-creation step left that
// could rename it). Validated kebab-case exactly like before; when the repo
// name itself is not kebab-case, --name is required.
const appName = deriveAppName();
if (!nameOverride && !KEBAB_RE.test(appName)) {
  usageError(
    `The repo name "${appName}" is not kebab-case (lowercase a-z, 0-9, -), 2-50 chars. ` +
      "Pass --name <deploy-name> to choose a different name for the Scaleway resources.",
  );
}
const name = nameOverride || appName;

// Resolved once, early - before any local file changes, so this reads the
// operator-level BAUDRIER_SCW_MODE env var (CONTRACT.md §1, §2), never a
// stale value. scwProject() and the linkage step (scwContainer()) both
// depend on it.
const scwMode = readScwMode();

// In-place only (CONTRACT.md §7): the repo pre-exists, and this script
// scaffolds into the checkout it is run from - there is no sibling-directory
// mode left.
const CWD = process.cwd();
const PROJECT_DIR = CWD;

// ─── helpers ──────────────────────────────────────────────────────────
// Step tracking - used to print a structured handoff if/when we fail, so a
// downstream agent (Claude Code) can pick up cleanly without re-reading the
// whole log. `STEPS` is the full ordered pipeline; `current` is what's running.
const STEPS = [
  "preflight",
  "scwProject",
  "scaffoldT3",
  "gitattributes",
  "bumpDrizzle",
  "cleanupDemo",
  "eslintCli",
  "healthcheck",
  "shadcn",
  "security",
  "seo",
  "imagePlaceholders",
  "notFoundPage",
  "dockerfile",
  "nextConfigStandalone",
  "copyAssets",
  "accessProxy",
  "claudeMdCore",
  "privacyPolicy",
  "cleanupWorkflow",
  "commit",
  "pushToOrigin",
  "scwRegistryNamespace",
  "scwContainerNamespace",
  "dockerBuildPush",
  "scwContainer",
  "smokeTest",
];
const completed = [];
const warnings = [];
let current = null;

async function step(name, fn) {
  current = name;
  await fn();
  completed.push(name);
  current = null;
}

function log(msg) {
  console.log(`\n▸ ${msg}`);
}
function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
  warnings.push(msg);
}

// Sanity check after a regex-based file modification. Prints a warning if the
// edit didn't actually take effect - typically because T3 changed the file
// structure since this script was written. Doesn't abort: the direct
// build/push (dockerBuildPush) is the real gate.
function expect(file, predicate, label) {
  try {
    const content = readFileSync(file, "utf8");
    if (!predicate(content)) {
      warn(`Sanity check failed in ${file}: ${label}. T3 scaffold may have drifted - verify manually after the run.`);
    }
  } catch (e) {
    warn(`Could not read ${file} for sanity check (${label}): ${e.message}`);
  }
}

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("Bootstrap-init handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) during the run:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }
  if (!success) {
    console.log(
      "\nFor the agent picking this up:\n" +
        `  - Project dir on disk: ${PROJECT_DIR}\n` +
        "  - The failure is above the handoff banner. Read the actual error there.\n" +
        "  - Continue manually from the failing step using the SKILL.md as reference -\n" +
        "    the repo already existed before this run (in-place bootstrap), so there is\n" +
        "    no fresh directory to retry into.\n" +
        "  - Each step in this script maps 1:1 to a section of the bootstrap SKILL.md.\n" +
        "  - scwProject runs right after preflight, before any local file changes. A\n" +
        "    failure there (most often a 403 needing ProjectManager) leaves nothing on\n" +
        "    disk - re-run with --scw-project-id and the run starts clean.\n" +
        "  - A failure at any later step may leave local files on disk AND partial\n" +
        "    Scaleway resources behind (a Project, a registry namespace, a container\n" +
        "    namespace, a container) - the Scaleway side is safe to re-run: every\n" +
        "    scripts/scaleway/ helper used here is find-or-create / idempotent-PATCH.\n",
    );
  }
  console.log("────────────────────────────────────────────────────────");
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  dumpHandoff(false);
  process.exit(1);
}

// Catch unhandled exceptions so they ALSO produce the handoff banner.
process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e.stack) console.error(e.stack);
  dumpHandoff(false);
  process.exit(1);
});

// Build-approval flags - version-aware.
//
// pnpm 10: `pnpm.onlyBuiltDependencies` in package.json is honored. Passing
//   --config.dangerously-allow-all-builds=true alongside it causes
//   ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES ("Cannot have both
//   neverBuiltDependencies and onlyBuiltDependencies") because pnpm 10
//   internally maps that flag to a neverBuiltDependencies override. No extra
//   CLI flags needed - the onlyBuiltDependencies list we write into package.json
//   (T3 already seeds it, we extend it) is sufficient.
//
// pnpm 11: `pnpm.onlyBuiltDependencies` is silently IGNORED. strictDepBuilds
//   defaults to true → any unapproved postinstall → ERR_PNPM_IGNORED_BUILDS.
//   CLI flags are the only reliable fix. Both flags are required:
//     --config.strict-dep-builds=false  → downgrade error to warning
//     --config.dangerously-allow-all-builds=true → actually run native builds
//   NPM_CONFIG_* env vars are NOT honored by pnpm 11 for these settings.
//
// PNPM_BUILD_FLAGS is set to the right value at the end of preflight(), once
// we know the actual pnpm major version.
let PNPM_BUILD_FLAGS = "";

function run(cmd, cwd, opts = {}) {
  const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
  const res = spawnSync(cmdStr, {
    cwd,
    stdio: opts.capture ? "pipe" : "inherit",
    shell: true,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  if (res.status !== 0 && !opts.allowFail) {
    if (opts.capture) {
      if (res.stdout) process.stderr.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    fail(`Command failed (exit ${res.status}): ${cmdStr}`);
  }
  return res;
}

function capture(cmd, cwd, opts = {}) {
  return run(cmd, cwd, { capture: true, allowFail: true, ...opts });
}

// Resolve {owner, repo} from the project's `origin` remote. Used by the git
// identity fallback (web) and the final banner - never talks to any GitHub
// API, only parses the remote URL git itself already knows (gh is no longer
// part of the toolchain, CONTRACT.md §7).
function getGhOwnerRepo() {
  const remote = capture("git remote get-url origin", PROJECT_DIR).stdout?.trim() || "";
  // Charsets are GitHub's own (owner: alphanumeric + "-"; repo adds "._").
  // The owner lands inside a shell-quoted `git config` call, so the tight
  // charset is what makes that interpolation safe.
  const m = remote.match(/github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (!m) fail("Could not parse the GitHub owner/repo from the origin remote.");
  return { owner: m[1], repo: m[2] };
}

// ─── Step 1: preflight ────────────────────────────────────────────────
function preflight() {
  log("Preflight");

  // In-place only (CONTRACT.md §7): the repo pre-exists, so this run must be
  // happening AT the repo's own root - not a parent directory (the old
  // sibling-directory mode, removed) and not a subdirectory of it. git always
  // prints the toplevel with forward slashes, even on Windows, so normalize
  // both sides the same way before comparing.
  const normalizeSlashes = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const top = capture("git rev-parse --show-toplevel", CWD);
  if (top.status !== 0 || normalizeSlashes(top.stdout.trim()) !== normalizeSlashes(CWD)) {
    fail(
      `${CWD} is not the root of a git repository. /bootstrap scaffolds in place: the app's repo already ` +
        "exists (created from the GitHub template, or already cloned) - run this from that checkout's top level.",
    );
  }

  for (const tool of ["pnpm", "git", "node", "npx"]) {
    const c = capture(`${tool} --version`, CWD);
    if (c.status !== 0) fail(`CLI missing or broken: ${tool}. Install it and retry.`);
  }

  // Repo-access gate (CONTRACT.md §7): `git ls-remote origin`, never a
  // `gh`-based auth check - the shell git credential's own status command is
  // unreliable on Claude Code web (it exits non-zero even when it works,
  // live-verified) and `gh` is no longer part of the toolchain at all.
  const remoteUrl = capture("git remote get-url origin", CWD).stdout?.trim();
  if (!remoteUrl) {
    fail("No `origin` remote is configured. The app's repo already exists on GitHub - add it as `origin` and retry.");
  }
  const lsRemote = capture("git ls-remote origin", CWD);
  if (lsRemote.status !== 0) {
    fail(
      `"git ls-remote origin" failed: ${(lsRemote.stderr || lsRemote.stdout || "").trim()}. ` +
        "Check the repo's access and this machine's git credentials.",
    );
  }

  // No prior scaffold (CONTRACT.md §7's in-place invariant): a fresh checkout
  // has neither yet.
  if (existsSync(join(PROJECT_DIR, "package.json")) || existsSync(join(PROJECT_DIR, "src"))) {
    fail(`${PROJECT_DIR} already looks scaffolded (package.json or src/ exists). /bootstrap only runs once, in a fresh checkout.`);
  }

  // Scaleway credentials: SCW_ACCESS_KEY / SCW_SECRET_KEY env vars, the only
  // source (CONTRACT.md §2) - see scripts/scaleway/_scw-auth.mjs. `scw` has no
  // OAuth/device-code login (CONTRACT.md §1) so there is no CLI "logged in?"
  // check to run here; requireCredentials() throws a friendly, actionable
  // message if nothing is configured.
  try {
    const creds = requireCredentials();
    if (!creds.organizationId) {
      fail(
        "SCW_DEFAULT_ORGANIZATION_ID is not set. scwProject (creating a dedicated " +
          "Scaleway Project for this app) needs it. Set it alongside SCW_ACCESS_KEY / SCW_SECRET_KEY.",
      );
    }
  } catch (e) {
    fail(e.message);
  }

  // Git identity: off web, an unconfigured identity is a hard failure exactly
  // like before. On a Claude Code web sandbox (isRemoteSandbox()), there is no
  // human to have configured one - set it from the origin remote's owner
  // instead (CONTRACT.md §7) and warn, rather than failing the whole run.
  const identityStatus = {
    "user.name": capture("git config --global user.name", CWD).stdout?.trim(),
    "user.email": capture("git config --global user.email", CWD).stdout?.trim(),
  };
  const missingIdentity = Object.entries(identityStatus)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missingIdentity.length) {
    if (isRemoteSandbox()) {
      const { owner } = getGhOwnerRepo();
      if (!identityStatus["user.name"]) {
        const r = spawnSync("git", ["config", "--global", "user.name", owner], { cwd: CWD, encoding: "utf8" });
        if (r.status !== 0) fail(`git config user.name failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
      if (!identityStatus["user.email"]) {
        const r = spawnSync("git", ["config", "--global", "user.email", `${owner}@users.noreply.github.com`], { cwd: CWD, encoding: "utf8" });
        if (r.status !== 0) fail(`git config user.email failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
      warn(`git identity was not configured (${missingIdentity.join(", ")}) - set from the origin remote owner "${owner}".`);
    } else {
      fail(`git config --global ${missingIdentity.join(" / ")} is not set. Configure it and retry.`);
    }
  }

  // Detect pnpm major version and set build flags accordingly (see comment above).
  // pnpm 11+ is required by the bootstrap for two reasons:
  //   - the final dependency audit (SKILL Étape 8a) runs `pnpm audit`, which only
  //     works on pnpm 11+; pnpm 10 hits the deprecated /audits/quick endpoint (410)
  //   - the CLI build flags below (strict-dep-builds / dangerously-allow-all-builds)
  //     exist on pnpm 11+.
  // If an older major is found, try a one-shot self-update (non-fatal).
  let pnpmVersion = capture("pnpm --version", CWD).stdout.trim();
  let pnpmMajor = parseInt(pnpmVersion.split(".")[0] ?? "0", 10);
  if (pnpmMajor < 11) {
    console.log(`  → pnpm ${pnpmVersion || "unknown"} (<11): updating to the latest…`);
    run("pnpm self-update", CWD, { allowFail: true });
    pnpmVersion = capture("pnpm --version", CWD).stdout.trim();
    pnpmMajor = parseInt(pnpmVersion.split(".")[0] ?? "0", 10);
    if (pnpmMajor >= 11) {
      console.log(`  → pnpm updated to ${pnpmVersion}`);
    } else {
      warn(
        `pnpm is ${pnpmVersion || "unknown"} (<11) and the auto-update didn't land. ` +
          "Update it manually (`pnpm self-update`, or `npm i -g pnpm@latest`) - " +
          "the final dependency audit (`pnpm audit`) needs pnpm 11+ to work.",
      );
    }
  }
  if (pnpmMajor >= 11) {
    PNPM_BUILD_FLAGS = "--config.strict-dep-builds=false --config.dangerously-allow-all-builds=true";
    console.log(`  → pnpm ${pnpmVersion} (≥11): using CLI build flags`);
  } else {
    PNPM_BUILD_FLAGS = "";
    console.log(`  → pnpm ${pnpmVersion} (<11): onlyBuiltDependencies in package.json is sufficient`);
  }

  ok("All prerequisites OK");
}

// ─── Step 2: dedicated Scaleway Project ────────────────────────────────
// Runs immediately after preflight, before scaffoldT3 writes a single local
// file - CONTRACT.md: one Scaleway Project per app (so a Secret Manager
// secret's name IS the env var name, no cross-app collisions). There is no
// scripts/scaleway/ module wrapping the Account/Projects API, so this talks
// to the SDK directly: `@scaleway/sdk`'s `Account.v3` namespace exposes
// Projects as `ProjectAPI` (not the default "API" class - see api()'s third
// argument below), with `listProjects`/`createProject` mirroring the
// find-or-create pattern every other scripts/scaleway/* namespace helper
// uses (see e.g. registry.mjs#ensureRegistryNamespace). The Account API is
// Organization-scoped, not region-scoped, so no `region` field is passed.
//
// WHY THIS RUNS FIRST: on a live run, an operator key without ProjectManager
// failed here (`scaleway-sdk-go: insufficient permissions: write project`)
// only after scaffoldT3 + pnpm install had already spent ~5 minutes building
// the local project directory, with no idempotent way to recover short of
// deleting the directory and starting over. check-scw-permissions.mjs cannot
// replace this step: it is a denial-only probe by design, so a clean read
// proves an absent right but never proves the create right is present.
// Running the real find-or-create here both proves the right and does the
// required work. On a 403, the needs_admin error below (recipe "project")
// now stops the run before a single local file exists, so the operator
// re-runs /bootstrap with --scw-project-id and the run starts clean.
let scwProjectId = null;

// A 403 here means the operator's key lacks ProjectManager - mapped onto
// needs_admin so /bootstrap can hand the user a forwardable French request
// instead of dying on a raw SDK error.
function needsAdminProjectError(e, slug) {
  if (e?.status !== 403) return e;
  return new ScwError(
    "Votre clé Scaleway n’a pas les droits nécessaires pour créer un projet. " +
      `Demandez à l’administrateur de créer un projet Scaleway nommé « ${slug} », de vous accorder les droits ` +
      "de service nécessaires sur ce projet (voir docs/ADMIN-SCALEWAY.md, recette « projet »), puis de vous " +
      "communiquer l’identifiant du projet. Relancez ensuite /bootstrap avec --scw-project-id et cet identifiant.",
    { type: "needs_admin", details: { recipe: "project", projectName: slug } },
  );
}

// poc mode never calls createProject (CONTRACT.md §1) - mirrors
// needsAdminProjectError's shape so /bootstrap's SKILL can catch it the same
// way.
function needsProjectIdError() {
  return new ScwError(
    "Le mode PoC est actif : Baudrier ne peut pas créer de projet Scaleway lui-même, il a besoin de l’identifiant " +
      "d’un projet existant pour cette application. Utilisez le projet que votre administrateur a préparé pour " +
      "elle, ou votre propre projet par défaut pour un premier essai, puis relancez /bootstrap avec " +
      "--scw-project-id et cet identifiant.",
    { type: "poc_needs_project_id" },
  );
}

// A second app reusing one Project would collide two apps' secrets under
// CONTRACT.md §2's name-equals-var invariant (Secret Manager naming) - this
// is the one place left to catch that once scwProject() skips its own
// find-or-create (poc mode, or a --scw-project-id retry after a full-mode
// 403).
async function refuseIfProjectAlreadyUsed(projectId) {
  const KNOWN_NAMES = new Set(["DATABASE_URL", "AUTH_SECRET", "ACCESS_RESTRICTED", "APP_URL"]);
  const existing = await listSecrets({ projectId });
  const hit = existing.find((s) => KNOWN_NAMES.has(s.name) || s.name.startsWith("BAUDRIER_"));
  if (!hit) return;
  throw new ScwError(
    `Ce projet Scaleway contient déjà un secret d’une autre application Baudrier (« ${hit.name} »). ` +
      "Chaque application doit avoir son propre projet Scaleway : partager un projet entre deux applications " +
      "casserait la correspondance entre le nom d’un secret et sa variable d’environnement. Indiquez l’identifiant " +
      "d’un autre projet, ou demandez-en un nouveau à votre administrateur.",
    { type: "project_already_used", details: { projectId, secretName: hit.name } },
  );
}

async function scwProject() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping Scaleway provisioning (scwProject).");
    return;
  }
  const slug = slugify(name);
  if (scwMode === "poc") {
    if (!scwProjectIdArg) throw needsProjectIdError();
    await refuseIfProjectAlreadyUsed(scwProjectIdArg);
    scwProjectId = scwProjectIdArg;
    cacheProjectId(slug, scwProjectId);
    ok(`Using the PoC Scaleway Project (${scwProjectId})`);
    return;
  }
  if (scwProjectIdArg) {
    await refuseIfProjectAlreadyUsed(scwProjectIdArg);
    scwProjectId = scwProjectIdArg;
    cacheProjectId(slug, scwProjectId);
    ok(`Using the admin-provided Scaleway Project (${scwProjectId})`);
    return;
  }
  log(`Creating dedicated Scaleway Project "${name}"`);
  const creds = requireCredentials();

  const projects = await api("Account", "v3", "ProjectAPI");
  let existing;
  try {
    existing = await sdkCall(() =>
      projects.listProjects({ organizationId: creds.organizationId, name: slug }).all(),
    );
  } catch (e) {
    throw needsAdminProjectError(e, slug);
  }
  const hit = existing.find((p) => p.name === slug);
  if (hit) {
    scwProjectId = hit.id;
    cacheProjectId(slug, scwProjectId);
    ok(`Reusing existing Scaleway Project "${slug}" (${scwProjectId})`);
    return;
  }

  let created;
  try {
    created = await sdkCall(() =>
      projects.createProject({
        name: slug,
        organizationId: creds.organizationId,
        description: description.slice(0, 200),
      }),
    );
  } catch (e) {
    throw needsAdminProjectError(e, slug);
  }
  scwProjectId = created.id;
  // Written here, not only left to resolveProjectId()'s own lazy lookup, so
  // deploy.mjs and every scripts/scaleway/*.mjs consumer resolves this app's
  // Project instantly for the rest of this session (CONTRACT.md §2, §7's
  // session-scoped /tmp cache).
  cacheProjectId(slug, scwProjectId);
  ok(`Scaleway Project "${slug}" created (${scwProjectId})`);
}

// create-t3-app still emits the Next 15 dependency set. This map overrides
// the versions in package.json before `pnpm install`, so the scaffold lands
// on the Next 16 / zod 4 baseline instead. Two holdbacks stay below latest:
//   - typescript stays ^5.9: typescript-eslint's peer range is
//     ">=4.8.4 <6.1.0" (refuses TS 7).
//   - eslint stays ^9: eslint-config-next's parser path crashes under
//     eslint 10 (verified live). eslint-config-next declares no peer
//     ceiling, so pnpm gives no warning if this hold is dropped - re-verify
//     live before raising it.
const NEXT16_VERSIONS = {
  dependencies: {
    next: "^16.0.0",
    zod: "^4.0.0",
    "@t3-oss/env-nextjs": "^0.13.0",
  },
  devDependencies: {
    "@types/node": "^24.0.0",
    typescript: "^5.9.0",
    eslint: "^9.0.0",
    "eslint-config-next": "^16.0.0",
  },
};

/** Overwrites each pinned dependency in NEXT16_VERSIONS onto `pkg`, only
 * when the key already exists (create-t3-app owns whether a dep is present
 * at all). Warns, does not fail, when a key is missing - a sign create-t3-app
 * changed its output shape. */
function applyNext16VersionOverrides(pkg) {
  for (const [field, deps] of Object.entries(NEXT16_VERSIONS)) {
    for (const [dep, version] of Object.entries(deps)) {
      if (pkg[field]?.[dep] === undefined) {
        warn(`applyNext16VersionOverrides: ${field}.${dep} not found in package.json - create-t3-app may have changed its scaffold shape. Add it manually if the app needs it.`);
        continue;
      }
      pkg[field][dep] = version;
    }
  }
}

// ─── Step 3: scaffold T3 ──────────────────────────────────────────────
// We go through `npx create-t3-app` rather than `pnpm create t3-app` because
// pnpm 10 is strict: `pnpm create/dlx/exec` errors out with
// ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND when cwd has no package.json - which
// is always the case right before scaffolding a brand-new project.
// npx has no such constraint. After scaffold, we wipe the npm-generated
// lockfile + node_modules and re-install with pnpm so the rest of the
// pipeline (shadcn, drizzle, etc.) runs on a clean pnpm install.
// Moves every entry (including dotfiles) from `scratchDir` up into
// `targetDir`. `.gitignore` is MERGED (append whatever line the scaffold adds
// that the repo doesn't already have) rather than overwritten - the repo may
// already carry its own (from the GitHub template). The repo's own
// `README.md` is KEPT and the scaffold's is dropped, for the same reason.
// Any other name collision is a fail(): silently overwriting a file the repo
// already had would be worse than stopping to ask.
function moveScaffoldIntoPlace(scratchDir, targetDir) {
  for (const entry of readdirSync(scratchDir, { withFileTypes: true })) {
    const src = join(scratchDir, entry.name);
    const dest = join(targetDir, entry.name);

    if (entry.name === ".gitignore" && existsSync(dest)) {
      const existingLines = new Set(
        readFileSync(dest, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      );
      const incoming = readFileSync(src, "utf8").split(/\r?\n/);
      const toAppend = incoming.filter((l) => l.trim() && !existingLines.has(l.trim()));
      if (toAppend.length) {
        const existing = readFileSync(dest, "utf8");
        const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
        writeFileSync(dest, existing + sep + toAppend.join("\n") + "\n");
      }
      continue;
    }
    if (entry.name === "README.md" && existsSync(dest)) {
      continue; // keep the repo's own README, drop the scaffold's
    }
    if (existsSync(dest)) {
      fail(
        `Scaffold conflict: "${entry.name}" already exists in ${targetDir} and is neither .gitignore nor ` +
          "README.md (both of those are merged/kept automatically). Resolve the conflict manually and retry.",
      );
    }
    renameSync(src, dest);
  }
  rmSync(scratchDir, { recursive: true, force: true });
}

function scaffoldT3() {
  // We pass `--noInstall --noGit` to create-t3-app so it just writes the files:
  // no `npm install` (we'll do pnpm install ourselves), no `git init + git add`
  // (the repo already exists - see gitattributes() below). This avoids the
  // fragile npm→pnpm conversion + git index reconciliation dance that
  // previously lived in scaffoldT3 + gitattributes.
  //
  // create-t3-app writes into a directory named after its positional arg, and
  // that directory must not already exist - so it cannot target PROJECT_DIR
  // directly (the repo checkout, which already has .git/, possibly a
  // README.md, etc.). Scaffold under a scratch directory INSIDE PROJECT_DIR
  // instead, then move its contents up (moveScaffoldIntoPlace, above).
  const scratchName = `baudrier-scratch-${process.pid}-${Date.now()}`;
  const scratchDir = join(PROJECT_DIR, scratchName);
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });

  log(`Scaffolding T3 app via npx (--noInstall --noGit) into a scratch dir`);
  run(
    `npx --yes create-t3-app@latest ${scratchName} --CI --noInstall --noGit --tailwind --trpc --drizzle --appRouter --eslint --dbProvider postgres`,
    PROJECT_DIR,
  );
  if (!existsSync(scratchDir)) fail("T3 scaffold did not create the expected scratch directory.");

  log(`Moving the scaffold into ${PROJECT_DIR} (merging .gitignore, keeping the existing README.md)`);
  moveScaffoldIntoPlace(scratchDir, PROJECT_DIR);

  // Patch package.json to make pnpm happy from the start:
  //   1. Strip `"packageManager": "npm@..."` so pnpm refuses to use npm.
  //   2. Whitelist all packages with native build scripts in `pnpm.onlyBuiltDependencies`
  //      (pnpm ≤10 mechanism - kept for backwards compat). pnpm treats ignored builds as
  //      a HARD ERROR (ERR_PNPM_IGNORED_BUILDS). We include the full T3-stack set:
  //      sharp (image), esbuild (transpiler), @tailwindcss/oxide (Tailwind 4 native),
  //      @swc/core (Next.js), @parcel/watcher (file watching), plus common transitive deps.
  log("Patching package.json for pnpm (strip packageManager, whitelist native-build deps)");
  const pkgPath = join(PROJECT_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // create-t3-app named the package after the scratch directory it scaffolded
  // into (moveScaffoldIntoPlace() above) - fix it to the app's real name now
  // that the files live at PROJECT_DIR.
  pkg.name = slugify(name);
  if (pkg.packageManager && pkg.packageManager.startsWith("npm")) {
    delete pkg.packageManager;
  }
  // T3 scaffolds "dev": "next dev --turbo". Turbopack (Next 16's default
  // engine) PANICS in this environment at BOTH `next dev` and `next build` -
  // verified live. The rewrite below covers every script, not only `dev`:
  // it also catches `build` (and `preview`, which chains `next build`) - the
  // Dockerfile's `RUN pnpm build` resolves through scripts.build, so a
  // dev-only fix would still panic in the image. Proven on a real Next
  // 16.2.12 scaffold: resulting scripts read
  // "dev": "next dev --webpack", "build": "next build --webpack",
  // "preview": "next build --webpack && next start". Do NOT restore
  // Turbopack without a live re-verification.
  for (const [key, val] of Object.entries(pkg.scripts ?? {})) {
    if (typeof val !== "string") continue;
    pkg.scripts[key] = val.replace(
      /\bnext (dev|build)\b(?:\s+--turbo\b)?(?:\s+--webpack\b)?/g,
      "next $1 --webpack",
    );
  }
  // create-t3-app still emits the Next 15 dependency set - apply the Next 16
  // baseline before `pnpm install` resolves anything (NEXT16_VERSIONS above).
  applyNext16VersionOverrides(pkg);
  // pnpm >= 11 never reads `pnpm.onlyBuiltDependencies` from package.json
  // (pnpm-workspace.yaml's `allowBuilds:`, written in shadcn() below, is the
  // real mechanism there) and WARNS on every command while the dead key is
  // still present - verified on a live run (pnpm 11.18.0): "The pnpm field
  // in package.json is no longer read by pnpm." Only pnpm <= 10 still reads
  // this field, so write it there only - PNPM_BUILD_FLAGS is already "" on
  // that path (see preflight() above).
  if (PNPM_BUILD_FLAGS) {
    delete pkg.pnpm;
  } else {
    pkg.pnpm ??= {};
    const existing = new Set(pkg.pnpm.onlyBuiltDependencies ?? []);
    const NATIVE_BUILD_DEPS = [
      "sharp",
      "esbuild",
      "@tailwindcss/oxide",
      "@swc/core",
      "@parcel/watcher",
      "bufferutil",
      "utf-8-validate",
      "better-sqlite3",
      "core-js",
      "core-js-pure",
    ];
    for (const dep of NATIVE_BUILD_DEPS) existing.add(dep);
    pkg.pnpm.onlyBuiltDependencies = [...existing].sort();
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // pnpm 11 changed the build-script approval mechanism in two breaking ways:
  //   a) `pnpm.onlyBuiltDependencies` in package.json is silently IGNORED
  //      (replaced by `allowBuilds:` in pnpm-workspace.yaml).
  //   b) `strictDepBuilds` defaults to `true`, so any unapproved postinstall
  //      script → ERR_PNPM_IGNORED_BUILDS → exit 1.
  // The pnpm-workspace.yaml with allowBuilds entries is generated BY `pnpm install`
  // itself (not by `create-t3-app --noInstall`), so we can't pre-patch it.
  // PNPM_BUILD_FLAGS is already set by preflight() based on pnpm major version.
  // pnpm ≥11: CLI flags needed (onlyBuiltDependencies ignored). pnpm ≤10: empty
  // (onlyBuiltDependencies in package.json is sufficient; the CLI flags would
  // conflict with it and cause ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES).
  const installLabel = PNPM_BUILD_FLAGS ? `with flags: ${PNPM_BUILD_FLAGS}` : "no extra flags (pnpm ≤10, onlyBuiltDependencies in package.json)";
  log(`Installing with pnpm (${installLabel})`);
  run(`pnpm install${PNPM_BUILD_FLAGS ? ` ${PNPM_BUILD_FLAGS}` : ""}`, PROJECT_DIR);

  // Write a project-local `.npmrc` so the USER's future `pnpm install` /
  // `pnpm add` commands (run without our CLI flags) don't fail. The
  // `strict-dep-builds=false` setting IS honored via .npmrc on pnpm 11 (it
  // downgrades ignored-builds from error to warning). `dangerously-allow-all-builds`
  // is NOT honored via .npmrc on pnpm 11 (empirically tested) but
  // `strict-dep-builds=false` alone is enough to prevent install failure.
  const npmrcPath = join(PROJECT_DIR, ".npmrc");
  writeFileSync(
    npmrcPath,
    "# pnpm 11 defaulted strictDepBuilds to true, which fails install when any\n" +
      "# postinstall script is unapproved. Setting this to false downgrades it to\n" +
      "# a warning so `pnpm add foo` won't break in the middle of development.\n" +
      "strict-dep-builds=false\n",
  );

  // Normalize any pnpm-workspace.yaml that pnpm install may have generated
  // (replace placeholder `set this to true or false` with `true`).
  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  if (existsSync(wsPath)) {
    const ws = readFileSync(wsPath, "utf8");
    const fixed = ws.replace(/:\s*set this to true or false/g, ": true");
    if (fixed !== ws) {
      writeFileSync(wsPath, fixed);
      console.log("  → Normalized pnpm-workspace.yaml allowBuilds (placeholders → true)");
    }
  }

  ok(`T3 scaffold written to ${PROJECT_DIR} (pnpm-managed, native builds approved)`);
}

// ─── Step 4: .gitattributes + stage ─────────────────────────────────
// The repo already exists (in-place bootstrap, CONTRACT.md §7) - there is no
// `git init` left to do here, only writing .gitattributes and staging
// everything the scaffold + move just wrote.
function gitattributes() {
  log("Writing .gitattributes");
  const content = [
    "# Normalize line endings - force LF everywhere.",
    "* text=auto eol=lf",
    // Explicit, not just covered by the blanket rule above: a CRLF shebang in a
    // shell script produces `exec /entrypoint.sh: no such file or directory`
    // while the file visibly exists on disk (CONTRACT.md §7, cross-platform
    // rules). Any .sh a future add-* skill writes (or COPYs into a Dockerfile)
    // inherits this rule from day one, regardless of the author's OS/editor.
    "*.sh text eol=lf",
    "",
  ].join("\n");
  writeFileSync(join(PROJECT_DIR, ".gitattributes"), content);

  log("Staging (attrs applied from the start)");
  run("git add -A", PROJECT_DIR);
  ok("Scaffold staged with .gitattributes in effect");
}

// ─── Step 5: bump drizzle ─────────────────────────────────────────────
function bumpDrizzle() {
  log("Bumping drizzle-orm + drizzle-kit (SQL injection patch)");
  run(`pnpm add drizzle-orm@latest ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
  run(`pnpm add -D drizzle-kit@latest ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
  ok("drizzle upgraded");
}

// ─── Step 6: cleanup demo ─────────────────────────────────────────────
function cleanupDemo() {
  log("Cleaning up T3 demo files");

  const postRouter = join(PROJECT_DIR, "src/server/api/routers/post.ts");
  if (existsSync(postRouter)) rmSync(postRouter);

  // T3 scaffolds a React component src/app/_components/post.tsx that imports
  // api.post - if left behind, `next build` fails type-check even though the
  // file isn't rendered (the _ prefix only blocks routing, not compilation).
  const postComponent = join(PROJECT_DIR, "src/app/_components/post.tsx");
  if (existsSync(postComponent)) rmSync(postComponent);
  const componentsDir = join(PROJECT_DIR, "src/app/_components");
  if (existsSync(componentsDir) && readdirSync(componentsDir).length === 0) {
    rmdirSync(componentsDir);
  }

  const rootPath = join(PROJECT_DIR, "src/server/api/root.ts");
  if (existsSync(rootPath)) {
    let root = readFileSync(rootPath, "utf8");
    root = root.replace(
      /import\s+\{\s*postRouter\s*\}\s+from\s+["']~\/server\/api\/routers\/post["'];?\s*\r?\n/g,
      "",
    );
    root = root.replace(/\s*post:\s*postRouter,?\s*\r?\n/g, "\n");
    writeFileSync(rootPath, root);
    // If T3 ever renames `postRouter` (e.g. to `demoRouter`), the regexes above
    // silently miss and root.ts keeps a broken import → build failure later.
    // Catch that drift here so the handoff banner flags it.
    expect(
      rootPath,
      (c) => !c.includes("postRouter"),
      "postRouter should be fully stripped from root.ts",
    );
  } else {
    warn(`${rootPath} not found - T3 may have moved the appRouter. Verify manually.`);
  }

  // Replace the T3 demo homepage with a minimal placeholder (template).
  const pagePath = join(PROJECT_DIR, "src/app/page.tsx");
  if (!existsSync(pagePath)) {
    warn(`${pagePath} not found - T3 may have moved the homepage. Skipping placeholder.`);
  } else {
    writeFileSync(pagePath, render("bootstrap/home-page.tsx", { PROJECT_NAME: name }));
  }

  // Remove .env.example. It duplicates what's in src/env.js (zod schema = source
  // of truth) and the CLAUDE.md "Variables d'env requises" section, and drifts
  // out of sync the moment addons add new vars. We don't maintain it - we delete it.
  const envExample = join(PROJECT_DIR, ".env.example");
  if (existsSync(envExample)) rmSync(envExample);

  // Reset src/server/db/schema.ts to a bare-bones placeholder. T3 scaffolds a
  // demo `posts` table and (by default) a `pgTableCreator` table-name-prefix
  // helper meant to let several projects share one Postgres instance. Neither
  // applies here: each app gets its OWN dedicated Scaleway Serverless SQL
  // database (CONTRACT.md §4), so there is no prefix hack to carry forward -
  // tables are declared directly with drizzle-orm/pg-core's `pgTable`.
  // Clearing the file also means the initial `drizzle-kit generate` sees zero
  // tables, so a later replacement with the real app schema is a pure
  // "tables added" diff - never a "table dropped + table added" diff, which
  // triggers drizzle-kit's interactive "is `x` a rename of `y`?" TTY prompt
  // that crashes in Claude Code's non-TTY environment.
  const schemaPath = join(PROJECT_DIR, "src/server/db/schema.ts");
  if (existsSync(schemaPath)) {
    const schemaSrc =
      "// Add tables here with drizzle-orm/pg-core's `pgTable` - e.g.:\n" +
      "//\n" +
      '//   import { pgTable, serial, text } from "drizzle-orm/pg-core";\n' +
      "//\n" +
      '//   export const users = pgTable("users", {\n' +
      '//     id: serial("id").primaryKey(),\n' +
      '//     email: text("email").notNull(),\n' +
      "//   });\n" +
      "//\n" +
      "// No table-name-prefix helper is needed: this app has its own dedicated\n" +
      "// Postgres database (CONTRACT.md §4), unlike setups that share one Postgres\n" +
      "// instance across projects.\n";
    writeFileSync(schemaPath, schemaSrc);
  } else {
    warn(`${schemaPath} not found - T3 may have moved the schema file. Skipping reset.`);
  }

  // T3's drizzle.config.ts keeps a `tablesFilter: ["<project>_*"]` entry for
  // setups that share ONE Postgres instance across several apps. It does not
  // apply here (schema.ts above was just reset WITHOUT the pgTableCreator
  // prefix helper - CONTRACT.md §4, each app has its own database) and
  // actively breaks drizzle-kit if left in: a table declared with a bare
  // `pgTable` name falls OUTSIDE the filter, so drizzle-kit silently never
  // sees it.
  const drizzleConfigPath = join(PROJECT_DIR, "drizzle.config.ts");
  if (existsSync(drizzleConfigPath)) {
    const before = readFileSync(drizzleConfigPath, "utf8");
    const after = before.replace(/^\s*tablesFilter:\s*\[[^\]]*\],?\s*\r?\n/m, "");
    if (after !== before) {
      writeFileSync(drizzleConfigPath, after);
    } else {
      warn(`${drizzleConfigPath}: no tablesFilter line found to strip - verify manually.`);
    }
  } else {
    warn(`${drizzleConfigPath} not found - T3 may have moved drizzle config. Skipping tablesFilter strip.`);
  }

  // Under Next 16 the inline-type import form (`import { type AppRouter }`)
  // still imports the value binding at runtime, dragging the server router's
  // Node-only imports (e.g. `pg`) into this "use client" bundle. A top-level
  // `import type` is erased at compile time instead - verified live.
  const trpcReactPath = join(PROJECT_DIR, "src/trpc/react.tsx");
  if (existsSync(trpcReactPath)) {
    const before = readFileSync(trpcReactPath, "utf8");
    const OLD_IMPORT = 'import { type AppRouter } from "~/server/api/root";';
    const NEW_IMPORT = 'import type { AppRouter } from "~/server/api/root";';
    if (before.includes(OLD_IMPORT)) {
      writeFileSync(trpcReactPath, before.replace(OLD_IMPORT, NEW_IMPORT));
    } else if (!before.includes(NEW_IMPORT)) {
      warn(`${trpcReactPath}: expected AppRouter import not found - T3 may have changed its shape. Verify the import is type-only so the server router does not leak into the client bundle.`);
    }
  } else {
    warn(`${trpcReactPath} not found - T3 may have moved the tRPC client. Verify the AppRouter import is type-only so the server router does not leak into the client bundle.`);
  }

  ok("Demo router + component + homepage + .env.example removed, schema.ts reset, tablesFilter stripped, trpc/react.tsx type-only import fixed");
}

// ─── Step 7: lint scripts → ESLint CLI ───────────────────────────────
// `next lint` is deprecated since Next 15.5 and removed in Next 16, and in
// Next 16 `next build` no longer runs ESLint either - the standalone lint
// script becomes the only lint gate, so it must work. create-next-app ≥15.5
// already emits `eslint`, but create-t3-app may still emit `next lint`.

/** Rewires a FlatCompat-based "next/core-web-vitals" extend to
 * eslint-config-next 16's native flat config. eslint-config-next 16 exports
 * flat configs directly; FlatCompat cannot translate them and crashes
 * eslint 9 with "TypeError: Converting circular structure to JSON" -
 * verified live. Each replacement is tolerant: it applies only the patterns
 * it finds, so a config that already looks different is left alone. */
function patchFlatCompatToNative(content) {
  let patched = content;
  let applied = false;

  const withImport = patched.replace(
    'import { FlatCompat } from "@eslint/eslintrc";',
    'import coreWebVitals from "eslint-config-next/core-web-vitals";',
  );
  if (withImport !== patched) {
    patched = withImport;
    applied = true;
  }

  const withoutCompat = patched.replace(/const compat = new FlatCompat\(\{[\s\S]*?\}\);\n*/, "");
  if (withoutCompat !== patched) {
    patched = withoutCompat;
    applied = true;
  }

  const withSpread = patched.replace('...compat.extends("next/core-web-vitals"),', "...coreWebVitals,");
  if (withSpread !== patched) {
    patched = withSpread;
    applied = true;
  }

  return { content: patched, applied };
}

function eslintCli() {
  log("Normalizing lint scripts to the ESLint CLI (next lint is deprecated)");

  const pkgPath = join(PROJECT_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  let migrated = 0;
  for (const [key, val] of Object.entries(pkg.scripts ?? {})) {
    if (typeof val === "string" && val.includes("next lint")) {
      pkg.scripts[key] = val
        .replace(/next lint --fix/g, "eslint . --fix")
        .replace(/next lint/g, "eslint .");
      migrated++;
    }
  }
  if (migrated > 0) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // The ESLint CLI needs an explicit flat config - unlike `next lint`, it has
  // no implicit Next.js default. Scaffolders normally generate one; this only
  // fires if a future scaffolder version stops doing so.
  const hasFlatConfig = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"]
    .some((f) => existsSync(join(PROJECT_DIR, f)));
  if (!hasFlatConfig) {
    // eslint-config-next 16 exports a native flat config, so this fallback
    // needs no FlatCompat wiring at all (unlike the scaffolder-shipped
    // config patched below).
    writeFileSync(
      join(PROJECT_DIR, "eslint.config.mjs"),
      [
        'import coreWebVitals from "eslint-config-next/core-web-vitals";',
        "",
        "const eslintConfig = [",
        "  ...coreWebVitals,",
        "  {",
        "    ignores: [",
        '      "node_modules/**",',
        '      ".next/**",',
        '      "out/**",',
        '      "build/**",',
        '      "next-env.d.ts",',
        "    ],",
        "  },",
        "];",
        "",
        "export default eslintConfig;",
        "",
      ].join("\n"),
    );
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // Pinned to the Next 16 baseline (NEXT16_VERSIONS) - an unversioned
    // install would pull today's latest eslint (10), which crashes under
    // eslint-config-next's parser path. @eslint/eslintrc is not needed: the
    // template above uses eslint-config-next's native flat config, not
    // FlatCompat.
    const FALLBACK_ESLINT_SPECS = {
      eslint: `eslint@${NEXT16_VERSIONS.devDependencies.eslint}`,
      "eslint-config-next": `eslint-config-next@${NEXT16_VERSIONS.devDependencies["eslint-config-next"]}`,
    };
    const missing = Object.keys(FALLBACK_ESLINT_SPECS).filter((d) => !allDeps[d]);
    if (missing.length > 0) {
      const specs = missing.map((d) => FALLBACK_ESLINT_SPECS[d]);
      run(`pnpm add -D ${specs.join(" ")} ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
    }
    warn("No flat ESLint config found - wrote eslint.config.mjs (next/core-web-vitals). Verify the scaffolder output.");
  } else {
    // The scaffolder shipped a flat config (T3 ships eslint.config.js with
    // `ignores: ['.next']`). Ensure `next-env.d.ts` is also ignored: Next
    // regenerates that file with a `/// <reference ... />` line that the
    // @typescript-eslint/triple-slash-reference rule flags as an ERROR, so
    // `eslint .` (and our `pnpm lint` convention) fails on a file nobody edits.
    const cfgFile = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"]
      .map((f) => join(PROJECT_DIR, f))
      .find((p) => existsSync(p));
    if (cfgFile) {
      let cfg = readFileSync(cfgFile, "utf8");

      // create-t3-app still routes "next/core-web-vitals" through
      // FlatCompat - eslint-config-next 16 ships native flat configs, and
      // that FlatCompat path crashes eslint 9 (see patchFlatCompatToNative).
      const { content: nativeCfg, applied } = patchFlatCompatToNative(cfg);
      if (applied) {
        cfg = nativeCfg;
        writeFileSync(cfgFile, cfg);
        ok(`${cfgFile}: rewired FlatCompat to eslint-config-next's native flat config`);
      } else if (!cfg.includes("eslint-config-next/core-web-vitals")) {
        warn(
          `${cfgFile}: expected FlatCompat wiring not found, and it does not already import ` +
            '"eslint-config-next/core-web-vitals" either - verify eslint runs cleanly ' +
            "(eslint 9 crashes under FlatCompat with eslint-config-next 16).",
        );
      }

      if (!cfg.includes("next-env.d.ts")) {
        // Inject into the first `ignores: [ ... ]` array (the global ignores).
        const patched = cfg.replace(/ignores:\s*\[([^\]]*)\]/, (_m, inner) => {
          const trimmed = inner.trim().replace(/,\s*$/, "");
          return `ignores: [${trimmed ? trimmed + ", " : ""}'next-env.d.ts']`;
        });
        if (patched !== cfg) {
          writeFileSync(cfgFile, patched);
          ok("Added 'next-env.d.ts' to the ESLint ignores (auto-generated file)");
        } else {
          warn(
            "Could not auto-add 'next-env.d.ts' to the ESLint ignores array - " +
              "no `ignores: [...]` found to patch. Add it manually so `pnpm lint` " +
              "doesn't error on the generated file.",
          );
        }
      }
    }
  }

  ok(
    migrated > 0
      ? `${migrated} script(s) migrated from next lint to the ESLint CLI`
      : "lint scripts already on the ESLint CLI - nothing to do",
  );
}

// ─── Step 8: healthcheck router ───────────────────────────────────────
function healthcheck() {
  log("Injecting healthcheck router");

  const routerDir = join(PROJECT_DIR, "src/server/api/routers");
  mkdirSync(routerDir, { recursive: true });

  writeFileSync(
    join(routerDir, "healthcheck.ts"),
    `import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const healthcheckRouter = createTRPCRouter({
  ping: publicProcedure.query(() => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  })),
});
`,
  );

  const rootPath = join(PROJECT_DIR, "src/server/api/root.ts");
  let root = readFileSync(rootPath, "utf8");

  if (!root.includes("healthcheckRouter")) {
    const importLine = `import { healthcheckRouter } from "~/server/api/routers/healthcheck";\n`;
    const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
    if (lastImport) {
      root = root.replace(lastImport[0], lastImport[0] + importLine);
    } else {
      root = importLine + root;
    }
    root = root.replace(
      /createTRPCRouter\(\s*\{/,
      `createTRPCRouter({\n  healthcheck: healthcheckRouter,`,
    );
    writeFileSync(rootPath, root);
  }

  // T3 ships a JSDoc block at the bottom of root.ts that references
  // `trpc.post.all()` - a method we just removed along with the demo router.
  // Strip the misleading example so new Claude sessions don't start from broken docs.
  {
    let updated = readFileSync(rootPath, "utf8");
    updated = updated.replace(
      /\/\*\*\n(?:\s*\*.*\n)*?\s*\*\s*const res = await trpc\.post\.all\(\);[\s\S]*?\*\/\n/,
      "/**\n * Create a server-side caller for the tRPC API.\n */\n",
    );
    writeFileSync(rootPath, updated);
  }

  // The IP gate (proxy.ts, CONTRACT.md §6) exempts only the plain
  // /api/healthz route below, with an EXACT pathname match - a tRPC prefix
  // exemption was a batching bypass (healthcheck.ping,admin.x?batch=1). The
  // keep-warm Job (setup-cron-worker.mjs) pings /api/healthz for the same
  // reason. If this route ever moves, proxy.ts must move with it.
  const healthzDir = join(PROJECT_DIR, "src/app/api/healthz");
  mkdirSync(healthzDir, { recursive: true });
  writeFileSync(join(healthzDir, "route.ts"), render("deploy/healthz-route.ts", {}));

  ok("Healthcheck wired: tRPC router (internal) + /api/healthz route (gate-exempt) + stale JSDoc stripped");
}

// ─── Step 9: shadcn + LinkButton ──────────────────────────────────────
// Run an `npx shadcn` command. shadcn invokes `pnpm add` internally to install
// the packages it needs; on pnpm 11 this can hit ERR_PNPM_IGNORED_BUILDS if a
// new transitive dep brings a postinstall script (e.g. msw via @base-ui/react).
// The error creates a `pnpm-workspace.yaml` with placeholder values. We
// normalize the file (placeholders → true) and retry once. The retry succeeds
// because pnpm 11 reads the explicit `allowBuilds:` entries.
function runShadcn(cmd) {
  const result = capture(cmd, PROJECT_DIR);
  // Surface output regardless of exit (matches `inherit` stdio semantics).
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) return;

  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  if (!existsSync(wsPath)) fail(`Command failed (exit ${result.status}): ${cmd}`);
  const ws = readFileSync(wsPath, "utf8");
  const fixed = ws.replace(/:\s*set this to true or false/g, ": true");
  if (fixed === ws) fail(`Command failed (exit ${result.status}): ${cmd}`);
  writeFileSync(wsPath, fixed);
  console.log("  → Normalized pnpm-workspace.yaml (placeholders → true), retrying shadcn");
  run(cmd, PROJECT_DIR);
}

function shadcn() {
  log("Installing shadcn/ui");

  // Pre-create pnpm-workspace.yaml with known build-script-using packages
  // approved. This prevents shadcn's internal `pnpm add` (which pulls in msw via
  // @base-ui/react transitive deps) from creating a placeholder yaml + exiting
  // 1 on its FIRST run. If we let that happen, the retry can write the
  // components but skips `src/lib/utils.ts` (because shadcn init treats
  // components.json already existing as a "do you want to overwrite?" prompt
  // that --yes does not auto-accept).
  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  const existingWs = existsSync(wsPath) ? readFileSync(wsPath, "utf8") : "";
  // unrs-resolver is a transitive native dep of eslint-config-next (via
  // eslint-plugin-import-x → @rspack/binding-resolver). It MUST be approved or
  // any future `pnpm install` (e.g. when the user adds a package) exits with
  // ERR_PNPM_IGNORED_BUILDS even when `strict-dep-builds=false` is in .npmrc.
  const knownBuildPkgs = ["msw", "sharp", "esbuild", "@tailwindcss/oxide", "@swc/core", "@parcel/watcher", "unrs-resolver"];
  const newWs =
    "allowBuilds:\n" +
    knownBuildPkgs.map((p) => `  ${p.includes("/") ? `"${p}"` : p}: true`).join("\n") +
    "\n" +
    // Both advisories are reached only through next's OWN bundled copies of
    // postcss and sharp, not the project's direct dependency on either -
    // verified on a live run (`pnpm audit --prod` reports `.>next>postcss`
    // and `.>next>sharp`). `pnpm update` cannot move a transitive dep by
    // itself; pnpm 11 needs this override instead. Drop it once next bundles
    // patched versions of both.
    "overrides:\n" +
    '  postcss: ">=8.5.18"\n' +
    '  sharp: ">=0.35.0"\n' +
    // A published-minutes-ago version is how an npm worm reaches a project
    // (ChainDrop, 2026: 1557 poisoned versions, pulled within hours). pnpm 11
    // already defaults to 1440; 4320 is the 3-day floor the advisories ask for.
    // minimumReleaseAgeStrict must stay false: pnpm defaults it to TRUE as soon
    // as minimumReleaseAge is set explicitly, which turns "the only match is too
    // new" into a hard install failure in front of a non-technical user.
    "minimumReleaseAge: 4320\n" +
    "minimumReleaseAgeStrict: false\n";
  if (existingWs !== newWs) {
    writeFileSync(wsPath, newWs);
    console.log("  → Pre-wrote pnpm-workspace.yaml with known build-script packages approved");
  }

  // npx is required - pnpm dlx fails with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND
  // because shadcn's CLI probes its cwd via the package-manager context and
  // pnpm's dlx sandbox confuses that detection.
  runShadcn("npx shadcn@latest init --defaults --yes");

  // Belt-and-suspenders: write src/lib/utils.ts if shadcn didn't (can happen if
  // init was retried after components.json existed and the overwrite prompt
  // blocked even with --yes). The standard shadcn utils.ts is stable.
  const utilsPath = join(PROJECT_DIR, "src/lib/utils.ts");
  if (!existsSync(utilsPath)) {
    writeFileSync(
      utilsPath,
      `import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n`,
    );
    console.log("  → Wrote missing src/lib/utils.ts fallback");
  }

  log("Adding base components");
  runShadcn(
    "npx shadcn@latest add button card input label dialog sheet dropdown-menu select separator badge sonner --yes",
  );

  log("Writing LinkButton (shadcn v4 has no asChild)");
  writeFileSync(
    join(PROJECT_DIR, "src/components/ui/link-button.tsx"),
    `import Link, { type LinkProps } from "next/link";
import { type VariantProps } from "class-variance-authority";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type LinkButtonProps = LinkProps &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    children: React.ReactNode;
  };

export function LinkButton({ className, variant, size, ...props }: LinkButtonProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
`,
  );

  // shadcn v4 init injects a `@theme inline { --font-sans: var(--font-sans); }`
  // block into globals.css that clobbers T3's Geist wiring (`@theme { --font-sans:
  // var(--font-geist-sans), ... }`). The self-referential declaration makes
  // `var(--font-sans)` resolve to itself → browser falls back to Times New Roman.
  // Fix: drop that one line. The outer @theme block then becomes the source of
  // truth for --font-sans.
  log("Patching globals.css (Geist clobber fix)");
  const globalsPath = join(PROJECT_DIR, "src/styles/globals.css");
  if (existsSync(globalsPath)) {
    const before = readFileSync(globalsPath, "utf8");
    const after = before.replace(/^\s*--font-sans:\s*var\(--font-sans\)\s*;\s*\r?\n/m, "");
    if (before !== after) {
      writeFileSync(globalsPath, after);
      ok("Stripped self-referential --font-sans from globals.css");
    } else {
      warn(
        "globals.css did not contain the expected `--font-sans: var(--font-sans);` line - " +
          "shadcn may have changed its output. If fonts render as Times New Roman, inspect " +
          "globals.css manually and ensure --font-sans resolves to var(--font-geist-sans).",
      );
    }
  } else {
    warn(`${globalsPath} not found - cannot patch Geist wiring.`);
  }

  ok("shadcn + LinkButton + Geist fix ready");
}

// ─── Step 10 + 11: sibling scripts ──────────────────────────────────────
function runSibling(script, extraArgs = []) {
  const p = join(__dirname, script);
  if (!existsSync(p)) fail(`Sibling script missing: ${p}`);
  run(["node", `"${p}"`, ...extraArgs].join(" "), PROJECT_DIR);
}

function security() {
  log("Applying security hardening");
  runSibling("setup-security.mjs");
  ok("Security done");
}

function seo() {
  log("Applying base SEO");
  // Quote args that may contain spaces / special chars. Node's cmdline parsing
  // on Windows keeps these as single argv entries when wrapped in double quotes.
  runSibling("setup-seo.mjs", [
    "--name",
    `"${name.replace(/"/g, '\\"')}"`,
    "--description",
    `"${description.replace(/"/g, '\\"')}"`,
    "--locale",
    locale,
  ]);
  ok("SEO done");
}

// ─── Step 12: local image placeholders (public/placeholders/) ─────────
// Generated as real files, never a remote URL - the previous default (Lorem
// Picsum / Unsplash, skills/bootstrap/SKILL.md) sent every visitor's IP to a
// US third party on page load, invisible to rgpd-audit.mjs since it's
// neither a dependency nor an env var. Deterministic on purpose (same index
// -> byte-identical SVG): re-running bootstrap on the same project never
// changes what ships, matching every other idempotent step in this file.
const PLACEHOLDER_PALETTES = [
  ["#6D28D9", "#DB2777"],
  ["#2563EB", "#06B6D4"],
  ["#059669", "#A3E635"],
  ["#EA580C", "#FACC15"],
  ["#DC2626", "#F472B6"],
  ["#0F766E", "#38BDF8"],
  ["#7C3AED", "#4F46E5"],
  ["#B45309", "#DC2626"],
];
const PLACEHOLDER_GRADIENT_DIRECTIONS = [
  { x1: "0%", y1: "0%", x2: "100%", y2: "100%" },
  { x1: "0%", y1: "100%", x2: "100%", y2: "0%" },
  { x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
  { x1: "0%", y1: "0%", x2: "0%", y2: "100%" },
];
const PLACEHOLDER_COUNT = 8;

// Deterministic PRNG (mulberry32) seeded per-image, so shape placement varies
// between the 8 placeholders without relying on Math.random (non-reproducible).
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderPlaceholderSvg(index) {
  const width = 1600;
  const height = 900;
  const [from, to] = PLACEHOLDER_PALETTES[index % PLACEHOLDER_PALETTES.length];
  const dir = PLACEHOLDER_GRADIENT_DIRECTIONS[index % PLACEHOLDER_GRADIENT_DIRECTIONS.length];
  const rand = mulberry32(index * 1000003 + 7);

  const circles = [];
  for (let i = 0; i < 3; i++) {
    const cx = Math.round(rand() * width);
    const cy = Math.round(rand() * height);
    const r = Math.round(90 + rand() * 260);
    const opacity = (0.06 + rand() * 0.1).toFixed(2);
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${i % 2 === 0 ? "#ffffff" : "#000000"}" opacity="${opacity}" />`);
  }
  const p1 = [Math.round(rand() * width), Math.round(rand() * height)];
  const p2 = [Math.round(rand() * width), Math.round(rand() * height)];
  const p3 = [Math.round(rand() * width), Math.round(rand() * height)];
  const triangleOpacity = (0.05 + rand() * 0.08).toFixed(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true">
  <defs>
    <linearGradient id="g${index}" x1="${dir.x1}" y1="${dir.y1}" x2="${dir.x2}" y2="${dir.y2}">
      <stop offset="0%" stop-color="${from}" />
      <stop offset="100%" stop-color="${to}" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g${index})" />
  ${circles.join("\n  ")}
  <polygon points="${p1.join(",")} ${p2.join(",")} ${p3.join(",")}" fill="#ffffff" opacity="${triangleOpacity}" />
</svg>
`;
}

function imagePlaceholders() {
  log("Generating local image placeholders (public/placeholders/)");
  const dir = join(PROJECT_DIR, "public/placeholders");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PLACEHOLDER_COUNT; i++) {
    const filename = `placeholder-${String(i + 1).padStart(2, "0")}.svg`;
    writeFileSync(join(dir, filename), renderPlaceholderSvg(i));
  }
  ok(`${PLACEHOLDER_COUNT} placeholder SVGs written to public/placeholders/`);
}

// ─── Step 13: 404 page ─────────────────────────────────────────────────
// Polished server-component 404 with the shadcn Button. Generated as part of
// the initial scaffold so every project ships with one out of the box.
function notFoundPage() {
  log("Writing src/app/not-found.tsx");
  // Template: templates/not-found/plain.tsx (no vars to substitute - purely static).
  // Uses LinkButton (created in shadcn()) because shadcn v4 has no asChild on Button.
  writeFileSync(join(PROJECT_DIR, "src/app/not-found.tsx"), render("not-found/plain.tsx", {}));
  ok("404 page written");
}

// ─── Step 14: Dockerfile ───────────────────────────────────────────────
// Copies templates/deploy/Dockerfile verbatim (no {{PLACEHOLDER}}s in it) -
// see templates/deploy/README.md for the three failure modes it exists to
// prevent (arm64 image, missing copy-assets step, binding 127.0.0.1). Nothing
// here invokes `docker` yet - dockerBuildPush() builds and pushes the image
// later, once the registry namespace exists.
function dockerfile() {
  log("Writing Dockerfile (multi-stage, node:24-alpine, Scaleway Serverless Containers)");
  writeFileSync(join(PROJECT_DIR, "Dockerfile"), render("deploy/Dockerfile", {}));
  writeFileSync(join(PROJECT_DIR, ".dockerignore"), render("deploy/.dockerignore", {}));
  // migrate.mjs runs the migration Job (scripts/deploy.mjs) on the app image
  // itself, so it must land in the build context the Dockerfile's runner
  // stage COPYs from (see templates/deploy/Dockerfile).
  writeFileSync(join(PROJECT_DIR, "migrate.mjs"), render("deploy/migrate.mjs", {}));
  ensureMigrationJournal();
  // proxy-ca.crt is written into the build context by _docker-build.mjs for
  // the duration of each build and removed right after; the ignore line
  // keeps a leftover from a killed build out of the repo.
  const gitignorePath = join(PROJECT_DIR, ".gitignore");
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.split(/\r?\n/).some((l) => l.trim() === "proxy-ca.crt")) {
    const sep = gitignore.length === 0 || gitignore.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, gitignore + sep + "proxy-ca.crt\n");
  }
  ok("Dockerfile + migrate.mjs written");
}

// migrate.mjs treats an empty or missing journal as a safe no-op (see
// templates/deploy/migrate.mjs), but the FILE must exist so the Dockerfile's
// `COPY drizzle ./drizzle` never fails on a fresh project - schema.ts starts
// empty (cleanupDemo() above) and nothing in this pipeline runs
// `drizzle-kit generate` before the first real table is added, so the
// drizzle/ directory would not otherwise exist yet. Verified against a live
// `drizzle-kit generate` run (drizzle-kit 0.31.10, zero-table schema): it
// writes exactly this shape, so a later real run only appends to `entries`.
function ensureMigrationJournal() {
  const journalPath = join(PROJECT_DIR, "drizzle/meta/_journal.json");
  if (existsSync(journalPath)) return;
  mkdirSync(join(PROJECT_DIR, "drizzle/meta"), { recursive: true });
  writeFileSync(journalPath, JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }, null, 2) + "\n");
}

// ─── Step 15: next.config → output: 'standalone' ──────────────────────
// templates/deploy/next.config.js is a FULL REPLACEMENT of next.config.js -
// but security() (step 9, already run) PATCHES the T3-scaffolded next.config
// in place to inject security headers, including the CSP + CSP-Report-Only
// pair (see setup-security.mjs: it regenerates nothing, it locates the
// existing `const config = {` object literal and injects into it). If
// nextConfigStandalone() overwrote the file wholesale with the template, the
// security headers security() just added would be silently lost.
//
// DECISION: convert templates/deploy/next.config.js's *content* (output:
// 'standalone' + images.remotePatterns for **.scw.cloud) into a second PATCH
// of the same style as setup-security.mjs, rather than reordering steps to
// run this before security(). Reordering was the other option, but the
// target step sequence puts security before this step, and a patch
// generalizes better anyway: any
// FUTURE step that also patches next.config.js (a11y headers, i18n, a
// wrapper for next-pwa, ...) keeps composing instead of stepping on whichever
// patch happens to run last.
function nextConfigStandalone() {
  log("Patching next.config for output: 'standalone' + Scaleway image remotePatterns");
  const candidates = ["next.config.ts", "next.config.mjs", "next.config.js"];
  const file = candidates.map((f) => join(PROJECT_DIR, f)).find((p) => existsSync(p));
  if (!file) {
    warn("next.config.(ts|mjs|js) not found - cannot patch for standalone output. See templates/deploy/next.config.js.");
    return;
  }

  let content = readFileSync(file, "utf8");
  let changed = false;

  if (!/output:\s*["']standalone["']/.test(content)) {
    const objRe = /(const\s+\w+\s*(?::\s*[\w.]+)?\s*=\s*\{)/;
    const m = content.match(objRe);
    if (!m) {
      warn(`${file}: could not locate the config object literal - add output: "standalone" manually (see templates/deploy/next.config.js).`);
    } else {
      content = content.replace(objRe, `$1\n  output: "standalone",`);
      changed = true;
    }
  }

  if (!content.includes("**.scw.cloud")) {
    if (/remotePatterns\s*:\s*\[/.test(content)) {
      // An `images.remotePatterns` array already exists (another patch got here
      // first) - extend it instead of adding a second `images` key.
      content = content.replace(
        /remotePatterns\s*:\s*\[/,
        `remotePatterns: [\n      { protocol: "https", hostname: "**.scw.cloud" },`,
      );
    } else if (/images\s*:\s*\{/.test(content)) {
      content = content.replace(
        /images\s*:\s*\{/,
        `images: {\n    remotePatterns: [{ protocol: "https", hostname: "**.scw.cloud" }],`,
      );
    } else {
      const objRe = /(const\s+\w+\s*(?::\s*[\w.]+)?\s*=\s*\{)/;
      content = content.replace(
        objRe,
        `$1\n  images: {\n    remotePatterns: [{ protocol: "https", hostname: "**.scw.cloud" }],\n  },`,
      );
    }
    changed = true;
  }

  // Enables next/image for the local SVG placeholders (public/placeholders/,
  // see imagePlaceholders() above) - Next.js blocks SVG optimisation by
  // default (a script can hide inside an SVG), these three keys are Next's
  // own documented safe opt-in. By this point the `images: {` object always
  // exists (created or extended above), so the same locate-and-inject
  // pattern applies.
  if (!content.includes("dangerouslyAllowSVG")) {
    if (/images\s*:\s*\{/.test(content)) {
      content = content.replace(
        /images\s*:\s*\{/,
        `images: {\n    dangerouslyAllowSVG: true,\n    contentDispositionType: "attachment",\n    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",`,
      );
      changed = true;
    } else {
      warn(`${file}: could not locate the images object literal - add dangerouslyAllowSVG manually (see templates/deploy/next.config.js).`);
    }
  }

  if (changed) {
    writeFileSync(file, content);
    ok(`${file}: patched for standalone output + Scaleway image remotePatterns + SVG placeholder support (security headers from security() preserved)`);
  } else {
    ok(`${file}: already has standalone output + Scaleway remotePatterns + SVG support (idempotent)`);
  }
}

// ─── Step 16: copy-assets.js ────────────────────────────────────────────
// Restores .next/static/ + public/ into .next/standalone/ after `next build`
// (standalone mode does not copy them itself). Run from the Dockerfile's
// `builder` stage - see templates/deploy/README.md failure mode #2, the
// single most likely way this setup gets silently broken by a future edit.
function copyAssets() {
  log("Writing copy-assets.js");
  writeFileSync(join(PROJECT_DIR, "copy-assets.js"), render("deploy/copy-assets.js", {}));
  ok("copy-assets.js written");
}

// ─── Step 17: access proxy (IP allowlist) ──────────────────────────────
// The ACCESS_RESTRICTED / ACCESS_ALLOWED_IPS gate from CONTRACT.md §6, with
// real IPv4/IPv6 CIDR matching. Application-layer only - Scaleway has no
// network-level IP filtering for Serverless Containers. Next 16 renamed
// middleware.ts to proxy.ts (CONTRACT.md §6).
function accessProxy() {
  log("Writing src/proxy.ts (IP allowlist gate)");
  mkdirSync(join(PROJECT_DIR, "src"), { recursive: true });
  writeFileSync(join(PROJECT_DIR, "src/proxy.ts"), render("deploy/proxy.ts", {}));
  ok("proxy.ts written");
}

// ─── Step 18: CLAUDE.md core ──────────────────────────────────────────
// Writes the project's initial CLAUDE.md. Contains the unconditional T3-specific
// conventions only - addons (add-db, add-email, ...) extend this file later via
// _update-claude-md. Cross-project conventions (TypeScript no-any, responsive,
// kebab-case URLs, etc.) live in the user's global ~/.claude/CLAUDE.md (managed
// by /start), not here. The bootstrap SKILL also adds a "Cahier des charges"
// line after the user-facing CDC step if a spec file was provided.
function claudeMdCore() {
  log("Writing CLAUDE.md (project-level core)");
  // Template: templates/bootstrap/claude-md-core.md
  // Substitutes PROJECT_NAME and DESCRIPTION. Conventions are static.
  writeFileSync(
    join(PROJECT_DIR, "CLAUDE.md"),
    render("bootstrap/claude-md-core.md", {
      PROJECT_NAME: name,
      DESCRIPTION: description,
    }),
  );
  ok("CLAUDE.md core written");
}

// ─── Step 19: privacy policy page + seed subprocessors registry ───────
// Writes a data-driven privacy policy page that renders from
// src/lib/subprocessors.ts. Then seeds that registry with Scaleway - the
// hosting + database provider, always present. As /add-* skills introduce new
// third-party data processors, each one calls _update-privacy-policy to add
// itself to the registry. The page picks up changes automatically, no
// template re-rendering needed.
function privacyPolicy() {
  log("Writing privacy policy page + seeding subprocessors registry");

  const pageDir = join(PROJECT_DIR, "src/app/politique-de-confidentialite");
  mkdirSync(pageDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(pageDir, "page.tsx"),
    render("privacy-policy/plain.tsx", {
      PROJECT_NAME: name,
      LAST_UPDATED: today,
    }),
  );

  // KNOWN CROSS-FILE DEPENDENCY (scripts/update-privacy-policy.mjs is NOT owned
  // by this script - see its CATALOG constant): as of this writing that
  // catalog still only has a hosting entry for the platform this harness used
  // BEFORE the Scaleway migration, not a "scaleway" one. This call will fail
  // ("Unknown key: scaleway") until whoever owns that file adds a "scaleway"
  // CATALOG entry (host + database processor, region fr-par, see CONTRACT.md
  // §1 for the exact services). Calling `--add scaleway` here (the
  // semantically correct key for this architecture) rather than continuing
  // to seed the retired catalog key, so the failure is loud and obvious
  // instead of silently shipping a wrong/stale subprocessor.
  runSibling("update-privacy-policy.mjs", ["--add", "scaleway"]);

  ok("Privacy policy page + Scaleway subprocessor written");
}

// ─── Step 20: branch-cleanup workflow ──────────────────────────────────
// Dispatch-only maintenance workflow, the one CONTRACT.md §5 exception: a
// web session cannot delete a remote ref, so the repository owner deletes
// merged branches from the Actions tab instead. Not a build workflow -
// checks 56 and 60 in tools/verify.mjs pin this.
function cleanupWorkflow() {
  log("Writing .github/workflows/clean-merged-branches.yml (dispatch-only maintenance workflow)");
  mkdirSync(join(PROJECT_DIR, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(PROJECT_DIR, ".github/workflows/clean-merged-branches.yml"),
    render("deploy/clean-merged-branches.yml", {}),
  );
  ok("clean-merged-branches.yml written");
}

// ─── Step 21: initial commit ───────────────────────────────────────────
function commit() {
  log("Creating initial commit");
  run("git add -A", PROJECT_DIR);
  // If there's nothing to commit (T3's initial commit already captured everything,
  // unlikely given we changed a lot), git commit exits 1. Allow that.
  const res = capture("git diff --cached --quiet", PROJECT_DIR);
  if (res.status === 0) {
    ok("Nothing to commit (already clean)");
    return;
  }
  run(
    ["git", "commit", "-m", '"chore: initial scaffold + security + SEO + deploy artifacts"'].join(" "),
    PROJECT_DIR,
  );
  ok("Commit done");
}

// ─── Step 22: push to the pre-existing origin ──────────────────────────
// The repo already exists (in-place bootstrap, CONTRACT.md §7) - there is no
// repo to create, only a first push of the scaffolded commit. A push
// rejected by branch protection is a WARNING, not a failure: the session's
// own pull-request flow still delivers the code (CONTRACT.md §5's fallout
// note), and the web git credential 403s on ref DELETE (live-verified) - so
// this never tries to work around a rejection by deleting or force-pushing
// anything.
function pushToOrigin() {
  const branch = capture("git rev-parse --abbrev-ref HEAD", PROJECT_DIR).stdout?.trim() || "main";
  log(`Pushing ${branch} to origin`);
  const push = capture(`git push -u origin ${branch}`, PROJECT_DIR);
  if (push.status !== 0) {
    warn(
      `git push was rejected: ${(push.stderr || push.stdout || "").trim().slice(0, 300)}. This is often branch ` +
        "protection on the default branch - open a pull request instead (the session's own PR flow) to land " +
        "this commit. Never delete or force-push the remote branch to work around it.",
    );
    return;
  }
  ok(`Pushed ${branch} to origin`);
}

// ─── Step 23: Container Registry namespace ─────────────────────────────
let registryNamespace = null;

async function scwRegistryNamespace() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping scwRegistryNamespace.");
    return;
  }
  log("Creating Scaleway Container Registry namespace");
  registryNamespace = await ensureRegistryNamespace(name, { projectId: scwProjectId });
  ok(`Registry namespace ready: ${registryNamespace.endpoint}`);
}

// ─── Step 24: Serverless Containers namespace ──────────────────────────
let containerNamespaceId = null;
let containerNamespaceName = null;

async function scwContainerNamespace() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping scwContainerNamespace.");
    return;
  }
  log("Creating Scaleway Serverless Containers namespace");
  const ns = await ensureNamespace(name, { projectId: scwProjectId });
  containerNamespaceId = ns.id;
  containerNamespaceName = ns.name;
  ok(`Container namespace ready (${containerNamespaceId})`);
}

// ─── Step 25: direct build + push ───────────────────────────────────────
// Direct pipeline (CONTRACT.md §5): the machine running the harness builds
// and pushes the image itself - no GitHub Actions, no repo secret. Runs
// BEFORE scwContainer(): Scaleway validates a container's registryImage
// against the registry at creation time (verified on a live run - see
// scwContainer()'s comment below), so the container cannot exist until an
// image is already pushed under some tag. commitSha becomes that tag - the
// same tag format the removed GitHub Actions workflow used
// (`${{ github.sha }}`, templates/deploy/build.yml, now deleted).
let commitSha = null;
let imageUri = null;

async function dockerBuildPush() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping dockerBuildPush.");
    return;
  }
  await ensureDocker();
  commitSha = capture("git rev-parse HEAD", PROJECT_DIR).stdout.trim();
  const slug = slugify(name);

  log(`Building + pushing the Docker image (tag ${commitSha.slice(0, 7)})`);
  const result = await buildAndPushImage({
    projectDir: PROJECT_DIR,
    registryEndpoint: registryNamespace.endpoint,
    registryNamespaceId: registryNamespace.id,
    imageName: slug,
    tag: commitSha,
    log: (msg) => log(msg),
  });
  imageUri = result.imageUri;
  ok(result.skipped ? `Image already present under this tag, reused: ${imageUri}` : `Image built and pushed: ${imageUri}`);
}

// ─── Step 26: Scaleway container ───────────────────────────────────────
// Scaleway validates registryImage against the registry when a container is
// created - a tag that does not exist yet is rejected outright
// (`ScwError: resource registry image with ID <slug> is not found`),
// verified on a live run. An earlier revision of this script created the
// container first, pointed at a placeholder tag
// (`<endpoint>/<slug>:bootstrap-pending`), meaning to repoint it at the real
// tag once a later step had pushed it - that placeholder trick does not
// work; Scaleway checks the image at creation time, not at deploy time.
// dockerBuildPush() now runs first (previous step), so by the time this step
// runs the image is already pushed under its real tag, the commit SHA
// (CONTRACT.md §1, §5). This function both creates
// the container AND waits for it to become ready, so a separate
// "firstDeploy" step is no longer needed.
//
// Scale preset S (CONTRACT.md §1 defaults) via SCALE_PRESETS.S from
// scripts/scaleway/container.mjs - createContainer({scale:"S"}) resolves it
// internally; SCALE_PRESETS is also imported directly here so the values are
// logged rather than silently trusted.
//
// find-or-create, mirroring deploy.mjs#updateContainerStep: a container
// created by an earlier, partially-failed run must be reused, not treated
// as an error on retry. The DATABASE_URL placeholder is only set on the
// create branch - on reuse, a real value may already have been written by
// /add-db, and this step must not clobber it.
let containerId = null;
let containerDomain = null;

// The operator's public egress address(es), detected once by scwContainer
// and reused by smokeTest to explain a 403.
let detectedEgressIps = [];
let accessBypassToken = null;

// One IPv4 and one IPv6 lookup, each best-effort with a short timeout. The
// ipify hosts return the bare address as plain text; the strict format check
// means a captive portal or an error page can never land in
// ACCESS_ALLOWED_IPS. This call sends the OPERATOR's own IP to a US service
// (ipify.org) - never a visitor's - see skills/bootstrap/DOC.md.
async function detectEgressIps() {
  // A Claude Code web sandbox's own address is not the operator's - recording
  // it would allowlist the sandbox VM, not the person who needs access, and
  // sandbox VMs are ephemeral anyway (CONTRACT.md §7). Skip the network call
  // entirely and let the SKILL ask the user for their own address instead
  // (https://ip.me), or /publish to lift the gate.
  if (isRemoteSandbox()) {
    warn(
      "Running in a Claude Code web sandbox: this machine's address is not the operator's own, so " +
        "ACCESS_ALLOWED_IPS is not seeded from it. Ask the user to open https://ip.me and paste their own " +
        "address, or use /publish to lift the IP gate instead.",
    );
    return [];
  }

  const found = [];
  const probes = [
    { url: "https://api.ipify.org", re: /^\d{1,3}(\.\d{1,3}){3}$/, suffix: "/32" },
    { url: "https://api6.ipify.org", re: /^(?=.*:)[0-9a-f:]{2,45}$/i, suffix: "/128" },
  ];
  for (const probe of probes) {
    try {
      const res = await fetch(probe.url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (probe.re.test(ip)) found.push(`${ip}${probe.suffix}`);
    } catch {
      // no route for this address family, or the service is down - non-fatal
    }
  }
  return found;
}

async function scwContainer() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping scwContainer.");
    return;
  }
  const preset = SCALE_PRESETS.S;
  log(
    `Creating Scaleway Serverless Container (scale S: ${preset.cpuLimit}mvCPU / ${preset.memoryLimit}MB / ` +
      `maxConcurrency ${preset.maxConcurrency}, min_scale 0, max_scale 5, port 8080)`,
  );

  const slug = slugify(name);
  const image = `${registryNamespace.endpoint}/${slug}:${commitSha}`;
  // Syntactically-valid Postgres URL so T3's src/env.js Zod validation
  // (z.string().url()) passes at container startup without ever opening a
  // real connection. /add-db replaces it with the real Serverless SQL
  // connection string (CONTRACT.md §4) and additionally registers it in
  // Secret Manager per the rotation model in CONTRACT.md §1.
  const dbPlaceholder = "postgresql://placeholder:placeholder@localhost:5432/placeholder";

  let created = await findContainerByName(containerNamespaceId, name);
  if (created) {
    ok(`Reusing existing container "${name}" (${created.id}) - pointing it at ${slug}:${commitSha.slice(0, 7)}`);
    created = await updateContainer(created.id, { registryImage: image });
  } else {
    created = await createContainer({
      namespaceId: containerNamespaceId,
      name,
      registryImage: image,
      scale: "S",
    });
    // Only on first creation: DATABASE_URL does not exist in Secret Manager
    // yet. A reused container implies an earlier run got this far, and a
    // real value may already sit there (written by /add-db) - never clobber
    // it with the placeholder again. putSecret() is create-or-new-version,
    // so /add-db's later putSecret("DATABASE_URL", ...) still overwrites
    // this placeholder cleanly regardless.
    await putSecret("DATABASE_URL", dbPlaceholder, { projectId: scwProjectId });
  }
  containerId = created.id;
  containerDomain = created.domain_name;

  // Scaleway refuses writes while the container is in a transient state
  // ("creating"/"deploying": 409 TransientStateError - verified on a live
  // run), and a secret write itself triggers a new deployment. The rhythm is
  // therefore wait, write, wait - never write-write.
  log("Waiting for the container to leave its creation state...");
  await waitForContainerReady(containerId, { timeoutMs: 300_000 });

  // APP_URL, ACCESS_RESTRICTED and ACCESS_ALLOWED_IPS are now made CANONICAL
  // in Secret Manager, not written to the container directly - see
  // container.mjs's header comment: a container GET can only ever return an
  // argon2 hash, never plaintext, so the container itself can never again
  // serve as a read-back source of truth, and a write REPLACES the whole
  // secret map, so a partial write deletes whatever it omits. A previous
  // revision of this function wrote a partial map straight to the container
  // via setContainerSecrets() - that is what deleted DATABASE_URL on a
  // later, unrelated write elsewhere, and what turned a read-back argon2
  // hash into a value the proxy could never match, locking every
  // operator out with a 403.
  //
  // APP_URL (CONTRACT.md §2 - replaces the old hosting platform's public-URL
  // var) is only known once the container exists (domain_name is assigned at
  // creation). ACCESS_RESTRICTED defaults every app to IP-restricted
  // (CONTRACT.md §6) - proxy.ts now fails CLOSED on an unset/unrecognised
  // value, but this is still set explicitly rather than relied upon as a
  // fallback.
  // ACCESS_ALLOWED_IPS: without it, the fail-closed proxy lets nobody
  // through while ACCESS_RESTRICTED is on - proxy.ts ships with NO
  // built-in allowlist (a hardcoded default made every new project reachable
  // only from one machine's VPN, verified on a live run). Detect this
  // machine's egress address(es) and allow them, so the smoke test and the
  // operator's own browser work out of the box. Best-effort: on failure the
  // smoke test explains the 403 instead.
  detectedEgressIps = await detectEgressIps();
  await putSecret("ACCESS_RESTRICTED", "true", { projectId: scwProjectId });
  await putSecret("APP_URL", `https://${containerDomain}`, { projectId: scwProjectId });
  // ACCESS_BYPASS_TOKEN (CONTRACT.md §6): the harness's own pass through the
  // IP gate. The web sandbox egresses from a shared pool that can never be
  // allowlisted by address, so the smoke tests authenticate with this header
  // token instead. Minted here, projected into the container by the secret
  // sync below like every other non-excluded secret.
  accessBypassToken = randomBytes(32).toString("hex");
  await putSecret("ACCESS_BYPASS_TOKEN", accessBypassToken, { projectId: scwProjectId });
  if (detectedEgressIps.length) {
    const allowedIps = detectedEgressIps.join(",");
    await putSecret("ACCESS_ALLOWED_IPS", allowedIps, { projectId: scwProjectId });
    ok(`Operator egress address detected - ACCESS_ALLOWED_IPS=${allowedIps}`);
    if (detectedEgressIps.length === 1) {
      // An operator machine commonly egresses BOTH address families, and a
      // client (e.g. curl) often prefers IPv6 - if only one family was
      // detected here, a request over the other family gets a 403 with no
      // clue why it happened. Warn now, while the cause is still obvious.
      const seenFamily = detectedEgressIps[0].includes(":") ? "IPv6" : "IPv4";
      const otherFamily = seenFamily === "IPv6" ? "IPv4" : "IPv6";
      warn(
        `Only ${seenFamily} was detected for this machine, so ACCESS_ALLOWED_IPS only allows ${seenFamily}. ` +
          `If this machine also has a working ${otherFamily} address and a client prefers it, that request ` +
          `will get HTTP 403 with no other clue why. Add the missing ${otherFamily} address to ` +
          "ACCESS_ALLOWED_IPS if that happens.",
      );
    }
  } else {
    warn(
      "Could not detect this machine's public IP address. ACCESS_ALLOWED_IPS stays unset, so the " +
        "restricted app will answer 403 to everyone (including the smoke test below) until it is set " +
        "or the app is published with /publish.",
    );
  }

  // syncContainerSecrets() does its own wait-write-wait around the secrets
  // write (CONTRACT.md §1) and returns the container once ready again.
  log("Syncing container secrets from Secret Manager...");
  created = await syncContainerSecrets(containerId, { projectId: scwProjectId });
  containerDomain = created.domain_name || containerDomain;

  // No linkage file is written (CONTRACT.md §2, §7: app repos carry no
  // Scaleway metadata at all). Every later script finds this same container
  // again by name - the Project resolves by name (resolveProjectId()), the
  // namespace and container by name within it (ensureNamespace() /
  // findContainerByName(), both called with `name` again, exactly as above).
  ok(`Container deployed and ready: https://${containerDomain}`);
}

// ─── Step 27: smoke test ────────────────────────────────────────────────
// Authenticates through the IP gate with ACCESS_BYPASS_TOKEN (minted in
// scwContainer above, checked by templates/deploy/proxy.ts), so a 200 is
// expected from ANY machine - web sandbox included - and a 403 is a real
// failure, not an artifact of the caller's address. A bare 200-check is NOT
// enough: the Geist font clobber and the missing-copy-assets.js regression
// (templates/deploy/README.md) both still return HTTP 200 with
// broken/unstyled markup. So this also resolves the page's own stylesheet
// link and confirms IT loads.
async function smokeTest() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping smoke test too.");
    return;
  }
  const url = `https://${containerDomain}`;
  log(`Smoke-testing ${url}`);
  if (!accessBypassToken) {
    try {
      accessBypassToken = await getSecret("ACCESS_BYPASS_TOKEN", { projectId: scwProjectId });
    } catch {
      warn("ACCESS_BYPASS_TOKEN could not be read back - the smoke test runs without it and a 403 below is inconclusive.");
    }
  }
  const bypassHeaders = accessBypassToken ? { "x-baudrier-access-token": accessBypassToken } : {};

  const MAX_ATTEMPTS = 8;
  const DELAY_MS = 8000;
  let lastStatus = null;
  // The address the proxy itself observed, from its x-baudrier-client-ip
  // 403 header (templates/deploy/proxy.ts) - lets the warning below name
  // the exact address that failed, not just "some" 403.
  let observedClientIp = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: bypassHeaders });
      lastStatus = res.status;
      if (res.status === 403) {
        observedClientIp = res.headers.get("x-baudrier-client-ip");
      }
      if (res.status === 200) {
        const html = await res.text();
        const cssMatch = html.match(/href="([^"]+\.css)"/);
        if (!cssMatch) {
          warn(`Smoke test: HTTP 200 but no <link ...css"> found in the HTML - cannot confirm styling shipped. Inspect ${url} manually.`);
          return;
        }
        const cssUrl = new URL(cssMatch[1], url).toString();
        const cssRes = await fetch(cssUrl, { headers: bypassHeaders });
        if (cssRes.status === 200) {
          const cssBody = await cssRes.text();
          if (cssBody.length > 50) {
            ok(`HTTP 200 + stylesheet loads (${cssBody.length} bytes, ${cssMatch[1]}) - styling confirmed (attempt ${attempt}/${MAX_ATTEMPTS})`);
            return;
          }
        }
        warn(
          `Smoke test: page loaded (200) but the stylesheet ${cssUrl} did not load correctly ` +
            `(status ${cssRes.status}) - this is exactly the missing-copy-assets.js regression ` +
            `documented in templates/deploy/README.md. Inspect the Dockerfile build logs.`,
        );
        return;
      }
    } catch (e) {
      lastStatus = `network error: ${e.message}`;
    }

    // 403 is deterministic: the container answered and the IP gate rejected
    // this machine. Retrying cannot change the outcome - explain it instead.
    if (lastStatus === 403) break;

    if (attempt < MAX_ATTEMPTS) {
      log(`  attempt ${attempt}/${MAX_ATTEMPTS}: ${lastStatus} - waiting ${DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  if (lastStatus === 403) {
    const seen = observedClientIp ?? "an address the gate could not report";
    if (!accessBypassToken) {
      warn(
        `Smoke test got HTTP 403 and no ACCESS_BYPASS_TOKEN was available to authenticate with (the gate saw ${seen}). ` +
          "The deploy itself is fine; the gate is up. Re-run the container secret sync so the token exists, or " +
          "check the token minting step above.",
      );
      return;
    }
    // The request carried a valid, freshly minted token, so the gate itself
    // rejected it: either the container's secret sync did not project
    // ACCESS_BYPASS_TOKEN yet, or the generated src/proxy.ts lost its
    // bypassTokenMatches() check.
    warn(
      `Smoke test got HTTP 403 DESPITE presenting ACCESS_BYPASS_TOKEN (the gate saw ${seen}). ` +
        "The app is up but the harness token bypass is not working. Check that the ACCESS_BYPASS_TOKEN secret " +
        "reached the container env (syncContainerSecrets) and that src/proxy.ts carries the " +
        "x-baudrier-access-token check (templates/deploy/proxy.ts). The operator's own browser access is a " +
        "separate matter: ACCESS_ALLOWED_IPS (ask https://ip.me) or /publish.",
    );
    return;
  }

  if (isRemoteSandbox() && typeof lastStatus === "string" && lastStatus.startsWith("network error")) {
    warn(
      `Smoke test could not reach the container from this sandbox (${lastStatus}). If this persists, add the ` +
        "container run domain family (*.fnc.fr-par.scw.cloud) to the environment's Custom network allowlist.",
    );
    return;
  }

  warn(
    `Smoke test inconclusive after ${MAX_ATTEMPTS} attempts: last status was ${lastStatus}. ` +
      `The deploy itself succeeded (scwContainer waited for "ready") but ${url} isn't responding as expected. ` +
      "Claude should investigate (cold start, health-check path, missing env var).",
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("scwProject", scwProject);
await step("scaffoldT3", scaffoldT3);
await step("gitattributes", gitattributes);
await step("bumpDrizzle", bumpDrizzle);
await step("cleanupDemo", cleanupDemo);
await step("eslintCli", eslintCli);
await step("healthcheck", healthcheck);
await step("shadcn", shadcn);
await step("security", security);
await step("seo", seo);
await step("imagePlaceholders", imagePlaceholders);
await step("notFoundPage", notFoundPage);
await step("dockerfile", dockerfile);
await step("nextConfigStandalone", nextConfigStandalone);
await step("copyAssets", copyAssets);
await step("accessProxy", accessProxy);
await step("claudeMdCore", claudeMdCore);
await step("privacyPolicy", privacyPolicy);
await step("cleanupWorkflow", cleanupWorkflow);
await step("commit", commit);
await step("pushToOrigin", pushToOrigin);
await step("scwRegistryNamespace", scwRegistryNamespace);
await step("scwContainerNamespace", scwContainerNamespace);
await step("dockerBuildPush", dockerBuildPush);
await step("scwContainer", scwContainer);
await step("smokeTest", smokeTest);

// Built from the origin remote, never an API call - gh is no longer part of
// the toolchain (CONTRACT.md §7).
const { owner: ghOwner, repo: ghRepoName } = getGhOwnerRepo();

console.log(`
🎉 bootstrap-init complete.

   Project:    ${PROJECT_DIR}
   GitHub:     https://github.com/${ghOwner}/${ghRepoName}
   Scaleway:   https://console.scaleway.com/ (Project "${name}"${scwProjectId ? `, ${scwProjectId}` : ""})
   Live:       ${containerDomain ? `https://${containerDomain}` : "(UNRESOLVED - --skip-deploy was passed, or the container URL was not captured)"}

Next: Claude takes over for the cahier-des-charges step, addon invocations
(add-db to replace the DATABASE_URL placeholder, add-auth, add-email,
add-storage, add-analytics, add-map), the application build, and the legal pages.
`);

dumpHandoff(true);
