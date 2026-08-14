# /add-email

Enables **transactional email sending** from your app, via **Scaleway Transactional Email (TEM)**. For contact forms, confirmations, notifications, welcome emails, etc.

## When to use it

- You want to add a **contact form** to your site
- You want to send automatic emails to your users (signup confirmation, forgotten password, event notification)
- You want to send emails from your own domain (`contact@mysite.com`)

## Only one provider: Scaleway TEM

This harness runs entirely on Scaleway (see the project's `CONTRACT.md`), so there is no provider choice to make - no separate API key to create at a third-party service, no vault to unlock. Sending uses the same Scaleway credentials as the rest of your infrastructure.

{{callout:warning|No shared test address}}
Unlike some other email services, **TEM has no shared "test" sending address** you can use immediately. You must verify a domain you own (SPF/DKIM/DMARC/MX DNS records, verification that can take **up to 48 hours**) before you can send a single email. `/add-email` asks for your sending address right away for this reason.
{{/callout}}

## How it works

1. **Check**: Baudrier looks at whether email is already configured on THIS project. If so, a menu offers to change the sending address, the recipient, republish the DNS records, create a `/contact` page, or start over.

2. **Sending address**: you tell Baudrier the address you want to send from (e.g. `contact@mysite.com`). Its domain becomes the TEM sending domain.

3. **Domain verification**: Baudrier creates (or finds) that domain in TEM, retrieves the SPF/DKIM/DMARC/MX records it needs, and:
   - if the domain's DNS is already managed by Scaleway (typically because you ran `/add-domain`), **publishes the records automatically**
   - otherwise, gives you the exact records to add manually at your current DNS provider

4. **Scaffolding**: a `src/server/mail.ts` file is created with a reusable `sendMail()` function + `escapeHtml()` for safely inserting user data into an email's HTML. A `contact` tRPC router is added to handle the contact form on the server side (anti-spam honeypot, rate limiting, HTML escaping).

5. **Environment variables**: `TEM_SENDER_EMAIL` and `TEM_SENDER_NAME` are written to `.env` and to this project's Scaleway Secret Manager (which feeds the deployed container at deploy time).

6. **Contact page (optional)**: at the end, Baudrier offers to create a working `/contact` page (Name, Email, Message form, responsive).

## What it creates for you

- A **TEM sending domain**, verified against the address you gave (verification can take up to 48h)
- `src/server/mail.ts` with `sendMail()` + `escapeHtml()`
- A `contact` tRPC router (`src/server/api/routers/contact.ts`) for the form
- `TEM_SENDER_EMAIL` and `TEM_SENDER_NAME` in `.env` + Scaleway Secret Manager
- If your domain's DNS is on Scaleway: the SPF/DKIM/DMARC/MX records, published automatically
- Otherwise: the exact records to add yourself, and a reminder to run `/add-domain` if you'd rather Baudrier manage this domain's DNS
- If you want: a complete, working **`/contact` page**

## Prerequisites

- The project must be in Next.js with tRPC (typically initialized by `/bootstrap`)
- The four `SCW_*` variables must be set in your Baudrier cloud environment - no separate email-provider key needed
- An email address on a domain you own, to use as the sender

## Tips

{{callout:warning|Verification takes up to 48h}}
After the DNS records are published, Scaleway can take **up to 48 hours** to fully verify your domain. Sending will fail until it does. This is normal - be patient, and don't re-run the setup while you wait.
{{/callout}}

{{callout:tip|Free-tier limits}}
A fresh Scaleway account (before identity verification) is capped at **500 emails/month and 2 sending domains**. Once you complete identity verification (KYC) in the Scaleway console, this rises to **5,000 emails/month and 5 domains**. Baudrier reminds you of this at the end of the install so you're not caught off guard when sending suddenly stops.
{{/callout}}

{{callout:info|TEM's hard limits}}
Every email must have a subject of **at least 10 characters** and **at most 3 recipients**. `sendMail()` checks both before calling the API and throws a clear message in French if you break either rule, instead of letting you hit a confusing HTTP 400.
{{/callout}}

{{callout:info|No inbound email}}
TEM is send-only. It does not provide anything like receiving mail at `contact@mysite.com` and forwarding it to your inbox - see `/add-domain`'s documentation for details on that gap. `/add-email` only sets up **outgoing** mail.
{{/callout}}

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
