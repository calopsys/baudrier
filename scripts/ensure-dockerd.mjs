#!/usr/bin/env node
// ensure-dockerd.mjs - lazily start the Docker daemon when it is not already
// running (CONTRACT.md §1, §5, §7).
//
// A Claude Code web session has the `dockerd` binaries but nothing starts the
// daemon at boot (live-verified: a fresh session has no running daemon). A
// filesystem snapshot cannot preserve a running process, so this must run
// every session, before the first `docker` command - `bootstrap-init.mjs` and
// `deploy.mjs` both call `ensureDocker()` first in their direct build/push
// pipeline (CONTRACT.md §5).
//
// Idempotent and fast once the daemon is already reachable: the `docker info`
// probe below is the only work done in that case.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRemoteSandbox } from "./_platform.mjs";

const POLL_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 1000;

function dockerInfoOk() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  return !r.error && r.status === 0;
}

/**
 * Can this process plausibly start a system daemon? Only root (uid 0, the
 * shape of every Claude Code web sandbox - CONTRACT.md §1, `isRemoteSandbox()`
 * confirms it) or an operator already running as root can. Anyone else gets a
 * clear instruction instead of a permission-denied spawn failure.
 */
function canStartDaemon() {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return isRoot || isRemoteSandbox();
}

function dockerdLogPath() {
  const dir = path.join(os.tmpdir(), "baudrier");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "dockerd.log");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make sure the Docker daemon answers `docker info`, starting it if this
 * process can plausibly do so.
 * @returns {Promise<void>}
 */
export async function ensureDocker() {
  if (dockerInfoOk()) return;

  if (!canStartDaemon()) {
    throw new Error(
      "Docker n’est pas démarré, et cette machine ne permet pas à Baudrier de le démarrer lui-même. " +
        "Installez Docker si besoin, puis démarrez-le (ouvrez Docker Desktop, " +
        "ou lancez `sudo systemctl start docker`), et relancez la commande.",
    );
  }

  const logPath = dockerdLogPath();
  const fd = openSync(logPath, "a");
  const child = spawn("dockerd", [], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dockerInfoOk()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Le démon Docker n’a pas démarré à temps (${Math.round(POLL_TIMEOUT_MS / 1000)}s). Journal : ${logPath}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  if (process.argv.includes("--start")) {
    ensureDocker()
      .then(() => {
        process.stdout.write(JSON.stringify({ running: true }) + "\n");
      })
      .catch((e) => {
        process.stdout.write(JSON.stringify({ running: false, error: e.message }) + "\n");
        process.exitCode = 1;
      });
  } else {
    process.stdout.write(JSON.stringify({ running: dockerInfoOk() }) + "\n");
  }
}
