---
name: blogpost
description: Write one French blog article from a chat description, on a site vitrine that already has /add-blog installed. Always previews first on the revue branch, shows the full text for approval, and only publishes to production after an explicit verdict. Create-only - modifying or deleting a published article is an ordinary chat edit + /deploy. Use when the user wants to write, publish, or post a new blog article.
argument-hint: "[sujet de l’article]"
allowed-tools: Bash Read Write Edit AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js and Docker; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Blogpost - write and publish one article

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: French for this product's user base). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You write one blog article from the user's description, in French, and walk it through a mandatory preview before it ever reaches production. This skill is **create-only**: it never edits or deletes an existing article. Modifying or removing a published post is an ordinary chat request ("change this paragraph", "remove this article") followed by `/deploy` - not a skill operation, since a published article is just a file in the repo like any other page.

---

## Step 0 - Preflight

Invoke `_detect-project-root` to get `PROJECT_NAME`, `WEB_DIR`, `PROJECT_TYPE`.

- **`PROJECT_TYPE=application`** -> stop and tell the user, in their language (French shown): « Cette fonctionnalité n’est pas disponible pour une application : elle est réservée aux sites vitrines. Votre application reste entièrement modifiable en discutant avec moi, et vous pouvez la déployer avec /deploy. »
- **`PROJECT_TYPE=unknown`** -> `_detect-project-root` has already reported why and returned an error state; abort here, the same way `/deploy`'s own Step 2 does.
- **`PROJECT_TYPE=landing`** -> continue to Step 1.

---

## Step 1 - Blog installed?

```bash
test -f "<WEB_DIR>/src/content.config.ts" && echo "present" || echo "absent"
```

If `absent`, tell the user no blog is installed yet on this site, and offer to run `/add-blog` first. If they accept, read and execute `skills/add-blog/SKILL.md` now, then resume here once it finishes. If `present`, continue to Step 2.

---

## Step 2 - Repo state check

Two things to check before touching anything, both reported to the user in plain French before continuing:

### 2a - Uncommitted changes outside the blog

```bash
git status --porcelain
```

`/deploy` commits **everything** uncommitted, not just the article. If files outside `<WEB_DIR>/src/content/blog/` show up here, tell the user plainly what else would ride along with this publication (e.g. « J’ai remarqué des changements non enregistrés dans d’autres fichiers du site - ils partiront avec l’article au moment du déploiement. ») and ask if that is fine, unless it is obviously nothing (e.g. only lockfile churn).

### 2b - An article already waiting on `revue`

```bash
git fetch origin
git log main..revue --oneline 2>/dev/null
```

A non-empty result means a previous article (or other work) already sits on `revue`, unpublished. Tell the user, and ask whether to:
- continue and add this new article to the same pending branch (it will preview and publish together with the earlier work), or
- leave it as is and stop here (they can come back to it, or use `/deploy` themselves once ready).

If the branch does not exist yet (`git log` above finds nothing because `revue` has no upstream), there is nothing pending - continue silently.

---

## Step 3 - Gather the article

Ask (or use what the user already gave in their `/blogpost` argument):
- **Subject**: what the article is about, in the user's own words.
- **Tags**: suggest 2 to 4 relevant tags based on the subject and the site's own topic (read `CLAUDE.md`'s description for context); let the user adjust.
- **Cover image** (optional): only if the user has one to provide - a local file path or something to describe. No image means no image; never invent a placeholder photo (CONTRACT.md decision: user-provided only).

---

## Step 4 - Switch to `revue` before writing

Never write the article file on `main`. Switch onto the stable `revue` branch first, reusing `deploy`'s own branch snippet:

```bash
git fetch origin
if git rev-parse --verify revue >/dev/null 2>&1; then
  git checkout revue
elif git rev-parse --verify origin/revue >/dev/null 2>&1; then
  git checkout -b revue origin/revue
else
  git checkout -b revue
fi
```

If the checkout itself fails (an uncommitted change conflicts with `revue`'s own history), stop and ask the user to commit or stash it first - never discard anything.

---

## Step 5 - Write the article

### 5a - Slug

Derive the slug from the subject: lowercase, accents stripped, spaces and punctuation replaced with a single hyphen (kebab-case), no leading/trailing hyphen. Example: « Nos nouveaux horaires d’été » -> `nos-nouveaux-horaires-d-ete`.

**The slug is stable forever.** It becomes the article's URL (`/blog/<slug>/`) and, once published, the file must never be renamed - a renamed slug 404s the old URL and loses whatever indexing it had (the same rule `/gsc`/`/seo` apply to any page). Check the slug does not already exist under `<WEB_DIR>/src/content/blog/` before writing; if it does, adjust it slightly rather than overwrite.

This collision check applies only to the **first** creation of the article within this run. If Step 9's "Modifier encore" verdict brings the flow back here, re-enter directly at 5b and edit the same file this run already created - never derive a new slug for a revision, or the earlier draft and the revised one would both exist and both publish.

### 5b - Write `<WEB_DIR>/src/content/blog/<slug>.md`

Frontmatter (matches `templates/blog/src/content.config.ts`'s schema exactly - no `draft:` field, the `revue` branch is itself the draft state):

```yaml
---
title: "<title>"
description: "<one or two sentences, for meta description and RSS>"
pubDate: <today's date, YYYY-MM-DD>
tags: [<tag1>, <tag2>]
cover: "<relative path under src/assets/blog/, only if provided>"
coverAlt: "<required alt text if cover is set>"
---
```

Body: French prose, 600 to 1200 words, structured with `##`/`###` headings (H2/H3) so the article scans well and gives search engines and AI answer engines clear chunks to cite. Write for the site's own audience and tone (read a couple of existing pages or `CLAUDE.md` for voice). Typographic apostrophe `’` throughout, no em dashes.

If a cover was provided, copy it into `<WEB_DIR>/src/assets/blog/` and reference it in the frontmatter's `cover:` field as `../../assets/blog/<fichier>` - relative from `src/content/blog/<slug>.md`, per the schema's `image()` helper.

---

## Step 6 - Approval loop [MANDATORY, NEVER SKIP]

🚨 **Show the full article text in chat and wait for explicit approval before anything else happens** - no preview deploy, no commit beyond what Step 5 already wrote locally, until the user has read the whole thing. Present title, tags, and the complete body as the user will read it.

If the user asks for changes, edit the file and show the full text again. Repeat until the user approves as-is. Only then continue to Step 7.

---

## Step 7 - Build gate, before paying for a Docker build

```bash
cd "<WEB_DIR>"
pnpm check && pnpm build
```

A preview deploy rebuilds the whole container image, which costs several minutes - catch a broken frontmatter field or a markdown error here first, for free. Fix and re-run before continuing.

---

## Step 8 - Preview deploy

Before deploying, always tell the user - a preview container is restricted by construction, whatever state production is in (`/deploy` overrides `ACCESS_RESTRICTED` to `"true"` on every preview deploy, never reading or depending on production's own value, CONTRACT.md §1): la prévisualisation n’est joignable que depuis une adresse déjà autorisée (le VPN de l’entreprise, par défaut) - c’est systématique pour tout aperçu, quel que soit l’état du site en production.

Also add the cost note here, since entering `/deploy` directly at Step 2 (below) skips its own Step 1, where this note would normally come from: ce premier déploiement crée un seul conteneur, réglé pour redescendre à zéro instance entre deux visites - l’aperçu ne coûte donc quasiment rien tant qu’il n’est pas consulté.

Read and execute `skills/deploy/SKILL.md`, entering directly at its **Step 2**, with **target preview**, **skipping its Step 0 and Step 1**. This is the documented exception for `/blogpost`'s two deploys (see `deploy`'s own Step 0): this skill's approval flow already collected the user's consent for both the preview and, later, the production deploy, so there is no need to ask again. The branch is already `revue` (Step 4), so deploy's own Step 2 preview path finds nothing left to switch.

Once the deploy succeeds, hand the user the exact article URL: `<preview-url>/blog/<slug>/`.

---

## Step 9 - Verdict

Ask with `AskUserQuestion`:
- Question: "Que voulez-vous faire de cet article ?"
- Options:
  - `Publier` - l’article part en production, visible par tous vos visiteurs.
  - `Modifier encore` - je reprends l’écriture avec vos retours.
  - `Le laisser en attente` - l’article reste sur la branche de révision, personne d’autre ne le voit pour l’instant.

- **`Publier`** -> continue to Step 10.
- **`Modifier encore`** -> ask what to change, then repeat from Step 5b (edit the same file in place, same slug - see 5a's scoping note) through Step 8 (preview).
- **`Le laisser en attente`** -> stop here. Tell the user the article stays on `revue` - it is the draft state, nothing is lost, and they can resume with `/blogpost` any time, or ask for it to be published later.

---

## Step 10 - Publish

Read and execute `skills/deploy/SKILL.md`, entering directly at its **Step 2**, with **target production**, **skipping its Step 0 and Step 1** (same documented exception as Step 8 - the verdict in Step 9 already is the explicit consent for this deploy). The current branch is `revue`, not `main`, so deploy's own Step 2 merge-into-`main` path applies exactly as written there: it merges `revue` into `main` first, then deploys production from `main`. This is the existing merge path, not a new one.

---

## Step 11 - IndexNow ping

Ping IndexNow only when **all three** conditions hold:
1. the production deploy in Step 10 succeeded;
2. production's own `ACCESS_RESTRICTED` value is `"false"` - read it fresh here, together with `APP_URL` (the production host, needed for the POST below), the same inline pattern `/deploy`'s own Step 1 uses (Secret Manager is the only readable source of truth for either - CONTRACT.md §1):

```bash
SECRETS_MJS="${CLAUDE_SKILL_DIR}/../../scripts/scaleway/secrets.mjs" \
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { getSecret } = await import(pathToFileURL(process.env.SECRETS_MJS).href);
try {
  const accessRestricted = await getSecret("ACCESS_RESTRICTED");
  const appUrl = await getSecret("APP_URL");
  console.log(JSON.stringify({ ok: true, accessRestricted, appUrl }));
} catch (e) {
  console.log(JSON.stringify({ ok: true, accessRestricted: e.type === "not_found" ? "true" : null, appUrl: null }));
}
'
```

3. a proof key exists: `ls "<WEB_DIR>/public" | grep -E '^[0-9a-f]{64}\.txt$'`.

If condition 2 fails (site restricted), **skip the ping** and tell the user why in plain French: les moteurs qui suivent IndexNow ne peuvent pas récupérer un site qui répond 403 - le signal serait rejeté, donc Baudrier ne l’envoie pas tant que le site n’est pas public.

If condition 3 fails (no key), skip silently - `/add-blog` was not run to completion, or the key was never generated; nothing to do here.

Otherwise, derive the host from the `appUrl` read above (the origin without the `https://` scheme) - never from `<WEB_DIR>/astro.config.mjs`'s `site:`, which can lag behind production after `/add-domain` runs later without a matching `/blogpost` re-run. Take the key from the proof file's own **name**, not its content: `KEY="${KEY_FILE%.txt}"` where `KEY_FILE` is the match from condition 3 - the file's content carries a trailing newline (`add-blog`'s `printf "%s\n"`) that would corrupt the JSON body if read directly. Then POST:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"host\":\"<host>\",\"key\":\"<key>\",\"keyLocation\":\"https://<host>/<key>.txt\",\"urlList\":[\"https://<host>/blog/<slug>/\",\"https://<host>/blog/\",\"https://<host>/\"]}"
```

`urlList` covers the new article, the blog listing (its content changed too), and the homepage (in case it links the latest post). A response other than 200/202 is a **soft warning only** - mention it to the user in passing, never treat it as a publication failure; the article is already live regardless of what IndexNow does with the ping.

---

## Step 12 - Summary

Tell the user, in French:
> ✅ Article publié : <live-url>/blog/<slug>/
>
> Le flux RSS et le sitemap se mettent à jour automatiquement, rien à faire de votre côté.
>
> Pour changer ou retirer cet article plus tard, dites-le-moi simplement en discussion, puis je déploierai avec `/deploy` - `/blogpost` sert uniquement à créer de nouveaux articles.

If both a preview and a production deploy ran in this conversation, add the cost note once: chaque déploiement prend quelques minutes ; l’aperçu (`revue`) ne coûte quasiment rien tant qu’il n’est pas visité, puisqu’il reste à zéro instance entre deux consultations.
