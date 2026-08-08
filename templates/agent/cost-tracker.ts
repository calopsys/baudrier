// agent/cost-tracker.ts - Cost tracking + circuit breaker for agents.
//
// Two budgets enforced:
//   - DAILY (EUR per day)   - protects against runaway loops
//   - MONTHLY (EUR per month) - protects against slow drift
//
// Whichever fires first trips the breaker. The agent loop calls
// checkCircuitBreaker() at the start of every invocation and skips the run
// if tripped. trackCost() is called at the end to accumulate.
//
// All amounts are EUR natively - Scaleway Generative APIs bills in EUR (see
// https://www.scaleway.com/en/generative-apis/ pricing table), so there is no
// USD/EUR conversion step anywhere in this file.
//
// Default caps (1 EUR/day, 10 EUR/month) were derived from Scaleway's own
// serverless model pricing, roughly an order of magnitude cheaper per token
// than a frontier hosted-LLM provider. Assumptions behind these numbers:
//   - TEMPLATE_MAX_ITERATIONS = 10, TEMPLATE_MAX_TOKENS_PER_CALL = 4096 (loop.ts)
//   - worst-case default model tier: llama-3.3-70b-instruct at ~EUR 0.90 / M
//     tokens (both input and output - the more expensive of the two models
//     offered at scaffold time)
//   - ~8 000 input tokens/turn on average by mid-conversation (growing context)
//   - => one fully-runaway invocation (10 turns, always hitting max tokens)
//     costs roughly EUR 0.11
//   - 1 EUR/day leaves ~9x headroom over that single worst-case run, a similar
//     safety margin to the old 5 USD/~0.61 USD (~8x) ratio
// Override via AGENT_DAILY_BUDGET_EUR / AGENT_MONTHLY_BUDGET_EUR if your
// agent's real usage pattern needs more (or less) room.

import { db } from "./db.js";
import { agentInvocations } from "./schema.js";
import { and, eq, gte, sql } from "drizzle-orm";

// ─── Default budgets (override per agent if needed) ───────────────────
const DAILY_BUDGET_EUR = Number(process.env.AGENT_DAILY_BUDGET_EUR ?? "1");
const MONTHLY_BUDGET_EUR = Number(process.env.AGENT_MONTHLY_BUDGET_EUR ?? "10");

// ─── Types ────────────────────────────────────────────────────────────
export interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  eur: number;
}

export interface BreakerStatus {
  tripped: boolean;
  reason?: string;
  spentTodayEur: number;
  spentThisMonthEur: number;
  dailyLimit: number;
  monthlyLimit: number;
}

// ─── Public API ───────────────────────────────────────────────────────
/**
 * Should be called at the start of every agent invocation. Returns
 * { tripped: true, reason } if the agent should NOT run.
 */
export async function checkCircuitBreaker(agentName: string): Promise<BreakerStatus> {
  const { spentToday, spentThisMonth } = await getSpend(agentName);

  if (spentToday >= DAILY_BUDGET_EUR) {
    return {
      tripped: true,
      reason: `Plafond journalier atteint : ${spentToday.toFixed(2)} EUR / ${DAILY_BUDGET_EUR} EUR`,
      spentTodayEur: spentToday,
      spentThisMonthEur: spentThisMonth,
      dailyLimit: DAILY_BUDGET_EUR,
      monthlyLimit: MONTHLY_BUDGET_EUR,
    };
  }
  if (spentThisMonth >= MONTHLY_BUDGET_EUR) {
    return {
      tripped: true,
      reason: `Plafond mensuel atteint : ${spentThisMonth.toFixed(2)} EUR / ${MONTHLY_BUDGET_EUR} EUR`,
      spentTodayEur: spentToday,
      spentThisMonthEur: spentThisMonth,
      dailyLimit: DAILY_BUDGET_EUR,
      monthlyLimit: MONTHLY_BUDGET_EUR,
    };
  }

  return {
    tripped: false,
    spentTodayEur: spentToday,
    spentThisMonthEur: spentThisMonth,
    dailyLimit: DAILY_BUDGET_EUR,
    monthlyLimit: MONTHLY_BUDGET_EUR,
  };
}

/**
 * Records that this agent just spent `eur` (in EUR). The actual recording is
 * done via the agentInvocations row's totalCostEur column (already persisted
 * by the loop). Kept for symmetry with the breaker check and as a future hook
 * (e.g. pushing to Cockpit metrics / alerting on threshold crossings).
 */
export async function trackCost(agentName: string, eur: number): Promise<void> {
  void agentName;
  void eur;
}

// ─── Spend aggregation (sums recent invocations) ─────────────────────
async function getSpend(agentName: string): Promise<{ spentToday: number; spentThisMonth: number }> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [todayRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${agentInvocations.totalCostEur}::numeric), 0)`,
    })
    .from(agentInvocations)
    .where(and(eq(agentInvocations.agentName, agentName), gte(agentInvocations.startedAt, dayStart)));

  const [monthRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${agentInvocations.totalCostEur}::numeric), 0)`,
    })
    .from(agentInvocations)
    .where(and(eq(agentInvocations.agentName, agentName), gte(agentInvocations.startedAt, monthStart)));

  return {
    spentToday: Number(todayRow?.total ?? 0),
    spentThisMonth: Number(monthRow?.total ?? 0),
  };
}
