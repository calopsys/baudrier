---
name: add-workflow
description: "Add an agentic workflow to the project: a finite, event-triggered pipeline of typed steps (some intelligent via Scaleway Generative APIs) that runs INSIDE the Next.js app's Scaleway Serverless Container by default - no dedicated worker, no 24/7 agent, no extra infrastructure for the common case. The sweet spot between /add-cron (a scheduled task) and /add-agent (an autonomous product agent): 'when X happens, do A then B then C, one of which needs to understand/decide/write'. Scaffolds a shared step-runner with per-step retry and run logging, the workflow module, and the chosen trigger (user action, webhook, or schedule via /add-cron). A pipeline that genuinely can't fit one request escalates to a dedicated Scaleway Serverless Job (same primitive /add-agent uses), never a bespoke worker. Invoked directly or routed from /add-automation."
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js and pnpm; the project must be a Next.js app (typically from /bootstrap)."
---

# Add Workflow - A finite intelligent pipeline inside the app

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms. Say "workflow" and "step", never "pipeline runner" or "idempotency key" without a one-line explanation.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

## What a workflow is (and is not)

A workflow is **a finite sequence of steps that the app itself executes when something happens**: a user clicks, a file lands, a payment arrives, a schedule fires. Some steps are plain code (call an API, write to the database, send an email); some steps are **intelligent** (a Scaleway Generative APIs call that reads, classifies, extracts, or writes). The whole run finishes in seconds to a couple of minutes, inside the app's own Scaleway Serverless Container - or, for the rare pipeline that needs real headroom, as a dedicated Scaleway Serverless Job (see Step 2).

Most people who ask for "an agent" actually want this. The test:

| It is a WORKFLOW if... | It is NOT a workflow (route elsewhere) |
|---|---|
| The sequence is finite and known in advance (2-8 steps) | The AI decides its own next actions in a loop with tools → `/add-agent` |
| Triggered by an event, then it ENDS | Runs continuously, 24/7, polls or listens → `/add-automation` (worker) |
| State lives in the database between runs | Needs in-memory state across runs, queues, websockets → `/add-automation` (worker) |
| Fits within the request/Job time budget (see Step 2) | Minutes of CPU, transcoding, huge files → `/add-automation` (worker) |
| Output serves the app or its users | Output is a brief/report for the operator themselves → `/add-routine` |

If during discovery the need clearly falls in the right column, say so in one honest sentence and hand off to the right command. Do not force a workflow.

## Step 0 - Preflight

1. Invoke **`_detect-project-root`** → `PROJECT_NAME`, `IS_MONOREPO`, `WEB_DIR`, `IS_NEXTJS`. If not a Next.js project, stop: workflows live inside the app.
2. Invoke **`_check-deps`** for the database. A real DB (Scaleway Serverless SQL Database wired by `/add-db`) enables run logging in a table; without it the runner degrades to console logging (say so, and continue - do not force `/add-db`).
3. **Scaleway Generative APIs key, ONLY if the pipeline will have intelligent steps** (checked again after discovery): check whether `SCW_GENERATIVE_API_KEY` already exists in Secret Manager (`node scripts/scaleway/secrets.mjs exists SCW_GENERATIVE_API_KEY`) - if `/add-agent` has already run in this project, it's already there and gets reused, nothing to do. Otherwise mint a narrowly-scoped one yourself the same way `setup-agent.mjs` does: `ensureApplication` + `ensurePolicy({ permissionSetNames: ["GenerativeApisModelAccess"] })` + `createApiKey` from `scripts/scaleway/iam.mjs`, then `putSecret("SCW_GENERATIVE_API_KEY", ...)`. No key to paste, nothing to ask the user for.

   **If minting fails with `"type":"permission_denied"`** (the operator's key lacks `IAMManager`): do not relay a French message to an administrator here - that no longer happens at this stage. The mint falls back to the operator's own personal Scaleway key for `SCW_GENERATIVE_API_KEY`, silently, the same delegated-secret-then-personal-key chain `/add-db` uses for `DATABASE_URL` (CONTRACT.md §1, §2): the fallback is recorded so `/publish` can find and swap it later, `SCW_GENERATIVE_API_KEY` is stored in Secret Manager as usual, and this step continues with no user-visible interruption. No administrator action happens at this point - the admin is asked once, later, when the user runs `/publish`, which refuses to proceed while any secret is still dev-backed and prints one consolidated request covering every addon at once.

## Step 1 - Discovery

Ask one open question:

> **Describe what should happen, from trigger to result**: what event starts it, what the app must do step by step, and what comes out at the end.

Read the answer against the table above FIRST (workflow or not). Then extract:

- **Trigger**: a user action in the app / an external service calling us (webhook) / a schedule
- **The steps**, in order, and which of them need intelligence (understand, classify, extract, summarize, decide, draft)
- **Volume and duration feel**: how often, how big are the inputs

Ask at most 2 clarifying questions if something is genuinely ambiguous. Typical: *"This summary the workflow writes, who reads it: your users, or you?"* (the answer may reroute to `/add-routine`).

## Step 2 - The duration budget (the honest gate)

By default a workflow runs inside the app's own Scaleway Serverless Container, handling the trigger's HTTP request directly - fine for the vast majority of pipelines (seconds to a couple of minutes). Do not recite a hard number from memory - Scaleway's own request-duration limits depend on the container's configuration:

1. Estimate the pipeline: each plain API step ~1-3s, each Generative APIs step ~2-20s depending on input size and model, file processing depends on size.
2. Rule of thumb to say out loud: **under a minute is always safe; beyond a couple of minutes, don't fight the request timeout - move the step execution to a Job.**

If the estimate clearly exceeds a couple of minutes, be honest and offer the escalation - NOT a bespoke in-app queue-and-cron trick, but the same primitive `/add-agent` already uses:

> Ton pipeline tel que décrit tournerait ~X. C'est trop long pour une seule requête HTTP. Je peux le faire tourner comme un **Job Scaleway dédié** à la place : le déclencheur enregistre la demande en base, un Job réveillé toutes les quelques minutes la traite avec tout le temps voulu (jusqu'à 24h), puis se rendort. Ça ajoute quelques minutes de latence, en échange d'une vraie marge de manœuvre et d'une facturation quasi nulle entre les exécutions. Je le mets en place ?

If the user agrees, scaffold the escalated version by mirroring `/add-agent`'s Job pattern (read `templates/agent/entry.ts`, `templates/agent/job-definition.json` and `templates/agent/Dockerfile` for the exact shape - do not duplicate that machinery blindly, adapt it):
- `apps/<workflow-name>-job/` with its own `entry.ts` (a short script that pops the oldest `queued` row from `workflow_run`, calls the same step-array through `runWorkflow()`, marks it `done`/`failed`, then exits - no tool-calling loop needed, workflows aren't agentic), `Dockerfile`, `package.json`, and `job-definition.json` (cron-triggered every few minutes, same `secretRefs` pattern for `DATABASE_URL` and, if there are intelligent steps, `SCW_GENERATIVE_API_KEY`).
- The trigger (tRPC mutation / webhook route) INSERTS a `workflow_run` row with `status: "queued"` and returns immediately - it does NOT call the workflow function directly, and it does NOT call the Scaleway Jobs API itself (the deployed app never holds Job-management credentials; only the operator's `/deploy` does, via `scripts/scaleway/jobs.mjs`).
- `/deploy` creates/updates this Job exactly like it does for an agent's Job, from the `job-definition.json` found under `apps/<workflow-name>-job/`.

This escalation path exists for the rare case; most workflows never need it, and it never grows into a webhook/queue custom worker like `/add-automation`'s.

## Step 3 - Scaffold

### 3.a The shared runner (once per project)

If `src/server/workflows/_runner.ts` does not exist, create it (in `WEB_DIR`; monorepo paths apply):

```ts
// src/server/workflows/_runner.ts
// Minimal step runner for in-app agentic workflows.
// - typed steps, executed in order, each with optional retry
// - every run and step is logged (DB table `workflow_run` when available, console otherwise)
// - idempotency: pass a stable key to make re-delivered events (webhooks!) no-ops

export type StepResult<T> = { output: T };

export type Step<In, Out> = {
  name: string;
  retryable?: boolean; // one retry after 2s on failure
  run: (input: In) => Promise<Out>;
};

export type RunOptions = {
  workflow: string;
  idempotencyKey?: string;
};

type StepLog = { name: string; status: "ok" | "failed" | "retried"; ms: number; error?: string };

async function persistRun(
  opts: RunOptions,
  status: "running" | "done" | "failed",
  steps: StepLog[],
  error?: string,
): Promise<void> {
  try {
    const { db } = await import("~/server/db");
    const { workflowRuns } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const existing = opts.idempotencyKey
      ? await db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, opts.idempotencyKey)).limit(1)
      : [];
    if (existing.length > 0) {
      await db
        .update(workflowRuns)
        .set({ status, steps, error: error ?? null, finishedAt: status === "running" ? null : new Date() })
        .where(eq(workflowRuns.id, existing[0]!.id));
    } else {
      await db.insert(workflowRuns).values({
        workflow: opts.workflow,
        status,
        steps,
        error: error ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: status === "running" ? null : new Date(),
      });
    }
  } catch {
    console.log(`[workflow:${opts.workflow}] ${status}`, JSON.stringify(steps));
  }
}

export async function alreadyRan(idempotencyKey: string): Promise<boolean> {
  try {
    const { db } = await import("~/server/db");
    const { workflowRuns } = await import("~/server/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.idempotencyKey, idempotencyKey), eq(workflowRuns.status, "done")))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false; // no DB: cannot deduplicate, run anyway
  }
}

export async function runWorkflow<T>(
  opts: RunOptions,
  steps: Array<Step<unknown, unknown>>,
  input: unknown,
): Promise<T> {
  if (opts.idempotencyKey && (await alreadyRan(opts.idempotencyKey))) {
    console.log(`[workflow:${opts.workflow}] skipped (already ran: ${opts.idempotencyKey})`);
    return undefined as T;
  }
  const log: StepLog[] = [];
  await persistRun(opts, "running", log);
  let current: unknown = input;
  for (const step of steps) {
    const t0 = Date.now();
    try {
      current = await step.run(current);
      log.push({ name: step.name, status: "ok", ms: Date.now() - t0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (step.retryable) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          current = await step.run(current);
          log.push({ name: step.name, status: "retried", ms: Date.now() - t0 });
          continue;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          log.push({ name: step.name, status: "failed", ms: Date.now() - t0, error: msg2 });
          await persistRun(opts, "failed", log, msg2);
          throw err2;
        }
      }
      log.push({ name: step.name, status: "failed", ms: Date.now() - t0, error: msg });
      await persistRun(opts, "failed", log, msg);
      throw err;
    }
  }
  await persistRun(opts, "done", log);
  return current as T;
}
```

### 3.b The run-log table (only if the DB exists)

Add to `src/server/db/schema.ts`, using `pgTable` (drizzle-orm/pg-core) and the file's existing style:

```ts
export const workflowRuns = pgTable("workflow_run", (d) => ({
  id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
  workflow: d.varchar({ length: 100 }).notNull(),
  status: d.varchar({ length: 20 }).notNull(), // running | done | failed
  steps: d.jsonb().$type<Array<{ name: string; status: string; ms: number; error?: string }>>().notNull(),
  error: d.text(),
  idempotencyKey: d.varchar({ length: 200 }).unique(),
  startedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  finishedAt: d.timestamp({ withTimezone: true }),
}));
```

Then `pnpm db:generate` (writes the SQL migration, no DB connection; the next `/deploy` applies it). Adapt the column-builder syntax to what the project's schema actually uses; older scaffolds differ. Read the file first, imitate it.

### 3.c The workflow module

Create `src/server/workflows/<kebab-name>.ts`. Template, to be tailored to the discovered steps (this example: analyze an uploaded document and notify):

```ts
// src/server/workflows/analyze-upload.ts
import OpenAI from "openai";
import { env } from "~/env";
import { runWorkflow, type Step } from "./_runner";

// Scaleway Generative APIs, OpenAI-compatible. Balanced default; use a
// larger model (e.g. llama-3.3-70b-instruct) only if quality demands it -
// see https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/
// for the current catalog and pricing.
const MODEL = env.SCW_GENERATIVE_MODEL ?? "mistral-small-3.2-24b-instruct-2506";

type Input = { documentUrl: string; userEmail: string };
type Extracted = Input & { text: string };
type Analyzed = Extracted & { summary: string; category: string };

const fetchDocument: Step<Input, Extracted> = {
  name: "fetch-document",
  retryable: true,
  run: async (input) => {
    const res = await fetch(input.documentUrl);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return { ...input, text: await res.text() };
  },
};

const analyze: Step<Extracted, Analyzed> = {
  name: "analyze",
  retryable: true,
  run: async (input) => {
    const client = new OpenAI({ apiKey: env.SCW_GENERATIVE_API_KEY, baseURL: env.SCW_GENERATIVE_BASE_URL });
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `Summarize this document in 3 sentences, then classify it as one of: invoice, contract, report, other.\nRespond as JSON: {"summary": "...", "category": "..."}\n\n${input.text.slice(0, 50_000)}`,
      }],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { summary?: string; category?: string };
    return { ...input, summary: parsed.summary ?? "", category: parsed.category ?? "other" };
  },
};

const notify: Step<Analyzed, { ok: true }> = {
  name: "notify",
  run: async (input) => {
    // Reuse the project's mail helper if /add-email is set up; otherwise persist only.
    console.log(`[analyze-upload] ${input.userEmail}: ${input.category} - ${input.summary}`);
    return { ok: true };
  },
};

export function analyzeUpload(input: Input, idempotencyKey?: string) {
  return runWorkflow<{ ok: true }>(
    { workflow: "analyze-upload", idempotencyKey },
    [fetchDocument, analyze, notify] as Array<Step<unknown, unknown>>,
    input,
  );
}
```

Install the SDK if missing: `pnpm add openai`. Add `SCW_GENERATIVE_API_KEY`, `SCW_GENERATIVE_BASE_URL` and `SCW_GENERATIVE_MODEL` to `src/env.js` (server section) following the file's existing pattern - these are the same canonical names CONTRACT.md §2 defines for `/add-agent`, so if an agent already exists in this project they're already wired and nothing new is needed.

### 3.d The trigger

Wire exactly ONE of these, per discovery:

- **User action** → a tRPC mutation in the relevant router calling the workflow function (protected by the project's auth if present). The UI side stays optimistic per house rules.
- **Webhook** → `src/app/api/webhooks/<name>/route.ts`: verify a shared secret header, derive the idempotency key from the event id, call the workflow. Generate the secret with `_generate-secret`, push it as `<NAME>_WEBHOOK_SECRET` via `_push-env-vars`, and give the user the URL + header to configure in the external service.

```ts
// src/app/api/webhooks/analyze-upload/route.ts
import { type NextRequest, NextResponse } from "next/server";
import { env } from "~/env";
import { analyzeUpload } from "~/server/workflows/analyze-upload";

export async function POST(req: NextRequest) {
  if (req.headers.get("x-webhook-secret") !== env.ANALYZE_UPLOAD_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { id: string; documentUrl: string; userEmail: string };
  await analyzeUpload({ documentUrl: body.documentUrl, userEmail: body.userEmail }, `analyze-upload:${body.id}`);
  return NextResponse.json({ ok: true });
}
```

- **Schedule** → do NOT reimplement a clock: invoke **`add-cron`** and have the generated `/api/cron/<name>` route call the workflow function. One mechanism, composed.

Note: Next.js's `export const maxDuration` route config is meant for platforms with per-route function timeouts and does nothing on Scaleway Serverless Containers (they run standalone Next.js in a plain Node server) - don't add it. The real budget is Step 2's request-duration estimate; if a pipeline needs more room than a single request safely allows, escalate to a Job as described there instead of trying to extend a request timeout that isn't configurable per-route here.

## Step 4 - Implement the real logic now, or later

Same contract as the other skills:

> The workflow skeleton is in place with example steps. **(a)** Describe the real steps in detail now and I implement them (15-30 min), or **(b)** keep the skeleton and we refine it whenever you want.

If (a): replace the example steps with the real ones, one `Step` per logical action, `retryable: true` on network calls, intelligent steps prompted precisely (input contract, output as JSON, low temperature behavior by default). If new third-party keys are needed, collect and push them via `_push-env-vars`.

## Step 5 - Test locally

Run the dev server and trigger once for real: call the tRPC procedure from the UI, or `curl` the webhook with the secret header, or hit the cron route. Then verify the run log (query `workflow_run`, or read the console) and show the user the step timeline. `pnpm tsc --noEmit && pnpm lint` must pass. Never call `pnpm build` to verify.

## Step 6 - CLAUDE.md

Invoke `_update-claude-md` with:
- `custom`:
  - heading: `## Workflows`
  - body:
    ```
    - **<kebab-name>** - <trigger: user action | webhook | schedule> - <1-sentence purpose>. Steps: <a → b → c>. Runs in-app (src/server/workflows/<kebab-name>.ts), logged in `workflow_run`<if AI steps>, intelligent steps on <MODEL></if>. Budget: ~<estimate>s per run.
    ```

## Step 7 - RGPD (conditional)

Scaleway Generative APIs runs on the same Scaleway infrastructure already declared as the project's host - no separate subprocessor entry needed for the workflow's intelligent steps.

## Step 8 - Final summary

> ## ✅ Workflow in place
>
> **<kebab-name>**: <trigger> → <steps in plain words> → <result>
> **Logged**: every run and step in your database (table `workflow_run`)<if no DB> in the server logs</if>
> **Cost note**<if AI steps>: each run makes <N> Generative APIs call(s); at your expected volume that is roughly <order of magnitude> EUR/month. The `workflow_run` timings let you watch it.</if>
>
> To evolve it, just describe the change ("add a step that...", "make it also..."). To see activity: "show me the last workflow runs".

If the user came from `/add-automation`, report completion so the orchestrator can close its own summary.
