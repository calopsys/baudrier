---
name: eco-audit
description: "Eco-responsibility audit of a deployed Next.js site. Measures representative pages via the PageSpeed Insights API, computes the EcoIndex score (open French methodology, grade A to G) and the per-visit impact estimate (gCO2e, water), identifies waste (images, unused JS, cache, third-party scripts), then proposes fixes validated one by one. Re-measures after deployment to quantify the before/after. Reuses the PAGESPEED_API_KEY secret from this project's own Scaleway Secret Manager (same key as seo-perf)."
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# eco-audit: Eco-responsibility audit (EcoIndex + carbon impact)

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You audit the environmental footprint of the **deployed** site: page weight, EcoIndex score, estimated CO2e per visit, and you propose concrete fixes.

**The difference with `/seo-perf`**: seo-perf optimizes **perceived speed** (and the Google ranking); eco-audit optimizes **bytes and energy**. A site can be fast AND obese (thanks to caching and the CDN): that is precisely what this audit reveals, with a normalized score (EcoIndex) and a quantified impact that speed alone does not show.

⚠️ **Honest limitation of this skill in a sovereignty-first harness**: like `/seo-perf`, this audit measures via the **Google** PageSpeed Insights API - there is no French/EU equivalent with the same reach, and it needs Google's servers to actually load the site. Every app ships IP-restricted to the office VPN by default (`ACCESS_RESTRICTED=true`, CONTRACT.md §6), so **this cannot work until the user runs `/publish`**. Step 0 below detects that state up front and explains it in French - it never reports a spurious failure or a misleading score. A self-hosted Lighthouse (no Google dependency) is a documented future option, not built here - see the Technical notes at the end.

---

## Pedagogical rule (important)

The user is not a green IT expert. Explain each concept on its first occurrence:

- *"EcoIndex = the open French methodology (cited by the RGESN, the official eco-design framework) that grades a page from A to G based on 3 measurements: page complexity (DOM size), number of requests, and transferred KB."*
- *"gCO2e/visit = the estimate of greenhouse gases emitted when someone loads this page (network + servers + device). It is an estimate derived from the EcoIndex methodology, not an exact measurement: useful to compare before/after, not for an official carbon assessment."*
- Make the impact **meaningful**: convert it to the scale of traffic (e.g. *"at 1,000 visits/month, your home page emits ~2 kg CO2e/month, the equivalent of roughly 10 km by car"*, using ~200 g CO2e/km as an order of magnitude, presented as such).
- Never make the user feel guilty: the angle is "your site can be lighter, faster AND less polluting, here is how".

---

## Step 0: Preflight

**Garde vitrine** : invoke `_detect-project-root` first. If `PROJECT_TYPE=landing`, stop and tell the user, in their language (French shown): « Cette fonctionnalité n’est pas disponible pour un site vitrine : elle est réservée aux applications web. Votre site reste modifiable, et vous pouvez le déployer avec /deploy. »

1. **Deployed site**: the audit measures the site **online**. Retrieve the prod URL (`APP_URL` in `.env`, or a known custom domain) and verify it responds (`curl -s -o /dev/null -w "%{http_code}"`). If not deployed, explain and stop cleanly.

2. **Detect the VPN IP restriction** (must run before any PSI call): every app ships IP-restricted by default (`ACCESS_RESTRICTED=true`, CONTRACT.md §6) - Google's PageSpeed Insights servers cannot load the site at all in that state. Resolve the container to confirm the site is deployed, then read the live value from Secret Manager - a container GET only ever returns an argon2 hash, never plaintext (CONTRACT.md §1), so Secret Manager is the only readable source of truth:

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

   - `accessRestricted` is `"true"` or missing/unclear (treat conservatively as restricted) -> **STOP. Do not call PSI, do not report a score.** Explain in French:

     > 🔒 **PageSpeed Insights ne peut pas encore mesurer votre site**
     >
     > Par défaut, chaque application est protégée : seul le VPN de l'entreprise peut y accéder. Les serveurs de Google (PageSpeed Insights) ne peuvent donc pas du tout charger vos pages tant que cette protection est active - ce n'est pas une panne de ma part, c'est le comportement normal et volontaire de votre application. Lancer l'audit maintenant donnerait un score faux, pas une vraie mesure de votre impact écologique.
     >
     > Pour que cette analyse fonctionne, il faut d'abord rendre le site public avec `/publish`. Vous pourrez ensuite relancer `/eco-audit`.

     Stop cleanly.
   - `accessRestricted === "false"` -> continue.
   - Container lookup fails for an unrelated reason -> fall back to `.env`'s `ACCESS_RESTRICTED`, noting it may be stale.

3. **PageSpeed Insights key**: the same one as `/seo-perf` - secret `PAGESPEED_API_KEY` in this app's own Scaleway Secret Manager Project (CONTRACT.md §2). The key value is free and reusable: if the user already created one for another project, they can paste the same value here.
   ```bash
   SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
   node --input-type=module -e '
   import { pathToFileURL } from "node:url";
   const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
   try { console.log(JSON.stringify({ ok: true, key: await getSecret("PAGESPEED_API_KEY") })); }
   catch (e) { console.log(JSON.stringify({ ok: false, error: e.type || "error" })); }
   '
   ```
   - `ok: false`, `error: "not_found"`, first use: follow **the "Create the PageSpeed Insights key" appendix in the SKILL.md of the `seo-perf` skill** (same key, hardcoded instructions there), store it the same way (`putSecret("PAGESPEED_API_KEY", ...)`, see seo-perf Step 0c), then document it via `remember-global-key.mjs` (cf. seo-perf Step 0c).
   - **Never display the key value.**

---

## Step 1: Representative pages

Same rules as `/seo-perf` (Step 1): **3 to 5 URLs, one per distinct template** (home + listing/gallery + detail + form depending on what exists), default locale only if i18n, **mobile by default**. No need to audit every page: the same template has the same weight. Announce the selected URLs in one sentence.

---

## Step 2: Measurement

Run the bundled engine (warm-up included so as not to measure a cold start):

```bash
PSI_KEY=$(SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
  node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
  process.stdout.write(await getSecret("PAGESPEED_API_KEY"));
  ') \
  node "${CLAUDE_SKILL_DIR}/../../scripts/eco-audit.mjs" \
  --urls "<URL1>,<URL2>,<URL3>" --strategy mobile --warmup
```

The JSON returns, per page: `ecoIndex` (score 0-100, grade A-G, gesGrammes, waterCl), `metrics` (DOM, requests, KB), `waste` (estimated savings: imagesKb, unusedJsKb, unusedCssKb, cacheKb), `thirdParties` (top 5 third parties by weight), `heaviest` (top 5 resources), `resourceBreakdown` (weight by type).

Allow ~15-30 s per page. If a page fails (timeout/5xx), report it and continue with the others.

---

## Step 3: Report

Present a table per page with color coding (A-B 🟢, C-D 🟠, E-G 🔴):

> | Page | EcoIndex | CO2e/visit | Weight | Requests | DOM |
> |---|---|---|---|---|---|
> | Home | 🟠 D (51) | ~1.98 g | 6.3 MB | 30 | 668 |

Then, in this order:
1. **The quantified waste**, sorted by savable KB: images (the #1 item in 90% of cases), cache, unused JS, third parties. Cite the precise files from the `heaviest` top list (that is what makes the report actionable).
2. **The meaningful scaling**: estimated monthly impact at the site's real or plausible traffic.
3. State once that CO2e/water are **methodological estimates** (comparable to one another, not a carbon assessment).

---

## Step 4: Proposed fixes (bounded, validated)

Based on `waste` + `heaviest` + code inspection, propose patches sorted by KB saved. **Present first, apply after validation.**

### Whitelist (auto-fixable without risk)

| Finding | Next.js patch |
|---|---|
| Heavy images / wrong format (`waste.imagesKb`) | Convert the sources to WebP/AVIF (one-off `sharp` script), check `next/image` everywhere (it serves AVIF/WebP automatically), adjust `sizes`/`quality` (75-80 is almost always enough), `priority` only on the LCP image. ⚠️ Common pitfall: images in CSS `background-image` or raw `<img>` tags escape next/image. |
| Weak caching (`waste.cacheKb`) | Long cache headers on static assets (`next.config`), immutable for fingerprinted assets. |
| Unused JS (`waste.unusedJsKb`) | `next/dynamic` for heavy non-critical components (maps, players, editors), check for imports of entire libraries (`import { x } from "lib"` vs sub-path). |
| Heavy fonts (`resourceBreakdown`) | `next/font` with `subsets`, limit the loaded weights, consider a variable or system font. |
| Auto-loaded videos/GIFs | Clickable facade (poster + load on click), `preload="none"`. |

### Red list (propose, do not impose)

- **Third-party scripts** (`thirdParties`): name them with their weight, propose lighter alternatives (YouTube facade, more frugal analytics), but it is a product choice.
- **Dark mode**: propose `/add-dark-mode` (real savings on OLED screens), a design decision.
- **Infinite animations, carousels, frequent polling**: flag their CPU/network cost, leave the call to the user.
- **DOM reduction** (architectural): flag if > 1,500 elements, without a unilateral refactor.

### Rules

1. Verify after applying: `pnpm tsc --noEmit && pnpm lint` (never `pnpm build`).
2. **A single pass** of fixes, then a single re-measurement. No loop chasing grade A at all costs.
3. Never visibly degrade the visual quality without the user's explicit agreement (show a before/after if a compression is aggressive).

---

## Step 5: Re-measurement (critical sequencing)

⚠️ The audit measures the site **online**: local fixes only appear after deployment.

1. Fixes applied and validated.
2. Propose the deployment (`/deploy`). **Never push without explicit agreement.**
3. Once live: re-run Step 2 on the same URLs.
4. Show the before/after: *"Home: EcoIndex D (51) → B (74), 6.3 MB → 1.2 MB, ~2 g → ~1.5 g CO2e/visit."*

If the user does not deploy now: that is fine, the patches are ready, re-measure at the next deployment (re-runnable with `/eco-audit`).

---

## Step 6: Summary

- Final table (before/after if a pass took place).
- What was fixed, what remains a "product choice" (red list), and the estimated impact at the scale of traffic.
- Synergies: `/seo-perf` (speed), `/clean` (dead code), `/add-dark-mode` (OLED). A lighter site is also faster: the two audits reinforce each other.

---

## Technical notes

- **Engine**: `scripts/eco-audit.mjs` (bundled, no dependencies, tested in real conditions on Lighthouse 13.3). Handles the Lighthouse 13+ audit names (insights) with a legacy fallback, retry, warm-up, cap of 8 URLs.
- **EcoIndex**: official quantiles and formulas (open cnumr methodology); impact: `ges = 2 + 2×(50-score)/100` gCO2e, `eau = 3 + 3×(50-score)/100` cl, per visit.
- **PSI quota**: shared with seo-perf (25,000/day), no risk in normal usage.
- **Google dependency (honest limitation)**: like `/seo-perf`, this skill calls the Google PageSpeed Insights API - there is no French/EU equivalent with the same reach. A **self-hosted Lighthouse** (running `lighthouse`/`chrome-launcher` inside a Scaleway Serverless Job) would remove this dependency entirely and is a documented **future option**, not built here.
