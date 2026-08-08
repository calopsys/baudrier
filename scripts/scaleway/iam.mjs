#!/usr/bin/env node
// iam.mjs - Scaleway IAM: applications, policies, API keys.
//
// Talks to the official @scaleway/sdk (`Iam` v1alpha1) via `api()`/`sdkCall()`
// from _scw-auth.mjs, not hand-written REST. IAM is a global/Organization-level
// product - there is no region path segment or parameter here.
// Reference: https://www.scaleway.com/en/developers/api/iam/
//
// Method names differ from what you might assume: API keys are
// `createAPIKey`/`listAPIKeys`/`deleteAPIKey`/`getAPIKey`/`updateAPIKey` -
// capital `API`, not `createApiKey` - confirmed by enumerating the live SDK
// instance's own methods rather than guessing.
//
// Real permission-set names (researched against the live permission-sets
// reference; verify against docs.scaleway.com/en/docs/iam/reference-content/permission-sets/
// before relying on this list, Scaleway adds sets over time):
//
//   Object Storage:          ObjectStorageReadOnly, ObjectStorageFullAccess,
//                             ObjectStorageObjectsRead, ObjectStorageObjectsWrite,
//                             ObjectStorageObjectsDelete, ObjectStorageBucketsRead,
//                             ObjectStorageBucketsWrite, ObjectStorageBucketsDelete,
//                             ObjectStorageBucketPolicyFullAccess
//   Serverless SQL Database: ServerlessSQLDatabaseReadOnly, ServerlessSQLDatabaseReadWrite,
//                             ServerlessSQLDatabaseDataReadWrite, ServerlessSQLDatabaseFullAccess
//                             (an app that only needs to connect and run queries wants
//                             ServerlessSQLDatabaseReadWrite, not FullAccess - FullAccess
//                             also grants provisioning/deletion of database instances)
//   Generative APIs:         GenerativeApisModelAccess, GenerativeApisFullAccess.
//                             Do NOT use the old InferenceReadOnly/InferenceFullAccess
//                             aliases - Scaleway's own docs said those "remain available
//                             at least until 1 June 2026", which has now passed.
//
// This module does not hardcode any of the above into ensurePolicy() - the caller
// (a skill) picks the exact permissionSetNames array. They're documented here
// because researching them was part of this task.

import { api, sdkCall, requireCredentials, ScwError, slugify } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";

const policyNameFor = (applicationId) => slugify(`harness-app-${applicationId}-access`);

// The one delegated secret that carries RAW key material, not a final value:
// setup-db.mjs must compose DATABASE_URL itself from {application_id,
// secret_key}, so the admin stores that pair here, in the app's own Project.
// Every other delegated fulfilment (agent, TEM, storage) stores the FINAL
// canonical secret directly instead - see CONTRACT.md's per-request
// delegation model.
export const DELEGATED_DB_KEY_SECRET_NAME = "BAUDRIER_DB_KEY";

/**
 * Run an IAM sdkCall, mapping a 403 onto a `permission_denied` ScwError so a
 * caller can fall back to an admin-delegated secret instead of failing
 * outright. One wrapper for every exported function below, instead of five
 * copies of the same try/catch.
 */
async function iamCall(fn, opts) {
  try {
    return await sdkCall(fn, opts);
  } catch (e) {
    if (e instanceof ScwError && e.status === 403) {
      throw new ScwError(e.message, { status: 403, type: "permission_denied", details: { needs: "IAMManager" } });
    }
    throw e;
  }
}

/**
 * Find-or-create an IAM Application by exact name within the Organization.
 * SDK calls:
 *   Iam.listApplications({ organizationId, name })
 *   Iam.createApplication({ organizationId, name, description })
 * @param {string} name
 * @param {{organizationId?:string}} [opts]
 * @returns {Promise<{id:string, name:string}>}
 */
export async function ensureApplication(name, opts = {}) {
  if (!name) throw new ScwError("ensureApplication requires a name", { type: "invalid_argument" });
  const creds = requireCredentials();
  const organizationId = opts.organizationId || creds.organizationId;
  const iam = await api("Iam", "v1alpha1");

  const existing = await iamCall(() => iam.listApplications({ organizationId, name }).all());
  const found = existing.find((a) => a.name === name);
  if (found) return { id: found.id, name: found.name };

  const created = await iamCall(() =>
    iam.createApplication({ name, organizationId, description: "Managed by baudrier" }),
  );
  return { id: created.id, name: created.name };
}

/**
 * Find-or-create a Policy binding an Application to a set of permission sets,
 * scoped to a Project. The policy's name is derived deterministically from
 * `applicationId` (`harness-app-<id>-access`) so reruns find the same policy.
 *
 * Note: if a policy with that name already exists, its rules are NOT
 * reconciled against `permissionSetNames` on rerun - we only find-or-create,
 * per the "never blow up on already exists" requirement. If the desired
 * permission set changes, delete the policy in the console/CLI first.
 *
 * SDK calls:
 *   Iam.listPolicies({ applicationIds: [applicationId], policyName: name })
 *   Iam.createPolicy({ name, organizationId, applicationId, rules, description })
 * @param {{applicationId:string, projectId:string, permissionSetNames:string[], organizationId?:string}} args
 * @returns {Promise<{id:string, name:string}>}
 */
export async function ensurePolicy({ applicationId, projectId, permissionSetNames, organizationId } = {}) {
  if (!applicationId) throw new ScwError("ensurePolicy requires applicationId", { type: "invalid_argument" });
  if (!Array.isArray(permissionSetNames) || permissionSetNames.length === 0) {
    throw new ScwError("ensurePolicy requires a non-empty permissionSetNames array", { type: "invalid_argument" });
  }
  const creds = requireCredentials();
  const orgId = organizationId || creds.organizationId;
  const proj = projectId || creds.projectId;
  const name = policyNameFor(applicationId);
  const iam = await api("Iam", "v1alpha1");

  const existing = await iamCall(() =>
    iam.listPolicies({ applicationIds: [applicationId], policyName: name }).all(),
  );
  const found = existing.find((p) => p.name === name);
  if (found) return { id: found.id, name: found.name };

  const created = await iamCall(() =>
    iam.createPolicy({
      name,
      organizationId: orgId,
      applicationId,
      description: "Managed by baudrier",
      rules: [
        {
          permissionSetNames,
          projectIds: proj ? [proj] : undefined,
        },
      ],
    }),
  );
  return { id: created.id, name: created.name };
}

/**
 * Create an IAM API key for an Application, WITH NO EXPIRY.
 *
 * How "no expiry" is expressed: the SDK's `CreateAPIKeyRequest.expiresAt` is
 * an OPTIONAL `Date`. There is no separate boolean like `neverExpires` -
 * simply never setting the field (not even to null/undefined explicitly) is
 * what produces a permanent key. This function therefore never puts
 * `expiresAt` in the request object at all. This matters here because
 * DATABASE_URL embeds this key, per CONTRACT.md §4, and rotating it would
 * break every deployed app until redeploy.
 *
 * This is a plain create, not find-or-create: API keys have no unique name
 * to look up by, and the secret is only ever returned once (at creation), so
 * there is nothing to idempotently "find" a usable value from. Callers that
 * need idempotency should persist the returned secretKey (e.g. via
 * secrets.mjs) and only call this once.
 *
 * SDK call: Iam.createAPIKey({ applicationId, defaultProjectId, description })
 * (note the capital `API` in the method name - confirmed against the live
 * SDK instance, not assumed.)
 * @param {{applicationId:string, projectId?:string, description?:string}} args
 * @returns {Promise<{accessKey:string, secretKey:string}>}
 */
export async function createApiKey({ applicationId, projectId, description } = {}) {
  if (!applicationId) throw new ScwError("createApiKey requires applicationId", { type: "invalid_argument" });
  const iam = await api("Iam", "v1alpha1");
  const request = { applicationId, description: description || "baudrier" };
  if (projectId) request.defaultProjectId = projectId;
  // Deliberately no `expiresAt` key here - see JSDoc above.
  const created = await iamCall(() => iam.createAPIKey(request));
  if (!created?.secretKey) {
    throw new ScwError("IAM API key creation did not return a secretKey", { type: "unexpected_response" });
  }
  return { accessKey: created.accessKey, secretKey: created.secretKey };
}

/**
 * SDK call: Iam.listAPIKeys({ applicationId })
 * @param {string} applicationId
 * @returns {Promise<Array<{accessKey:string, description:string, createdAt:string, expiresAt:string|null}>>}
 */
export async function listApiKeys(applicationId) {
  if (!applicationId) throw new ScwError("listApiKeys requires applicationId", { type: "invalid_argument" });
  const iam = await api("Iam", "v1alpha1");
  const keys = await iamCall(() => iam.listAPIKeys({ applicationId }).all());
  // The SDK unmarshals timestamps into `Date` instances; convert back to ISO
  // strings so this function's return shape (documented as `string`) doesn't
  // silently change type under callers that expect to print/serialise it.
  return keys.map((k) => ({
    accessKey: k.accessKey,
    description: k.description,
    createdAt: k.createdAt ? k.createdAt.toISOString() : null,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
  }));
}

/**
 * SDK call: Iam.deleteAPIKey({ accessKey })
 * @param {string} accessKey
 */
export async function deleteApiKey(accessKey) {
  if (!accessKey) throw new ScwError("deleteApiKey requires accessKey", { type: "invalid_argument" });
  const iam = await api("Iam", "v1alpha1");
  await iamCall(() => iam.deleteAPIKey({ accessKey }));
}

/* ------------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "ensure-app": {
        const [name] = rest;
        if (!name) throw new ScwError("usage: node iam.mjs ensure-app <NAME>", { type: "usage" });
        console.log(`▸ ensuring IAM application ${name}`);
        const app = await ensureApplication(name);
        console.log(`✅ application ${app.name} (${app.id})`);
        console.log(JSON.stringify({ ok: true, application: app }));
        break;
      }
      case "ensure-policy": {
        const [applicationId, projectId, permSets] = rest;
        if (!applicationId || !projectId || !permSets) {
          throw new ScwError("usage: node iam.mjs ensure-policy <APP_ID> <PROJECT_ID> <PERM1,PERM2>", { type: "usage" });
        }
        console.log(`▸ ensuring policy for application ${applicationId}`);
        const policy = await ensurePolicy({ applicationId, projectId, permissionSetNames: permSets.split(",") });
        console.log(`✅ policy ${policy.name} (${policy.id})`);
        console.log(JSON.stringify({ ok: true, policy }));
        break;
      }
      case "create-key": {
        const reveal = rest.includes("--reveal");
        const [applicationId, projectId, description] = rest.filter((a) => a !== "--reveal");
        if (!applicationId) {
          throw new ScwError("usage: node iam.mjs create-key <APP_ID> [PROJECT_ID] [DESCRIPTION] [--reveal]", { type: "usage" });
        }
        console.log(`▸ creating non-expiring API key for application ${applicationId}`);
        const key = await createApiKey({ applicationId, projectId, description });
        console.log(`✅ created key ${key.accessKey}`);
        // The secret half only leaves this process on an explicit --reveal:
        // a caller that only needs to confirm the mint succeeded gets a
        // length instead of a value that would otherwise sit in a transcript
        // or a piped log forever.
        console.log(
          JSON.stringify(
            reveal
              ? { ok: true, accessKey: key.accessKey, secretKey: key.secretKey }
              : { ok: true, accessKey: key.accessKey, secretKeyLength: key.secretKey.length },
          ),
        );
        break;
      }
      case "list-keys": {
        const [applicationId] = rest;
        if (!applicationId) throw new ScwError("usage: node iam.mjs list-keys <APP_ID>", { type: "usage" });
        console.log(`▸ listing API keys for application ${applicationId}`);
        const keys = await listApiKeys(applicationId);
        console.log(`✅ ${keys.length} key(s)`);
        console.log(JSON.stringify({ ok: true, keys }));
        break;
      }
      case "delete-key": {
        const [accessKey] = rest;
        if (!accessKey) throw new ScwError("usage: node iam.mjs delete-key <ACCESS_KEY>", { type: "usage" });
        console.log(`▸ deleting API key ${accessKey}`);
        await deleteApiKey(accessKey);
        console.log(`✅ deleted ${accessKey}`);
        console.log(JSON.stringify({ ok: true, accessKey }));
        break;
      }
      default:
        console.log("usage: node iam.mjs <ensure-app|ensure-policy|create-key|list-keys|delete-key> [args]");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, type: err.type, details: err.details }));
    process.exitCode = 1;
  });
}
