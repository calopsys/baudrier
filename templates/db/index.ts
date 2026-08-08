import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "~/env.js";
import * as schema from "./schema";

// Scaleway Serverless SQL Database (PostgreSQL 16), IAM-authenticated - see
// CONTRACT.md §4. DATABASE_URL already carries `?sslmode=require`. We do NOT
// disable TLS certificate verification here, unlike Scaleway's own Next.js
// tutorial (which sets the pg `ssl` option to skip CA checks) - doing so
// would silently accept a man-in-the-middle on every query. Node's default
// TLS behaviour (verify against the system CA store) works fine against
// Scaleway's endpoint without any override, so `ssl: true` is all that's needed.
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: true,
});

export const db = drizzle(pool, { schema });
