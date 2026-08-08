#!/usr/bin/env node
/**
 * deps-dir.mjs - the single place that knows where the harness's node_modules is.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Claude Code exports ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA} and
 * ${CLAUDE_PROJECT_DIR} as real environment variables **only** to hook processes
 * and to MCP/LSP subprocesses. A Bash tool call does not get them (verified: a
 * Bash call inside a session sees CLAUDE_CODE_*, CLAUDE_PID, CLAUDE_EFFORT and
 * no CLAUDE_PLUGIN_DATA at all).
 *
 * That asymmetry used to split the harness in two halves that disagreed about
 * where dependencies live:
 *
 *   - tools/bootstrap-deps.mjs runs as a SessionStart *hook*, so it sees
 *     ${CLAUDE_PLUGIN_DATA} and installs into
 *     ~/.claude/plugins/data/<plugin>-<marketplace>/
 *   - scripts/scaleway/*.mjs run under the *Bash tool*, see nothing, and used to
 *     guess ~/.claude/plugins/data/baudrier - a directory that does not exist.
 *
 * The result was that every scripts/scaleway/* call threw "Les dépendances du
 * harness ne sont pas installées", on every OS, in every real install.
 *
 * The plugin data directory id is the plugin identifier with every character
 * outside [a-zA-Z0-9_-] replaced by "-", so an install of `baudrier` from the
 * marketplace `baudrier` yields the directory
 * `baudrier-baudrier`. The marketplace half is chosen by whoever installs
 * the plugin, so that name can never be hardcoded. Two mechanisms bridge the gap
 * instead:
 *
 *   1. a POINTER FILE (~/.claude/baudrier/deps-dir.txt) written by the hook,
 *      which is the only process that knows the authoritative directory, and read
 *      by everything that runs under the Bash tool, which does not;
 *   2. a SCAN of ~/.claude/plugins/data/* for a package.json whose "name" is
 *      "baudrier". This survives any marketplace name and also works when
 *      the pointer was never written (fresh clone, deleted pointer, moved HOME).
 *
 * Both sides of the harness - the installer and the consumers - go through this
 * module, so they can no longer drift apart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * This file lives in <plugin>/tools/, so the plugin root is one level up.
 * Deliberately derived from import.meta.dirname rather than ${CLAUDE_PLUGIN_ROOT}:
 * that variable is exactly the one missing under the Bash tool, and the path on
 * disk is always correct anyway.
 */
export const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");

/** The manifest bootstrap-deps.mjs copies into the data directory. */
export const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, "package.json");

/** `name` in that manifest - the marker the directory scan looks for. */
const MANIFEST_NAME = "baudrier";

/**
 * Last-resort install directory name. Deliberately not the plugin's own name
 * alone: that was the old wrong guess at a real plugin data directory, and
 * reusing it would make a fallback install look like the authoritative one.
 */
const FALLBACK_DIR_NAME = "baudrier-fallback";

/**
 * os.homedir() reads the password database, which can disagree with the running
 * user's HOME (containers, `sudo -E`), and on Windows the value that matters is
 * USERPROFILE. Try the environment first, exactly as bootstrap-deps.mjs has
 * always done, so behaviour is identical on Windows.
 */
export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
}

/** ~/.claude/plugins/data - the parent of every plugin's data directory. */
export function pluginDataParent() {
  const home = homeDir();
  return home ? path.join(home, ".claude", "plugins", "data") : "";
}

/**
 * The pointer file. Kept outside plugins/data on purpose: a plugin update or a
 * marketplace rename rewrites that tree, and the pointer must survive both.
 */
export function pointerFile() {
  const home = homeDir();
  return home ? path.join(home, ".claude", "baudrier", "deps-dir.txt") : "";
}

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasNodeModules(dir) {
  return isDir(path.join(dir, "node_modules"));
}

function readIfFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Record the authoritative directory. Called by bootstrap-deps.mjs, which runs as
 * a hook and therefore knows it. Never throws: a missing pointer only means the
 * readers fall through to the scan, which is slower but correct.
 */
export function writePointer(dir) {
  const file = pointerFile();
  if (!file || !dir) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${path.resolve(dir)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The directory the pointer file names, or null. Not validated here. */
export function readPointer() {
  const raw = readIfFile(pointerFile());
  if (!raw) return null;
  const dir = raw.trim();
  return dir ? path.resolve(dir) : null;
}

/**
 * Every ~/.claude/plugins/data/* directory that holds this harness's manifest,
 * best first. "Best" means: package.json byte-identical to the plugin's own copy
 * (that copy is what bootstrap-deps.mjs writes, so an exact match is almost
 * certainly the install produced by the plugin version now running), then most
 * recently modified.
 */
function scanDataDirs({ requireNodeModules }) {
  const parent = pluginDataParent();
  if (!isDir(parent)) return [];

  const own = readIfFile(PLUGIN_MANIFEST);
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(parent, entry.name);
    const manifest = readIfFile(path.join(dir, "package.json"));
    if (!manifest) continue;
    let name = null;
    try {
      name = JSON.parse(manifest)?.name ?? null;
    } catch {
      continue; // a corrupt manifest is not a match, and must not abort the scan
    }
    if (name !== MANIFEST_NAME) continue;
    if (requireNodeModules && !hasNodeModules(dir)) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, "package.json")).mtimeMs;
    } catch {}
    hits.push({ dir, identical: own !== null && manifest === own, mtime });
  }

  hits.sort((a, b) => Number(b.identical) - Number(a.identical) || b.mtime - a.mtime);
  return hits.map((h) => h.dir);
}

/**
 * Candidate directories in reading order.
 *
 * BAUDRIER_DEPS_DIR short-circuits everything: an explicit override that quietly
 * fell through to some other directory would hide exactly the class of bug this
 * module exists to fix, so when it is set it is the only answer - right or wrong.
 */
function candidates({ requireNodeModules }) {
  const out = [];
  const push = (dir, source) => {
    if (dir) out.push({ dir: path.resolve(dir), source });
  };

  if (process.env.BAUDRIER_DEPS_DIR) {
    push(process.env.BAUDRIER_DEPS_DIR, "env-override");
    return out;
  }

  push(process.env.CLAUDE_PLUGIN_DATA, "plugin-data-env"); // hooks and MCP only
  push(readPointer(), "pointer"); // written by the hook, read by the Bash side
  for (const dir of scanDataDirs({ requireNodeModules })) push(dir, "scan");
  push(PLUGIN_ROOT, "repo"); // dev checkout with a local node_modules
  return out;
}

/**
 * Resolve the directory whose node_modules the harness should use.
 *
 * @param {{requireNodeModules?: boolean}} [opts] when true (the default) a
 *   candidate only counts if <dir>/node_modules exists.
 * @returns {{dir: string, source: "env-override"|"plugin-data-env"|"pointer"|"scan"|"repo"}|null}
 */
export function resolveDepsDir({ requireNodeModules = true } = {}) {
  for (const c of candidates({ requireNodeModules })) {
    if (requireNodeModules ? hasNodeModules(c.dir) : isDir(c.dir)) {
      return { dir: c.dir, source: c.source };
    }
  }
  return null;
}

/**
 * The candidates that were (or would be) tried, for diagnostics. Error messages
 * name them so a user can see which directories were looked at.
 */
export function attemptedDirs({ requireNodeModules = true } = {}) {
  return candidates({ requireNodeModules }).map(({ dir, source }) => ({ dir, source }));
}

/**
 * Where to install INTO. Unlike reading, this must return a directory even when
 * nothing is installed yet, so it never requires node_modules.
 *
 * An existing install found by the scan wins over inventing a new directory even
 * if its node_modules is missing or half-written: reinstalling in place keeps one
 * copy of the dependencies instead of two.
 */
export function resolveInstallTarget() {
  if (process.env.BAUDRIER_DEPS_DIR) {
    return { dir: path.resolve(process.env.BAUDRIER_DEPS_DIR), source: "env-override" };
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return { dir: path.resolve(process.env.CLAUDE_PLUGIN_DATA), source: "plugin-data-env" };
  }
  const scanned = scanDataDirs({ requireNodeModules: false });
  if (scanned.length) return { dir: scanned[0], source: "scan" };

  const parent = pluginDataParent();
  if (parent) return { dir: path.join(parent, FALLBACK_DIR_NAME), source: "fallback" };

  return { dir: PLUGIN_ROOT, source: "repo" };
}

/** The directory to install into, as a plain path. */
export function installTargetDir() {
  return resolveInstallTarget().dir;
}

// Self-test / diagnostics. `pathToFileURL(argv[1])` rather than a `file://${...}`
// template because on Windows argv[1] is `C:\a\b.mjs` and the template never
// matches import.meta.url (CONTRACT.md §7).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const resolved = resolveDepsDir();
  const target = resolveInstallTarget();
  console.log(`▸ plugin root      : ${PLUGIN_ROOT}`);
  console.log(`▸ pointeur         : ${pointerFile()} ${readPointer() ? `-> ${readPointer()}` : "(absent)"}`);
  console.log(`▸ lecture          : ${resolved ? `${resolved.dir} [${resolved.source}]` : "(aucune installation trouvée)"}`);
  console.log(`▸ cible d'install  : ${target.dir} [${target.source}]`);
  for (const c of attemptedDirs()) console.log(`   - candidat ${c.dir} [${c.source}]`);
  console.log(JSON.stringify({ ok: !!resolved, dir: resolved?.dir ?? null, source: resolved?.source ?? null, installTarget: target.dir }));
}
