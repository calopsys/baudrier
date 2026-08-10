# /add-db

Adds a **database** to your project so you can store information that persists over time. Baudrier provisions a PostgreSQL database hosted in France, wires it into your code, and keeps it backed up automatically.

## When to use it

- When your app needs to store information: users, orders, articles, customer records, bookings, editorial content, etc.
- Often called automatically by `/bootstrap` when the project is created. You can also run it later if you want to add persistence to an existing project.

## How it works

1. **Check**: Baudrier looks at whether a database is already wired into this project.
   - If so, a small menu offers you: apply a schema change, or start over with a brand-new database. No risk of duplicates.
   - Otherwise, it moves on.
2. **Database creation**: a Scaleway Serverless SQL Database (PostgreSQL 16) is created under your project, in the `fr-par` region (Paris).
3. **Dedicated access key**: a private access key is created just for this app - it is never shared with any other project, and it never expires (so your app never breaks because a key silently lapsed).
4. **Drizzle ORM configuration**: Baudrier configures Drizzle (the tool that acts as the intermediary between your code and the database) to talk to your database.
5. **Saving the connection**: the connection string is saved securely on Scaleway's side (Secret Manager). It is never written to a file on this computer, and never shown in the chat - there is nothing for you to copy or lose.
6. **Automatic backups**: included from day one, nothing to turn on. A snapshot is taken every day and kept for 7 days.

## What it creates for you

- A **Scaleway Serverless SQL Database** in your project, ready to receive data
- The **Drizzle schema file** (`src/server/db/schema.ts`) where you (or Baudrier) will define your tables
- The connection configured in `src/server/db/index.ts`
- The handy command `pnpm db:generate` (prepares a schema change safely, without touching the live database)
- **Automatic backups** active from the start, no setup needed

## An important difference from most database tools

This computer never talks directly to your database - not even to preview a change. When you (or Baudrier) change what data your app stores, the change is written to a file first; it only becomes real the next time you publish (`/deploy`), through a dedicated, safe process. This is a deliberate safety choice: it removes an entire category of "someone ran a risky command against production by accident" mistakes.

## Prerequisites

- The project must be a Next.js project (typically initialized by `/bootstrap`)
- The four `SCW_*` variables must be set in your Baudrier cloud environment

## Tips

{{callout:tip|Included, no separate plan to pick}}
There's no free-tier-vs-paid-tier database decision to make here: the database scales itself down when nobody is using it and scales up automatically with traffic. You don't need to size anything up front.
{{/callout}}

{{callout:info|Backups come for free}}
You don't have to configure backups manually: a daily snapshot with 7-day retention is included at no extra cost from the moment the database is created. There's currently no button to trigger an extra backup on demand - the daily one is the safety net.
{{/callout}}

{{callout:warning|Data in France}}
The database is created in the `fr-par` (Paris) region to comply with RGPD on the data-residency side. You have nothing to do for that.
{{/callout}}

{{callout:warning|Baudrier never deletes a database}}
Deleting a database is never something Baudrier does on its own, even if asked - it's technically blocked. If you genuinely want a database gone, that's a deliberate, manual action you take yourself in the Scaleway console. This is intentional: with no on-demand backup available right before a deletion, an accidental one would be unrecoverable past the last daily snapshot.
{{/callout}}
