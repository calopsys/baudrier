// agent/loop.ts - Generic agent loop on Scaleway Generative APIs.
//
// Drop-in pattern for an agent that:
//   - Uses Scaleway Generative APIs (OpenAI-compatible Chat Completions) -
//     see https://www.scaleway.com/en/docs/generative-apis/api-cli/using-chat-api/
//   - Loops on tool use (OpenAI-style function calling) until finish_reason
//     is "stop" or max_iterations is reached
//   - Tracks cost per turn (Scaleway bills EUR per token; there is no
//     prompt-caching discount tier or cache_control mechanism on this API)
//   - Persists every turn (decisions, tool calls, results) to Postgres
//   - Honors a daily/monthly EUR cost circuit breaker (kills runs over budget)
//   - Sends an email on failure or budget breach
//
// Each agent has its own SYSTEM_PROMPT, TOOLS array, and config (model,
// max_iterations, budget). The loop is reusable as-is.
//
// Replace the TEMPLATE_AGENT_NAME below with your agent's slug (used as the
// `agentName` column key in `agent_invocations` table). Keep it kebab-case.

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { db } from "./db.js";
import {
  agentInvocations,
  agentTurns,
} from "./schema.js";
import { eq } from "drizzle-orm";
import { trackCost, checkCircuitBreaker, type CostBreakdown } from "./cost-tracker.js";
import { sendAgentFailureEmail } from "./mail.js";
import { resetSendCount } from "./tools/send-email.js";

// ─── Per-agent config (override per agent) ────────────────────────────
const TEMPLATE_AGENT_NAME = "my-agent";              // slug, replace
// SCW_GENERATIVE_MODEL is set per-app at scaffold time (CONTRACT.md §2). The
// literal below is only the scaffold-time fallback if the env var is unset.
const TEMPLATE_MODEL = process.env.SCW_GENERATIVE_MODEL ?? "mistral-small-3.2-24b-instruct-2506";
const TEMPLATE_MAX_ITERATIONS = 10;
const TEMPLATE_MAX_TOKENS_PER_CALL = 4096;

// System prompt - kept in a top-level const, not fetched per turn.
const TEMPLATE_SYSTEM_PROMPT = `You are an autonomous agent. Your goal is X.
You have access to tools. Use them to accomplish the goal. When done, respond
with a clear final answer. If you encounter an unrecoverable error, explain it
in plain text and stop.`;

// ─── Tool registry (replace with your real tools) ─────────────────────
// Each tool has: definition (OpenAI-style function schema) + handler (JS
// impl). See ./tools/*.ts for ready-to-use tools (http-fetch, send-email,
// db-query).
import { tools as TEMPLATE_TOOLS } from "./tools/index.js";
type ToolName = keyof typeof TEMPLATE_TOOLS;

// ─── Types ─────────────────────────────────────────────────────────────
export interface AgentInput {
  /** Free-form description of what the agent should do this run.
   *  Becomes the first user message. */
  prompt: string;
  /** Optional structured context (will be JSON-stringified into the user
   *  message). Use for things like {emails: [...], rss: [...]}. */
  context?: Record<string, unknown>;
  /** Set to false to skip cost tracking (rare - testing only). */
  trackCosts?: boolean;
  /** Triggered by: "cron" | "manual" | "webhook" | "event". Logged for stats. */
  triggeredBy?: string;
}

export interface AgentResult {
  invocationId: string;
  status: "success" | "max_iterations_reached" | "budget_killed" | "error";
  finalText: string | null;
  iterations: number;
  totalCost: CostBreakdown;
  errorMessage?: string;
}

// ─── Main entry point ─────────────────────────────────────────────────
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  // The send-email cap is per-run, but its counter is module-level (cron
  // ticks and continuous-mode runs share the process) - reset it here.
  resetSendCount();

  const apiKey = process.env.SCW_GENERATIVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SCW_GENERATIVE_API_KEY is not set. The agent cannot run without it.",
    );
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.SCW_GENERATIVE_BASE_URL ?? "https://api.scaleway.ai/v1",
  });

  const totalCost: CostBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    eur: 0,
  };
  let iterations = 0;
  let finalText: string | null = null;
  let lastError: string | undefined;
  // Stays undefined if the circuit-breaker check or createInvocation itself
  // throws (e.g. DB unreachable), so the catch below knows there is no row
  // to finalize yet.
  let invocationId: string | undefined;

  try {
    // Step 1 - Circuit breaker check BEFORE any API call.
    const breakerStatus = await checkCircuitBreaker(TEMPLATE_AGENT_NAME);
    if (breakerStatus.tripped) {
      invocationId = await createInvocation(
        input,
        "budget_killed",
        `Circuit breaker tripped: ${breakerStatus.reason}`,
      );
      await sendAgentFailureEmail({
        agentName: TEMPLATE_AGENT_NAME,
        invocationId,
        reason: `Plafond budgétaire atteint (${breakerStatus.reason}). L'agent a été mis en pause auto.`,
      });
      return {
        invocationId,
        status: "budget_killed",
        finalText: null,
        iterations: 0,
        totalCost,
        errorMessage: breakerStatus.reason,
      };
    }

    // Step 2 - Create invocation row (status="running" → updated at end).
    invocationId = await createInvocation(input, "running");

    // Step 3 - Build initial messages.
    const initialUserContent = input.context
      ? `${input.prompt}\n\n<context>${JSON.stringify(input.context, null, 2)}</context>`
      : input.prompt;
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
      { role: "user", content: initialUserContent },
    ];

    // Step 4 - Build tool defs (OpenAI "function" tool shape).
    const toolDefs: ChatCompletionTool[] = Object.values(TEMPLATE_TOOLS).map((t) => ({
      type: "function",
      function: t.definition,
    }));

    // Step 5 - Loop.
    while (iterations < TEMPLATE_MAX_ITERATIONS) {
      iterations++;

      const response = await client.chat.completions.create({
        model: TEMPLATE_MODEL,
        max_tokens: TEMPLATE_MAX_TOKENS_PER_CALL,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        tool_choice: toolDefs.length > 0 ? "auto" : undefined,
      });

      const choice = response.choices[0];
      if (!choice) {
        lastError = "Empty response (no choices) from Generative APIs";
        break;
      }
      const message = choice.message;

      // Track usage for this turn (Scaleway's usage block is OpenAI-shaped:
      // prompt_tokens / completion_tokens - no cache tiers to account for).
      const turnCost = computeTurnCost(response.usage, TEMPLATE_MODEL);
      totalCost.inputTokens += turnCost.inputTokens;
      totalCost.outputTokens += turnCost.outputTokens;
      totalCost.eur += turnCost.eur;

      // Persist this turn (decisions + cost + content)
      await persistTurn(invocationId, iterations, message, choice.finish_reason, turnCost);

      // End conditions
      if (choice.finish_reason === "stop") {
        finalText = message.content ?? "";
        await finalizeInvocation(invocationId, "success", finalText, iterations, totalCost);
        if (input.trackCosts !== false) await trackCost(TEMPLATE_AGENT_NAME, totalCost.eur);
        return { invocationId, status: "success", finalText, iterations, totalCost };
      }

      if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
        // Append assistant message + execute tools + append one "tool" message per call
        messages.push({
          role: "assistant",
          content: message.content,
          tool_calls: message.tool_calls,
        });
        const toolResults = await executeToolCalls(message.tool_calls);
        messages.push(...toolResults);
        continue;
      }

      // Unexpected finish reason (length, content_filter, or tool_calls with no calls)
      lastError = `Unexpected finish_reason: ${choice.finish_reason}`;
      break;
    }

    // Either max iterations reached or unexpected stop
    if (lastError) {
      await finalizeInvocation(invocationId, "error", null, iterations, totalCost, lastError);
      if (input.trackCosts !== false) await trackCost(TEMPLATE_AGENT_NAME, totalCost.eur);
      await sendAgentFailureEmail({
        agentName: TEMPLATE_AGENT_NAME,
        invocationId,
        reason: lastError,
      });
      return { invocationId, status: "error", finalText: null, iterations, totalCost, errorMessage: lastError };
    }

    await finalizeInvocation(invocationId, "max_iterations_reached", null, iterations, totalCost);
    if (input.trackCosts !== false) await trackCost(TEMPLATE_AGENT_NAME, totalCost.eur);
    return { invocationId, status: "max_iterations_reached", finalText: null, iterations, totalCost };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (invocationId) {
      try {
        await finalizeInvocation(invocationId, "error", null, iterations, totalCost, message);
      } catch (finalizeErr) {
        // Log only: the original error is what the caller and the failure
        // email must report, not a secondary DB failure here.
        console.error(`[agent] finalizeInvocation failed for invocation ${invocationId}:`, finalizeErr);
      }
    }
    // Same rule as finalize above: a secondary failure while reporting must
    // not replace the original error in the returned result.
    if (input.trackCosts !== false) {
      try {
        await trackCost(TEMPLATE_AGENT_NAME, totalCost.eur);
      } catch (trackErr) {
        console.error(`[agent] trackCost failed for invocation ${invocationId ?? "unknown"}:`, trackErr);
      }
    }
    try {
      await sendAgentFailureEmail({
        agentName: TEMPLATE_AGENT_NAME,
        invocationId: invocationId ?? "unknown",
        reason: message,
      });
    } catch (mailErr) {
      console.error(`[agent] failure email failed for invocation ${invocationId ?? "unknown"}:`, mailErr);
    }
    return { invocationId: invocationId ?? "unknown", status: "error", finalText: null, iterations, totalCost, errorMessage: message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────
async function executeToolCalls(
  toolCalls: ChatCompletionMessageToolCall[],
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];
  for (const tc of toolCalls) {
    if (tc.type !== "function") continue;
    const tool = TEMPLATE_TOOLS[tc.function.name as ToolName];
    if (!tool) {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Error: unknown tool "${tc.function.name}"`,
      });
      continue;
    }
    try {
      const args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      const out = await tool.handler(args);
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: typeof out === "string" ? out : JSON.stringify(out),
      });
    } catch (e) {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

// Pricing (EUR per 1M tokens) for the models offered at scaffold time. Update
// when Scaleway changes pricing - see https://www.scaleway.com/en/generative-apis/
// (source used at rewrite time: mistral-small-3.2-24b-instruct-2506 and
// llama-3.3-70b-instruct, fetched July 2026). No cache tiers on this API.
const PRICING_PER_MTOK_EUR: Record<string, { input: number; output: number }> = {
  "mistral-small-3.2-24b-instruct-2506": { input: 0.15, output: 0.35 },
  "llama-3.3-70b-instruct": { input: 0.9, output: 0.9 },
};
const DEFAULT_PRICING = { input: 0.9, output: 0.9 }; // assume the pricier tier for unknown/custom models

function computeTurnCost(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  model: string,
): CostBreakdown {
  const p = PRICING_PER_MTOK_EUR[model] ?? DEFAULT_PRICING;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const eur = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return { inputTokens, outputTokens, eur };
}

// ─── DB persistence ───────────────────────────────────────────────────
async function createInvocation(
  input: AgentInput,
  status: string,
  errorMessage?: string,
): Promise<string> {
  const [row] = await db
    .insert(agentInvocations)
    .values({
      agentName: TEMPLATE_AGENT_NAME,
      status,
      promptPreview: input.prompt.slice(0, 500),
      triggeredBy: input.triggeredBy ?? "manual",
      errorMessage: errorMessage ?? null,
    })
    .returning({ id: agentInvocations.id });
  return row!.id;
}

async function persistTurn(
  invocationId: string,
  turnNumber: number,
  message: { content?: string | null; tool_calls?: ChatCompletionMessageToolCall[] },
  finishReason: string,
  cost: CostBreakdown,
) {
  await db.insert(agentTurns).values({
    invocationId,
    turnNumber,
    stopReason: finishReason,
    content: { text: message.content ?? null, toolCalls: message.tool_calls ?? [] },
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costEur: cost.eur.toFixed(6),
  });
}

async function finalizeInvocation(
  invocationId: string,
  status: string,
  finalText: string | null,
  iterations: number,
  totalCost: CostBreakdown,
  errorMessage?: string,
) {
  await db
    .update(agentInvocations)
    .set({
      status,
      finalText,
      iterations,
      totalCostEur: totalCost.eur.toFixed(6),
      finishedAt: new Date(),
      errorMessage: errorMessage ?? null,
    })
    .where(eq(agentInvocations.id, invocationId));
}
