#!/usr/bin/env node
// check-scw-permissions.mjs - read-only probe for the two IAM permission
// sets /start's continuous per-app provisioning depends on: ProjectManager
// and IAMManager (CONTRACT.md §1). Re-runnable after an admin grants access.
//
// A 403 on a probe is a hard "missing" signal. A 200 is NOT proof of create
// rights - read-only permission sets exist (e.g. ProjectReadOnly), so a
// successful list call only rules out the read side of the gap. Hence
// "certainty":"denial-only" below: this script can prove absence, never
// presence, of the rights /start actually needs.
//
// Output: exactly one JSON line on stdout. Exit 1 only when credentials are
// entirely missing; a detected permission gap is non-blocking (blocking:false)
// so /start can surface it as a warning and keep going.
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

async function probeProjects(organizationId) {
  try {
    const projects = await api("Account", "v3", "ProjectAPI");
    const list = await sdkCall(() => projects.listProjects({ organizationId }).all());
    return { ok: true, status: null, count: list.length, error: null };
  } catch (e) {
    return { ok: false, status: e?.status ?? null, count: null, error: String(e?.message || e).slice(0, 200) };
  }
}

async function probeIam(organizationId) {
  try {
    const iam = await api("Iam", "v1alpha1");
    const list = await sdkCall(() => iam.listApplications({ organizationId }).all());
    return { ok: true, status: null, count: list.length, error: null };
  } catch (e) {
    return { ok: false, status: e?.status ?? null, count: null, error: String(e?.message || e).slice(0, 200) };
  }
}

async function main() {
  let creds;
  try {
    creds = requireCredentials();
  } catch (e) {
    const reason =
      e?.type === "missing_credentials"
        ? "Identifiants Scaleway introuvables sur cette machine. Lancez /start pour les configurer."
        : String(e?.message || e).slice(0, 300);
    out({ ok: false, type: e?.type || "missing_credentials", reason });
    process.exitCode = 1;
    return;
  }

  const organizationId = arg("--organization-id") || creds.organizationId;

  const [projects, iam] = await Promise.all([probeProjects(organizationId), probeIam(organizationId)]);

  const likelyMissing = [];
  if (projects.status === 403) likelyMissing.push("ProjectManager");
  if (iam.status === 403) likelyMissing.push("IAMManager");

  out({
    ok: true,
    probes: { projects, iam },
    likelyMissing,
    certainty: "denial-only",
    blocking: false,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    out({ ok: false, type: "unexpected_error", reason: String(e?.message || e).slice(0, 300) });
    process.exitCode = 1;
  });
}
