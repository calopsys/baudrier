---
name: rgpd-audit
description: Audit a Next.js project's RGPD compliance. Scans the code, env vars, and dependencies to detect every third-party data processor (subprocessor) actually used, compares it with the project's privacy policy registry (`src/lib/subprocessors.json`), and reports gaps. Offers to fix the registry, generate the privacy policy page if missing, and link it from the mentions légales. Use when bootstrap was done before the registry-driven privacy policy existed, when refactoring an existing site for RGPD compliance, or to verify nothing has drifted between the code and the legal documentation.
allowed-tools: Bash Read Edit Write Glob Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, gh, and scw."
---

# /rgpd-audit - Project RGPD audit

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You will audit the project's RGPD compliance: detecting the third-party subprocessors actually used, comparing them with the registry, generating/synchronizing the privacy policy page, and linking it from the legal notices.

Announce each major block clearly.

---

## Step 0 - Preflight

Verify that you are at the root of a Next.js project:

```bash
test -f package.json || test -f apps/web/package.json && echo OK || echo "Not a Next.js project"
```

If the output is not `OK`, tell the user that `/rgpd-audit` must be run from the root of a project and stop.

## Step 1 - Run the audit

Run the bundled script:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rgpd-audit.mjs"
```

The script returns a JSON object with:
- `webRoot` - root of the code (apps/web for monorepos, root otherwise)
- `registryPath` - path of the registry `src/lib/subprocessors.json`
- `registryExists` - boolean
- `policyPagePath` - path of the policy page if found, otherwise `null`
- `mentionsLegalesPath` - path of the legal notices page if found
- `registryKeys` - keys present in the registry
- `detectedKeys` - keys detected in the code that belong in the registry (hosting, database, storage, email, analytics - see below)
- `detected` - object `{ key: true }` for each detected subprocessor
- `evidence` - for each detected key, the evidence (package, env var, or source pattern)
- `missing` - keys detected BUT absent from the registry (to add)
- `stale` - keys present in the registry BUT no longer detected (to remove or justify). Never includes a key whose registry entry carries `"manual": true` (see the note on manual entries below) - the script excludes those before computing `stale`.
- `otherThirdParties` - third parties involved in building/operating the project that do **not** belong in the privacy policy registry because they never touch a visitor's personal data (`github` = source hosting + CI, in the deploy path per CONTRACT.md §5; `google` = PageSpeed Insights / Search Console, used by `/seo-perf` and `/gsc`, reads public page data and the operator's own search analytics; `push` = Web Push/VAPID wiring, delivery goes through the visitor's own browser vendor - Mozilla/Google/Apple - not a service this app contracts with; `indexnow` = a no-PII ping telling search engines a page changed). Informational only - never compare these against the registry or report them as "missing".
- `otherEvidence` - evidence for each `otherThirdParties` entry
- `undeclaredHosts` - every external `https://` hostname found in source that isn't already explained by `detected`, `otherThirdParties`, or a small known-EU/self allowlist. Purely informational: never auto-added to the registry (no legal metadata to attach automatically) and never treated as a compliance failure - some false positives are expected (a legal reference link, an XML namespace). Just flag the list to the user so a human can look.
- `sovereignty` - `{ declaredSubprocessors, euOrFrenchResident, nonEuResident, summary }`, computed from the registry's own `isEUResident` field. This is the actual selling point of this stack (hosting/database/storage/email are always Scaleway, France, région fr-par) - report the real number, never round up or assert "100% French" without checking it here first.

**Note on `detectedKeys`**: since the last update this can also include `scaleway-generative` (Scaleway Generative APIs - LLM/embeddings client referenced in source). Treat it exactly like any other detected key in the diff below.

**Note on manual registry entries**: an entry can carry `"manual": true` (currently only `openfreemap`, see `skills/add-map/SKILL.md`) when the subprocessor has no dependency, no env var, and no source string the script could grep for. The script itself already keeps such an entry out of `stale` - you will simply never see it there. Do not add your own logic to second-guess this; if a manual entry ever needs to be removed, that is a deliberate hand edit to `src/lib/subprocessors.json`, never something `/rgpd-audit` proposes.

Capture the output. You will reason about it in the following Steps.

## Step 2 - Present the report to the user

Present the diagnosis clearly. Format:

> ## 🔍 RGPD audit
>
> **Subprocessors detected in the code (X):**
> - `<key>` - <evidence>
> - …
>
> **State of the `subprocessors.json` registry:**
> - ✅ Present: <count> entries
> - ❌ Absent (never initialized)
>
> **Privacy policy page:**
> - ✅ Found: `<path>`
> - ❌ Missing
>
> **Registry vs code diff:**
> - ❌ Missing from the registry: `<missing keys>` (to add)
> - ⚠️ Stale in the registry: `<stale keys>` (to remove if truly no longer used)
> - ✅ Everything is aligned (if missing.length === 0 && stale.length === 0)
>
> **Souveraineté des données :** `<sovereignty.summary>` - the plain-language selling point of this stack: hosting, base de données, stockage et email sont hébergés en France (Scaleway, région Paris/fr-par). Present it as a genuine strength, but only using the real count the script computed - never claim "100% français" if `nonEuResident > 0` (Matomo Cloud, when used, is Nouvelle-Zélande with an EU adequacy decision - accurate, not "French").
>
> **Autres tiers impliqués (hors politique de confidentialité) :** if `otherThirdParties` is non-empty, list them separately from the subprocessors above, and make clear they are **not** a compliance gap - they don't process visitor data:
> - `github` → hébergement du code source et intégration continue (déploiement) - jamais de donnée visiteur
> - `google` → outils d'audit SEO (PageSpeed Insights / Search Console) - données publiques du site, pas de donnée personnelle des visiteurs
> - `push` → notifications Web Push (VAPID) - la livraison passe par le service du navigateur du visiteur (Mozilla / Google / Apple), pas par un prestataire choisi par ce projet
> - `indexnow` → signal envoyé aux moteurs de recherche qu'une page a changé - aucune donnée personnelle
>
> **Tiers potentiels non déclarés (informationnel) :** if `undeclaredHosts` is non-empty, list the hostnames and make clear this is **not** an automatic finding of wrongdoing - just a nudge to double-check each one (some are expected false positives, e.g. a legal reference link).

## Step 3 - Propose actions

Ask the user which actions to run, as a menu:

> Would you like to:
> 1. **Synchronize the registry** (add `missing`, remove `stale`)
> 2. **Generate / refresh the page** of the privacy policy
> 3. **Update the legal notices** to point to the privacy policy
> 4. **Do everything** (1 + 2 + 3)
> 5. **Exit** without changing anything

## Step 4 - Synchronize the registry (if requested)

For each key in `missing`, call the `_update-privacy-policy` helper:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add <key>
```

You can pass several `--add` in a single call.

For each key in `stale`, ask the user **before** removing:
> The subprocessor `matomo` is in the registry but no longer detected in the code. Remove it? (y/N)

If yes:
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --remove <key>
```

**Never offer removal for a manual entry.** `stale` already excludes any registry entry with `"manual": true` (the script filters it before returning), so a manual key never appears in this loop in the first place - do not add your own check on top, and never propose `--remove` for one even if a user asks "why isn't `openfreemap` flagged" - explain instead that it's marked manual because nothing in the code can grep-detect it (no dependency, no env var, no source string), so absence-from-detection is expected and not a signal it's unused.

If the detected key is not in the helper's catalog (rare - it would mean we invented a new subprocessor), the helper rejects with an error. In that case, alert the user - the catalog must be extended in `scripts/update-privacy-policy.mjs` on the plugin side.

## Step 5 - Generate or refresh the policy page (if requested)

### Case A: `policyPagePath === null` (no page)

Create the page from `${CLAUDE_SKILL_DIR}/../../templates/privacy-policy/plain.tsx` - the only template (this product is French-only, no i18n, per CONTRACT.md §1; there is no locale-aware variant to choose between).

Substitute in the template:
- `{{PROJECT_NAME}}` (read the web-root's `package.json`)
- `{{LAST_UPDATED}}` (today's date, format `YYYY-MM-DD`)

Page location: `src/app/politique-de-confidentialite/page.tsx`.

Create the folder then write the file. Verify that the page does import `~/lib/subprocessors`. If the `~/` alias is not configured in the project (rare), replace it with the appropriate relative path.

### Case B: `policyPagePath !== null` (the page already exists)

Ask the user:
> A privacy policy page already exists at `<path>`. You can:
> 1. **Keep it as is** - the registry is updated but the page is not modified
> 2. **Replace it** with the data-driven template (the current page will be overwritten - useful if the existing page is outdated, hand-written, or out of sync)

If the user chooses 2, make a backup first:
```bash
cp <policyPagePath> <policyPagePath>.backup
```
Then regenerate from the template.

## Step 6 - Update the legal notices (if requested)

If `mentionsLegalesPath !== null`, open the page and verify that it contains a link to `/politique-de-confidentialite`. Otherwise, add a mention in the "Données personnelles et RGPD" section (or create it if absent):

```tsx
<p>
  Pour le détail complet du traitement de vos données et la liste de nos sous-traitants,
  consultez notre <Link href="/politique-de-confidentialite">politique de confidentialité</Link>.
</p>
```

If the user has a very detailed hand-written policy (the Baudrier case), do **not** touch it in this skill - that is a separate refactor. Mention it in the summary.

## Step 7 - Check UTF-8 (sanity check)

If you touched one or more `.tsx` files, do the global UTF-8 self-check:

```bash
node -e "
  const fs = require('node:fs');
  for (const f of process.argv.slice(1)) {
    const c = fs.readFileSync(f, 'utf8');
    const m = c.match(/\\\\u[0-9a-fA-F]{4}/g);
    if (m) { console.log(f, ':', m.length, 'escapes'); process.exit(1); }
  }
  console.log('UTF-8 OK');
" <files-touched>
```

If Unicode escapes are reported, fix them with the quick recovery script documented in the global CLAUDE.md (section "Règle prioritaire UTF-8").

## Step 8 - Re-run the audit to verify

Re-run the script:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/rgpd-audit.mjs" --pretty
```

Present the output to the user. Everything should be ✅ aligned.

## Step 9 - Final summary

Present a short recap:

> ## ✅ RGPD audit complete
>
> - Registry: <count> documented subprocessors
> - Policy page: `<path>` (created / refreshed / unchanged depending on the case)
> - Legal notices: (updated to point to the policy / already up to date)
>
> **To do manually**:
> - Replace `contact@example.com` in the page with your real contact address
> - Check the legal content of sections 5 (rights) and 6 (cookies) - the template provides standard wording, but your case may require adjustments (minors vs adults, health data, etc.)
> - If you added an unusual subprocessor not covered by the catalog, extend `scripts/update-privacy-policy.mjs` on the Baudrier plugin side

---

## Notes on special cases

- **Project with the minimum stack**: `scaleway` (hosting) is always detected - it's the only hosting option in this harness (CONTRACT.md §1). That is OK, and the page must still exist to comply with the LCEN even with a single declared subprocessor.
- **False positive detected**: if the script reports a subprocessor that is not actually used (for example, `@aws-sdk/client-s3` installed but Object Storage never actually wired up), inform the user - they can remove the unused dependency, or you can extract the key from the registry via `--remove`.
- **Out-of-catalog subprocessor**: the `_update-privacy-policy` helper rejects unknown keys. This is intentional, to avoid inventing legal data. If a project uses a service outside the current catalog (a custom tool an agent calls, a niche integration), extend the catalog in the plugin's `scripts/update-privacy-policy.mjs` with the correct legal info (legal name, registered office address, legal basis, hosting location, mechanism for transfers outside the EU where applicable).
- **`otherThirdParties` is not a compliance gap**: never propose adding `github` or `google` to the registry via `_update-privacy-policy` - they have no catalog entry on purpose (see the script's header comment). If a user insists their audit tooling (PageSpeed, GSC) does process personal data in their specific case, that's a judgment call for them, not something this skill should silently "fix" by inventing a catalog key.
