// agent/memory-pgvector.ts - Semantic memory backed by pgvector + Scaleway
// Generative APIs embeddings.
//
// When to use this instead of memory-kv.ts:
//   - The agent needs to "remember" facts/conversations/documents
//     and later find them by *semantic similarity* (not exact key match)
//   - "Find similar past invocations to this one"
//   - "What did the user mention about X in the last 3 months?"
//   - RAG pattern: "search my knowledge base for relevant chunks"
//
// Stack:
//   - pgvector extension on Scaleway Serverless SQL Database (PostgreSQL 16;
//     `CREATE EXTENSION vector;` - see schema-snippet.ts for the migration)
//   - Scaleway Generative APIs embeddings - model qwen3-embedding-8b, native
//     up to 4096 dims, Matryoshka (truncatable & re-usable as a shorter
//     vector - see https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/#qwen3-embedding-8b).
//     Reuses the project's SCW_GENERATIVE_API_KEY - no new vendor.
//
// IMPORTANT - why we truncate client-side: Scaleway's Embeddings API is
// OpenAI-compatible but explicitly does NOT support the `dimensions` request
// parameter (see using-embeddings-api.mdx "Unsupported parameters"). So to
// get a 2000-dim vector we request the model's native embedding and truncate
// it to the first 2000 floats ourselves, then re-normalize (L2) - this is
// exactly what a Matryoshka-trained embedding model is designed to tolerate:
// "a 4096-dimension vector can be truncated to its 768 first dimensions and
// used directly" (Scaleway docs). 2000 was chosen because it comfortably fits
// pgvector's hnsw/ivfflat index dimension limits while keeping most of the
// model's representational power (dimensions are sorted most-meaningful-first).
//
// Required env vars (set by /add-agent at scaffold time):
//   - SCW_GENERATIVE_API_KEY, SCW_GENERATIVE_BASE_URL (CONTRACT.md §2)
//
// Usage:
//   import { vmem } from "./memory-pgvector.js";
//   await vmem.add("user said: I'm allergic to peanuts", { source: "email_123" });
//   const hits = await vmem.search("does this user have allergies?", 5);
//   // hits = [{ id, content, score, metadata }, ...]

import OpenAI from "openai";
import { db } from "./db.js";
import { sql } from "drizzle-orm";

// ─── Per-agent config ─────────────────────────────────────────────────
// Replace with your agent's slug. Memory is scoped to this name to avoid
// cross-agent contamination of search results.
const AGENT_NAME = "my-agent";

// qwen3-embedding-8b's native output is up to 4096 dims (Matryoshka). We
// truncate + re-normalize to this many dims before storing/querying.
// Changing this REQUIRES re-creating the agent_memory_vector table with a
// different vector(N) dim - old embeddings become incompatible.
const EMBEDDING_MODEL = "qwen3-embedding-8b";
const EMBEDDING_DIMS = 2000;

// ─── Types ────────────────────────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity, 0..1 (higher = more similar). */
  score: number;
}

// ─── Embedding helper (Scaleway Generative APIs) ──────────────────────
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.SCW_GENERATIVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SCW_GENERATIVE_API_KEY must be set. Semantic memory uses Scaleway Generative APIs for embeddings - configured automatically by /add-agent.",
    );
  }
  client = new OpenAI({
    apiKey,
    baseURL: process.env.SCW_GENERATIVE_BASE_URL ?? "https://api.scaleway.ai/v1",
  });
  return client;
}

/** Truncate a Matryoshka embedding to `dims` and re-normalize (L2). */
function truncateAndNormalize(vec: number[], dims: number): number[] {
  const truncated = vec.slice(0, dims);
  const norm = Math.sqrt(truncated.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? truncated.map((x) => x / norm) : truncated;
}

async function embed(text: string): Promise<number[]> {
  const res = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vec = res.data[0]?.embedding;
  if (!vec || vec.length < EMBEDDING_DIMS) {
    throw new Error(
      `Scaleway Generative APIs returned an unexpected embedding (got ${vec?.length ?? 0} dims, expected at least ${EMBEDDING_DIMS}).`,
    );
  }
  return truncateAndNormalize(vec, EMBEDDING_DIMS);
}

// ─── Public API ───────────────────────────────────────────────────────
export const vmem = {
  /**
   * Store a piece of content. Computes its embedding via Scaleway Generative
   * APIs and inserts a row in `agent_memory_vector` (raw SQL - table isn't in
   * Drizzle schema because Drizzle doesn't model `vector(2000)` natively).
   * Returns the inserted row id.
   */
  async add(content: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const embedding = await embed(content);
    const vectorLiteral = "[" + embedding.join(",") + "]";
    const result = await db.execute(sql`
      INSERT INTO agent_memory_vector (agent_name, content, metadata, embedding)
      VALUES (${AGENT_NAME}, ${content}, ${JSON.stringify(metadata)}::jsonb, ${vectorLiteral}::vector)
      RETURNING id::text
    `);
    const rows = (result as unknown as { rows: { id: string }[] }).rows ?? [];
    if (!rows[0]?.id) throw new Error("Insert into agent_memory_vector did not return an id");
    return rows[0].id;
  },

  /**
   * Find the K most similar entries to the query, scoped to this agent.
   * Uses cosine distance (1 - cosine_similarity) under the hood, returns
   * the score as similarity (1 = identical, 0 = orthogonal).
   */
  async search(query: string, limit = 5): Promise<MemoryEntry[]> {
    const queryEmbedding = await embed(query);
    const vectorLiteral = "[" + queryEmbedding.join(",") + "]";

    // pgvector's cosine distance operator: <=>
    const result = await db.execute(sql`
      SELECT
        id::text,
        content,
        metadata,
        1 - (embedding <=> ${vectorLiteral}::vector) AS score
      FROM agent_memory_vector
      WHERE agent_name = ${AGENT_NAME}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `);
    const rows = (result as unknown as { rows: { id: string; content: string; metadata: unknown; score: number }[] }).rows ?? [];
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      score: Number(r.score),
    }));
  },

  /** Delete a specific memory by its id (returned from add()). */
  async delete(id: string): Promise<void> {
    await db.execute(sql`DELETE FROM agent_memory_vector WHERE id = ${id}::uuid AND agent_name = ${AGENT_NAME}`);
  },

  /** Wipe ALL vector memory for this agent. Irreversible. */
  async clear(): Promise<void> {
    await db.execute(sql`DELETE FROM agent_memory_vector WHERE agent_name = ${AGENT_NAME}`);
  },

  /** Count entries (for stats / debugging). */
  async count(): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*)::int AS n FROM agent_memory_vector WHERE agent_name = ${AGENT_NAME}`);
    const rows = (result as unknown as { rows: { n: number }[] }).rows ?? [];
    return rows[0]?.n ?? 0;
  },
};
