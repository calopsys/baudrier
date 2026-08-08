// ─── Password reset tokens (appended by /add-auth when email is configured) ──
//
// Selector:verifier format, not one hash-per-token: the emailed link is
// `<selector>.<verifier>`. `selector` is an indexed, non-secret lookup key
// (stored in the clear), `verifier` is the actual secret, stored only as its
// scrypt hash. This means resetPassword looks the row up by selector (an
// indexed equality lookup) and scrypt-verifies exactly ONE hash - not every
// outstanding token, which is what let an attacker force N scrypt hashes per
// guess just by holding N reset requests open.
//
// Tokens expire 1h after creation. One use only: `consumedAt` flips when the
// user successfully resets their password, and the reset also deletes every
// other outstanding token for that user (a successful reset should retire
// every other in-flight link, not just the one used).

export const passwordResetTokens = createTable(
  "password_reset_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    selector: text("selector").notNull(),
    verifierHash: text("verifier_hash").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userIdIdx: index("password_reset_user_id_idx").on(t.userId),
    selectorIdx: index("password_reset_selector_idx").on(t.selector),
  }),
);
