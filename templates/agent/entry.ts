// agent/entry.ts - Entry point for the Scaleway Serverless Job.
//
// Unlike the old always-on background worker process, a
// Serverless Job run is FINITE: it starts, runs, and must exit - up to 6
// vCPU / 16 GB / 24h per CONTRACT.md §1. There is no public port to expose
// and no "always warm" state between runs by default, but Jobs support
// native cron triggers (with real IANA timezones) and CAN reference Secret
// Manager directly - both used here.
//
// AGENT_TRIGGER_MODE (baked into the Job definition's default env at scaffold
// time by setup-agent.mjs) picks one of three run shapes:
//
//   "cron"       - the Job's own cron_schedule (see jobs.mjs setSchedule, set
//                  at deploy time to the user's chosen cadence) wakes this
//                  process at the scheduled time. It runs the configured
//                  AGENT_CRON_PROMPT once, ALSO drains any pending manual
//                  triggers from agent_trigger_queue picked up at the same
//                  wake-up, then exits. Manual "Run now" clicks on a
//                  cron-mode agent are picked up at the NEXT scheduled tick,
//                  not within seconds - an honest trade-off against the old
//                  design, documented in the dashboard's trigger form.
//
//   "manual"     - the Job's cron_schedule is set to a short, fixed interval
//                  (every 5 minutes - see setup-agent.mjs) purely to wake up,
//                  drain agent_trigger_queue, and exit. Nothing runs between
//                  ticks, so a manual-only agent is near scale-to-zero
//                  (billed only for the few seconds of each tick, not 24/7) -
//                  something an always-on worker could never do.
//
//   "continuous" - the process stays up and polls agent_trigger_queue every
//                  5 s, same as before, for agents that genuinely need
//                  sub-minute reactivity (e.g. a future event-source tool).
//                  It self-exits a safety margin before the 24h Job runtime
//                  cap; the Job definition also carries a once-a-day cron
//                  trigger as a restart safety net in case the process ever
//                  exits early (crash, OOM). Brief overlap between an old and
//                  a newly-restarted run is possible and harmless: queue rows
//                  are marked "running" as soon as they're picked up.
//
// Lifecycle: on SIGTERM (Job termination), finish in-flight invocations
// (up to 60 s), then exit clean.

import { db } from "./db.js";
import { agentTriggerQueue } from "./schema.js";
import { eq } from "drizzle-orm";
import { runAgent } from "./loop.js";

const MODE = process.env.AGENT_TRIGGER_MODE ?? "manual"; // cron | manual | continuous
const AGENT_CRON_PROMPT = process.env.AGENT_CRON_PROMPT; // prompt used for cron-triggered runs
const CONTINUOUS_POLL_INTERVAL_MS = 5_000;
// Safety margin under the 24h Job runtime cap (CONTRACT.md §1).
const CONTINUOUS_MAX_RUNTIME_MS = 23.5 * 60 * 60 * 1000;

let shuttingDown = false;
let inflight = 0;

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function shutdown(signal: string) {
  console.log(`[agent] Received ${signal} - shutting down gracefully (${inflight} in-flight)`);
  shuttingDown = true;
  const deadline = Date.now() + 60_000;
  while (inflight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── Drain agent_trigger_queue: run every pending row, then return ───
async function drainQueue(): Promise<void> {
  const pending = await db
    .select()
    .from(agentTriggerQueue)
    .where(eq(agentTriggerQueue.status, "pending"))
    .limit(10);

  for (const trigger of pending) {
    if (shuttingDown) return;
    await db
      .update(agentTriggerQueue)
      .set({ status: "running", pickedUpAt: new Date() })
      .where(eq(agentTriggerQueue.id, trigger.id));

    inflight++;
    try {
      const result = await runAgent({
        prompt: trigger.prompt,
        context: (trigger.context as Record<string, unknown>) ?? undefined,
        triggeredBy: trigger.source ?? "manual",
      });
      await db
        .update(agentTriggerQueue)
        .set({ status: "done", finishedAt: new Date(), invocationId: result.invocationId })
        .where(eq(agentTriggerQueue.id, trigger.id));
      console.log(`[agent] Trigger ${trigger.id} done: ${result.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(agentTriggerQueue)
        .set({ status: "failed", finishedAt: new Date(), errorMessage: msg })
        .where(eq(agentTriggerQueue.id, trigger.id));
      console.error(`[agent] Trigger ${trigger.id} failed:`, msg);
    } finally {
      inflight--;
    }
  }
}

// ─── "cron" mode: one scheduled run + one queue drain, then exit ─────
async function runCronTick(): Promise<void> {
  inflight++;
  try {
    const result = await runAgent({
      prompt: AGENT_CRON_PROMPT ?? "Run your scheduled task.",
      triggeredBy: "cron",
    });
    console.log(`[agent] Cron run complete: ${result.status} (${result.iterations} turns, €${result.totalCost.eur.toFixed(4)})`);
  } catch (e) {
    console.error("[agent] Cron run errored:", e);
  } finally {
    inflight--;
  }
  await drainQueue();
}

// ─── "continuous" mode: stay up, poll every 5 s, self-exit before 24h ─
async function runContinuous(): Promise<void> {
  const deadline = Date.now() + CONTINUOUS_MAX_RUNTIME_MS;
  console.log("[agent] Continuous mode - polling agent_trigger_queue every 5 s");
  while (!shuttingDown && Date.now() < deadline) {
    try {
      await drainQueue();
    } catch (e) {
      console.error("[agent] Poll error (continuing):", e);
    }
    await new Promise((r) => setTimeout(r, CONTINUOUS_POLL_INTERVAL_MS));
  }
  console.log("[agent] Continuous run reached its safety deadline or was asked to stop - exiting clean (the daily restart cron trigger picks it back up).");
}

// ─── Boot ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`[agent] Boot - Scaleway Serverless Job started (mode: ${MODE})`);
  if (MODE === "cron") {
    await runCronTick();
  } else if (MODE === "continuous") {
    await runContinuous();
  } else {
    // "manual" - a single lightweight queue drain, driven by the Job's
    // short-interval cron trigger (see setup-agent.mjs).
    await drainQueue();
  }
  await shutdown("done");
  process.exit(0);
}

void main();
