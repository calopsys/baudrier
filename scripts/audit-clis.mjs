#!/usr/bin/env node
// audit-clis.mjs - Report which CLIs are installed and logged in, WITHOUT ever hanging.
//
// Every check runs with its own timeout, so one slow service degrades to
// `timeout` on that row only instead of burning the whole Bash tool call's
// 2-minute budget.
//
//   node audit-clis.mjs              # human table on stdout
//   node audit-clis.mjs --json       # machine-readable
//   node audit-clis.mjs --timeout 8  # per-check timeout in seconds (default 10)
//
// Exit code is always 0: "tool missing" is a finding to report, not a script failure.
//
// `gh` and `scw` are no longer probed here (CONTRACT.md §7): `gh` is not part
// of the toolchain at all (the repo-access gate is `git ls-remote origin`,
// never a `gh` auth check), and Scaleway credentials are env-only, resolved
// by `scripts/scaleway/_scw-auth.mjs` - there is no CLI login state to check
// for either. Whether the Scaleway credentials are actually valid is verified
// separately with a live API call (`_check-deps scaleway` /
// `scripts/check-deps.mjs scaleway`), not here.
//
// Node also gets a MINIMUM VERSION check, because "installed" is not "usable":
// Debian trixie's apt `nodejs` is 20.19.2, below this plugin's
// engines.node ">=20.20.2", and npm only *warns* (EBADENGINE) instead of
// failing - so the breakage lands late and looks unrelated. That row reports
// `outdated`, a status of its own, never `ready`.
//
// `docker`'s row also reports whether the DAEMON is reachable
// (`daemonRunning`), separately from the CLI being installed - a Claude Code
// web sandbox has the `docker` binary but nothing starts `dockerd` at boot
// (CONTRACT.md §1); this probe never starts it itself (that is
// `scripts/ensure-dockerd.mjs`'s job, run lazily by the build pipeline), it
// only reports the current state.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isRemoteSandbox } from "./_platform.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const ti = args.indexOf("--timeout");
const TIMEOUT_MS = (ti >= 0 && Number(args[ti + 1]) ? Number(args[ti + 1]) : 10) * 1000;

// The floor lives in package.json's engines.node - that is the source of truth,
// and the literal below is only the last-resort fallback if that file is
// unreadable (the plugin cache is read-only, but not guaranteed complete).
const NODE_MIN_FALLBACK = "20.20.2";

function requiredNodeVersion() {
  try {
    // Resolved relative to THIS script, not to cwd: the plugin is invoked from
    // whatever directory the user's project happens to be in.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const parsed = parseSemver(pkg?.engines?.node);
    if (parsed) return parsed.join(".");
  } catch {
    // fall through to the pinned fallback
  }
  return NODE_MIN_FALLBACK;
}

/** "v20.19.2" / ">=20.20.2" / "git version 2.47.2" -> [20,19,2]. */
function parseSemver(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when `installed` >= `required`. Tiny inline compare - no dependency. */
function meetsMinimum(installed, required) {
  const a = parseSemver(installed);
  const b = parseSemver(required);
  if (!a || !b) return true; // unparseable: do not invent a failure
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

// `login: null` = nothing to log into (version check is enough).
// `min` = minimum usable version; absent means any version is fine.
const TOOLS = [
  { name: "node", version: "node --version", login: null, min: requiredNodeVersion() },
  { name: "pnpm", version: "pnpm --version", login: null },
  { name: "git", version: "git --version", login: null },
  { name: "docker", version: "docker --version", login: null },
];

function run(cmd) {
  // Single command string + shell:true (an args array alongside shell:true trips
  // Node's DEP0190 warning and pollutes the output).
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error && (r.error.code === "ETIMEDOUT" || r.signal)) return { timedOut: true };
  if (r.error) return { ok: false, out: r.error.message };
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { ok: r.status === 0, out };
}

// First non-empty line, ANSI stripped, capped - enough to show a version or an account.
function firstLine(s) {
  const clean = (s || "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  const line = clean.split(/\r?\n/).find((l) => l.trim()) || "";
  return line.trim().slice(0, 90);
}

const results = [];
for (const t of TOOLS) {
  const v = run(t.version);
  if (v.timedOut) {
    results.push({ tool: t.name, status: "timeout", detail: `\`${t.version}\` did not answer in ${TIMEOUT_MS / 1000}s` });
    continue;
  }
  if (!v.ok) {
    results.push({ tool: t.name, status: "missing", detail: firstLine(v.out) });
    continue;
  }
  const version = firstLine(v.out);
  if (t.min && !meetsMinimum(version, t.min)) {
    // Installed but below the floor: distinct from `missing` (nothing to
    // install) and from `ready` (nothing to do). /start must offer an upgrade.
    results.push({
      tool: t.name,
      status: "outdated",
      version,
      required: t.min,
      detail: `${version} est inférieur au minimum requis ${t.min}`,
    });
    continue;
  }
  if (!t.login) {
    results.push({ tool: t.name, status: "ready", version });
    continue;
  }
  const l = run(t.login);
  if (l.timedOut) {
    results.push({ tool: t.name, status: "timeout", version, detail: `\`${t.login}\` did not answer in ${TIMEOUT_MS / 1000}s` });
  } else if (!l.ok) {
    results.push({ tool: t.name, status: "logged-out", version, detail: firstLine(l.out) });
  } else {
    results.push({ tool: t.name, status: "ready", version, account: firstLine(l.out) });
  }
}

// Every row for a tool that has a floor carries `required`, so a caller never has
// to know which statuses happen to include it.
for (const r of results) {
  const t = TOOLS.find((x) => x.name === r.tool);
  if (t?.min && !r.required) r.required = t.min;
}

// The daemon is a separate concern from the CLI being installed (see the
// header comment) - only probed when the CLI itself is usable, and never
// started here.
const dockerResult = results.find((r) => r.tool === "docker");
if (dockerResult) {
  dockerResult.daemonRunning = dockerResult.status === "ready" ? run("docker info").ok === true : false;
}

// /start reports the environment back to the user, and remote-sandbox
// detection changes what the rest of the harness can do (no persistence
// outside /tmp - CONTRACT.md §7), so it belongs in the same payload rather
// than a second probe.
const env = { remoteSandbox: isRemoteSandbox() };

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ results, timeoutSeconds: TIMEOUT_MS / 1000, ...env }, null, 2) + "\n");
} else {
  const ICON = { ready: "OK      ", "logged-out": "LOGGEDOUT", missing: "MISSING ", timeout: "TIMEOUT ", outdated: "OUTDATED" };
  for (const r of results) {
    const daemonNote = r.tool === "docker" ? ` (daemon: ${r.daemonRunning ? "running" : "stopped"})` : "";
    const extra = (r.account || r.detail || r.version || "") + daemonNote;
    process.stdout.write(`${ICON[r.status] || r.status}  ${r.tool.padEnd(9)} ${extra}\n`);
  }
  if (env.remoteSandbox) process.stdout.write("\nEnvironnement : bac à sable Claude Code web\n");
  const bad = results.filter((r) => r.status !== "ready");
  process.stdout.write(
    bad.length
      ? `\n${bad.length} tool(s) need attention: ${bad.map((b) => `${b.tool} (${b.status})`).join(", ")}\n`
      : "\nAll tools installed and connected.\n",
  );
}
