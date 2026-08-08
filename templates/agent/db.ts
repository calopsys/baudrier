// agent/db.ts - Drizzle client for the agent Job process.
//
// Per CONTRACT.md §4: Scaleway Serverless SQL Database is plain PostgreSQL 16
// reached over TCP, so we use `pg` + `drizzle-orm/node-postgres` (a real TCP
// connection pool, not an HTTP-based serverless driver). Auth is IAM: the
// "user" is an IAM Application id, the "password" is that application's API
// secret key - both already baked into DATABASE_URL by the harness.
//
// Do NOT set `ssl: { rejectUnauthorized: false }` - Scaleway's own tutorials
// show it, but CONTRACT.md explicitly forbids it here. `sslmode=require` in
// the connection string is enough for the driver to negotiate TLS with proper
// CA verification (Node's default trust store recognizes Scaleway's CA).
//
// All env vars are passed by the Serverless Job definition (secret reference
// to DATABASE_URL in Secret Manager - see job-definition.json in this folder).

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required (set as a Secret Manager reference on the Job definition)");
}

const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
