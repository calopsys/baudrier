// agent/tools/db-query.ts - Read-only SQL access to the project's database.
//
// Lets the agent run SELECT queries against the project's Postgres database.
// Useful for: looking up users, fetching past invocation context, computing
// stats, finding things to act on ("send a reminder to all users with X").
//
// SAFETY MODEL - READ-ONLY by default:
//   - Only SELECT statements allowed (no INSERT/UPDATE/DELETE/DROP/...)
//   - The real boundary is Postgres itself: the query runs inside
//     `BEGIN; SET TRANSACTION READ ONLY;`, then an unconditional ROLLBACK.
//     The lexical keyword/comment check below is a fast-fail UX layer only -
//     a comment-stripping mismatch between this file and Postgres's own
//     parser (nested `/*-- */`) must never be the last line of defense.
//   - Statement-level timeout (10 s, via `SET LOCAL statement_timeout`)
//   - Result row cap (100 rows - prevents 100k-row dumps into the agent context)
//   - Result size cap (100 KB stringified)
//
// If the agent NEEDS to write, give it a more specific tool (e.g.
// `mark_user_contacted` that takes a userId and updates a single row). Don't
// loosen this tool to allow arbitrary writes - that's a foot-gun.

import type { ToolDefinition } from "./types.js";
import { db } from "../db.js";

const definition: ToolDefinition = {
  name: "db_query",
  description:
    "Run a READ-ONLY SQL query (SELECT only) against the project's Postgres database. Use for looking up users, fetching context, computing stats. Times out after 10 seconds. Returns at most 100 rows. To make changes to the database, ask for a more specific write tool - this one cannot insert, update, or delete.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A SELECT SQL query. Examples: 'SELECT id, email FROM users WHERE created_at > NOW() - INTERVAL \\'7 days\\'' - 'SELECT COUNT(*) FROM orders WHERE status = \\'paid\\''.",
      },
    },
    required: ["query"],
  },
};

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "truncate",
  "grant", "revoke", "create", "comment", "vacuum", "lock",
  "copy", "do", "call", "merge",
];

function isReadOnly(query: string): { ok: true } | { ok: false; reason: string } {
  const stripped = query
    .replace(/--[^\n]*/g, " ")            // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")    // strip block comments
    .trim()
    .toLowerCase();

  if (!stripped.startsWith("select") && !stripped.startsWith("with")) {
    return { ok: false, reason: "query must start with SELECT (or WITH ... SELECT)" };
  }
  for (const kw of FORBIDDEN_KEYWORDS) {
    // word-boundary match
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(stripped)) {
      return { ok: false, reason: `forbidden keyword: ${kw.toUpperCase()}` };
    }
  }
  // Block multi-statement (basic guard against query stacking)
  if (stripped.replace(/;\s*$/, "").includes(";")) {
    return { ok: false, reason: "multiple statements not allowed (single SELECT only)" };
  }
  return { ok: true };
}

async function handler(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) return `Error: 'query' is required`;

  const safety = isReadOnly(query);
  if (!safety.ok) return `Error: ${safety.reason}`;

  // Wrap the (keyword-validated) query in a subquery to enforce the 100-row
  // cap without a second statement or a double LIMIT (which would break a
  // query that already has its own LIMIT).
  const inner = query.replace(/;\s*$/, "");

  // Run on a dedicated connection, not through drizzle's query builder: a
  // multi-statement read-only transaction (BEGIN / SET TRANSACTION READ ONLY /
  // SET LOCAL statement_timeout / ... / ROLLBACK) needs one pinned connection,
  // and Postgres itself - not this file's lexical guard - is what makes the
  // query incapable of writing or running past 10 s.
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query(`SELECT * FROM (${inner}) AS _agent_q LIMIT 100`);
    const rows = result.rows ?? [];
    const json = JSON.stringify(rows, null, 2);
    if (json.length > 100_000) {
      return `Result too large (${json.length} bytes > 100 KB cap). Refine the query (LIMIT, narrower WHERE, fewer columns).`;
    }
    return `${rows.length} row(s):\n${json}`;
  } catch (e) {
    // A statement_timeout cancellation surfaces as Postgres error code 57014.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "57014") {
      return `Error: query timed out after 10 seconds`;
    }
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // ROLLBACK unconditionally - a read-only transaction never has anything
    // to commit, and this is what actually discards any statement that the
    // lexical guard above failed to catch.
    const rollbackErr = await client.query("ROLLBACK").then(
      () => undefined,
      (e) => (e instanceof Error ? e : new Error(String(e))),
    );
    // A failed ROLLBACK can leave the connection mid-transaction; releasing
    // it with an Error tells pg to destroy it instead of pooling it.
    client.release(rollbackErr);
  }
}

export const tool = { definition, handler };
