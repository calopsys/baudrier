// baudrier:rate-limit db-backed
//
// Two-tier login rate limiter:
//   - An in-memory Map is the fast path - once a key is known-blocked for the
//     current window, every subsequent check short-circuits without a DB
//     round-trip (this is what keeps a sustained attack from turning into a
//     query-per-request flood against Postgres).
//   - A `login_attempt` Postgres table is the source of truth - the count
//     survives a scale-to-zero cold start and isn't reset just because the
//     next request lands on a different container instance (each
//     instance's Map is a cache of the shared DB counter, never its own
//     independent truth).
//
// Fixed-window algorithm: the current window is floor(now / WINDOW_MS), so
// concurrent increments (even across instances) only ever race on the SAME
// row, resolved by Postgres's own `ON CONFLICT ... DO UPDATE` atomicity - no
// SELECT-then-UPDATE race.

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { loginAttempts } from "~/server/db/schema";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const blockedUntil = new Map<string, number>();

// Auto-cleanup expired entries every 5 minutes
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, until] of blockedUntil) {
    if (until <= now) blockedUntil.delete(key);
  }
}, 5 * 60 * 1000);
cleanup.unref(); // Don't prevent serverless process from exiting

function windowStart(now: number): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

export async function checkRateLimit(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const now = Date.now();

  const cachedUntil = blockedUntil.get(key);
  if (cachedUntil && cachedUntil > now) {
    return { allowed: false, retryAfterMs: cachedUntil - now };
  }

  const start = windowStart(now);
  let count: number;
  try {
    const [row] = await db
      .insert(loginAttempts)
      .values({ identifier: key, windowStart: start, count: 1 })
      .onConflictDoUpdate({
        target: [loginAttempts.identifier, loginAttempts.windowStart],
        set: { count: sql`${loginAttempts.count} + 1` },
      })
      .returning({ count: loginAttempts.count });
    count = row?.count ?? 1;
  } catch (e) {
    // The gate this backs (CONTRACT.md §6, "Access control fails closed")
    // fails closed on an unreachable dependency, and this counter follows
    // the same rule: if Postgres can't be reached, deny rather than fall
    // back to an allow that an attacker could induce by forcing DB errors.
    console.warn(
      `rate-limit: DB unavailable, failing closed for this window: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { allowed: false, retryAfterMs: WINDOW_MS };
  }

  if (count > MAX_ATTEMPTS) {
    const retryAfterMs = start.getTime() + WINDOW_MS - now;
    blockedUntil.set(key, now + retryAfterMs);
    return { allowed: false, retryAfterMs };
  }

  return { allowed: true };
}
