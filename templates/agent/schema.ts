// agent/schema.ts - Re-exports the agent tables from the main schema.
//
// We define the canonical table objects in `schema-snippet.ts` (which is
// merged into the main app's src/server/db/schema.ts when /add-agent runs),
// but the Job process also needs to import them. Easiest: re-declare them
// here with identical signatures. This package owns its own copy that
// happens to point at the same physical tables in the Serverless SQL
// Database.
//
// IMPORTANT: keep this file IN SYNC with schema-snippet.ts (or with whatever
// the main app committed). If you add a column there, mirror it here.

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

export const agentInvocations = pgTable(
  "agent_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull(),
    triggeredBy: text("triggered_by").notNull().default("manual"),
    promptPreview: text("prompt_preview"),
    finalText: text("final_text"),
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

export const agentTurns = pgTable(
  "agent_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invocationId: uuid("invocation_id").notNull().references(() => agentInvocations.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    stopReason: text("stop_reason").notNull(),
    content: jsonb("content").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costEur: numeric("cost_eur", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("agent_turns_invocation_idx").on(t.invocationId, t.turnNumber)],
);

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

export const agentTriggerQueue = pgTable(
  "agent_trigger_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("manual"),
    prompt: text("prompt").notNull(),
    context: jsonb("context"),
    invocationId: uuid("invocation_id"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_trigger_queue_pending_idx").on(t.status, t.createdAt)],
);

// agent_memory_vector is INTENTIONALLY NOT declared in Drizzle. The table
// exists in DB (created by a custom drizzle-kit migration when
// --memory=pgvector is chosen; see schema-snippet.ts for the exact DDL), but
// a partial Drizzle declaration would make `drizzle-kit generate` try to drop
// the embedding column it doesn't know about. memory-pgvector.ts uses raw SQL
// for all reads/writes - see that module.
