# /add-auth

Adds **sign-in / signup** to your app. A single question decides between two modes for you: an admin login reserved for you, or a complete user accounts system.

## When to use it

- You want a private area on your site that only you (or a small team) can see
- Your app has users who need to create an account, sign in, and have their own space

## How it works

1. **Check**: Baudrier detects whether authentication is already in place on the project. If so, you get a small menu to evolve it (change the admin password, add "forgot password", etc.).

2. **Main question** (unless already chosen by `/bootstrap`): Baudrier asks what type of authentication you want:
  - **Admin mode**: a single fixed login (yours), with a password stored in the environment variables. Perfect for a backoffice, a private dashboard, a site admin.
  - **Users mode**: a real system with signup, sign-in, account page, account deletion. Suitable when you have external users who need their own space.

3. **Automatic setup**:
  - **Admin mode**: Baudrier generates a secure password, hashes it, pushes it into your environment variables (local + your hosted app's secrets). The plaintext password is shown to you **only once**: save it in your password manager.
  - **Users mode**: Baudrier adds the necessary tables to the database (users, sessions, accounts, verifications), creates the `/signin` / `/signup` / `/account` pages, the tRPC API for signup/sign-in, and the full NextAuth integration.

This harness is **email + password only** - there is no Google/GitHub sign-in option, so there is nothing else to add on top.

## What it creates for you

**In admin mode**:
- A `src/server/auth.ts` file that handles a fixed login
- The `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_DEV`, `ADMIN_PASSWORD_HASH_PROD` variables in `.env` + your app's secrets
- An `isAdmin()` function you can use to protect pages
- Password shown once for you

**In users mode**:
- All the NextAuth tables in the database (users, sessions, accounts, verification_tokens, password_reset_tokens)
- `/signin`, `/signup`, `/account` pages, and optionally `/forgot-password` + `/reset-password`
- tRPC API for secure signup and sign-in (scrypt hashing, rate limiting, anti-brute-force protection)
- Site layout updated with a user menu (sign-in/sign-out)

## Prerequisites

- The project must be in Next.js
- Users mode: requires a database, `/add-db` must have been run first (Baudrier offers it to you if missing)
- Users mode with forgot password: also requires `/add-email` to be configured

## Tips

{{callout:tip|You can have both modes at the same time}}
If you have already chosen a mode and want to add the other one later, re-run `/add-auth`: a menu offers to add the second mode without breaking the existing one. The admin login and the users signup can coexist.
{{/callout}}

{{callout:warning|The admin password is shown only once}}
In admin mode, the plaintext password is shown to you **only once** at the end of the setup. Save it in your password manager immediately, it is not stored anywhere in plaintext on disk (only the hash exists).
{{/callout}}

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
