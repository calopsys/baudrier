#!/usr/bin/env node
// discover-resources.mjs - Phase 1 of /delete-project: read-only inventory of
// every Scaleway resource tied to one app.
//
// Usage:
//   node discover-resources.mjs --project <name> --project-dir <path>
//
// IMPORTANT - database and storage are inventoried here for REPORTING ONLY.
// Per direct user requirement, /delete-project must never be able to destroy
// a database or a bucket (see execute-deletions.mjs's header for the hard
// guarantee on the deletion side). `database` and `storage` below exist
// purely so Phase 4's French handoff can tell the user exactly what was
// deliberately left behind, with its name and a console URL - never so
// execute-deletions.mjs can act on them.
//
// CONTRACT.md: one Scaleway Project per app. So the whole discovery pivots on
// resolving that ONE Project id first (resolveScwProject), then listing every
// resource TYPE scoped by `project_id=<that id>` - which every Scaleway
// product used by the harness supports as a list filter (containers,
// registry namespaces, Serverless Jobs, Serverless SQL databases, Secret
// Manager secrets, TEM domains - confirmed by reading how each
// scripts/scaleway/*.mjs module's own find-or-create helpers already filter
// their "does this exist yet" lookups). That means almost nothing here needs
// the name/token-matching heuristics upstream relied on: a resource that
// lives inside the app's own Project unambiguously belongs to the app.
//
// Two exceptions remain, and get the collision guard from ../_match.mjs:
//   - IAM Applications/API keys are Organization-scoped, not Project-scoped
//     (see scripts/scaleway/iam.mjs's own header comment) - there is no
//     `project_id` filter to lean on, so they are attributed by name
//     (exact match for the deterministic `baudrier-agents-<projectId>`
//     naming used by setup-agent.mjs, token match + moreSpecificOwner
//     disambiguation for everything else, e.g. `<project>-db`).
//   - DNS: the app's custom domain and TEM sender domain live in the USER'S
//     OWN external domain, which is not itself a resource "in" the Project
//     the way a container or a database is. We only ever touch the specific
//     records the harness added (CNAME to the container, TEM verification
//     records), never the zone as a whole - see scanDns() below.
//
// Design: every scan is fault-tolerant (Promise.all, no scan throwing aborts
// the others) and 100% read-only - no mutation happens in this script.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REGION, requireCredentials, resolveProjectId, api, sdkCall, slugify } from "../scaleway/_scw-auth.mjs";
import { listCustomDomains } from "../scaleway/container.mjs";
import { listImages } from "../scaleway/registry.mjs";
import { listJobDefinitions } from "../scaleway/jobs.mjs";
import { listSecrets, getSecret, secretExists } from "../scaleway/secrets.mjs";
import { listApiKeys } from "../scaleway/iam.mjs";
import { bucketExists } from "../scaleway/object-storage.mjs";
import { zoneExists, listRecords } from "../scaleway/dns.mjs";
import { tokenMatches, moreSpecificOwner } from "../_match.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const TEMPLATES_DIR = join(PLUGIN_ROOT, "templates", "delete-project");

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const PROJECT = arg("--project");
if (!PROJECT) {
  console.error("Usage: node discover-resources.mjs --project <name> --project-dir <path>");
  process.exit(1);
}
const PROJECT_SLUG = slugify(PROJECT);
const PROJECT_DIR = arg("--project-dir") || process.cwd();

// ─── SDK namespaces for the Scaleway sub-resources not wrapped by a scripts/
// scaleway/*.mjs export (documented endpoints, mirroring how bootstrap-init.mjs
// already calls the Account SDK directly for Projects - CONTRACT.md's module
// list is deliberately not exhaustive of every SDK method). Container uses
// **v1** (v1beta1 was deprecated 2026-07-09, per CONTRACT.md's version-choice
// guidance) - note its Container type exposes `publicEndpoint`, not the
// v1beta1-era `domainName` field.

// ─── Scaleway console deep links, scoped by project id ─────────────────────
// Used only for the Phase 4 handoff message (never for any API call - this
// script never deletes anything). Best-effort convenience links: the
// `?project=<id>` filter is Scaleway console's standard convention for
// scoping a resource list to one Project. If a link is ever stale (console
// redesign), the resource name/id printed alongside it is always enough for
// the user to find it by hand.
function consoleProjectUrl(projectId) {
  return `https://console.scaleway.com/project/settings?project=${projectId}`;
}
function consoleDatabasesUrl(projectId) {
  return `https://console.scaleway.com/serverless-sql-databases/databases?project=${projectId}`;
}
function consoleBucketsUrl(projectId) {
  return `https://console.scaleway.com/object-storage/buckets?project=${projectId}`;
}

// ─── 0. Resolve the app's own Scaleway Project ─────────────────────────────
// Resolved by name (CONTRACT.md §2, §7 - app repos carry no Scaleway metadata
// at all): the same axis check-name-collision.mjs already uses at creation
// time, so the two skills agree on identity. When the org-wide Project list
// is reachable, it also feeds `ownerCandidates` for the IAM ownership guard
// below - degrade to the env map/override / session cache (resolveProjectId())
// instead of aborting discovery when it is not (missing ProjectManager).
async function resolveScwProject() {
  const creds = requireCredentials();
  const projectsApi = await api("Account", "v3", "ProjectAPI");

  let all = [];
  let orgListFailed = false;
  try {
    all = await sdkCall(() => projectsApi.listProjects({ organizationId: creds.organizationId }).all());
  } catch (e) {
    if (e?.status !== 403) throw e;
    orgListFailed = true;
  }
  // Every OTHER project name in the org - feeds the IAM ownership guard below.
  const ownerCandidates = all.map((p) => p.name).filter((n) => n && n !== PROJECT_SLUG);
  const orgListNote =
    "Liste des projets de l’organisation indisponible (droits ProjectManager manquants).";

  if (!orgListFailed) {
    const hit = all.find((p) => p.name === PROJECT_SLUG);
    return {
      found: !!hit,
      id: hit?.id || null,
      name: hit?.name || null,
      organizationId: creds.organizationId,
      via: hit ? "name-lookup" : null,
      ownerCandidates,
    };
  }

  try {
    const id = await resolveProjectId({ appName: PROJECT_SLUG });
    return {
      found: true,
      id,
      name: null,
      organizationId: creds.organizationId,
      via: "env-or-cache",
      ownerCandidates,
      note: `${orgListNote} Identifiant repris de SCW_DEFAULT_PROJECT_ID ou du cache de session.`,
    };
  } catch {
    return {
      found: false,
      id: null,
      name: null,
      organizationId: creds.organizationId,
      via: null,
      ownerCandidates,
      note: `${orgListNote} Aucun identifiant de projet exploitable (SCW_DEFAULT_PROJECT_ID absent, cache de session vide) - projet non résolu.`,
    };
  }
}

// ─── 1. Serverless Containers: namespace(s) + containers + custom domains ──
async function scanContainers(projectId) {
  const containersApi = await api("Container", "v1");
  const namespaces = await sdkCall(() => containersApi.listNamespaces({ projectId, region: REGION }).all());
  const out = [];
  for (const ns of namespaces) {
    const containers = await sdkCall(() => containersApi.listContainers({ namespaceId: ns.id, region: REGION }).all());
    const withDomains = [];
    for (const c of containers) {
      let domains = [];
      try {
        domains = await listCustomDomains(c.id);
      } catch {
        domains = [];
      }
      withDomains.push({
        id: c.id,
        name: c.name,
        domainName: c.publicEndpoint,
        customDomains: domains.map((d) => ({ id: d.id, hostname: d.hostname })),
      });
    }
    out.push({ id: ns.id, name: ns.name, containers: withDomains });
  }
  const containerCount = out.reduce((n, ns) => n + ns.containers.length, 0);
  return { found: namespaces.length > 0, namespaces: out, namespaceCount: namespaces.length, containerCount };
}

// ─── 2. Container Registry: namespace(s) + image count ─────────────────────
async function scanRegistry(projectId) {
  const registryApi = await api("Registry", "v1");
  const namespaces = await sdkCall(() => registryApi.listNamespaces({ projectId, region: REGION }).all());
  const out = [];
  for (const ns of namespaces) {
    let images = [];
    try {
      images = await listImages(ns.id);
    } catch {
      images = [];
    }
    out.push({ id: ns.id, name: ns.name, endpoint: ns.endpoint, imageCount: images.length });
  }
  return { found: namespaces.length > 0, namespaces: out };
}

// ─── 3. Serverless Jobs: every definition in the Project (migration, agents,
//        keep-warm, add-cron schedules - all of them, project-scoped) ──────
async function scanJobs(projectId) {
  const definitions = await listJobDefinitions({ projectId });
  return { found: definitions.length > 0, definitions: definitions.map((d) => ({ id: d.id, name: d.name })) };
}

// ─── 4. Serverless SQL Database(s): production AND preview databases, all
//        of them - preview DBs use an arbitrary `<project>-preview-<branch>`
//        name (see scripts/deploy.mjs), so listing by project_id rather than
//        by a guessed name is what makes this complete. NEVER DELETED by
//        this skill - listed here so Phase 4 can hand the exact name(s) +
//        console link back to the user. ────────────────────────────────────
async function scanDatabases(projectId, organizationId) {
  const sdbApi = await api("ServerlessSqldb", "v1alpha1");
  const databases = await sdkCall(() => sdbApi.listDatabases({ projectId, organizationId, region: REGION }).all());
  return {
    found: databases.length > 0,
    neverDeleted: true,
    consoleUrl: consoleDatabasesUrl(projectId),
    databases: databases.map((d) => ({ id: d.id, name: d.name, status: d.status })),
  };
}

// ─── 5. Secret Manager: every secret in the Project ─────────────────────────
async function scanSecrets(projectId) {
  const secrets = await listSecrets({ projectId });
  return { found: secrets.length > 0, count: secrets.length, names: secrets.map((s) => s.name) };
}

// ─── 6. Object Storage: the bucket recorded in Secret Manager (STORAGE_*) ──
// Object Storage has NO project-scoped listing API (see scripts/scaleway/
// object-storage.mjs's header - it's S3-only, no bearer-token REST family),
// so the bucket can only be found via the STORAGE_BUCKET secret this app's
// own /add-storage run wrote. If storage was never added, this cleanly
// reports found:false rather than guessing a bucket name. NEVER DELETED and
// NEVER EMPTIED by this skill - the bucket's versioned object history is the
// user's only backup of their file data. Listed here purely so Phase 4 can
// hand the exact bucket name + console link back to the user.
async function scanStorage(projectId) {
  const opts = { projectId };
  if (!(await secretExists("STORAGE_BUCKET", opts))) return { found: false, neverDeleted: true };
  try {
    const bucket = await getSecret("STORAGE_BUCKET", opts);
    const region = (await secretExists("STORAGE_REGION", opts)) ? await getSecret("STORAGE_REGION", opts) : REGION;
    const accessKey = await getSecret("STORAGE_ACCESS_KEY", opts).catch(() => null);
    const secretKey = await getSecret("STORAGE_SECRET_KEY", opts).catch(() => null);
    let exists = null;
    if (accessKey && secretKey) {
      try {
        exists = await bucketExists(bucket, { accessKey, secretKey, region });
      } catch {
        exists = null; // unknown - never resolved by deleting anything, just informational
      }
    }
    return { found: true, neverDeleted: true, consoleUrl: consoleBucketsUrl(projectId), bucket, region, exists, hasCredentials: !!(accessKey && secretKey) };
  } catch (e) {
    return { found: true, neverDeleted: true, consoleUrl: consoleBucketsUrl(projectId), error: String(e.message || e) };
  }
}

// ─── 7. IAM: applications this app owns, org-scoped so name-attributed ─────
async function scanIam(projectId, ownerCandidates) {
  const creds = requireCredentials();
  const iamApi = await api("Iam", "v1alpha1");
  let all;
  try {
    all = await sdkCall(() => iamApi.listApplications({ organizationId: creds.organizationId }).all());
  } catch (e) {
    if (e?.status !== 403) throw e;
    // No IAMManager: degrade to an empty, honest result rather than aborting
    // the whole discovery - the admin is the one who can actually check.
    return {
      found: false,
      applications: [],
      excluded: [],
      note:
        "Inventaire IAM indisponible (droits IAMManager manquants). Demandez à l’administrateur de vérifier " +
        `les applications nommées « ${PROJECT_SLUG}-db », « ${PROJECT_SLUG}-storage » et « baudrier-agents-${projectId} ».`,
    };
  }
  // setup-agent.mjs names the Jobs/agents IAM Application after the Scaleway
  // Project id itself - deterministic, no ambiguity possible.
  const exactName = `baudrier-agents-${projectId}`;
  const matched = [];
  const excluded = [];
  for (const app of all) {
    const name = app.name || "";
    if (name === exactName) {
      matched.push({ id: app.id, name, matchedBy: "exact" });
      continue;
    }
    if (tokenMatches(PROJECT_SLUG, name)) {
      const owner = moreSpecificOwner(PROJECT_SLUG, name, ownerCandidates);
      if (owner) {
        excluded.push({ id: app.id, name, excludedReason: `appartient probablement au projet "${owner}"` });
      } else {
        matched.push({ id: app.id, name, matchedBy: "name" });
      }
    }
  }
  for (const m of matched) {
    try {
      m.keyCount = (await listApiKeys(m.id)).length;
    } catch {
      m.keyCount = null;
    }
  }
  return { found: matched.length > 0, applications: matched, excluded };
}

// ─── 8. TEM: sender domain(s) created for this Project ─────────────────────
async function scanTem(projectId) {
  const temApi = await api("Tem", "v1alpha1");
  const domains = await sdkCall(() => temApi.listDomains({ projectId, region: REGION }).all());
  return { found: domains.length > 0, domains: domains.map((d) => ({ id: d.id, name: d.name, status: d.status })) };
}

// ─── 9. DNS: only the specific records the harness added, never the zone ──
// The custom domain (add-domain) and the TEM sender domain both live in a
// zone Scaleway does not "own" the way it owns a Project's other resources -
// it's the user's external domain, which may carry unrelated records (a
// personal mailbox's MX, other subdomains). We locate the zone by walking up
// the label chain of every hostname we know we touched until zoneExists()
// confirms a zone, then only report the records whose name matches one of
// those known hostnames (never "every record in the zone").
async function scanDns(containerScan, temScan) {
  const hostnames = new Set();
  for (const ns of containerScan.namespaces || []) {
    for (const c of ns.containers) {
      for (const d of c.customDomains) if (d.hostname) hostnames.add(d.hostname);
    }
  }
  for (const d of temScan.domains || []) if (d.name) hostnames.add(d.name);
  if (hostnames.size === 0) return { found: false, hostnamesConsidered: [] };

  const zoneRecordNames = new Map(); // zone -> Set(record name relative to zone)
  for (const host of hostnames) {
    const labels = host.split(".");
    let zone = null;
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      try {
        if (await zoneExists(candidate)) {
          zone = candidate;
          break;
        }
      } catch {
        // treat as "no zone here", keep trying shorter suffixes
      }
    }
    if (!zone) continue;
    if (!zoneRecordNames.has(zone)) zoneRecordNames.set(zone, new Set());
    zoneRecordNames.get(zone).add(host === zone ? "" : host.slice(0, host.length - zone.length - 1));
  }

  const zones = [];
  for (const [zone, names] of zoneRecordNames) {
    let all = [];
    try {
      all = await listRecords(zone);
    } catch {
      all = [];
    }
    const ours = all.filter((r) => names.has(r.name));
    zones.push({ zone, records: ours.map((r) => ({ id: r.id, name: r.name, type: r.type, data: r.data })) });
  }
  const recordCount = zones.reduce((n, z) => n + z.records.length, 0);
  return { found: recordCount > 0, zones, hostnamesConsidered: [...hostnames] };
}

// ─── 10. Claude Code project memory/transcripts ─────────────────────────────
function scanMemory() {
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return { found: false, dirs: [] };
  const normalize = (s) => s.toLowerCase().replace(/[.\\/:]/g, "-");
  const needle = normalize(PROJECT);
  const dirs = [];
  try {
    // Token-boundary match (../_match.mjs): a substring match here let deleting
    // "art" also sweep up the memory directory of "smart-app".
    for (const d of readdirSync(projectsRoot)) {
      if (tokenMatches(needle, normalize(d))) dirs.push({ name: d, path: join(projectsRoot, d) });
    }
  } catch (e) {
    return { found: false, dirs: [], error: String(e) };
  }
  return { found: dirs.length > 0, dirs };
}

// ─── 11. GitHub repo ─────────────────────────────────────────────────────
// `gh` is no longer part of the toolchain (CONTRACT.md §7) - this only parses
// the local checkout's own `origin` remote (git already knows it, no network
// call needed) rather than calling any GitHub API. Privacy (public/private)
// is therefore not reported here; Phase 4's handoff names the repo URL and
// lets the user check/delete it by hand (execute-deletions.mjs#deleteGitHub
// no longer deletes it either, for the same reason).
function scanGitHub() {
  const r = spawnSync("git", ["-C", PROJECT_DIR, "remote", "get-url", "origin"], { encoding: "utf8" });
  const remote = (r.stdout || "").trim();
  if (r.status !== 0 || !remote) return { exists: false };
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) return { exists: false };
  const [, owner, name] = m;
  return { exists: true, owner, name, url: `https://github.com/${owner}/${name}` };
}

// ─── 12. Local project folder ───────────────────────────────────────────────
function scanLocalDir() {
  if (!existsSync(PROJECT_DIR)) return { exists: false, path: PROJECT_DIR };
  return { exists: true, path: PROJECT_DIR };
}

// ─── 13. Env vars: local .env(.local) + Secret Manager names, diffed against
//         the known Baudrier/Scaleway stack -> third-party detection ───────
function scanEnvVars(localExists, secretNames) {
  const known = JSON.parse(readFileSync(join(TEMPLATES_DIR, "known-env-vars.json"), "utf8"));
  const knownSet = new Set(known.vars);
  const knownPatterns = (known.patterns || []).map((p) => new RegExp(p));
  const servicesList = JSON.parse(readFileSync(join(TEMPLATES_DIR, "third-party-services.json"), "utf8")).services;

  const names = new Set(secretNames || []);
  const sources = secretNames?.length ? ["secret-manager"] : [];
  if (localExists) {
    for (const file of [".env.local", ".env"]) {
      const p = join(PROJECT_DIR, file);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m) names.add(m[1]);
      }
      sources.push(file);
    }
  }

  const isKnown = (v) => knownSet.has(v) || knownPatterns.some((re) => re.test(v));
  const allVars = [...names].sort();
  const unknown = allVars.filter((v) => !isKnown(v));

  const thirdParty = [];
  const matched = new Set();
  for (const svc of servicesList) {
    const re = new RegExp(svc.pattern);
    for (const v of unknown) {
      if (re.test(v) && !matched.has(v)) {
        matched.add(v);
        thirdParty.push({ envVar: v, ...svc });
      }
    }
  }
  const unknownUnclassified = unknown.filter((v) => !matched.has(v));

  return {
    sources,
    allVarsCount: allVars.length,
    stackVarsCount: allVars.length - unknown.length,
    thirdPartyDetected: thirdParty,
    unknownUnclassified,
  };
}

// ─── orchestrator ────────────────────────────────────────────────────────
const startedAt = Date.now();
const scwProject = await resolveScwProject();

let container = { found: false, namespaces: [] };
let registry = { found: false, namespaces: [] };
let jobs = { found: false, definitions: [] };
let database = { found: false, databases: [] };
let secrets = { found: false, count: 0, names: [] };
let storage = { found: false };
let iam = { found: false, applications: [], excluded: [] };
let tem = { found: false, domains: [] };
let dns = { found: false, zones: [] };

if (scwProject.found) {
  [container, registry, jobs, database, secrets, storage, iam, tem] = await Promise.all([
    scanContainers(scwProject.id),
    scanRegistry(scwProject.id),
    scanJobs(scwProject.id),
    scanDatabases(scwProject.id, scwProject.organizationId),
    scanSecrets(scwProject.id),
    scanStorage(scwProject.id),
    scanIam(scwProject.id, scwProject.ownerCandidates),
    scanTem(scwProject.id),
  ]);
  dns = await scanDns(container, tem);
}

const memory = scanMemory();
const github = scanGitHub();
const localDir = scanLocalDir();
const envVars = scanEnvVars(localDir.exists, secrets.names);

// The Scaleway Project itself is NEVER deleted by this skill (deleting it
// would cascade to the database and bucket left behind on purpose) - attach
// its console URL here too, purely for the Phase 4 handoff.
if (scwProject.found) {
  scwProject.neverDeleted = true;
  scwProject.consoleUrl = consoleProjectUrl(scwProject.id);
}

const report = {
  project: PROJECT,
  projectSlug: PROJECT_SLUG,
  scannedAt: new Date().toISOString(),
  scanDurationMs: Date.now() - startedAt,
  scwProject,
  container,
  registry,
  jobs,
  database,
  secrets,
  storage,
  iam,
  tem,
  dns,
  memory,
  github,
  localDir,
  envVars,
};

console.log(JSON.stringify(report, null, 2));
