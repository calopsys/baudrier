# /add-domain

Connects a **custom domain name** to your app: `mysite.com` instead of the default Scaleway container URL.

## When to use it

- You want your site to be accessible at **your own address** (more professional, better ranked, more credible)
- You already own a domain name and want to connect it to your project

## What this does NOT do

{{callout:warning|External domains only - no registrar automation}}
This harness does **not** sell or register domain names, and does **not** automate any registrar (no Hostinger, OVH, Namecheap, GoDaddy, etc.). You must already own the domain. If it isn't delegated to Scaleway DNS yet, `/add-domain` stops and gives you the exact nameserver values to hand to whoever manages the domain - it never tries to change them for you.
{{/callout}}

{{callout:warning|No inbound email}}
Scaleway has **no equivalent to an email-forwarding service**. Connecting a domain here only enables **sending** email from it (via a separate `/add-email` run) - it does **not** let you receive email at `contact@mysite.com`. If you need a real mailbox on this domain, you need a separate email hosting provider; this harness does not set that up.
{{/callout}}

## How it works

The target architecture: **your domain (bought anywhere) → Scaleway DNS (delegated zone) → Scaleway Serverless Containers (hosting)**.

1. **Domain name**: you give Baudrier the exact domain, e.g. `mysite.com`.

2. **Delegation check**: Baudrier checks whether the domain's nameservers already point at Scaleway (`ns0.dom.scw.cloud` / `ns1.dom.scw.cloud`) and whether a DNS zone exists for it in your Scaleway account. If not, it stops and gives you the exact values to set at your registrar - it never attempts this automatically.

3. **DNS record**: once delegated, Baudrier adds a DNS record pointing your domain at your container's address.

4. **Wait for propagation**: Baudrier actively waits (up to 3 minutes, matching Scaleway's certificate-issuance window) until that DNS record is visible on the public internet - **before** touching anything else. This ordering matters: attaching the domain too early can put it in a broken state that can only be fixed by starting over.

5. **Attach + certificate**: Baudrier attaches the domain to your container, which triggers automatic, free HTTPS certificate issuance.

6. **Cleanup**: any leftover references to the old default Scaleway URL in your code (sitemap, metadata, robots.txt) are replaced by your new domain - important for search engine ranking.

## What it creates for you

- A DNS record on your domain, pointing at your app's container
- The domain **attached to your Scaleway container** with an automatic, auto-renewing HTTPS certificate
- The `APP_URL` variable updated everywhere (`.env`, Scaleway Secret Manager, source code)

## Prerequisites

- An app already deployed on a Scaleway Serverless Container (typically via `/bootstrap` then `/deploy`)
- A domain name you already own, with access to change its nameservers at your registrar (or someone on your team who does)
- Your Scaleway account connected (`/start` handles it)

## Tips

{{callout:tip|DNS propagation timing}}
Nameserver changes can take anywhere from a few minutes to 24-48h to propagate worldwide. Baudrier actively checks rather than guessing, and will tell you clearly if it's still waiting.
{{/callout}}

{{callout:info|Why the wait matters}}
Scaleway's HTTPS certificate issuance uses a challenge with a hard **3-minute window**. If the DNS record isn't visible yet when that challenge runs, the domain can end up in a state that serves **neither HTTP nor HTTPS**, with no automatic retry - the only fix is deleting and re-adding it. That's why Baudrier always confirms propagation first, even if it means waiting or asking you to try again later.
{{/callout}}

{{callout:info|Org-wide limit}}
A Scaleway Organization can have at most **10 external domains** connected. If you hit that limit, remove an unused one from the Scaleway console first.
{{/callout}}

{{callout:info|Keep the ACME exemption in proxy.ts}}
Your app ships with an IP allowlist by default. Its `proxy.ts` always exempts `/.well-known/acme-challenge/*` from that filter, specifically so Scaleway can keep issuing and renewing your HTTPS certificate. Never remove that exemption - doing so would silently break certificate renewal and eventually take your site offline over HTTPS.
{{/callout}}
