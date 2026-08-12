// Snippet à insérer dans src/server/db/schema.ts (ou packages/db/src/schema.ts en
// monorepo), après la table `users`. Posé par /add-notification-center.
//
// Prérequis d’imports (typiques d’un schéma de ce harnais) :
//   import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
//   import { sql } from "drizzle-orm";
//   et la table `users`.

export const notifications = pgTable(
  "notification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    url: text("url"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  // Forme tableau (Drizzle récent). Si le schéma du projet utilise encore la
  // forme objet `(t) => ({ ... })`, s’aligner sur sa convention.
  (t) => [index("notification_user_idx").on(t.userId, t.read)],
);
