// agent/schema-snippet.ts - Drizzle table definitions for agent persistence.
//
// Append this snippet to your project's `src/server/db/schema.ts` (or import
// it from there). The setup-agent.mjs script does this automatically when
// scaffolding the agent.
//
// Tables:
//   - agent_invocations    : one row per agent run (status, cost, final answer)
//   - agent_turns          : one row per loop iteration (decisions, tools, cost)
//   - agent_memory_kv      : per-agent key/value store (used by memory-kv.ts)
//   - agent_memory_vector  : per-agent semantic memory (pgvector - only added
//                            if the agent uses memory-pgvector.ts)
//   - agent_trigger_queue  : pending manual triggers from dashboard / external
//
// pgvector NOTE: Scaleway Serverless SQL Database (PostgreSQL 16) ships the
// pgvector extension - `CREATE EXTENSION vector;` works with no separate
// provisioning. If any agent uses semantic memory, setup-agent.mjs generates
// a CUSTOM drizzle-kit migration (drizzle-kit generate --custom) carrying
// that DDL, rather than connecting to the database directly - per
// CONTRACT.md §4, the operator's machine never holds a DATABASE_URL; only
// `drizzle-kit generate` (no connection) runs locally, and `drizzle-kit
// migrate` runs inside the deploy pipeline's migration Serverless Job.
//
// IMPORTANT: after appending, run `drizzle-kit generate` (writes the SQL
// migration file, no DB connection) - `/deploy` applies it via the migration
// Job on the next deploy.

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  jsonb,
  numeric,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

// ─── invocations ──────────────────────────────────────────────────────
export const agentInvocations = pgTable(
  "agent_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull(), // running | success | error | budget_killed | max_iterations_reached
    triggeredBy: text("triggered_by").notNull().default("manual"), // manual | cron | webhook | event
    promptPreview: text("prompt_preview"), // first 500 chars of the user prompt
    finalText: text("final_text"),         // the agent's last text response (if success)
    iterations: integer("iterations").notNull().default(0),
    totalCostEur: numeric("total_cost_eur", { precision: 12, scale: 6 }).notNull().default("0"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_invocations_started_idx").on(t.startedAt),
    index("agent_invocations_agent_idx").on(t.agentName, t.startedAt),
  ],
);

// ─── turns ────────────────────────────────────────────────────────────
export const agentTurns = pgTable(
  "agent_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invocationId: uuid("invocation_id")
      .notNull()
      .references(() => agentInvocations.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    stopReason: text("stop_reason").notNull(), // stop | tool_calls | length | content_filter
    content: jsonb("content").notNull(),       // { text: string|null, toolCalls: OpenAI tool_calls[] }
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costEur: numeric("cost_eur", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("agent_turns_invocation_idx").on(t.invocationId, t.turnNumber)],
);

// ─── KV memory ────────────────────────────────────────────────────────
export const agentMemoryKv = pgTable(
  "agent_memory_kv",
  {
    agentName: text("agent_name").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [primaryKey({ columns: [t.agentName, t.key] })],
);

// ─── Vector memory (semantic search) - INTENTIONALLY NOT IN DRIZZLE ──
// The agent_memory_vector table is created by a custom drizzle-kit migration
// (see setup-agent.mjs's patchMemory step) when --memory=pgvector is chosen.
// It is NOT declared here because Drizzle's pgTable can't model `vector(2000)`
// natively - and a partial declaration would make later `drizzle-kit generate`
// runs try to drop the embedding column it doesn't know about.
//
// All reads/writes to agent_memory_vector go through templates/agent/memory-
// pgvector.ts which uses raw SQL via db.execute(). The dashboard does NOT
// query this table - vector entries are an internal concern of each agent.
//
// DDL written into the custom migration by setup-agent.mjs:
//   CREATE EXTENSION IF NOT EXISTS vector;
//   CREATE TABLE agent_memory_vector (
//     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     agent_name text NOT NULL,
//     content text NOT NULL,
//     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
//     embedding vector(2000) NOT NULL,
//     created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
//   );
//   CREATE INDEX agent_memory_vector_agent_idx ON agent_memory_vector(agent_name);
//   CREATE INDEX agent_memory_vector_embedding_idx ON agent_memory_vector
//     USING hnsw (embedding vector_cosine_ops);
//
// Embeddings come from Scaleway Generative APIs' qwen3-embedding-8b (native
// up to 4096 dims, Matryoshka - truncatable). The Embeddings API does not
// accept a `dimensions` request parameter, so memory-pgvector.ts requests the
// full vector and truncates + re-normalizes to 2000 dims client-side, which
// is exactly what "Matryoshka" embeddings are designed to support.

// ─── Trigger queue (dashboard "Run now" + external triggers) ─────────
export const agentTriggerQueue = pgTable(
  "agent_trigger_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | done | failed
    source: text("source").notNull().default("manual"),  // manual | webhook | api | …
    prompt: text("prompt").notNull(),
    context: jsonb("context"),
    invocationId: uuid("invocation_id"), // populated when picked up + run
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_trigger_queue_pending_idx").on(t.status, t.createdAt),
  ],
);
