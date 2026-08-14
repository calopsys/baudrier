# /add-blog

Installs a **blog** on your site vitrine: an article list, an article page, an RSS feed, a sitemap entry, and everything that helps search engines and AI answer engines find and cite your posts. Run it once; `/blogpost` writes the articles afterward.

## When to use it

- You want a **news or blog section** on your site vitrine
- You want to publish content regularly and be found for it (SEO/GEO)
- You have not installed a blog on this project yet

## How it works

1. **Landing-only check**: this only applies to a site vitrine (Astro). On an application, Baudrier explains that the feature does not apply and points you to your usual chat-and-deploy workflow instead.

2. **Already installed?**: if a blog is already there, Baudrier offers to write a first article right away, to re-check and repair the installation, or to just confirm everything is in order.

3. **Installing the pieces**: Baudrier adds the article list page, the article page, the RSS feed, and the sitemap link; sets your site's public address (`site:`) so links, RSS, and search-engine tags resolve correctly; and extends your page template with the extra tags an article needs (canonical link, article type, RSS link) without changing how your existing pages look.

4. **A "Blog" link**: Baudrier proposes where to add a Blog link in your navigation, and asks before touching it.

5. **Search engine proof file**: Baudrier drops a small proof file used later by `/blogpost` to tell search engines "a new article is up" the moment you publish. This file is public by design, it is how the engines confirm you own the site.

6. **Build check**: Baudrier verifies the whole site still builds cleanly before finishing.

7. **Save, no publish**: Baudrier commits the blog to your project, but does **not** put it online. The blog page will appear the next time you deploy - either right after this (if you write a first article) or whenever you next run `/deploy`.

## What it creates for you

- A **blog section** (`/blog`) ready to receive articles
- An **RSS feed** (`/rss.xml`) that updates itself as you publish
- Search-engine-friendly pages: canonical links, article structured data, tags
- A **proof file** letting `/blogpost` notify search engines instantly on publish

## Prerequisites

- A **site vitrine** (Astro) project - not an application
- Ideally, a public address already set for the site (a custom domain via `/add-domain`, or at least a first deploy so a container address exists); if none is found, Baudrier asks you directly

## Tips

{{callout:info|The blog starts empty, and that is expected}}
Right after `/add-blog`, the blog page has no articles yet - it shows a short "no articles yet" message. That is normal: this skill only builds the machinery. Run `/blogpost` to write your first article.
{{/callout}}

{{callout:tip|Editing or removing an article is not a skill}}
`/blogpost` only ever **creates** new articles. To change or delete one that is already published, just tell Baudrier what you want changed in the chat, the same way you would for any other page, then ask for `/deploy`. There is no separate skill for it.
{{/callout}}

## Landing sites only

`/add-blog` and `/blogpost` are the two skills reserved for a site vitrine; they refuse on an application project with a clear explanation, and your application stays fully usable through ordinary chat and `/deploy`.
