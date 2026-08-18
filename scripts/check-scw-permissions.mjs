#!/usr/bin/env node
// check-scw-permissions.mjs - read-only probe for the three organization-scoped
// permission sets the harness cares about: ProjectManager, IAMManager, and
// BillingReadOnly (CONTRACT.md §1, §1's IAM permission-set table). Re-runnable
// after an admin grants access.
// Advisory only: on a detected gap it recommends SCW_DEFAULT_PROJECT_ID as
// the workaround, it does not set it itself.
//
// A 403 on a probe is a hard "missing" signal. A 200 is NOT proof of create
// rights - read-only permission sets exist (e.g. ProjectReadOnly), so a
// successful list call only rules out the read side of the gap. Hence
// "certainty":"denial-only" below: this script can prove absence, never
// presence, of the rights the preflight actually needs.
//
// Output: exactly one JSON line on stdout. Exit 1 only when credentials are
// entirely missing; a detected permission gap is non-blocking (blocking:false)
// so the preflight can surface it as a warning and keep going. The line also
// carries the credential-shape verdict from probeOrgReach(): orgReach,
// canMint, conclusive, and the derived shape ("unknown"/"org"/"project").
//
//   node check-scw-permissions.mjs [--organization-id <ID>] [--json]

import { pathToFileURL } from "node:url";
import { api, requireCredentials, sdkCall } from "./scaleway/_scw-auth.mjs";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function out(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/** Run a probe call, translating any throw into the shared probe result shape. */
async function probe(fn) {
  try {
    const count = await fn();
    return { ok: true, status: null, count, error: null };
  } catch (e) {
    return { ok: false, status: e?.status ?? null, count: null, error: String(e?.message || e).slice(0, 200) };
  }
}

async function probeProjects(organizationId) {
  return probe(async () => {
    const projects = await api("Account", "v3", "ProjectAPI");
    const list = await sdkCall(() => projects.listProjects({ organizationId }).all());
    return list.length;
  });
}

async function probeIam(organizationId) {
  return probe(async () => {
    const iam = await api("Iam", "v1alpha1");
    const list = await sdkCall(() => iam.listApplications({ organizationId }).all());
    return list.length;
  });
}

/** Current calendar period as "YYYY-MM", the granularity listConsumptions expects. */
function currentBillingPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function probeBilling(organizationId) {
  return probe(async () => {
    const billing = await api("Billing", "v2beta1");
    const list = await sdkCall(() =>
      billing.listConsumptions({ organizationId, billingPeriod: currentBillingPeriod() }).all(),
    );
    return list.length;
  });
}

/** A probe result is conclusive on a clean success or a clean 403/401 denial. */
function isConclusive(p) {
  return p.ok || p.status === 403 || p.status === 401;
}

/**
 * Probe every organization-scoped permission set and summarise organization
 * reach for the app-credential chokepoint (`app-credentials.mjs`).
 * `orgReach` is true when ANY probe succeeds - organization reach is not only
 * about creating Projects. `canMint` mirrors the IAM probe alone: minting a
 * scoped key needs IAMManager specifically. `conclusive` is false when any
 * probe failed for a reason other than a clean 403/401 (network error,
 * timeout, unexpected status); an inconclusive probe must never be read as
 * "no reach".
 * @param {{organizationId?:string}} [args]
 * @returns {Promise<{orgReach:boolean, canMint:boolean, conclusive:boolean, probes:object}>}
 */
export async function probeOrgReach({ organizationId } = {}) {
  const creds = requireCredentials();
  const orgId = organizationId || creds.organizationId;

  const [projects, iam, billing] = await Promise.all([
    probeProjects(orgId),
    probeIam(orgId),
    probeBilling(orgId),
  ]);
  const probes = { projects, iam, billing };

  return {
    orgReach: projects.ok || iam.ok || billing.ok,
    canMint: iam.ok,
    conclusive: isConclusive(projects) && isConclusive(iam) && isConclusive(billing),
    probes,
  };
}

// Reports "org" for the deadlock input, where credentialShape() throws
// shape_deadlock: this probe is advisory and must never throw.
function credentialShapeFromReach({ orgReach, conclusive }) {
  if (!conclusive) return "unknown";
  return orgReach ? "org" : "project";
}

async function main() {
  let creds;
  try {
    creds = requireCredentials();
  } catch (e) {
    const reason =
      e?.type === "missing_credentials"
        ? "Identifiants Scaleway introuvables sur cette machine. Renseignez les variables SCW_* dans l’environnement cloud « Baudrier », puis démarrez une nouvelle conversation."
        : String(e?.message || e).slice(0, 300);
    out({ ok: false, type: e?.type || "missing_credentials", reason });
    process.exitCode = 1;
    return;
  }

  const organizationId = arg("--organization-id") || creds.organizationId;

  const { orgReach, canMint, conclusive, probes } = await probeOrgReach({ organizationId });
  const { projects, iam, billing } = probes;

  const likelyMissing = [];
  if (projects.status === 403) likelyMissing.push("ProjectManager");
  if (iam.status === 403) likelyMissing.push("IAMManager");
  if (billing.status === 403) likelyMissing.push("BillingReadOnly");

  out({
    ok: true,
    probes,
    likelyMissing,
    certainty: "denial-only",
    blocking: false,
    orgReach,
    canMint,
    conclusive,
    shape: credentialShapeFromReach({ orgReach, conclusive }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    out({ ok: false, type: "unexpected_error", reason: String(e?.message || e).slice(0, 300) });
    process.exitCode = 1;
  });
}
