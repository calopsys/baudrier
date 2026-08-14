# /add-2fa

Adds **two-factor authentication** to your app's login: a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password...) on top of the password, a big security upgrade against stolen passwords.

## When to use it

- Your app has a login (an admin space or user accounts) and you want to harden it.
- You handle sensitive data (customers, orders, payments) and want a second layer beyond the password.
- A client, or your own security policy, requires strong authentication.

## How it works

1. **App choice**: Baudrier asks which authenticator app you (or your users) will use.

2. **Auth detection**: it detects how your project handles login and adapts:
  - **Admin space** (a single fixed login): 2FA is made **mandatory** for that admin. The secret key and the backup codes are stored safely in Scaleway Secret Manager, never shown in the chat.
  - **User accounts**: 2FA becomes **optional for each user**, and everyone turns it on from their own account page. Each person's secret and backup codes live in the database, tied to their account.

3. **Setup**: Baudrier installs everything needed: the code generation, the login flow with the extra step, a "trusted device" option so the code is not asked on every visit, and an automatic logout after inactivity. It also prepares the QR code (or key) to enroll your app.

4. **Backup codes**: a set of one-time backup codes is generated in case you lose your phone. They are stored safely (Secret Manager or account), never displayed in plain text in the chat.

> **Prerequisite**: your project must already have a login. If it does not, Baudrier offers to set one up first, then adds 2FA right after.

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
