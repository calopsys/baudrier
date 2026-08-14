# /seo-perf

Measures your site's real speed with PageSpeed Insights, Google's official tool. A few representative pages are loaded as if by a real visitor, you get scores (speed, accessibility, SEO) and the Core Web Vitals, then concrete fixes sorted by measured impact.

## When to use it

- You want to know whether your site is **genuinely fast** (not a feeling, but figures measured by Google)
- You just ran `/seo` and want to **check the result** against an objective measurement (offered automatically at the end of `/seo`)
- A few weeks after launch, to see the **data from your real visitors** (field Core Web Vitals)

## How it works

1. **Checks**: the site must be **public** first - every app ships restricted to the office VPN by default, and Google cannot reach a restricted site, so Baudrier checks this and asks for `/publish` if needed. It must also be deployed (we measure the live site, not the local code). On first use, Baudrier guides you through creating a free Google key (2 minutes, just once for all your projects, stored in the Scaleway secrets vault).

2. **Choosing representative pages**: we don't audit the whole site. Pages of the same type (template) have the same performance, so Baudrier selects 3 to 5 sample pages (home, listing, form...) and measures on mobile first (that's what Google looks at).

3. **Measurement**: each page is loaded by Google's servers (15 to 30 seconds per page), after a "wake-up" of the site so we don't measure a false cold start.

4. **Report**: a clear table per page (scores out of 100, display time, visual stability), with a concrete explanation of each problem and the distinction between a real problem and measurement noise.

5. **Proposed fixes**: sorted by estimated gain. You decide which ones to apply; risky or design changes stay in your hands.

6. **Re-check**: after the fixes are deployed, a new measurement shows the before/after in figures.

## What it creates for you

- A performance report with figures per page (scores + Core Web Vitals)
- The validated fixes applied to the code
- A reusable PageSpeed Insights key in the Scaleway secrets vault (first time only)

## Prerequisites

- A **public** site (`/publish`): every app ships restricted to the office VPN by default, and Google cannot reach a restricted site
- A **deployed** site (the audit measures the live site)
- A free Google PageSpeed key (guided creation on first use)

## Good to know

- On a brand-new site, the measurements come from Google's "lab". With real traffic (a few weeks), the audit also shows the **field Core Web Vitals**: the speed actually experienced by your real visitors. So running `/seo-perf` again later brings new information.
- Core Web Vitals are a **confirmed Google ranking factor**: improving these figures helps your search visibility.

## Landing sites (site vitrine)

On a landing site (Astro), Baudrier picks representative pages from your `src/pages` folder instead of Next.js's `app/` router - usually the whole small page set, since a landing site rarely has more than a handful of pages. The measurement itself (PageSpeed Insights, the restricted-site check) works identically on both stacks.
