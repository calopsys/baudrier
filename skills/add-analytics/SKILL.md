---
name: add-analytics
description: Add Matomo audience-measurement analytics to an existing Next.js project. Cookieless by default (no cookies, no pre-consent banner needed for anonymous audience measurement) with an always-available opt-out control. Matomo is not a Scaleway product - the skill asks the user for their own Matomo instance URL and site ID (Matomo Cloud EU or self-hosted) rather than provisioning anything.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Analytics - Matomo

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Adds Matomo audience-measurement tracking to the current project. **Cookieless by default**: the tracker is configured with `disableCookies()`, so no personal identifier is stored on the visitor's device and no pre-consent banner is legally required for this specific, limited purpose (see "Why cookieless" below). A discreet, always-available opt-out control still ships, because RGPD/CNIL requires that visitors can object to even anonymous measurement at any time. Can be called by `/bootstrap` or standalone on an existing project.

**Important**: unlike most other `/add-*` skills, this one does **not** provision anything on Scaleway. Matomo is a separate product (Matomo Cloud EU or self-hosted, on the user's own infrastructure); the skill only asks for the instance URL and site ID and wires the tracking code.

### Why cookieless (and why that means no banner)

Matomo's `disableCookies()` mode drops no visitor-identifying cookie and does not persist a cross-session identifier. Under CNIL's published exemption criteria for audience-measurement tools, tracking that is (a) strictly limited to anonymous, first-party audience measurement, (b) not cross-referenced with other processing, (c) not shared with third parties, and (d) does not build an identifying trail across sites, is **exempt from prior consent** - a simple notice plus an easy opt-out is enough. Cookieless Matomo, configured this way, meets that bar. This is why the skill does **not** install a blocking "Accept/Refuse" banner: there is nothing that requires the visitor's prior consent. It still installs a permanent, easy-to-find opt-out (see Step 5) and a mention in the privacy policy (Step 7), because disclosure and the right to object remain mandatory regardless of the consent-exemption.

If a project later needs cookie-based tracking (e.g. cross-device recognition, long-lived funnels), that is a deliberate step **up** in data collection and requires re-introducing a real consent gate - out of scope for the default flow. Mention this to the user only if they explicitly ask for it, and do not build it without being asked.

---

## Step 0 - Preflight: is Analytics already configured?

Invoke `_detect-project-root` to get `PROJECT_TYPE` (`landing` or `application`) - it decides how the tracking code is wired (Step 2 and Step 4).

**First of all**, check whether Matomo is already wired up:

**If `PROJECT_TYPE=application`**:
```bash
grep -q "NEXT_PUBLIC_MATOMO_URL" "<web-root>/.env" 2>/dev/null && echo configured || echo not_configured
```

**If `PROJECT_TYPE=landing`** (no env var - see Step 2): check the component instead:
```bash
test -f "<WEB_DIR>/src/components/Matomo.astro" && echo configured || echo not_configured
```

### If `configured` -> re-configuration mode

Read the current values: from `.env` (`NEXT_PUBLIC_MATOMO_URL`, `NEXT_PUBLIC_MATOMO_SITE_ID`) for `PROJECT_TYPE=application`, or from the two constants at the top of `<WEB_DIR>/src/components/Matomo.astro` for `PROJECT_TYPE=landing`. Do NOT recreate the tracking/opt-out components, nor rewrite the layout. Show a menu:

> ## 📊 Matomo analytics is already in place (site **$siteId** on $matomoUrl)
>
> What do you want to do?
>
> 1. **Switch Matomo instance or site** (new Matomo account, new site, or you're migrating self-hosted ↔ Matomo Cloud) - I just replace the URL and site ID
> 2. **Reinstall the opt-out control** (if the component was deleted by accident or is broken)
> 3. **Reinstall the MatomoAnalytics component** (same thing, if deleted or broken)
> 4. **Exclude admin routes / authenticated areas from tracking** - so that admin and logged-in client sessions are no longer counted as discovery traffic
> 5. **Redo everything from scratch** (only useful if the configuration is completely broken - first remove `NEXT_PUBLIC_MATOMO_URL` / `NEXT_PUBLIC_MATOMO_SITE_ID` from the local `.env` and the `MatomoAnalytics.tsx` / `AnalyticsOptOut.tsx` components)
> 6. **Something else** - tell me what you want

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (switch instance/site) | Ask for the new URL + site ID (validate as in Step 1). `PROJECT_TYPE=application`: push via `_push-env-vars`. `PROJECT_TYPE=landing`: edit the two baked-in constants at the top of `Matomo.astro` directly, then remind the user a rebuild + redeploy is needed (Step 2's landing branch explains why). |
| 2 (reinstall opt-out control) | Re-run only the "Create the opt-out control" section (Step 5 of the nominal flow). Do not touch the rest. |
| 3 (reinstall MatomoAnalytics) | Re-run only the "Create MatomoAnalytics component" section (Step 4 of the nominal flow). |
| 4 (exclude admin / authenticated) | **Retrofit the exclusion onto an existing component** - see the procedure below. |
| 5 (redo everything) | Abort: ask the user to clean up manually, then re-run. |
| 6 (something else) | Ask for details. Do not launch the full flow by default. |

#### Choice 4 - Retrofit the admin / authenticated exclusion

Locate the existing component (`MatomoAnalytics.tsx`, often under `src/components/` or `src/components/shared/`) and upgrade it to the **Step 4** version:

1. Read the current `MatomoAnalytics.tsx`.
2. If it is still the old version (no `EXCLUDED_PREFIXES` and no `usePathname`), **replace its entire contents** with the Step 4 component (keeping the import path of the env vars and the file location). If it already has `EXCLUDED_PREFIXES`, do not rewrite it - just adjust the list.
3. Detect and (on confirmation) add the authenticated areas (dashboard, members area, account) to `EXCLUDED_PREFIXES`, same procedure as in Step 4.
4. Verify: `pnpm tsc --noEmit && pnpm lint`.
5. Remind the user that the effect is immediate on the code side, but that the data already collected in Matomo is not retroactively cleaned (only new admin/client sessions stop being counted).

**At the end**, jump straight to the **final summary**.

### If `not_configured`

Continue normally to Step 1. This is the initial installation flow.

---

## Step 1 - Ask for the Matomo instance

Matomo is not something this harness provisions - the user brings their own instance. Explain briefly, then ask:

> To measure your site's audience, I use **Matomo**, a privacy-friendly analytics tool. Two options:
> - **Matomo Cloud** (hosted by Matomo, matomo.cloud - simplest, has a free trial then a paid plan)
> - **Self-hosted Matomo** (you or someone you know already runs one)
>
> If you don't have one yet: go to https://matomo.org/pricing/ (or https://matomo.org/free-analytics-tools/ for the free self-hosted download), create your account / instance, then come back here with two things:
> 1. **Your Matomo URL** (e.g. `https://your-name.matomo.cloud` or `https://analytics.your-domain.com`, no trailing slash)
> 2. **Your site ID** (a small number, visible in Matomo under Administration → Websites → Manage - the ID of the website you want to track)

**Do not proceed until the user provides both.** Validate:
- URL: starts with `https://`, no trailing `/`.
- Site ID: digits only.

## Step 2 - Push env vars

**If `PROJECT_TYPE=landing`, skip this step entirely.** A static Astro build has no server to read `process.env` at runtime, so there is no env var to push - the URL and site ID are written straight into `Matomo.astro`'s source instead (Step 4). Go directly to Step 3.

**If `PROJECT_TYPE=application`**, invoke `_push-env-vars` with:
- `NEXT_PUBLIC_MATOMO_URL=<url>`
- `NEXT_PUBLIC_MATOMO_SITE_ID=<siteId>`

The helper writes to `.env` locally and to the hosted app's secrets.

### Update the Content-Security-Policy (`PROJECT_TYPE=application` only)

`/bootstrap` ships a `Content-Security-Policy-Report-Only` header by default (`next.config.js`, see `CONTENT_SECURITY_POLICY_REPORT_ONLY`) that does not yet know about this Matomo instance. Open `next.config.js` and append the Matomo URL to both `script-src` and `connect-src` in that constant, for example:

```
"default-src 'self'; img-src 'self' data: blob: https://*.scw.cloud; script-src 'self' 'unsafe-inline' https://your-instance.matomo.cloud; style-src 'self' 'unsafe-inline'; connect-src 'self' https://your-instance.matomo.cloud"
```

If the project has since promoted the policy from Report-Only to a real, enforced `Content-Security-Policy` header, make the same addition there too - otherwise the tracker silently stops loading (no console error visible to a non-technical user, just missing data in Matomo) the moment that policy is enforced. A landing's headers live in its Caddyfile, not `next.config.js` - leave that file alone.

## Step 3 - One-time check in the user's Matomo admin (informational, not automatable)

Matomo's cookieless mode is only part of the compliance story - the other part is a couple of settings on the Matomo side that this skill cannot configure remotely (no public API for this). Tell the user, once, briefly:

> One-time check on your side (2 minutes, in your Matomo admin → Administration → Privacy): make sure **"Anonymize visitor's IP addresses"** is enabled, and that Matomo isn't sharing data with third parties. These are usually already the default. I can't change them for you, but they're what keeps the cookieless setup exempt from a consent banner.

Do not block on this - it is a courtesy reminder, not a hard gate.

## Step 4 - Create the tracking component

**If `PROJECT_TYPE=landing`, use the Astro branch below instead of the Next.js component.**

### Astro branch (`PROJECT_TYPE=landing`)

Create `<WEB_DIR>/src/components/Matomo.astro`, with the instance URL and site ID **baked into the source** (constants, not env vars):

```astro
---
// Baked into the source, not read from an env var: a static Astro build has
// no server at request time to resolve process.env from. This is not a
// leak - the same values are already public in the page source of every
// Matomo site (the tracker snippet always embeds them client-side, even
// when it originates from an env var on a server-rendered stack).
const MATOMO_URL = "https://your-instance.matomo.cloud";
const MATOMO_SITE_ID = "1";
---

<script define:vars={{ MATOMO_URL, MATOMO_SITE_ID }} is:inline>
  window._paq = window._paq || [];
  if (window.localStorage && window.localStorage.getItem("matomo-optout") === "true") {
    // Visitor opted out before the tracker ever loaded - do nothing.
  } else {
    // Cookieless: no visitor-id cookie is set. See add-analytics SKILL.md
    // for why this means no pre-consent banner is required.
    _paq.push(["disableCookies"]);
    _paq.push(["trackPageView"]);
    _paq.push(["enableLinkTracking"]);
    (function () {
      var u = MATOMO_URL + "/";
      _paq.push(["setTrackerUrl", u + "matomo.php"]);
      _paq.push(["setSiteId", MATOMO_SITE_ID]);
      var d = document, g = d.createElement("script"), s = d.getElementsByTagName("script")[0];
      g.async = true;
      g.src = u + "matomo.js";
      s.parentNode?.insertBefore(g, s);
    })();
  }
</script>
```

There is no client-side router to re-fire on navigation: an Astro landing is a set of static pages, each a full page load, so the init script's own `trackPageView` call is enough - no `PageViewTracker`/`usePathname` equivalent is needed (unlike the Next.js branch below). Replace `MATOMO_URL`/`MATOMO_SITE_ID` with the values from Step 1. Fill in the values directly - do not leave the placeholders in the file.

Set values directly with the user-provided URL and site ID before moving to Step 5.

### Next.js branch (`PROJECT_TYPE=application`)

Create a `MatomoAnalytics` component (location depends on project structure - e.g. `src/components/MatomoAnalytics.tsx` or `src/components/shared/MatomoAnalytics.tsx`):

```typescript
"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

declare global {
  interface Window {
    _paq?: unknown[][];
  }
}

/**
 * Route prefixes excluded from Matomo tracking.
 * No page whose path starts with one of these prefixes is tracked
 * (neither on direct load, nor on internal navigation). By default: the admin.
 *
 * Add your authenticated routes here if you want to keep them out of the
 * acquisition stats (admin/client sessions are not discovery traffic),
 * for example: "/dashboard", "/espace-membres", "/compte".
 */
const EXCLUDED_PREFIXES = ["/admin"];

function isExcludedPath(pathname: string | null) {
  if (!pathname) return false;
  return EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isOptedOut() {
  return typeof window !== "undefined" && window.localStorage.getItem("matomo-optout") === "true";
}

/**
 * Sends a virtual pageview on each internal navigation (SPA), skipping the
 * first one (already emitted by the tracker's init script below) and the
 * excluded/opted-out cases.
 */
function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return; // initial pageview already sent by the inline init script
    }
    if (isExcludedPath(pathname) || isOptedOut()) return;
    const query = searchParams.toString();
    window._paq?.push(["setCustomUrl", query ? `${pathname}?${query}` : (pathname ?? "/")]);
    window._paq?.push(["setDocumentTitle", document.title]);
    window._paq?.push(["trackPageView"]);
  }, [pathname, searchParams]);

  return null;
}

export function MatomoAnalytics() {
  const pathname = usePathname();
  const matomoUrl = process.env.NEXT_PUBLIC_MATOMO_URL;
  const siteId = process.env.NEXT_PUBLIC_MATOMO_SITE_ID;

  // No config, excluded route (admin/authenticated area), or the visitor
  // opted out: don't even load matomo.js.
  if (!matomoUrl || !siteId || isExcludedPath(pathname)) return null;

  return (
    <>
      <Script id="matomo-analytics" strategy="afterInteractive">
        {`
          window._paq = window._paq || [];
          if (window.localStorage && window.localStorage.getItem("matomo-optout") === "true") {
            // Visitor opted out before the tracker ever loaded - do nothing.
          } else {
            // Cookieless: no visitor-id cookie is set. See add-analytics SKILL.md
            // for why this means no pre-consent banner is required.
            _paq.push(["disableCookies"]);
            _paq.push(["trackPageView"]);
            _paq.push(["enableLinkTracking"]);
            (function () {
              var u = "${matomoUrl}/";
              _paq.push(["setTrackerUrl", u + "matomo.php"]);
              _paq.push(["setSiteId", "${siteId}"]);
              var d = document, g = d.createElement("script"), s = d.getElementsByTagName("script")[0];
              g.async = true;
              g.src = u + "matomo.js";
              s.parentNode?.insertBefore(g, s);
            })();
          }
        `}
      </Script>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
    </>
  );
}
```

**Source of the tracker snippet**: the `_paq.push` / `matomo.php` / `matomo.js` pattern is Matomo's official JavaScript Tracking Client, documented at https://developer.matomo.org/guides/tracking-javascript-guide and https://developer.matomo.org/api-reference/tracking-javascript (init snippet), plus the SPA pageview guidance at https://developer.matomo.org/guides/spa-tracking (adapted here to Next.js App Router's `usePathname`/`useSearchParams` instead of `hashchange`, per that guide's own note to use "your framework's router hooks"). `disableCookies()` is documented at https://matomo.org/faq/general/faq_157/ and must be called before `trackPageView`.

**To do after creating the component - offer to broaden the exclusion.** Same procedure as before: detect the project's authenticated areas (`src/app/admin`, `src/app/dashboard`, `src/app/espace-membres`, `src/app/compte`, `src/app/account`, ...) and offer, in plain language, to add the confirmed ones to `EXCLUDED_PREFIXES`.

## Step 5 - Create the opt-out control

Even though no consent is required to start cookieless measurement, RGPD/CNIL still requires an always-available, easy way to object to it.

**If `PROJECT_TYPE=landing`**: create `<WEB_DIR>/src/components/AnalyticsOptOut.astro`, a small hidden panel toggled by a global function (vanilla JS, no framework):

```astro
<div id="analytics-optout" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/60 p-4">
  <div class="max-w-sm rounded-lg bg-[var(--color-surface)] p-6 text-[var(--color-ink)]">
    <p class="mb-4 text-sm">Ce site utilise une mesure d’audience anonyme et sans cookie (Matomo). Vous pouvez vous y opposer à tout moment.</p>
    <div class="flex justify-end gap-2">
      <button type="button" id="analytics-optout-close" class="text-sm underline">Continuer sans s’opposer</button>
      <button type="button" id="analytics-optout-refuse" class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white">S’opposer au suivi</button>
    </div>
  </div>
</div>

<script is:inline>
  window.openAnalyticsPreferences = function () {
    document.getElementById("analytics-optout")?.classList.remove("hidden");
    document.getElementById("analytics-optout")?.classList.add("flex");
  };
  document.getElementById("analytics-optout-close")?.addEventListener("click", () => {
    document.getElementById("analytics-optout")?.classList.add("hidden");
  });
  document.getElementById("analytics-optout-refuse")?.addEventListener("click", () => {
    window.localStorage.setItem("matomo-optout", "true");
    window.location.reload();
  });
</script>
```

Use the project's semantic tokens (`--color-surface`, `--color-ink`, `--color-accent`, from `theme.css`) instead of the placeholder classes above if the project already has them (it does, from `/bootstrap`).

**Important**: this control is **hidden by default** (it only opens via `window.openAnalyticsPreferences()`, wired to a footer link in Step 6.5) - unlike a consent banner, it must never auto-pop-up on first visit, since there is nothing to consent to.

**If `PROJECT_TYPE=application`**, create an `AnalyticsOptOut` component from the shared template:

```bash
cp "${CLAUDE_SKILL_DIR}/../../templates/cookie-banner/plain.tsx" "<web-root>/src/components/AnalyticsOptOut.tsx"
```

**Adjust the colors**: the template has a `bg-black/90` background and a `bg-white text-black` button. Replace with the project's colors - look in `globals.css` or the project's `CLAUDE.md` for the main accent color.

**Important**: this control is **hidden by default** (it only opens via `openAnalyticsPreferences()`, wired to a footer link in Step 6.5) - unlike a consent banner, it must never auto-pop-up on first visit, since there is nothing to consent to.

**Adapt the link to the privacy policy**: by default the template points to `/politique-de-confidentialite` (the path created by `/bootstrap`). If the project uses a different path, adjust the `href`.

## Step 6 - Mount the tracking component

**If `PROJECT_TYPE=landing`**: in `<WEB_DIR>/src/layouts/BaseLayout.astro`, add the import to the frontmatter (`---` block) and mount both components at the analytics anchor comment - the template ships this exact marker for that purpose:

```
<!-- baudrier:analytics-anchor - /add-analytics mounts <Matomo /> here -->
```

```astro
---
import Matomo from "../components/Matomo.astro";
import AnalyticsOptOut from "../components/AnalyticsOptOut.astro";
---
```

```astro
<Matomo />
<AnalyticsOptOut />
```

**If `PROJECT_TYPE=application`**: add the tracking component to the root layout, before `</body>`. The opt-out control renders `null` until opened, so it can live anywhere in the tree - the root layout is simplest:

```typescript
import { MatomoAnalytics } from "~/components/MatomoAnalytics";
import { AnalyticsOptOut } from "~/components/AnalyticsOptOut";

// Before </body>:
<MatomoAnalytics />
<AnalyticsOptOut />
```

## Step 6.5 - Add "Manage tracking" link to the footer (RGPD requirement)

**This is legally required**: even for consent-exempt cookieless measurement, the visitor must be able to object at any time, with a discoverable control. A discreet link in the footer fulfills this.

**If `PROJECT_TYPE=landing`**: locate `<WEB_DIR>/src/components/Footer.astro`. Add a button alongside the legal links:

```astro
<button
  type="button"
  onclick="window.openAnalyticsPreferences?.()"
  class="cursor-pointer text-xs underline"
>
  Gérer le suivi anonyme
</button>
```

**If `PROJECT_TYPE=application`**: locate the project's footer component (typically `src/components/layout/footer.tsx`, `src/components/Footer.tsx`, or similar). Add a button alongside the other legal links (e.g. next to "Mentions légales", "Politique de confidentialité"):

```tsx
import { openAnalyticsPreferences } from "~/components/AnalyticsOptOut";
// (or wherever AnalyticsOptOut lives in this project)

// In the footer legal links row:
<button
  type="button"
  onClick={openAnalyticsPreferences}
  className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-primary"
>
  Gérer le suivi anonyme
</button>
```

**Note**: if the project has no footer yet (rare), skip this step but inform the user - they'll need to add the link manually when they build their footer.

## Step 7 - Update legal pages (RGPD)

**If `PROJECT_TYPE=landing`**: the two legal pages are plain `.astro` files, not a registry-driven Next page - open `<WEB_DIR>/src/pages/politique-de-confidentialite.astro` and `<WEB_DIR>/src/pages/mentions-legales.astro` and add a short paragraph by hand to the privacy policy page:

> Mesure d’audience anonyme et sans cookies (Matomo). Aucune donnée personnelle n’est collectée ; les visiteurs peuvent s’opposer à tout moment via le lien "Gérer le suivi anonyme" en bas de page. Aucun partage avec un tiers.

**If `PROJECT_TYPE=application`**, add Matomo to the project's RGPD subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add matomo
```

The helper is idempotent. **If it prints `Unknown key: matomo`** (the registry entry may not exist yet in this harness), don't fail the flow: open `<web-root>/src/app/politique-de-confidentialite/page.tsx` (if it exists, created by `/bootstrap`) and add the same short paragraph by hand instead.

If the site has a hand-written privacy policy (not generated by bootstrap), do the same edit there.

## Step 8 - Update CLAUDE.md

**If `PROJECT_TYPE=landing`**, invoke `_update-claude-md` with:
- `stack`: `- **Analytics**: Matomo (cookieless audience measurement, no consent banner needed, values baked into Matomo.astro)`
- `conventions`:
  - `- Analytics is cookieless by default (\`disableCookies()\` in \`Matomo.astro\`) - do not add cookie-based tracking without discussing it first, it changes the RGPD basis.`
  - `- The Matomo URL and site ID are baked into \`Matomo.astro\`'s source, not an env var (static build - see add-analytics SKILL.md). Changing them needs a rebuild + redeploy (\`/deploy\`), not just a secret update.`
  - `- Visitor opt-out: \`localStorage.matomo-optout\`, toggled from \`AnalyticsOptOut.astro\` (opened via \`window.openAnalyticsPreferences()\`).`

**If `PROJECT_TYPE=application`**, invoke `_update-claude-md` with:
- `stack`: `- **Analytics**: Matomo (cookieless audience measurement, no consent banner needed)`
- `env-vars`: `- \`NEXT_PUBLIC_MATOMO_URL\` - Matomo instance URL` ; `- \`NEXT_PUBLIC_MATOMO_SITE_ID\` - Matomo site ID`
- `conventions`:
  - `- Analytics is cookieless by default (\`disableCookies()\` in \`MatomoAnalytics.tsx\`) - do not add cookie-based tracking or a consent-gate without discussing it first, it changes the RGPD basis.`
  - `- Analytics exclusion: \`MatomoAnalytics.tsx\` does not trigger Matomo on any route listed in \`EXCLUDED_PREFIXES\` (default \`["/admin"]\`). To also exclude an authenticated area, add its URL prefix to \`EXCLUDED_PREFIXES\`.`
  - `- Visitor opt-out: \`localStorage.matomo-optout\`, toggled from \`AnalyticsOptOut.tsx\` (opened via \`openAnalyticsPreferences()\`).`

---

## Step 9 - Summary

**If `PROJECT_TYPE=landing`, tell the user explicitly, in French**: « Les identifiants Matomo sont écrits directement dans le code (nécessaire pour un site statique) : toute modification future demande une reconstruction et un redéploiement du site (`/deploy`), pas juste une mise à jour de secret. »

Tell the user:
- Matomo is installed, cookieless (no cookies, no personal data collected)
- No consent banner blocks the page - measurement starts immediately, which is why it must stay strictly anonymous (remind them not to add cookie-based tracking without revisiting this)
- The admin routes (`/admin`) are excluded from tracking: no admin session is counted as discovery traffic. If authenticated areas were added to the exclusion, remind them here.
- A discreet "Gérer le suivi anonyme" link in the footer lets any visitor opt out
- Legal page updated (or: ask them to double-check the manual paragraph if the registry key was missing)
- Data visible in their own Matomo instance, under the site they gave us the ID for
- One-time reminder: check "Anonymize visitor's IP addresses" is on in their Matomo admin (Step 3)
