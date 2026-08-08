#!/usr/bin/env node
// execute-deletions.mjs - Phase 3 of /delete-project: deletes exactly what
// discover-resources.mjs found, scoped to the categories the user approved.
//
// Usage:
//   node execute-deletions.mjs --inventory <path.json> --scope <json-array>
//
// --scope is a subset of:
//   ["container","registry","jobs","secrets","iam","tem","dns","memory","github"]
// Pass ["all"] as a shortcut for every category.
//
// ─────────────────────────────────────────────────────────────────────────
// HARD GUARANTEE - this script NEVER deletes a database, a bucket, or the
// Scaleway Project itself. Per direct user requirement, /delete-project must
// never be capable of destroying data. This is not a runtime check you could
// bypass with a crafted --scope: there is no code path in this file that
// calls sdb.mjs's deleteDatabase or object-storage.mjs's deleteBucket, and
// there never was a code path that could empty a bucket's object history -
// those imports simply do not exist here. "database" and "storage" are
// intentionally ABSENT from ALL_CATEGORIES below; if a caller still passes
// them in --scope (or "project"), the orchestration below records them under
// report.refused with an explicit reason, rather than silently ignoring
// them, so the gap is never mistaken for a bug. The Scaleway Project itself is never deleted
// either, deliberately: deleting a Project cascades to everything still
// inside it, including the database and bucket this script leaves behind on
// purpose. See skills/delete-project/SKILL.md Phase 4 for the mandatory
// French handoff that tells the user exactly what was left and why.
// ─────────────────────────────────────────────────────────────────────────
//
// Each deletion is fault-tolerant: one category failing does not abort the
// others. Re-running with a narrower --scope retries only what is left.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { REGION, api, sdkCall } from "../scaleway/_scw-auth.mjs";
import { listCustomDomains, deleteCustomDomain } from "../scaleway/container.mjs";
import { deleteJobDefinition } from "../scaleway/jobs.mjs";
import { deleteSecret } from "../scaleway/secrets.mjs";
import { listApiKeys, deleteApiKey } from "../scaleway/iam.mjs";
import { deleteRecords } from "../scaleway/dns.mjs";

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const INVENTORY_PATH = arg("--inventory");
const SCOPE_JSON = arg("--scope");
if (!INVENTORY_PATH || !SCOPE_JSON) {
  console.error("Usage: node execute-deletions.mjs --inventory <path.json> --scope <json-array>");
  process.exit(1);
}
if (!existsSync(INVENTORY_PATH)) {
  console.error(`Inventory file not found: ${INVENTORY_PATH}`);
  process.exit(1);
}
let inventory;
try {
  inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
} catch {
  console.error(`Invalid inventory JSON: ${INVENTORY_PATH}`);
  process.exit(1);
}
let scope;
try {
  scope = JSON.parse(SCOPE_JSON);
} catch {
  console.error(`Invalid --scope JSON: ${SCOPE_JSON}`);
  process.exit(1);
}
const ALL_CATEGORIES = ["container", "registry", "jobs", "secrets", "iam", "tem", "dns", "memory", "github"];
// Categories this script will NEVER execute, no matter what --scope says -
// see the header comment. Kept as an explicit list (rather than just
// omitting them from ALL_CATEGORIES) so a caller passing one of these gets a
// clear "refused" entry in the report instead of a silent no-op that could
// be mistaken for "forgot to implement it".
const NEVER_DELETE = new Set(["database", "storage", "project"]);
if (scope.length === 1 && scope[0] === "all") scope = ALL_CATEGORIES;
const scopeSet = new Set(scope);
const refusedCategories = scope.filter((c) => NEVER_DELETE.has(c));

const PROJECT_ID = inventory.scwProject?.id || null;

// ─── SDK namespaces not wrapped by a scripts/scaleway/*.mjs export ─────────
// (same reasoning as discover-resources.mjs's header - CONTRACT.md's module
// list documents the primary find-or-create helpers, not every DELETE.)
// Container uses **v1** (v1beta1 was deprecated 2026-07-09).

// ─── Serverless Containers: custom domains -> containers -> namespace ──
async function deleteContainerNamespaces() {
  if (!inventory.container?.found) return { status: "skipped", reason: "aucun namespace trouvé" };
  const containersApi = await api("Container", "v1");
  const results = [];
  for (const ns of inventory.container.namespaces) {
    for (const c of ns.containers) {
      for (const d of c.customDomains) {
        try {
          await deleteCustomDomain(d.id);
          results.push({ type: "domain", id: d.id, hostname: d.hostname, status: "deleted" });
        } catch (e) {
          results.push({ type: "domain", id: d.id, hostname: d.hostname, status: "failed", error: e.message });
        }
      }
      try {
        await sdkCall(() => containersApi.deleteContainer({ containerId: c.id, region: REGION }));
        results.push({ type: "container", id: c.id, name: c.name, status: "deleted" });
      } catch (e) {
        results.push({ type: "container", id: c.id, name: c.name, status: "failed", error: e.message });
      }
    }
    try {
      await sdkCall(() => containersApi.deleteNamespace({ namespaceId: ns.id, region: REGION }));
      results.push({ type: "namespace", id: ns.id, name: ns.name, status: "deleted" });
    } catch (e) {
      results.push({ type: "namespace", id: ns.id, name: ns.name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── 2. Container Registry: namespace deletion cascades to its images/tags ─
async function deleteRegistryNamespaces() {
  if (!inventory.registry?.found) return { status: "skipped", reason: "aucun namespace trouvé" };
  const registryApi = await api("Registry", "v1");
  const results = [];
  for (const ns of inventory.registry.namespaces) {
    try {
      await sdkCall(() => registryApi.deleteNamespace({ namespaceId: ns.id, region: REGION }));
      results.push({ id: ns.id, name: ns.name, imageCount: ns.imageCount, status: "deleted" });
    } catch (e) {
      results.push({ id: ns.id, name: ns.name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── 3. Serverless Jobs ─────────────────────────────────────────────────────
async function deleteJobs() {
  if (!inventory.jobs?.found) return { status: "skipped", reason: "aucune définition de job trouvée" };
  const results = [];
  for (const def of inventory.jobs.definitions) {
    try {
      await deleteJobDefinition(def.id);
      results.push({ id: def.id, name: def.name, status: "deleted" });
    } catch (e) {
      results.push({ id: def.id, name: def.name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── Secret Manager ───────────────────────────────────────────────────────
async function deleteSecrets() {
  if (!inventory.secrets?.found) return { status: "skipped", reason: "aucun secret trouvé" };
  const results = [];
  for (const name of inventory.secrets.names) {
    try {
      await deleteSecret(name, { projectId: PROJECT_ID });
      results.push({ name, status: "deleted" });
    } catch (e) {
      results.push({ name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── IAM: keys -> policy -> application, for every application discovered
async function deleteIam() {
  if (!inventory.iam?.found) return { status: "skipped", reason: "aucune application IAM trouvée" };
  const iamApi = await api("Iam", "v1alpha1");
  const results = [];
  for (const appEntry of inventory.iam.applications) {
    const appResult = { id: appEntry.id, name: appEntry.name, keys: [] };
    try {
      // listApiKeys/deleteApiKey are iam.mjs's own frozen exports - reused as-is
      // rather than reimplemented, per this file's ownership boundary.
      const keys = await listApiKeys(appEntry.id);
      for (const k of keys) {
        try {
          await deleteApiKey(k.accessKey);
          appResult.keys.push({ accessKey: k.accessKey, status: "deleted" });
        } catch (e) {
          appResult.keys.push({ accessKey: k.accessKey, status: "failed", error: e.message });
        }
      }
    } catch (e) {
      appResult.keysError = e.message;
    }

    try {
      const policies = await sdkCall(() => iamApi.listPolicies({ applicationIds: [appEntry.id] }).all());
      appResult.policies = [];
      for (const p of policies) {
        try {
          await sdkCall(() => iamApi.deletePolicy({ policyId: p.id }));
          appResult.policies.push({ id: p.id, name: p.name, status: "deleted" });
        } catch (e) {
          appResult.policies.push({ id: p.id, name: p.name, status: "failed", error: e.message });
        }
      }
    } catch (e) {
      appResult.policiesError = e.message;
    }

    try {
      await sdkCall(() => iamApi.deleteApplication({ applicationId: appEntry.id }));
      appResult.status = "deleted";
    } catch (e) {
      appResult.status = "failed";
      appResult.error = e.message;
    }
    results.push(appResult);
  }
  const anyFail = results.some((r) => r.status === "failed" || r.keys.some((k) => k.status === "failed"));
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── TEM domain(s) ────────────────────────────────────────────────────────
async function deleteTem() {
  if (!inventory.tem?.found) return { status: "skipped", reason: "aucun domaine TEM trouvé" };
  const temApi = await api("Tem", "v1alpha1");
  const results = [];
  for (const d of inventory.tem.domains) {
    try {
      // The SDK's delete-equivalent for a TEM domain is `revokeDomain` - there
      // is no separate `deleteDomain` method.
      await sdkCall(() => temApi.revokeDomain({ domainId: d.id, region: REGION }));
      results.push({ id: d.id, name: d.name, status: "deleted" });
    } catch (e) {
      results.push({ id: d.id, name: d.name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── DNS: only the exact records discovery attributed to this app ──────
async function deleteDns() {
  if (!inventory.dns?.found) return { status: "skipped", reason: "aucun enregistrement DNS attribué à cette app" };
  const results = [];
  for (const zoneEntry of inventory.dns.zones) {
    if (zoneEntry.records.length === 0) continue;
    try {
      await deleteRecords(
        zoneEntry.zone,
        zoneEntry.records.map((r) => ({ name: r.name, type: r.type })),
      );
      results.push({ zone: zoneEntry.zone, recordCount: zoneEntry.records.length, status: "deleted" });
    } catch (e) {
      results.push({ zone: zoneEntry.zone, recordCount: zoneEntry.records.length, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── Claude Code project memory/transcripts ─────────────────────────────
async function deleteMemory() {
  if (!inventory.memory?.found) return { status: "skipped", reason: "aucun dossier mémoire trouvé" };
  const results = [];
  for (const d of inventory.memory.dirs) {
    try {
      rmSync(d.path, { recursive: true, force: true });
      results.push({ name: d.name, status: "deleted" });
    } catch (e) {
      results.push({ name: d.name, status: "failed", error: e.message });
    }
  }
  const anyFail = results.some((r) => r.status === "failed");
  return { status: anyFail ? "partial" : "deleted", results };
}

// ─── GitHub repo ─────────────────────────────────────────────────────────────
// `gh` is no longer part of the toolchain (CONTRACT.md §7), and the shell git
// credential 403s on ref DELETE, let alone repo deletion (live-verified) -
// there is no code path left here that can delete a GitHub repo. Report it
// as skipped with the console URL instead of silently dropping the category.
async function deleteGitHub() {
  if (!inventory.github?.exists) return { status: "skipped", reason: "aucun dépôt GitHub trouvé" };
  const fullName = `${inventory.github.owner}/${inventory.project}`;
  return {
    status: "skipped",
    repo: fullName,
    reason:
      "Baudrier ne peut plus supprimer un dépôt GitHub lui-même (gh n’est plus utilisé, et l’identifiant git ne " +
      `permet pas de supprimer un dépôt). Supprimez-le vous-même si besoin : https://github.com/${fullName}/settings`,
  };
}

// ─── orchestration ───────────────────────────────────────────────────────
const startedAt = Date.now();
const report = { project: inventory.project, startedAt: new Date().toISOString(), scope, deleted: {}, failed: {}, skipped: {}, refused: {} };

// database/storage/project: never executed, always reported as an explicit
// refusal (not silently dropped) so the report - and therefore the French
// handoff in Phase 4 of the skill - always surfaces them. See the header
// comment for why this is a hard guarantee, not a --scope-dependent choice.
for (const cat of refusedCategories) {
  report.refused[cat] = {
    status: "refused",
    reason:
      "cette catégorie ne peut jamais être supprimée par /delete-project (garde-fou permanent : les bases de données, les buckets et le Project Scaleway ne sont jamais détruits automatiquement)",
  };
}

function record(category, result) {
  if (result.status === "deleted" || result.status === "partial") report.deleted[category] = result;
  else if (result.status === "failed") report.failed[category] = result;
  else report.skipped[category] = result;
}

const parallelTasks = [];
if (scopeSet.has("container")) parallelTasks.push(deleteContainerNamespaces().then((r) => ["container", r]));
if (scopeSet.has("registry")) parallelTasks.push(deleteRegistryNamespaces().then((r) => ["registry", r]));
if (scopeSet.has("jobs")) parallelTasks.push(deleteJobs().then((r) => ["jobs", r]));
if (scopeSet.has("secrets")) parallelTasks.push(deleteSecrets().then((r) => ["secrets", r]));
if (scopeSet.has("iam")) parallelTasks.push(deleteIam().then((r) => ["iam", r]));
if (scopeSet.has("tem")) parallelTasks.push(deleteTem().then((r) => ["tem", r]));
if (scopeSet.has("dns")) parallelTasks.push(deleteDns().then((r) => ["dns", r]));
if (scopeSet.has("memory")) parallelTasks.push(deleteMemory().then((r) => ["memory", r]));
if (scopeSet.has("github")) parallelTasks.push(deleteGitHub().then((r) => ["github", r]));

const parallelResults = await Promise.all(parallelTasks);
for (const [cat, res] of parallelResults) record(cat, res);

for (const cat of ALL_CATEGORIES) {
  if (!scopeSet.has(cat) && !report.deleted[cat] && !report.failed[cat] && !report.skipped[cat]) {
    report.skipped[cat] = { status: "skipped", reason: "hors du périmètre choisi" };
  }
}

report.completedAt = new Date().toISOString();
report.durationMs = Date.now() - startedAt;

console.log(JSON.stringify(report, null, 2));
