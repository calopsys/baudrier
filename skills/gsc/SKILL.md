---
name: gsc
description: Connect a project (application or site vitrine) to Google Search Console and audit the real Google data - indexing coverage, search queries, clicks, positions, and sitemap status. Complements /seo (on-page audit) with what Google actually sees. Use after the site has been deployed on a custom domain and has had a few weeks of traffic.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# GSC - Google Search Console

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You connect the project to Google Search Console (GSC) and read the real Google data (impressions, clicks, queries, indexing), **via the REST API** (`webmasters/v3` + `searchconsole/v1` + `siteVerification/v1`), authenticated by a service account stored in Scaleway Secret Manager. This is the external complement to `/seo`.

⚠️ **Google-dependent skill**: every app ships IP-restricted to the office VPN by default (`ACCESS_RESTRICTED=true`, CONTRACT.md §6). Googlebot cannot crawl a restricted site at all. **Step 0 below detects this before anything else** and explains it in French rather than reporting a spurious failure - do not skip it.

## Authentication (preamble, before any GSC API call)

Forge a Google token from Scaleway Secret Manager (secret `GSC_SERVICE_ACCOUNT`, this app's own Project - CONTRACT.md §2):
```bash
GSCTOKEN="${CLAUDE_SKILL_DIR}/../../scripts/gsc/gsc-token.mjs"
TOK=$(node "$GSCTOKEN" --readonly); RC=$?     # read (audit, inspection)
# or without --readonly for read+write (add property, verify, sitemap)
```
Handling `RC`:
- **0** -> we have the token.
- **4** (GSC not configured: no `GSC_SERVICE_ACCOUNT` secret yet) -> delegate to the internal skill **`_setup-gsc`** (creates the service account + stores the key in Secret Manager + authorizes it on GSC), then retry.
- **1** (any other error: missing Scaleway credentials, invalid key, Google token exchange failure) -> relay the error plainly; if it looks like missing Scaleway credentials, tell the user to check the four `SCW_*` variables in the cloud environment dialog, then start a new conversation.

The token is valid for 1h; re-forge it if a session exceeds this duration. **Never display `$TOK`.**

Encoding the `siteUrl` in URLs: `sc-domain:example.com` -> `sc-domain%3Aexample.com`; `https://example.com/` -> `https%3A%2F%2Fexample.com%2F`. In the **bodies** (urlInspection, siteVerification) the siteUrl/identifier is **raw**.

---

## Teaching rule (important)

The user is **not necessarily an SEO pro**. It is often someone who just put their site online and wants to understand what Google does with it. The rules:

- When you use a technical term, explain it immediately in parentheses the first time. Examples:
  - *"Impressions (the number of times your site appears in Google's results, whether people click or not)"*
  - *"CTR (for Click-Through Rate: out of 100 times your site appears, how many people click on it - a good CTR is 3-5% and up)"*
  - *"Average position (what spot your site comes up in Google's results on average for a query - position 1 is the top, position 10 is the bottom of the first page)"*
  - *"Indexing coverage (how many pages of your site Google has properly recorded, vs how many it has ignored or blocked)"*
  - *"GSC property (a site you declare to Google Search Console so it shows you its data - you have to prove you really are the owner)"*
  - *"Sitemap (the list of your site's pages that you give to Google so it can find them all)"*
  - *"DNS / TXT record (a line of text you add to your domain's configuration to prove to Google that you really are the owner)"*
- Never raw jargon ("SERP", "crawl budget", "index bloat" without explanation). Either avoid it, or explain it in 1 sentence.
- Explain the **concrete impact** of each number / problem, not just its name.
- Never be condescending. The user is smart, they just don't know this field.

---

## Step 0 - Preflight

Invoke `_detect-project-root` first to get `PROJECT_NAME` and `PROJECT_TYPE`. Both stacks are supported here; abort only on `PROJECT_TYPE=unknown`. `PROJECT_TYPE` selects the sitemap check (Step 3.1) and the redirect location (Step 5).

### 0.1 - Verify the site is deployed on a usable domain

Read `.env`/`.env.production` (`APP_URL`) or the linked container's custom domain to retrieve the production domain.

- **No custom domain** (only the raw container URL): warn that GSC accepts it, but its value is limited (no brand, and it can change). Suggest `/add-domain` first.
- **Site not yet deployed**: stop and warn that GSC serves to analyze what Google sees, so you first need a site online (`/deploy`).

### 0.2 - Detect the VPN IP restriction (must run before any Google-dependent call)

Every app ships IP-restricted by default (`ACCESS_RESTRICTED=true`, CONTRACT.md §6): Googlebot and every Google service cannot reach the site at all in that state. Detect this **before** attempting anything below, rather than reporting a spurious failure or empty data as if something were broken.

Resolve the container to confirm the site is deployed, then read the live value from Secret Manager - a container GET only ever returns an argon2 hash, never plaintext (CONTRACT.md §1), so Secret Manager is the only readable source of truth, not the container:

```bash
CONTAINER_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/container.mjs" \
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
PROJECT_NAME="<PROJECT_NAME>" \
CONTAINER_NAME="<resolved container name>" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { ensureNamespace, findContainerByName } = await import(pathToFileURL(process.env.CONTAINER_MJS).href);
const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
const ns = await ensureNamespace(process.env.PROJECT_NAME);
const container = await findContainerByName(ns.id, process.env.CONTAINER_NAME);
if (!container) { console.log(JSON.stringify({ ok: false, error: "container_not_found" })); process.exit(1); }
// Production-canonical: this skill only ever audits the public production site (never a preview
// container), so ACCESS_RESTRICTED is production's own value in Secret Manager.
try {
  const accessRestricted = await getSecret("ACCESS_RESTRICTED");
  console.log(JSON.stringify({ ok: true, accessRestricted }));
} catch (e) {
  // not_found (or any other read failure) fails closed: treat as restricted.
  console.log(JSON.stringify({ ok: true, accessRestricted: e.type === "not_found" ? "true" : null }));
}
'
```

- **`container_not_found`** -> not deployed yet; that is already covered by 0.1, stop there.
- **`accessRestricted` is `"true"` or missing/unclear** (treat conservatively as restricted - `ACCESS_RESTRICTED` is always explicitly set at bootstrap, so a missing value is not a trustworthy "public") -> **STOP. Do not call the GSC API at all.** Explain in French:

  > 🔒 **Google ne peut pas encore accéder à votre site**
  >
  > Par défaut, chaque application est protégée : seul le VPN de l'entreprise peut y accéder. Le robot d'indexation de Google (Googlebot) ne peut donc pas du tout charger vos pages tant que cette protection est active - ce n'est pas une erreur de ma part, c'est le comportement normal et volontaire de votre application.
  >
  > Pour connecter Google Search Console, il faut d'abord rendre le site public avec `/publish`. Vous pourrez ensuite relancer `/gsc`.

  Stop cleanly.
- **`accessRestricted === "false"`** -> the site is public, continue to 0.3.
- If the container lookup itself fails for an unrelated reason (credentials, network), fall back to reading `ACCESS_RESTRICTED` from the local `.env` as a best-effort signal, noting to the user that it may be stale.

### 0.3 - Verify GSC is configured (Secret Manager)

Forge a token (preamble). If `RC=4` -> GSC not yet configured on this machine -> 0.4. If `RC=0` -> note `GSC_OK` and continue. If `RC=1` -> relay the error (see preamble).

### 0.4 - GSC setup (if absent) - delegated to `_setup-gsc`

Delegate to the internal skill **`_setup-gsc`**: it guides the creation of a Google service account (one-time), stores its key in Scaleway Secret Manager (`GSC_SERVICE_ACCOUNT`), and authorizes it as owner on the GSC property. No MCP, no Python, no restart.

When `_setup-gsc` hands back successfully, re-forge the token and continue to Step 1.

If the user declines the setup -> propose an on-page audit via `/seo` (without GSC) and stop cleanly.

---

## Progress communication

At startup, display a checklist in natural language. During execution, announce with `↳ …` then mark `✅`. **Never** an internal "Step N" / "Étape N" in your user-facing messages. **Never** the internal skill names prefixed with `_` - describe in plain language.

---

## Step 1 - List / add the property

The service account has the full scope (read + write + verification) -> the whole add / verify / sitemap flow is autonomous.

List the visible properties:
```bash
curl -s -H "Authorization: Bearer $TOK" "https://www.googleapis.com/webmasters/v3/sites"
```
Returns `siteEntry[]` (`siteUrl` + `permissionLevel`).

### 1.1 - The site is already in GSC

If the domain (or an `sc-domain:` variant / with-without `www`) appears with an owner permission -> skip to Step 3 (sitemap) or 4 (audit).

> Good news: your site `example.fr` is already connected to Google Search Console. I'm going straight to the analysis.

### 1.2 - The site is not in GSC: add a Domain property

Briefly explain (Domain = covers the whole site, verified by DNS) then launch the **add + verify** flow (read+write token required). For `<domain>` (without `https://`, without `www`):

**(a) Get the DNS verification token**:
```bash
curl -s -X POST "https://www.googleapis.com/siteVerification/v1/token" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"site":{"type":"INET_DOMAIN","identifier":"<domain>"},"verificationMethod":"DNS_TXT"}'
```
-> returns `{"token":"google-site-verification=XXXX"}`. This is the value to place in a root TXT.

**(b) Place the TXT** -> see Step 2 (Scaleway DNS).

**(c) Verify ownership** (once the TXT has propagated), while also delegating access to the human via `owners`:
```bash
curl -s -X POST "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"site":{"type":"INET_DOMAIN","identifier":"<domain>"},"owners":["<user_google_email>"]}'
```
Ask the user for their Google address (the one for their Search Console) for the `owners` - this guarantees them access in the GSC UI in addition to the service account.

**(d) Add the property in GSC** (after successful verification):
```bash
curl -s -X PUT "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3A<domain>" -H "Authorization: Bearer $TOK"
```
Mandatory order: (a) token -> (b) TXT -> (c) verify -> (d) add (otherwise 403).

---

## Step 2 - Place the verification TXT (DNS)

The value `google-site-verification=...` (from Step 1a) goes into a **root TXT (`@`)** of the domain.

### 2.1 - DNS on Scaleway (standard case, once `/add-domain` has run)

The domain's zone is delegated to Scaleway DNS (after `/add-domain` - CONTRACT.md: "DNS: Scaleway Domains & DNS - external domains only"). Use `scripts/scaleway/dns.mjs` directly, the same cross-platform-safe inline-import pattern used elsewhere in this harness:

```bash
DNS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/dns.mjs" \
DOMAIN="<domain>" \
TXT_VALUE="google-site-verification=XXXX" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { upsertRecords } = await import(pathToFileURL(process.env.DNS_MJS).href);
await upsertRecords(process.env.DOMAIN, [{ name: "@", type: "TXT", data: process.env.TXT_VALUE, ttl: 300 }]);
console.log(JSON.stringify({ ok: true }));
'
```
Show the user what is being added (TXT type, name @, value), noting that it changes nothing about the site.

### 2.2 - DNS elsewhere (manual)

If the domain is not delegated to Scaleway DNS, display the copy-paste instructions (root TXT = the value) for the registrar's dashboard, and wait for confirmation.

### 2.3 - Wait for propagation then verify

After adding, wait a few seconds/minutes, then run Step 1c (verify). If it fails with `dns_record_not_found` / not verified:

> Google hasn't seen the DNS record yet - propagation can take from 5 minutes to 24 hours. Re-run `/gsc` later, I'll pick up where we left off.

---

## Step 3 - Submit the sitemap

### 3.1 - Verify that the sitemap exists
- `PROJECT_TYPE=application`: look for `src/app/sitemap.ts` (or `apps/web/src/app/sitemap.ts`).
- `PROJECT_TYPE=landing`: look for `@astrojs/sitemap` in `astro.config.mjs` integrations and a `site:` value.

Absent -> tell the user to run `/seo` first (which creates the sitemap for both stacks).

### 3.2 - Submit (PUT)
The feed path differs by stack: `sitemap.xml` for an application, `sitemap-index.xml` for a landing (`@astrojs/sitemap` generates an index).
```bash
SITE="sc-domain%3A<domain>"; FEED="https%3A%2F%2F<domain>%2Fsitemap.xml"   # landing: %2Fsitemap-index.xml
curl -s -X PUT -H "Authorization: Bearer $TOK" "https://www.googleapis.com/webmasters/v3/sites/$SITE/sitemaps/$FEED"
```

### 3.3 - Check the status
```bash
curl -s -H "Authorization: Bearer $TOK" "https://www.googleapis.com/webmasters/v3/sites/$SITE/sitemaps"
```
> ✅ Sitemap submitted. Google will gradually visit each page. Status "pending" at first, that's normal.

---

## Step 4 - Audit the GSC data

The core of the skill. A `--readonly` token is enough here.

### 4.1 - Site too recent?
If the property is new / "insufficient data": warn that it takes **2-3 days** for the first data, **2-4 weeks** for a reliable overview.

### 4.2 - Indexing coverage
Inspect the key pages (from the sitemap) via the URL Inspection API:
```bash
curl -s -X POST "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"inspectionUrl":"https://<domain>/","siteUrl":"sc-domain:<domain>"}'
```
(`siteUrl` raw in the body.) Iterate over the main URLs (quota ~2000/day, 600/min - sample if a large site, and flag it). Present:

> **Indexing coverage**
> - ✅ Pages properly indexed: X
> - ⚠️ Pages not indexed: Y (with reasons: "Discovered, not indexed" = normal for a recent site; "noindex" = check that it's intentional; "404" = add a 301 redirect)
> - ❌ Critical errors: U (with URL + explanation)

### 4.3 - Performance (last 28 days)
```bash
curl -s -X POST "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3A<domain>/searchAnalytics/query" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"startDate":"<D-28>","endDate":"<D>","dimensions":["query"],"rowLimit":100}'
```
(Redo with `"dimensions":["page"]` for the top pages; without `dimensions` for the aggregate.)

Present **Top 10 queries** and **Top 10 pages** as markdown tables (Query/Page | Impressions | Clicks | CTR | Average position), plus the **28-day Total**.

### 4.4 - Opportunities (the most useful)
Analyze for concrete recommendations in order of impact:
- **Queries in position 11-20** (close to the top 10 -> small effort = big gain). List with impressions/position.
- **High-volume queries but low CTR** (unengaging title/meta -> propose a rewrite).
- **Zombie pages** (0 impressions over 28 days -> thin content / cannibalization / query too competitive).

For each, explain the concrete impact and propose an action (see teaching tone).

### 4.5 - Summary
> **GSC report - last 28 days**
> - **Indexing**: X/Y pages indexed
> - **Google traffic**: Z clicks, average position P
> - **Main opportunities**: 1. [easy win] 2. [meta to rewrite] 3. [page to strengthen/remove]

---

## Step 5 - Fixes

Propose applying the fixes (titles / metas / content), same rules as `/seo`. Explicit validation before writing any code. **Never rename an existing route without a 301 redirect** (otherwise 404 on the indexed URLs -> loss of ranking). Add the redirect in `next.config.js` for an application; for a landing add a `redir <old-path> <new-path> permanent` line in the `Caddyfile` route block, after the gate import and before the catch-all handle (Astro's own `redirects` config only emits meta-refresh pages, not a real 301).

---

## Step 6 - Final report

Summary: what was added (property, sitemap), fixed (titles/metas/content), and what remains (wait 2-4 weeks to review the data). Do not suggest `/seo` or `/geo` here (the bridges go the other way).

---

## Notes

- **No on-page audit** (-> `/seo`). **No GA4** (-> `/add-analytics`). **No automatic weekly report**.
- **Idempotence**: re-run on an already-connected project, jumps to the audit (Step 4). Does not re-add the property or the sitemap if they exist.
- If in doubt about a GSC endpoint, query Context7 (`/websites/developers_google_webmaster-tools_v1`) rather than inventing.
