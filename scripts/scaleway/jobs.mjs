#!/usr/bin/env node
// jobs.mjs - Scaleway Serverless Jobs: job definitions, runs, secret
// references and cron schedules.
//
// API: Serverless Jobs v1alpha2, via the official @scaleway/sdk (see
// CONTRACT.md §3). v1alpha2 is newer than v1alpha1 (which the harness
// previously targeted with hand-written REST calls); the two differ in ways
// that matter here - see the notes above JOB_RUN_TERMINAL_STATES and
// setSchedule() below.
//
// Per CONTRACT.md §1: Serverless Jobs (unlike Serverless Containers) CAN
// reference Secret Manager natively and directly, region-scoped to fr-par.

import { REGION, ScwError, api, sdkCall, requireCredentials, pollUntil, slugify } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";

async function jobsApi() {
  return api("Jobs", "v1alpha2");
}

// JobRun.state enum, v1alpha2 (confirmed against
// @scaleway/sdk-jobs/dist/v1alpha2/types.gen.d.ts): unknown_state,
// initialized, validated, queued, running, succeeded, failed, interrupting,
// interrupted, retrying.
//
// This is NOT the same enum as v1alpha1 (unknown_state, queued, scheduled,
// running, succeeded, failed, canceled, internal_error): "canceled" and
// "internal_error" are gone; "initialized", "validated", "interrupting",
// "interrupted" and "retrying" are new. "retrying" in particular means the
// run is NOT done - the platform is about to re-attempt it under the job's
// retryPolicy - so it must NOT be treated as terminal, or waitForJobRun
// would return on a run that is still going to execute again.
const JOB_RUN_TERMINAL_STATES = new Set(["succeeded", "failed", "interrupted"]);
const JOB_RUN_ERROR_STATES = new Set(["failed", "interrupted"]);

function toSecretConfig(ref) {
  const out = {
    secretManagerId: ref.secretManagerId ?? ref.secretId,
    // CreateSecretsRequestSecretConfig.secretManagerVersion is a required
    // field in the SDK's types (true in both v1alpha1 and v1alpha2 - not a
    // v1alpha2 regression). "latest_enabled" is Scaleway's documented sentinel
    // for "whatever is currently active", matching the old code's behaviour of
    // omitting the field and letting the API default it.
    secretManagerVersion: ref.secretManagerVersion || "latest_enabled",
  };
  // x-one-of on the API: exactly one of env_var_name / path.
  if (ref.envVarName) out.envVarName = ref.envVarName;
  else if (ref.path) out.path = ref.path;
  return out;
}

/**
 * Translate an SDK JobDefinition (camelCase) back into the snake_case shape
 * callers (scripts/setup-cron-worker.mjs's `actionList`) still read
 * (`d.cron_schedule?.schedule`) - CONTRACT.md §3 freezes return shapes, not
 * just export names. The camelCase fields are also kept (spread first) for
 * any forward-compatible reader.
 */
function toLegacyJobDefinition(def, extra = {}) {
  if (!def) return def;
  return {
    ...def,
    cron_schedule: def.cronSchedule ? { schedule: def.cronSchedule.schedule, timezone: def.cronSchedule.timezone } : undefined,
    ...extra,
  };
}

/**
 * Find-or-create-or-update a job definition by (slugified) name.
 *
 * Unlike the other `ensure*` helpers in this module, this one does more than
 * find-or-return: the migration Job's `imageUri` changes on every deploy
 * (new commit SHA tag), so when a definition with this name already exists,
 * ensureJobDefinition updates it to the given spec instead of leaving it
 * stale. Secret references (which can't be introspected/diffed back from
 * the API) are simply (re-)posted if `secretRefs` is given.
 *
 * v1alpha2's ListJobDefinitionsRequest has no server-side `name` filter
 * (confirmed against the SDK types - only page/pageSize/orderBy/projectId/
 * organizationId), so this fetches every definition in the Project and
 * filters client-side, same as the old code effectively did (it also always
 * re-checked `d.name === slug` after the list call).
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.imageUri
 * @param {string} [spec.command]
 * @param {Record<string,string>} [spec.env]
 * @param {{secretManagerId:string, secretManagerVersion?:string, envVarName?:string, path?:string}[]} [spec.secretRefs]
 * @param {number} [spec.cpuLimit=250]  mvCPU
 * @param {number} [spec.memoryLimit=512]  MiB (same unit in v1alpha1 and v1alpha2 - unlike Container, Jobs did not rename or rescale this field)
 * @param {number} [spec.localStorageCapacity=1024]  MiB of scratch disk for the
 *   job's container. The API rejects a definition with no local storage
 *   ("local_storage_capacity does not respect constraint, value must be
 *   greater than 0") - 1024 is the value confirmed working against the live
 *   API (region fr-par).
 * @param {string} [spec.timeout]  duration string, e.g. "1800s"
 * @returns {Promise<object>} the job definition
 */
export async function ensureJobDefinition({
  name,
  imageUri,
  command,
  env,
  secretRefs,
  cpuLimit = 250,
  memoryLimit = 512,
  localStorageCapacity = 1024,
  timeout,
  opts = {},
} = {}) {
  if (!name || !imageUri) {
    throw new ScwError("ensureJobDefinition requires name and imageUri", { type: "invalid_args" });
  }
  const region = opts.region || REGION;
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const slug = slugify(name);
  const jobs = await jobsApi();

  const existing = await sdkCall(() => jobs.listJobDefinitions({ region, projectId }).all());
  const hit = existing.find((d) => d.name === slug);

  let definition;
  if (hit) {
    definition = await sdkCall(() =>
      jobs.updateJobDefinition({
        jobDefinitionId: hit.id,
        region,
        imageUri,
        command,
        cpuLimit,
        memoryLimit,
        localStorageCapacity,
        jobTimeout: timeout,
        environmentVariables: env,
      }),
    );
  } else {
    definition = await sdkCall(() =>
      jobs.createJobDefinition({
        region,
        name: slug,
        imageUri,
        // CreateJobDefinitionRequest.command/description are typed as
        // required strings in the SDK (true in v1alpha1 too - not new here);
        // the API has always accepted an empty description in practice, so
        // default rather than widen this function's frozen signature.
        command: command ?? "",
        description: "",
        cpuLimit,
        memoryLimit,
        localStorageCapacity,
        jobTimeout: timeout,
        environmentVariables: env,
        projectId,
      }),
    );
  }

  if (secretRefs?.length) {
    // Secrets can't be diffed/updated in place (same limitation noted above
    // for secretRefs generally), so a re-deploy must clear whatever is on the
    // definition first - otherwise the API answers "http error 409: secret
    // path or env_var_name is duplicated" on the second createSecrets call.
    // listSecrets' response shape is unverified across SDK versions (only the
    // live 409 confirmed the duplicate, not the list shape), so this handles
    // both a bare array and an object carrying a `secrets` field.
    const existingSecretsRes = await sdkCall(() => jobs.listSecrets({ region, jobDefinitionId: definition.id }));
    const existingSecrets = Array.isArray(existingSecretsRes) ? existingSecretsRes : (existingSecretsRes?.secrets ?? []);
    for (const secret of existingSecrets) {
      // Live-verified (v1alpha2): the reference id field is `secretId`, not `id`.
      await sdkCall(() => jobs.deleteSecret({ region, secretId: secret.secretId ?? secret.id }));
    }

    await sdkCall(() =>
      jobs.createSecrets({
        region,
        jobDefinitionId: definition.id,
        secrets: secretRefs.map(toSecretConfig),
      }),
    );
  }

  return toLegacyJobDefinition(definition);
}

/**
 * Start an existing job definition, creating a new job run.
 *
 * The API's response is `{ jobRuns: [...] }` (one JobRun per replica). This
 * helper returns just the first run's id, matching CONTRACT.md's `-> runId`
 * signature; for `replicas > 1` use listJobDefinitions/listJobRuns filtering
 * by jobDefinitionId to see the rest.
 *
 * @returns {Promise<string>} runId
 */
export async function startJob(definitionId, { env, command, replicas, opts = {} } = {}) {
  const region = opts.region || REGION;
  const jobs = await jobsApi();
  const request = { jobDefinitionId: definitionId, region };
  if (command !== undefined) request.command = command;
  if (env !== undefined) request.environmentVariables = env;
  if (replicas !== undefined) request.replicas = replicas;

  const res = await sdkCall(() => jobs.startJobDefinition(request));
  const run = res?.jobRuns?.[0];
  if (!run) {
    throw new ScwError(`starting job definition ${definitionId} returned no job runs`, {
      type: "job_start_error",
      details: res,
    });
  }
  return run.id;
}

/**
 * Polls getJobRun (no SDK waiter exists for Jobs - only Container's
 * waitForContainer/waitForNamespace/waitForDomain are provided) until
 * `state` is terminal. Treats "failed" and "interrupted" as errors and
 * throws ScwError with the run's error message (and failure `reason` when
 * present - v1alpha2 adds this richer failure context over v1alpha1) - it
 * never keeps polling a run that will never succeed. See the enum comment
 * above JOB_RUN_TERMINAL_STATES for the v1alpha1 -> v1alpha2 state changes.
 *
 * @returns {Promise<{state:string, exitCode:number|null}>}
 */
export async function waitForJobRun(runId, { timeoutMs = 900_000, ...opts } = {}) {
  const region = opts.region || REGION;
  const jobs = await jobsApi();
  const result = await pollUntil(
    async () => {
      const run = await sdkCall(() => jobs.getJobRun({ jobRunId: runId, region }));
      return JOB_RUN_TERMINAL_STATES.has(run.state) ? run : false;
    },
    { timeoutMs, intervalMs: 5000, label: `job run ${runId} completion` },
  );

  if (JOB_RUN_ERROR_STATES.has(result.state)) {
    const reason = result.reason ? ` (${result.reason})` : "";
    throw new ScwError(
      `job run ${runId} ended in state "${result.state}"${reason}: ${result.errorMessage || "no error message"}`,
      { type: "job_run_error", details: result },
    );
  }
  return { state: result.state, exitCode: result.exitCode ?? null };
}

/**
 * Set (or update) the job definition's cron schedule.
 *
 * Maps to the Trigger API (createTrigger/listTriggers/updateTrigger),
 * confirmed present on Jobs.v1alpha2's API instance - NOT a direct PATCH of
 * JobDefinition.cronSchedule (that inline field also exists on the SDK type,
 * but the Trigger API is the general-purpose mechanism Scaleway ships
 * scheduling through in v1alpha2, so this module owns exactly one source of
 * truth for a definition's schedule: its cron Trigger). find-or-update: a
 * job definition may have at most one cron trigger in this harness's usage,
 * so this looks for an existing trigger with a `cronConfig` and updates it,
 * creating one only if none exists yet.
 *
 * @returns {Promise<object>} the job definition, with a `cron_schedule`
 *   field reflecting the trigger just written (see toLegacyJobDefinition)
 */
export async function setSchedule(definitionId, { cron, timezone, opts = {} } = {}) {
  const region = opts.region || REGION;
  const jobs = await jobsApi();

  const existingTriggers = await sdkCall(() => jobs.listTriggers({ jobDefinitionId: definitionId, region }).all());
  const cronTrigger = existingTriggers.find((t) => t.cronConfig);

  let trigger;
  if (cronTrigger) {
    trigger = await sdkCall(() =>
      jobs.updateTrigger({ triggerId: cronTrigger.id, region, cronConfig: { schedule: cron, timezone } }),
    );
  } else {
    trigger = await sdkCall(() =>
      jobs.createTrigger({
        jobDefinitionId: definitionId,
        region,
        name: "schedule",
        // CreateTriggerRequestCronConfig requires startupCommand/args (no `?`
        // in the SDK types) even though this harness only ever overrides the
        // schedule/timezone - empty arrays mean "use the job's own defaults".
        cronConfig: { schedule: cron, timezone, startupCommand: [], args: [] },
      }),
    );
  }

  const definition = await sdkCall(() => jobs.getJobDefinition({ jobDefinitionId: definitionId, region }));
  return toLegacyJobDefinition(definition, {
    cron_schedule: {
      schedule: trigger.cronConfig?.schedule ?? cron,
      timezone: trigger.cronConfig?.timezone ?? timezone,
    },
  });
}

/**
 * List every job definition in the Project.
 *
 * Enriches each definition with a `cron_schedule` derived from its cron
 * Trigger (see setSchedule) when the inline `cronSchedule` field itself is
 * empty - this harness always schedules through the Trigger API, so that is
 * the common case. This costs one extra listTriggers call per definition;
 * accepted because this function is only called from low-frequency,
 * operator-facing paths (`/add-cron list`, `/delete-project` discovery), and
 * CONTRACT.md §3 freezes the `d.cron_schedule?.schedule` shape
 * scripts/setup-cron-worker.mjs already reads.
 */
export async function listJobDefinitions(opts = {}) {
  const region = opts.region || REGION;
  const jobs = await jobsApi();
  const creds = requireCredentials();
  const projectId = opts.projectId || creds.projectId;
  const defs = await sdkCall(() => jobs.listJobDefinitions({ region, projectId }).all());

  return Promise.all(
    defs.map(async (d) => {
      let cronSchedule = d.cronSchedule;
      if (!cronSchedule) {
        try {
          const triggers = await sdkCall(() => jobs.listTriggers({ jobDefinitionId: d.id, region }).all());
          const cronTrigger = triggers.find((t) => t.cronConfig);
          if (cronTrigger) {
            cronSchedule = { schedule: cronTrigger.cronConfig.schedule, timezone: cronTrigger.cronConfig.timezone };
          }
        } catch {
          // Best-effort enrichment only - never fail the whole listing
          // because one definition's triggers couldn't be fetched.
        }
      }
      return toLegacyJobDefinition(d, { cron_schedule: cronSchedule ?? undefined });
    }),
  );
}

/**
 * Delete a job definition.
 */
export async function deleteJobDefinition(definitionId, opts = {}) {
  const region = opts.region || REGION;
  const jobs = await jobsApi();
  return sdkCall(() => jobs.deleteJobDefinition({ jobDefinitionId: definitionId, region }));
}

/* ------------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , cmd, ...rest] = process.argv;

  const usage = () => {
    console.log("⚠️ usage: jobs.mjs <list|start|wait|delete> <args...>");
    console.log(JSON.stringify({ ok: false, error: "unknown or missing command" }));
    process.exitCode = 1;
  };

  (async () => {
    try {
      switch (cmd) {
        case "list": {
          console.log("▸ listing job definitions");
          const result = await listJobDefinitions();
          console.log(`✅ found ${result.length} definition(s)`);
          console.log(JSON.stringify({ job_definitions: result }));
          break;
        }
        case "start": {
          console.log(`▸ starting job definition ${rest[0]}`);
          const runId = await startJob(rest[0]);
          console.log(`✅ started run ${runId}`);
          console.log(JSON.stringify({ runId }));
          break;
        }
        case "wait": {
          console.log(`▸ waiting for job run ${rest[0]}`);
          const result = await waitForJobRun(rest[0], { timeoutMs: 60_000 });
          console.log(`✅ run finished: ${result.state}`);
          console.log(JSON.stringify(result));
          break;
        }
        case "delete": {
          console.log(`▸ deleting job definition ${rest[0]}`);
          await deleteJobDefinition(rest[0]);
          console.log("✅ deleted");
          console.log(JSON.stringify({ ok: true }));
          break;
        }
        default:
          usage();
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      console.log(JSON.stringify({ ok: false, error: e.message, type: e.type, details: e.details }));
      process.exitCode = 1;
    }
  })();
}
