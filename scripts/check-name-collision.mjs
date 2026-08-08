#!/usr/bin/env node
// check-name-collision.mjs - /bootstrap name guard.
//
// Before creating a project, verify the proposed name does not TOKEN-collide
// with an existing project on this account. A collision is exactly what forces
// /delete-project to fall back on its (imperfect) ownership heuristic later:
// deleting "street" would otherwise sweep up everything of "street-cool". We
// catch it at creation, where it is cheap to fix, and propose token-disjoint
// alternatives when the name can be auto-disambiguated.
//
// Existing names come from the same sources as the /delete-project ownership
// pass, so the two skills agree on what "collides" means:
//   1. sibling folders of the parent dir (where the project will be created),
//   2. the Scaleway Project list (REST, account/v3/projects) - CONTRACT.md:
//      one Scaleway Project per app, so this is the same axis bootstrap-init.mjs
//      itself uses when it creates the project (scwProject step).
// Every source is fault-tolerant: a missing credential or an absent CLI just
// drops that source (reported in `sources`), it never aborts the guard.
//
// Usage:
//   node check-name-collision.mjs --name <kebab> [--parent-dir <path>]
//
// Output: a single JSON object on stdout. A collision is NOT an error (exit 0):
// the caller decides what to do. Exit 1 only on a usage error (missing/invalid
// --name).
//
//   {
//     "proposed": "street",
//     "normalized": "street",
//     "status": "ok" | "exact" | "subset" | "superset" | "both",
//     "collisions": [ { "name": "street-cool", "relation": "proposed-is-subset-of" } ],
//     "suggestions": ["street-app", "street-web"],
//     "existingCount": 42,
//     "sources": { "siblings": true, "scaleway": false },
//     "notes": [ ... ]
//   }
//
// Relations (from the proposed name's point of view):
//   exact                  -> a project with this exact name already exists.
//   proposed-is-subset-of  -> the name is a token inside a LONGER existing name
//                             (deleting it later is the dangerous direction ->
//                             auto-fixable by lengthening, suggestions given).
//   proposed-is-superset-of-> the name CONTAINS a shorter existing name as a
//                             token (cannot be auto-disambiguated by affixing;
//                             suggestions may be empty -> the caller warns).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenMatches, normalizeName } from "./_match.mjs";
import { loadCredentials, api, sdkCall } from "./scaleway/_scw-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const NAME = arg("--name");
const PARENT_DIR = arg("--parent-dir") || process.cwd();
if (!NAME) {
  console.error("Usage: node check-name-collision.mjs --name <kebab> [--parent-dir <path>]");
  process.exit(1);
}
// Same kebab constraint as bootstrap-init.mjs (2-50 chars), so a name that
// passes the guard is guaranteed creatable.
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(NAME)) {
  console.error(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${NAME}`);
  process.exit(1);
}
const P = normalizeName(NAME);

// ─── sources ─────────────────────────────────────────────────────────────
function fromSiblings() {
  try {
    const names = [];
    for (const e of readdirSync(PARENT_DIR, { withFileTypes: true })) {
      if (names.length >= 500) break;
      if (e.isDirectory() && !e.name.startsWith(".")) names.push(e.name);
    }
    return { names, ok: true };
  } catch {
    return { names: [], ok: false };
  }
}

// CONTRACT.md: one Scaleway Project per app. `bootstrap-init.mjs`'s scwProject
// step slugifies `--name` and finds-or-creates a Project with that slug, so
// the Scaleway Project list is exactly the axis to check for collisions on.
// Uses the SDK's Account.v3.ProjectAPI directly (same namespace/class
// bootstrap-init.mjs's scwProject() uses) rather than the raw
// /account/v3/projects endpoint.
// Soft-fails (returns ok:false) if credentials aren't configured or the
// organization id is missing - this guard must never be the reason /bootstrap
// can't proceed, it only adds signal when it can.
async function fromScaleway() {
  const creds = loadCredentials();
  if (!creds.accessKey || !creds.secretKey || !creds.organizationId) return { names: [], ok: false };
  try {
    const projectsApi = await api("Account", "v3", "ProjectAPI");
    const projects = await sdkCall(() => projectsApi.listProjects({ organizationId: creds.organizationId }).all());
    return { names: projects.map((p) => p.name).filter(Boolean), ok: true };
  } catch {
    return { names: [], ok: false };
  }
}

// ─── suggestion generator ──────────────────────────────────────────────────
const AFFIXES = ["app", "web", "site", "hq", "studio", "pro", "io", "hub", "2", "3", "4"];

function isKebabLen(s) {
  return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(s);
}

// A candidate is a SAFE suggestion when its own future deletion cannot sweep a
// sibling, i.e. it is not a token-SUBSET of any existing name (the dangerous
// direction) and not an exact dupe. Being a token-SUPERSET of an existing name
// is allowed: that is the natural disambiguation for an exact clash
// ("cool-trattoria" -> "cool-trattoria-2"), and the /delete-project ownership
// pass already protects the longer name against the shorter one.
function isSafeSuggestion(cand, existing) {
  const c = normalizeName(cand);
  for (const e of existing) {
    if (!e) continue;
    if (c === e) return false;
    if (tokenMatches(c, e)) return false; // c is a subset of e -> dangerous
  }
  return true;
}

// Only meaningful for `exact` and `subset`. For `superset`/`both` the proposed
// name CONTAINS a shorter existing name as a token, which no affix can remove,
// so we return [] and let the caller warn + ask for a different name.
function buildSuggestions(existing) {
  const out = [];
  const seen = new Set();
  for (const affix of AFFIXES) {
    for (const cand of [`${P}-${affix}`, `${affix}-${P}`]) {
      if (seen.has(cand) || !isKebabLen(cand)) continue;
      seen.add(cand);
      if (isSafeSuggestion(cand, existing)) out.push(cand);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

// ─── orchestration ─────────────────────────────────────────────────────────
const siblings = fromSiblings();
const scaleway = await fromScaleway();

const sources = { siblings: siblings.ok, scaleway: scaleway.ok };
const notes = [];
if (!scaleway.ok) notes.push("Scaleway Project list unavailable (no access key, secret key, or organization id found in the environment variables, or the API call failed): a Scaleway-only name clash cannot be seen.");

// Dedup the existing names (normalized).
const existing = [...new Set(
  [...siblings.names, ...scaleway.names].map(normalizeName).filter(Boolean),
)];

// Classify every collision from the proposed name's point of view.
const collisions = [];
let hasExact = false, hasSubset = false, hasSuperset = false;
for (const e of existing) {
  if (e === P) {
    collisions.push({ name: e, relation: "exact" });
    hasExact = true;
  } else if (tokenMatches(P, e)) {
    // P appears as a whole token inside the longer name e.
    collisions.push({ name: e, relation: "proposed-is-subset-of" });
    hasSubset = true;
  } else if (tokenMatches(e, P)) {
    // The shorter existing name e appears as a token inside P.
    collisions.push({ name: e, relation: "proposed-is-superset-of" });
    hasSuperset = true;
  }
}

let status = "ok";
if (hasExact) status = "exact";
else if (hasSubset && hasSuperset) status = "both";
else if (hasSubset) status = "subset";
else if (hasSuperset) status = "superset";

// Auto-disambiguation is only possible when we can affix the name without
// leaving a contained sibling token: that is the exact and subset cases. For
// superset/both, the name wraps a shorter existing project name and must be
// changed by hand.
const suggestions = (status === "exact" || status === "subset") ? buildSuggestions(existing) : [];

console.log(JSON.stringify({
  proposed: NAME,
  normalized: P,
  status,
  collisions,
  suggestions,
  existingCount: existing.length,
  sources,
  notes,
}, null, 2));
