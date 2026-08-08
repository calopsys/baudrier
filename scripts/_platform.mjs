#!/usr/bin/env node
// _platform.mjs - The single place that knows WHERE the harness is running.
//
// USAGE (module):
//   import { isRemoteSandbox } from "./_platform.mjs";
//
// USAGE (self-test):
//   node _platform.mjs        # prints the detected environment as JSON

import { platform } from "node:os";
import { pathToFileURL } from "node:url";

// ─── Remote sandbox detection ──────────────────────────────────────────
let _isRemoteSandbox;
/**
 * Are we running in a Claude Code web sandbox VM, not the maintainer's own
 * machine?
 *
 * `BAUDRIER_FORCE_REMOTE` is a test override and wins over everything else:
 * "1"/"true" forces true, any other set value forces false.
 */
export function isRemoteSandbox() {
  if (_isRemoteSandbox !== undefined) return _isRemoteSandbox;
  try {
    if (process.env.BAUDRIER_FORCE_REMOTE !== undefined) {
      _isRemoteSandbox = ["1", "true"].includes(process.env.BAUDRIER_FORCE_REMOTE);
    } else {
      _isRemoteSandbox = ["true", "1"].includes(process.env.CLAUDE_CODE_REMOTE);
    }
  } catch {
    _isRemoteSandbox = false;
  }
  return _isRemoteSandbox;
}

// ─── Self-test ────────────────────────────────────────────────────────
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  process.stdout.write(
    JSON.stringify(
      {
        platform: platform(),
        remoteSandbox: isRemoteSandbox(),
      },
      null,
      2,
    ) + "\n",
  );
}
