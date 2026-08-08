// ─── Rate-limit storage (appended by /add-auth and /add-2fa) ──────────────
//
// Backs src/lib/rate-limit.ts: a fixed-window counter keyed by
// (identifier, windowStart) so the count survives a scale-to-zero cold start
// and isn't reset by rotating through several container instances. The
// in-memory Map in rate-limit.ts is a read-through cache in front of this
// table, not a second source of truth - see that file's comment.

export const loginAttempts = createTable(
  "login_attempt",
  {
    identifier: text("identifier").notNull(),
    windowStart: timestamp("window_start", { mode: "date", withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.windowStart] }),
  }),
);
