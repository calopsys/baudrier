---
name: add-blog
description: Install a blog once on an existing vitrine (Astro content collections) - RSS, sitemap, JSON-LD BlogPosting, tags, canonical URLs, prev/next links, IndexNow. Landing sites only. Use when the user wants a blog or news section on their site vitrine.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Blog - Astro content collections for a site vitrine

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You install a blog on the current site vitrine, once: an Astro content collection under `src/content/blog/`, a listing page, an article page, RSS, sitemap, and everything helping SEO/GEO (JSON-LD `BlogPosting`, `og:type article`, canonical URLs, tags, prev/next). After this skill, `/blogpost` writes and publishes articles. This skill only installs the machinery - it never writes an article itself.

---

## Step 0 - Preflight

Invoke `_detect-project-root` to get `PROJECT_NAME`, `WEB_DIR`, `PROJECT_TYPE`.

- **`PROJECT_TYPE=application`** -> stop and tell the user, in their language (French shown): « Cette fonctionnalité n’est pas disponible pour une application : elle est réservée aux sites vitrines. Votre application reste entièrement modifiable en discutant avec moi, et vous pouvez la déployer avec /deploy. »
- **`PROJECT_TYPE=unknown`** -> `_detect-project-root` has already reported why and returned an error state; abort here, the same way `/deploy`'s own Step 2 does.
- **`PROJECT_TYPE=landing`** -> continue to Step 1.

---

## Step 1 - Idempotence: is a blog already installed?

```bash
test -f "<WEB_DIR>/src/content.config.ts" && echo "present" || echo "absent"
```

### If `present`

The blog is already installed. Show a menu:

> ## 📰 Un blog est déjà installé sur ce site
>
> Que voulez-vous faire ?
>
> 1. **Écrire un premier article** - je lance `/blogpost` tout de suite
> 2. **Réparer l’installation** - je revérifie chaque pièce (dépendances, `site:`, ancres du gabarit, clé IndexNow) et je corrige ce qui manque, sans rien dupliquer
> 3. **Rien, juste vérifier** - je confirme que tout est en ordre et je m’arrête là

Wait for the answer.
- Choice 1 -> read and execute `skills/blogpost/SKILL.md` now.
- Choice 2 -> run Steps 2 through 11 below; from Step 3 onward each one is already written to detect its own prior state and skip or fix rather than duplicate, and Step 11 commits whatever this pass actually changed.
- Choice 3 -> read-only, no writes, no commit. Run each of these probes and report what is in place versus missing, then stop:
  - Step 2's dependencies: `pnpm list @astrojs/rss @astrojs/sitemap sharp` (or read `package.json`) instead of running `pnpm add`.
  - Step 3a/3b's own checks: `grep -n "site:"` and `grep -q "@astrojs/sitemap"` against `astro.config.mjs`.
  - Step 4's five template files: confirm each exists under `<WEB_DIR>/src/` and that none still carries a `{{SITE_` placeholder, instead of copying anything.
  - Step 5's own `grep -q "ogType"` against `BaseLayout.astro`.
  - Step 6: whether a "Blog" link already exists in the nav component.
  - Step 7's own `test -f` for `public/llms.txt`, and whether it already has a `/blog` line.
  - Step 8a's own proof-key `ls`/`grep`.
  - Step 9: whether the `CLAUDE.md` sections it writes are already present.
  - Never run Step 2's `pnpm add`, Step 4's file copy, Step 10's build, or Step 11's commit.

### If `absent`

Continue normally to Step 2. This is the initial installation flow.

---

## Step 2 - Install the dependencies

```bash
cd "<WEB_DIR>"
pnpm add @astrojs/rss @astrojs/sitemap sharp
```

`sharp` is `astro:assets`'s image processor (cover images, Step 4); its build script is pre-allowed by `pnpm-workspace.yaml`'s `allowBuilds`.

---

## Step 3 - Ensure `site:` and the sitemap integration

RSS cannot build without an absolute `site:` in `astro.config.mjs` (`@astrojs/rss` needs it to resolve every item link), so this step is mandatory, not optional. The `@astrojs/sitemap` integration (3b) is a separate, always-run check - a project that already has `site:` set (any vitrine on which `/seo` or `/add-domain` already ran) still needs the integration added, so 3b never lives inside the branch that derives `site:`.

### 3a - Read the current value, deriving it if missing

```bash
grep -n "site:" "<WEB_DIR>/astro.config.mjs" || echo "no site: key"
```

If a real `https://` value is already set, skip to 3b. Otherwise, derive it the same way `/seo` does for a landing: read `APP_URL` from Secret Manager, the same inline pattern `/deploy` uses for `ACCESS_RESTRICTED` (a plain URL is not sensitive, and Secret Manager is the only readable source of truth for it - CONTRACT.md §1):

```bash
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
try {
  const appUrl = await getSecret("APP_URL");
  console.log(JSON.stringify({ ok: true, appUrl }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.type ?? String(e) }));
}
'
```

If this fails or returns nothing usable (project not deployed yet, credentials unavailable), **ask the user directly** for the site's public URL - RSS, the sitemap, canonical tags and JSON-LD all need an absolute origin, and there is no other way to get one. Accept a custom domain if the user already has one in mind, even before it is wired up with `/add-domain`; the value can be corrected later by re-running this step.

Set `site:` in `astro.config.mjs` to that value:

```js
export default defineConfig({
  site: "<the resolved URL>",
  output: "static",
  // ...
});
```

### 3b - Ensure the `@astrojs/sitemap` integration

Always run this check, whether `site:` was already set or was just derived above:

```bash
grep -q "@astrojs/sitemap" "<WEB_DIR>/astro.config.mjs" && echo "already wired" || echo "not wired"
```

If `already wired`, skip. Otherwise, add the integration:

```js
import sitemap from "@astrojs/sitemap";
// ...
export default defineConfig({
  // ...
  integrations: [sitemap()],
  // ...
});
```

Preserve any existing `integrations` entries and any existing Vite config; add to the array, do not replace it.

### 3c - Note the preview caveat once

`site:` always points at production. Tell the user, once, in plain French, before Step 4 finishes: la prévisualisation d’un article (`/blogpost`) affichera donc des adresses de production dans le flux RSS et les balises canoniques même sur l’aperçu - c’est normal, seule l’adresse affichée dans la barre du navigateur change.

---

## Step 4 - Copy the blog template

```bash
PLUGIN_ROOT="${CLAUDE_SKILL_DIR}/../.."
mkdir -p "<WEB_DIR>/src/content/blog" "<WEB_DIR>/src/pages/blog" "<WEB_DIR>/src/components" "<WEB_DIR>/src/assets/blog"
cp "$PLUGIN_ROOT/templates/blog/src/content.config.ts" "<WEB_DIR>/src/content.config.ts"
cp "$PLUGIN_ROOT/templates/blog/src/content/blog/.gitkeep" "<WEB_DIR>/src/content/blog/.gitkeep"
cp "$PLUGIN_ROOT/templates/blog/src/pages/blog/index.astro" "<WEB_DIR>/src/pages/blog/index.astro"
cp "$PLUGIN_ROOT/templates/blog/src/pages/blog/[slug].astro" "<WEB_DIR>/src/pages/blog/[slug].astro"
cp "$PLUGIN_ROOT/templates/blog/src/pages/rss.xml.ts" "<WEB_DIR>/src/pages/rss.xml.ts"
cp "$PLUGIN_ROOT/templates/blog/src/components/PostCard.astro" "<WEB_DIR>/src/components/PostCard.astro"
```

Skip a file whose destination already exists and was already customized (repair mode, Step 1 choice 2) - diff it first and only overwrite if it is still the untouched template.

### Fill the placeholders

`src/pages/rss.xml.ts`, `src/pages/blog/[slug].astro`, and `src/pages/blog/index.astro` carry `{{SITE_TITLE}}` / `{{SITE_DESCRIPTION}}`. Derive real values from the generated project's own `CLAUDE.md`: the `# ` heading at the top is the project name (`SITE_TITLE`), and the paragraph on the line right after it is the description (`SITE_DESCRIPTION`). Never derive either value from a page's own `title=`/`description=` props - a page title carries a suffix (e.g. « · Accueil »), and if this skill were ever invoked before the real pages are composed, the homepage would still hold the scaffold's neutral placeholder text (`CLAUDE.md`'s project name and description, by contrast, are already real from bootstrap's own Step 2 onward). If `CLAUDE.md` is missing, or its heading/description still read as generic placeholder text, ask the user directly for the site's name and a one-sentence description instead of guessing. Replace both placeholders in all three files.

### Sync content types

```bash
cd "<WEB_DIR>"
pnpm astro sync
```

This regenerates Astro's content-collection types from `content.config.ts` before the type-checking gate in Step 10.

---

## Step 5 - Extend `BaseLayout.astro`

Three anchored, idempotence-guarded edits to `<WEB_DIR>/src/layouts/BaseLayout.astro`. Check first whether they are already applied:

```bash
grep -q "ogType" "<WEB_DIR>/src/layouts/BaseLayout.astro" && echo "already extended" || echo "not extended"
```

If `already extended`, skip this step entirely (repair mode already has what it needs). Otherwise apply the three edits below, in order, using `Edit` with the exact old strings from the pinned template. **If any old string does not match** (the project's `BaseLayout.astro` diverged from the pinned template, e.g. after manual edits), do not force it: read the file, understand the current shape of the `Props` interface and the `<head>`, and adapt the same three changes by hand instead of failing the whole step.

### 5a - Add `ogType?`/`canonical?` props

Old:
```astro
export interface Props {
  title: string;
  description: string;
  ogImage?: string;
}

const { title, description, ogImage } = Astro.props;
```

New:
```astro
export interface Props {
  title: string;
  description: string;
  ogImage?: string;
  ogType?: string;
  canonical?: string;
}

const { title, description, ogImage, ogType = "website", canonical } = Astro.props;
```

### 5b - Make `og:type` use the prop

Old:
```astro
    <meta property="og:type" content="website" />
```

New:
```astro
    <meta property="og:type" content={ogType} />
```

### 5c - Insert canonical + RSS `<link>` lines after the twitter:card meta

Old:
```astro
    <meta name="twitter:card" content="summary_large_image" />
```

New:
```astro
    <meta name="twitter:card" content="summary_large_image" />
    {canonical && <link rel="canonical" href={canonical} />}
    <link rel="alternate" type="application/rss+xml" title="Flux RSS" href="/rss.xml" />
```

Every existing page keeps working unchanged (`ogType` defaults to `"website"`, `canonical` is optional) - only the blog's article page (already written to pass both props, see `templates/blog/src/pages/blog/[slug].astro`) uses the new behavior.

---

## Step 6 - Add a "Blog" nav link

Detect the site's header/nav component:

```bash
grep -rEl "nav|header" --include="*.astro" "<WEB_DIR>/src/components" 2>/dev/null
```

Read it and propose, in prose, where a "Blog" link fits among the existing nav items (never a blind patch - pages compose the header freely, and every vitrine's nav is hand-written to the business description). Ask for confirmation before editing, unless the user already asked for this in the same turn.

---

## Step 7 - `llms.txt` line, if the file exists

```bash
test -f "<WEB_DIR>/public/llms.txt" && echo "present" || echo "absent"
```

If `present`, add one line under its "Main pages" (or equivalent) section pointing at `/blog` - same format as the other entries `/geo` writes there. If `absent`, do nothing here; `/geo` is what creates that file, and it is not this skill's job to create it early.

---

## Step 8 - IndexNow proof key

Inline the same two key-generation commands `_setup-indexnow`'s own Step 1 uses (do not invoke that internal skill - its remaining steps target a Next.js pipeline this project does not have, and its `PUBLIC_DIR` detection is not needed here since `<WEB_DIR>/public` is already known).

### 8a - Idempotence

```bash
ls "<WEB_DIR>/public" 2>/dev/null | grep -E '^[0-9a-f]{64}\.txt$' || echo "no key yet"
```

If a matching file already exists, skip straight to Step 9 - a key, once published, must never be regenerated (the IndexNow ping in `/blogpost` reads this exact file).

### 8b - Generate and drop the key file

```bash
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
printf "%s\n" "$KEY" > "<WEB_DIR>/public/$KEY.txt"
```

Tell the user: cette clé prouve à IndexNow (Bing, Yandex, et les moteurs qui suivent ce protocole) que vous êtes propriétaire du site, quand `/blogpost` publie un article. Elle est publique par construction (le fichier est servi tel quel) - ce n’est pas un secret, et le fichier est commité avec le reste du projet.

---

## Step 9 - Update the project's own documentation

### 9a - `CLAUDE.md` via `_update-claude-md`

Invoke `_update-claude-md` with:
- `stack`: `- **Blog** : collection de contenu Astro (\`src/content/blog/\`), RSS (\`/rss.xml\`), sitemap, JSON-LD BlogPosting - installé par /add-blog, articles écrits par /blogpost`
- `conventions`:
  - `- Un article se crée avec /blogpost uniquement. Modifier ou supprimer un article déjà publié est une demande de discussion normale suivie de /deploy, pas une opération de skill.`
  - `- Le slug d’un article (le nom de fichier dans src/content/blog/) est stable pour toujours - ne jamais le renommer après publication, ça casserait l’URL indexée.`
- a custom section:
  - `heading`: `## Blog`
  - `body`: a short paragraph stating the blog lives under `src/content/blog/*.md`, has no `draft:` field (the `revue` branch is the draft state), and that `/blogpost` is create-only.

Do **not** pass an `env-vars` section - the vitrine's `CLAUDE.md` does not carry an "Environment Variables" heading at all (only « Variables d’environnement » as free-form prose), so `_update-claude-md`'s `env-vars` target would create a section this project's convention does not recognize.

### 9b - Direct edit: retire the "blog not installed yet" sentence

Read `CLAUDE.md`. Depending on when this project was bootstrapped, it may still carry one of two sentences left by scaffolding - remove whichever is present, the blog now exists, both read as stale:
- an older project: « Une extension blog est prévue pour une prochaine version - `src/content/` reste volontairement inutilisé pour l’instant. »
- a more recently bootstrapped project: the sentence opening with « Pas encore de blog sur ce site ». Match on this opening clause only, then remove the whole sentence it starts - `templates/landing/claude-md-core.md` hard-wraps the full sentence across two source lines, so the complete string is not a reliable match target.

### 9c - Direct edit: extend "Skills disponibles"

In the same section, check whether `/add-blog` and `/blogpost` already appear in the comma-separated list of skills that apply to this vitrine (a recently bootstrapped project already lists both). If either is missing, add it.

---

## Step 10 - Verify it builds

```bash
cd "<WEB_DIR>"
pnpm check && pnpm build
```

`pnpm check` runs Astro's own type check (content collection types included, thanks to Step 4's `astro sync`); `pnpm build` is what actually exercises the RSS endpoint and the sitemap integration. Fix any error and re-run before continuing - do not commit a broken build.

---

## Step 11 - Commit, no deploy

```bash
git add -A
git commit -m "feat: add blog (content collections, RSS, sitemap, JSON-LD)"
```

**Do not deploy.** A deploy is a separate, explicit decision (`/deploy`'s own Step 0), and this skill's job ends at "the blog exists in the repo and builds cleanly."

Tell the user, in French:
> ✅ Le blog est installé : page de liste, page d’article, flux RSS, sitemap, tout ce qui aide le référencement. Le blog est vide pour l’instant - la page `/blog` affichera « Aucun article pour l’instant. » jusqu’au premier article, et n’apparaîtra en ligne qu’au prochain déploiement.
>
> Voulez-vous que j’écrive un premier article maintenant avec `/blogpost` ?

If the user says yes, read and execute `skills/blogpost/SKILL.md` now.
