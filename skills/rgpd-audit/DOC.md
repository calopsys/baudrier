# /rgpd-audit

Audits your project's RGPD compliance and updates your privacy policy. Baudrier automatically detects every third-party service used by your app, compares it with your online policy, and proposes the fixes - and shows you exactly how sovereign your stack really is.

## When to use it

- You did an old `/bootstrap` (before the data-driven privacy policy) and you want to **update your compliance**
- You have added several services over time and you want to **verify** that your privacy policy is up to date
- You want to **regenerate** your privacy policy page from the actual list of subprocessors
- You want to make sure that **no third-party service is used** without being mentioned in your policy

## How it works

1. **Preflight**: Baudrier verifies that you are indeed at the root of a Next.js project.

2. **Full audit**: Baudrier scans your code (`src/`), your environment variables (`.env`) and your dependencies (`package.json`) to detect **every third-party subprocessor** actually used:
   - Hosting (Scaleway Serverless Containers - always present)
   - Database (Scaleway Serverless SQL Database)
   - File storage (Scaleway Object Storage)
   - Email (Scaleway Transactional Email)
   - Analytics (Matomo, cookieless by default)
   - And all the others that can be detected

   It also flags third parties involved in **building and operating** the project that do not belong in the privacy policy because they never touch a visitor's personal data: GitHub (source hosting + CI, in the deploy pipeline) and Google SEO tooling (PageSpeed Insights / Search Console, used by `/seo-perf` and `/gsc` - reads public page data, not visitor data). These are reported separately, for transparency, not as a compliance gap.

3. **Comparison with the registry**: Baudrier reads `src/lib/subprocessors.json` (the project's central registry of RGPD subprocessors) and compares it with what is detected in the code.

4. **Report**: Baudrier displays the diagnosis:
   - **Detected in the code**: the full list of third-party services currently used (with the evidence: `package.json`, env var, or code pattern)
   - **Missing**: services detected but **absent from the registry** (to add)
   - **Obsolete**: services present in the registry but **no longer detected** in the code (to remove or justify)
   - **Sovereignty**: how many of your declared subprocessors are actually based in France/EU - typically the vast majority, since hosting, database, storage and email are all Scaleway (région Paris, fr-par) by default in this stack

5. **Proposed fixes**: Baudrier proposes to:
   - **Update the registry** `subprocessors.json` with the missing ones and / or remove the obsolete ones
   - **Generate or refresh** the privacy policy page (if it is missing or out of sync)
   - **Link** the privacy policy from the legal notices if it is not already done

6. **Application**: Baudrier applies the validated changes. The privacy policy page is **data-driven**: it updates itself automatically from the registry. You no longer have to manually edit the RGPD content with each new service added.

## What it creates for you

- An up-to-date **`subprocessors.json` registry** (the single source of truth about your RGPD subprocessors)
- A **privacy policy page** regenerated from the registry, compliant with French regulations
- A **link** from the legal notices (if missing)
- A clear report with the detected gaps and a real, computed sovereignty summary

## Prerequisites

- The project must be in Next.js with the App Router (typically initialized by `/bootstrap`)
- No other dependency, `/rgpd-audit` works even if you have never touched the privacy policy

## Tips

{{callout:info|Why a central registry}}
Instead of writing your privacy policy by hand (and having to remember to update it with each new service), Baudrier uses a **central registry** (`subprocessors.json`) that is the single source of truth. Each `/add-*` skill (`/add-db`, `/add-storage`, `/add-email`, `/add-analytics`, etc.) updates the registry automatically. The privacy policy page is just a rendering of this registry.
{{/callout}}

{{callout:tip|Run it after a big overhaul}}
If you have added or removed several services in a short time (for example: added an AI agent, switched Matomo hosting mode, removed the analytics), `/rgpd-audit` is the quick way to bring everything back into consistency. A single command, and your policy is up to date.
{{/callout}}

{{callout:warning|RGPD = legal obligation in France}}
For any site that collects or processes personal data of French / European users (contact form, user accounts, notifications, analytics, etc.), an up-to-date privacy policy is **mandatory**. CNIL fines can climb. Running `/rgpd-audit` regularly (every 2-3 months or after each overhaul) is good hygiene.
{{/callout}}

## Landing sites (site vitrine)

Not available on a landing site: this command is reserved for full applications. If your project is a landing site (built with Astro, no database, no user accounts), Baudrier refuses the command and tells you so - your site stays exactly as it is, and remains deployable with `/deploy`.
