#!/usr/bin/env node
// setup-git-identity.mjs - Make sure `git commit` can actually run.
//
// WHY THIS EXISTS
// ---------------
// /start installs git but never configures it. Git refuses to create a commit
// without user.name and user.email:
//
//   Identité d'auteur inconnue
//   *** Veuillez me dire qui vous êtes.
//
// Every commit the harness makes on the user's behalf (/bootstrap's first
// commit, /deploy's push, every add-* skill that commits its own scaffolding)
// dies on that error. A non-technical user has no idea what it means, and it
// surfaces in the middle of a deploy rather than during onboarding.
//
// WHERE THE VALUES COME FROM
// --------------------------
// Asking a non-technical user to type a name and an email is a bad first
// experience, and the email is the part they are most likely to get wrong in a
// way that matters (a mismatched address means GitHub never attributes their
// commits to their account). So by default we derive both from the app's own
// `origin` remote (git already knows it - `gh` is no longer part of the
// toolchain, CONTRACT.md §7): the owner segment of `github.com/<owner>/<repo>`.
//
// The email defaults to GitHub's generic no-reply form, `<owner>@users.noreply
// .github.com`, rather than the account's public address. GitHub still
// attributes a commit authored with that address to the matching account, so
// attribution works, and it is the only choice that cannot leak a personal
// address into the permanent history of a public repository. It also
// sidesteps the "Block command line pushes that expose my email" setting,
// which otherwise rejects the push with an error no beginner can act on.
// (The numeric-id form, `<id>+<login>@users.noreply.github.com`, needs a real
// GitHub API call to resolve the id - no longer available here without `gh`.)
//
// SCOPE
// -----
// Written with `git config --global`, matching the rest of /start's
// machine-level setup (global CLAUDE.md, the global Gitleaks hook, the durable
// SCW_* environment variables). An existing identity is NEVER overwritten:
// this only fills a gap, it does not take over a configured machine.
//
// USAGE
//   node setup-git-identity.mjs --json                    # inspect only, no writes
//   node setup-git-identity.mjs --name "X" --email "y@z" --json   # write
//   node setup-git-identity.mjs --json --local            # write to this repo only
//
// Output: exactly one JSON line on stdout.
//   status: "already-set"  nothing to do
//           "needs-input"  no identity, and gh could not supply one - ask the user
//           "suggested"    no identity, but gh gave us values to confirm
//           "written"      identity persisted
//   Exit 0 in every one of those cases: "not configured yet" is a finding to
//   report, not a script failure. Exit 1 only on bad usage or a failed write.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const LOCAL = args.includes("--local");

function arg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

// argv array, never an interpolated shell string, for shell-injection safety (CONTRACT.md §7).
function run(cmd, argv, timeout = 15_000) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", timeout });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout || ""}`.trim(), err: `${r.stderr || ""}`.trim() };
}

const SCOPE = LOCAL ? "--local" : "--global";

/** Whatever git already knows. Either field may be missing independently. */
export function currentIdentity() {
  const name = run("git", ["config", SCOPE, "user.name"]);
  const email = run("git", ["config", SCOPE, "user.email"]);
  return {
    name: name.ok && name.out ? name.out : null,
    email: email.ok && email.out ? email.out : null,
  };
}

/**
 * Derive a name and a no-reply email from the app's own `origin` remote -
 * git already knows it, no GitHub API call needed (`gh` is no longer part of
 * the toolchain, CONTRACT.md §7). Best-effort: no `origin`, or a non-GitHub
 * remote, and this returns null rather than throwing.
 */
export function suggestFromGitHub() {
  const r = run("git", ["remote", "get-url", "origin"]);
  if (!r.ok || !r.out) return null;
  const m = r.out.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) return null;
  const owner = m[1];
  return {
    name: owner,
    email: `${owner}@users.noreply.github.com`,
    login: owner,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Persist an identity. Returns the values actually written. */
export function writeIdentity(name, email) {
  if (!name || !String(name).trim()) throw new Error("le nom ne peut pas être vide");
  if (!EMAIL_RE.test(String(email || ""))) throw new Error(`adresse e-mail invalide : "${email}"`);
  const n = run("git", ["config", SCOPE, "user.name", String(name).trim()]);
  if (!n.ok) throw new Error(`git config user.name a échoué : ${n.err || n.out}`);
  const e = run("git", ["config", SCOPE, "user.email", String(email).trim()]);
  if (!e.ok) throw new Error(`git config user.email a échoué : ${e.err || e.out}`);
  return { name: String(name).trim(), email: String(email).trim() };
}

function main() {
  const out = (payload) => {
    if (JSON_OUT) process.stdout.write(JSON.stringify(payload) + "\n");
    return payload;
  };

  if (!run("git", ["--version"], 8_000).ok) {
    out({ ok: false, status: "no-git", reason: "git n’est pas installé sur cette machine." });
    if (!JSON_OUT) console.error("❌ git n’est pas installé.");
    process.exit(1);
  }

  const wantName = arg("--name");
  const wantEmail = arg("--email");

  // Explicit values: write them, whatever is already there. This is the branch
  // /start uses after the user has confirmed or corrected the suggestion.
  if (wantName || wantEmail) {
    if (!wantName || !wantEmail) {
      out({ ok: false, status: "usage", reason: "--name et --email doivent être fournis ensemble." });
      process.exit(1);
    }
    try {
      const written = writeIdentity(wantName, wantEmail);
      out({ ok: true, status: "written", scope: LOCAL ? "local" : "global", ...written });
      if (!JSON_OUT) console.log(`✅ Identité git enregistrée : ${written.name} <${written.email}>`);
      return;
    } catch (err) {
      out({ ok: false, status: "write-failed", reason: err.message });
      if (!JSON_OUT) console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  }

  // Inspection mode.
  const current = currentIdentity();
  if (current.name && current.email) {
    out({ ok: true, status: "already-set", scope: LOCAL ? "local" : "global", ...current });
    if (!JSON_OUT) console.log(`✅ Identité git déjà configurée : ${current.name} <${current.email}>`);
    return;
  }

  const suggested = suggestFromGitHub();
  if (suggested) {
    out({
      ok: true,
      status: "suggested",
      scope: LOCAL ? "local" : "global",
      current,
      suggested: { name: suggested.name, email: suggested.email },
      githubLogin: suggested.login,
    });
    if (!JSON_OUT) {
      console.log(`▸ Aucune identité git. Proposition depuis GitHub : ${suggested.name} <${suggested.email}>`);
    }
    return;
  }

  out({
    ok: true,
    status: "needs-input",
    scope: LOCAL ? "local" : "global",
    current,
    reason: "Aucun nom ni adresse n’a pu être déduit (pas de remote `origin` GitHub configuré).",
  });
  if (!JSON_OUT) console.log("▸ Aucune identité git, et aucune proposition n’a pu être déduite du dépôt.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
