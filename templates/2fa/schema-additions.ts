// ─── 2FA tables (appended by /add-2fa on top of baudrier admin auth) ──────
//
// Three tables, all owned by the admin-mode 2FA flow (src/lib/auth-2fa.ts,
// src/lib/auth-backup-codes.ts):
//   - trusted_device       : one row per "remember this browser for 24h"
//     grant. The cookie is signed, but the signature alone can't be revoked -
//     sign-out marks `revoked_at` here so a stolen/replayed cookie stops
//     working even though its signature still checks out.
//   - login_proof          : one-time nonce handed from the password+2FA
//     server action to the NextAuth `authorize()` callback. `consumed_at`
//     makes a captured proof string unusable a second time.
//   - consumed_backup_code : which of the (env-var-hashed) backup codes have
//     already been used. The codes themselves stay in
//     ADMIN_2FA_BACKUP_HASHES (no DB needed to regenerate them); this table
//     is only "has this specific hash already been spent".

export const trustedDevices = createTable(
  "trusted_device",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    usernameIdx: index("trusted_device_username_idx").on(t.username),
  }),
);

export const loginProofs = createTable(
  "login_proof",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    usernameIdx: index("login_proof_username_idx").on(t.username),
  }),
);

export const consumedBackupCodes = createTable("consumed_backup_code", {
  codeHash: text("code_hash").primaryKey(),
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
