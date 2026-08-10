#!/usr/bin/env node
/**
 * bootstrap-deps.mjs - install the harness's npm dependencies, once, on session start.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Claude Code plugin is installed into a read-only cache (${CLAUDE_PLUGIN_ROOT}),
 * so it cannot carry a node_modules of its own. Claude Code provides a writable,
 * update-surviving directory for exactly this purpose (${CLAUDE_PLUGIN_DATA}), and
 * the documented pattern is: ship package.json in the plugin, install into the data
 * directory from a SessionStart hook.
 *
 * This is deliberately a Node script rather than the shell one-liner the docs show.
 * That example relies on `diff` and shell `&&`, which needs a shell to run; this
 * harness spawns with argv arrays only, never a shell, for shell-injection safety.
 *
 * WHY IT WRITES A POINTER FILE
 * ----------------------------
 * ${CLAUDE_PLUGIN_DATA} only exists in the environment of hooks and MCP/LSP
 * subprocesses. This script runs as a hook, so it is the one process that knows
 * the authoritative directory; everything under the Bash tool (scripts/scaleway/*)
 * does not. So after resolving, it records the absolute path in
 * ~/.claude/baudrier/deps-dir.txt, which the readers consult. See tools/deps-dir.mjs
 * for the full resolution order and for the scan that covers a missing pointer.
 *
 * WHAT IT DOES
 * ------------
 *   1. Resolves the install directory via tools/deps-dir.mjs.
 *   2. Refuses to install on a Node older than package.json's engines.node floor:
 *      a doomed `npm install` failing with EBADENGINE is worse than saying why.
 *   3. Compares the plugin's package.json AND package-lock.json against the copies
 *      already installed there. Identical -> nothing to do (but still refresh the
 *      pointer, so a good pre-existing install becomes findable). This runs on every
 *      session start, so the no-op path must be fast and quiet.
 *   4. Otherwise copies package.json (and package-lock.json, if the plugin ships one)
 *      across and runs `npm ci --ignore-scripts` when a lockfile is present, else
 *      `npm install`.
 *   5. Verifies the result with tools/check-deps-health.mjs, because an install can
 *      "succeed" while producing unusable packages (see that file for the specific
 *      upstream breakage this guards against).
 *
 * Failure is reported but never fatal to the session: a skill that needs the SDK
 * will fail with its own clear message, which beats blocking Claude Code from
 * starting at all. The one exception is --json, where the caller asked for a
 * machine-readable answer and wants a non-zero exit to branch on.
 *
 * Usage:
 *   node tools/bootstrap-deps.mjs [--quiet]   # install if needed (the hook)
 *   node tools/bootstrap-deps.mjs --json      # one JSON line on stdout, exit 1 if !ok
 *   node tools/bootstrap-deps.mjs --check     # resolve + health only, install nothing
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { attemptedDirs, readPointer, resolveDepsDir, resolveInstallTarget, writePointer } from "./deps-dir.mjs";

const argv = process.argv.slice(2);
const QUIET = argv.includes("--quiet");
const CHECK_ONLY = argv.includes("--check");
// --check exists to be a gate for another program, and a gate that printed
// nothing machine-readable would be useless, so it implies --json.
const JSON_OUT = argv.includes("--json") || CHECK_ONLY;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
const srcManifest = path.join(PLUGIN_ROOT, "package.json");
const srcLockfile = path.join(PLUGIN_ROOT, "package-lock.json");
const healthScript = path.join(PLUGIN_ROOT, "tools", "check-deps-health.mjs");
const selfPath = path.join(PLUGIN_ROOT, "tools", "bootstrap-deps.mjs");

/**
 * With --json the JSON line must be the ONLY thing on stdout, because the
 * preflight parses it. Human logs are routed to stderr in that mode rather than dropped:
 * they are still useful in a transcript.
 */
const log = (msg) => {
  if (QUIET) return;
  if (JSON_OUT) console.error(msg);
  else console.log(msg);
};

// Marker line the installer looks for before overwriting: a hook without it
// belongs to the user and is never clobbered.
const HOOK_MARKER = "baudrier commit-msg hook";

/**
 * Install scripts/git-hooks/commit-msg into the session repo's active hooks
 * directory. Claude Code appends a Co-Authored-By trailer and a claude.ai
 * session URL to every commit; the hook strips both. Web VMs are ephemeral,
 * so the install must repeat at every session start - which is exactly when
 * this script runs. Honors core.hooksPath, if the repo sets one, so the hook
 * lands where git actually looks.
 */
function installCommitMsgHook() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const hookSrc = path.join(PLUGIN_ROOT, "scripts", "git-hooks", "commit-msg");
    if (!fs.existsSync(hookSrc)) return;
    const git = (args) => spawnSync("git", ["-C", projectDir, ...args], { encoding: "utf8" });
    const gitDirRes = git(["rev-parse", "--git-dir"]);
    if (gitDirRes.error || gitDirRes.status !== 0) return;

    const configured = git(["config", "--get", "core.hooksPath"]).stdout?.trim();
    let hooksDir;
    if (configured) {
      if (configured.startsWith("~")) hooksDir = path.join(os.homedir(), configured.slice(1));
      else hooksDir = path.isAbsolute(configured) ? configured : path.resolve(projectDir, configured);
    } else {
      hooksDir = path.resolve(projectDir, gitDirRes.stdout.trim(), "hooks");
    }

    const dest = path.join(hooksDir, "commit-msg");
    const content = fs.readFileSync(hookSrc, "utf8");
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, "utf8");
      if (!existing.includes(HOOK_MARKER)) return;
      if (existing === content) return;
    }
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(dest, content, { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
  } catch {
    // A hook problem must never break a session start.
  }
}

/** Emit the machine-readable result (if asked) and exit. */
function finish({ ok, dir, source, action, pointerWritten, health, error }) {
  installCommitMsgHook();
  if (JSON_OUT) {
    console.log(
      JSON.stringify({
        ok,
        dir: dir ?? null,
        source: source ?? null,
        action,
        pointerWritten: !!pointerWritten,
        nodeVersion: process.version,
        health,
        error: error ?? null,
      }),
    );
    process.exit(ok ? 0 : 1);
  }
  // Without --json, never break a session over a dependency problem.
  process.exit(0);
}

function versionParts(v) {
  const m = String(v ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is `have` at least `want`? Inline rather than a semver dependency, because
 * engines.node here is a plain ">=x.y.z" floor and this script must run before
 * any dependency exists. An unparseable value never blocks: guessing wrong in the
 * strict direction would break the harness on a perfectly good Node.
 */
function meetsMinimum(have, want) {
  const a = versionParts(have);
  const b = versionParts(want);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Run the health checker against a directory. Returns {ok, output}. */
function runHealth(dir) {
  const res = spawnSync(process.execPath, [healthScript, "--dir", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: res.status === 0, output: (res.stdout || res.stderr || "").trim() };
}

/* ------------------------------------------------------------------ manifest */

if (!fs.existsSync(srcManifest)) {
  const error = `Aucun package.json trouvé dans ${PLUGIN_ROOT} : rien à installer.`;
  console.error(`[baudrier] no package.json at ${srcManifest} - nothing to install.`);
  finish({ ok: false, dir: null, source: null, action: CHECK_ONLY ? "check" : "failed", pointerWritten: false, health: "skipped", error });
}

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(srcManifest, "utf8"));
} catch (e) {
  const error = `Le fichier ${srcManifest} est illisible : ${e.message}`;
  console.error(`[baudrier] unreadable package.json: ${e.message}`);
  finish({ ok: false, dir: null, source: null, action: CHECK_ONLY ? "check" : "failed", pointerWritten: false, health: "skipped", error });
}

const nodeFloor = manifest?.engines?.node ?? null;
const nodeOk = meetsMinimum(process.version, nodeFloor);
const nodeError = nodeOk
  ? null
  : `Node ${process.version} est trop ancien : le harness exige Node ${nodeFloor}. ` +
    "Mettez Node à jour, puis relancez une session Claude Code.";

/* --------------------------------------------------------------- check mode */

if (CHECK_ONLY) {
  // --check has no side effects on purpose (it is a cheap gate the preflight can
  // call any number of times), so it does not write the pointer. `pointerWritten`
  // therefore reports whether the pointer on disk already agrees with what was
  // resolved - the useful signal at that point.
  const resolved = resolveDepsDir();
  const pointerOk = !!resolved && readPointer() === resolved.dir;

  if (!resolved) {
    const tried = attemptedDirs()
      .map((c) => `${c.dir} [${c.source}]`)
      .join(", ");
    log(`[baudrier] no usable dependencies found (tried: ${tried})`);
    finish({
      ok: false,
      dir: null,
      source: null,
      action: "check",
      pointerWritten: pointerOk,
      health: "skipped",
      error:
        "Les dépendances du harness ne sont pas installées. " +
        `Dossiers examinés : ${tried}. Lancez : node "${selfPath}"`,
    });
  }

  if (!nodeOk) {
    log(`[baudrier] ${nodeError}`);
    finish({ ok: false, dir: resolved.dir, source: resolved.source, action: "check", pointerWritten: pointerOk, health: "skipped", error: nodeError });
  }

  const health = runHealth(resolved.dir);
  if (!health.ok) {
    log(`[baudrier] dependencies present but unusable in ${resolved.dir}`);
    finish({
      ok: false,
      dir: resolved.dir,
      source: resolved.source,
      action: "check",
      pointerWritten: pointerOk,
      health: "broken",
      error:
        `Les dépendances présentes dans ${resolved.dir} ne sont pas utilisables. ` +
        `Diagnostic : node "${healthScript}" --dir "${resolved.dir}". Réparation : node "${selfPath}"`,
    });
  }

  log(`[baudrier] dependencies ready in ${resolved.dir} (${resolved.source}).`);
  finish({ ok: true, dir: resolved.dir, source: resolved.source, action: "check", pointerWritten: pointerOk, health: "ok", error: null });
}

/* ------------------------------------------------------------- install mode */

const target = resolveInstallTarget();
const DATA = target.dir;
const dstManifest = path.join(DATA, "package.json");
const dstLockfile = path.join(DATA, "package-lock.json");
const hasSrcLockfile = fs.existsSync(srcLockfile);

if (!nodeOk) {
  // Attempting the install anyway would fail deep inside npm with EBADENGINE,
  // which reads like a harness bug rather than "update Node".
  console.error(`[baudrier] ${nodeError}`);
  finish({ ok: false, dir: DATA, source: target.source, action: "failed", pointerWritten: false, health: "skipped", error: nodeError });
}

// Step 3: is an install actually needed? Compare content, not mtime. The
// lockfile is part of that comparison too - a manifest that didn't change but
// a lockfile that did (a dependency bump within the same range) still means
// the installed tree is stale.
let needsInstall = true;
if (fs.existsSync(dstManifest) && fs.existsSync(path.join(DATA, "node_modules"))) {
  try {
    const manifestSame = fs.readFileSync(srcManifest, "utf8") === fs.readFileSync(dstManifest, "utf8");
    const lockfileSame = !hasSrcLockfile
      ? true
      : fs.existsSync(dstLockfile) && fs.readFileSync(srcLockfile, "utf8") === fs.readFileSync(dstLockfile, "utf8");
    needsInstall = !(manifestSame && lockfileSame);
  } catch {
    needsInstall = true;
  }
}

if (!needsInstall) {
  // Still refresh the pointer: an install that predates this mechanism (or a
  // pointer someone deleted) would otherwise stay invisible to the Bash side.
  const pointerWritten = writePointer(DATA);
  if (!pointerWritten) console.error(`[baudrier] could not write the deps pointer file (harmless, resolution falls back to a scan).`);
  log("[baudrier] dependencies already up to date.");
  finish({ ok: true, dir: DATA, source: target.source, action: "up-to-date", pointerWritten, health: "skipped", error: null });
}

log(`[baudrier] installing dependencies into ${DATA} ...`);

try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.copyFileSync(srcManifest, dstManifest);
  if (hasSrcLockfile) fs.copyFileSync(srcLockfile, dstLockfile);
} catch (e) {
  console.error(`[baudrier] could not prepare ${DATA}: ${e.message}`);
  finish({
    ok: false,
    dir: DATA,
    source: target.source,
    action: "failed",
    pointerWritten: false,
    health: "skipped",
    error: `Impossible de préparer le dossier ${DATA} : ${e.message}`,
  });
}

// Step 4: install. argv array, never an interpolated shell string (CONTRACT.md §7).
// `npm ci` when a lockfile shipped with the plugin: it installs the exact
// resolved tree instead of re-resolving ranges, and --ignore-scripts refuses
// to run any dependency's install-time scripts. `npm install` stays the
// fallback for the (currently hypothetical) case where the plugin ships
// without a lockfile.
const npmCmd = "npm";
const npmArgs = hasSrcLockfile
  ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error"]
  : ["install", "--no-audit", "--no-fund", "--loglevel", "error"];
const res = spawnSync(npmCmd, npmArgs, {
  cwd: DATA,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 300_000,
  shell: false,
});

if (res.status !== 0) {
  const detail = (res.stderr || res.stdout || `exit ${res.status}`).trim().split("\n").slice(-8).join("\n");
  console.error("[baudrier] npm install failed:");
  console.error(detail);
  // Leave no stale manifest behind, so the next session retries instead of
  // believing the install already succeeded.
  try {
    fs.rmSync(dstManifest, { force: true });
    fs.rmSync(dstLockfile, { force: true });
  } catch {}
  finish({
    ok: false,
    dir: DATA,
    source: target.source,
    action: "failed",
    pointerWritten: false,
    health: "skipped",
    error: `L'installation npm dans ${DATA} a échoué : ${detail.split("\n").slice(-1)[0]}`,
  });
}

// Step 5: an install that "succeeded" can still be unusable.
const health = runHealth(DATA);

if (!health.ok) {
  console.error("[baudrier] dependencies installed but are not usable:");
  console.error(health.output);
  try {
    fs.rmSync(dstManifest, { force: true });
    fs.rmSync(dstLockfile, { force: true });
  } catch {}
  finish({
    ok: false,
    dir: DATA,
    source: target.source,
    action: "failed",
    pointerWritten: false,
    health: "broken",
    error:
      `Les dépendances ont été installées dans ${DATA} mais ne sont pas utilisables. ` +
      `Diagnostic : node "${healthScript}" --dir "${DATA}"`,
  });
}

const pointerWritten = writePointer(DATA);
if (!pointerWritten) console.error("[baudrier] could not write the deps pointer file (harmless, resolution falls back to a scan).");

log("[baudrier] dependencies ready.");
finish({ ok: true, dir: DATA, source: target.source, action: "installed", pointerWritten, health: "ok", error: null });
