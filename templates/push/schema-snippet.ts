// Snippet à insérer dans src/server/db/schema.ts (ou packages/db/src/schema.ts
// en monorepo), après la table `users`. Posé par /add-push-notification.
//
// Prérequis d’imports (déjà présents dans un schéma typique de ce harnais) :
//   import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
//   import { sql } from "drizzle-orm";
//   et la table `users`.
// Adapter `users` aux conventions du projet si différentes.

export const pushSubscriptions = pgTable(
  "push_subscription",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").unique().notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  // Forme tableau (Drizzle récent). Si le schéma du projet utilise encore la
  // forme objet `(t) => ({ ... })`, s’aligner sur sa convention.
  (t) => [index("push_sub_user_idx").on(t.userId)],
);
