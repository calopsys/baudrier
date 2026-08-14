# /blogpost

Writes one **blog article** from your description, in French, and walks it through a private preview before it ever reaches your public site. Give it a subject; Baudrier does the writing, the structuring, and the SEO details.

## When to use it

- You want to **publish a new article** on your site vitrine's blog
- `/add-blog` has already installed the blog on this project

## How it works

1. **Preflight**: Baudrier checks the blog is installed (offers `/add-blog` if not), and checks whether other changes or an earlier unpublished article are already sitting around, so nothing surprises you later.

2. **Gathering the subject**: you describe what the article is about. Baudrier suggests a few tags, and asks if you have a cover image (optional - no image is a perfectly normal article, Baudrier never invents a stock photo).

3. **Writing**: Baudrier writes the article - title, short description, and a structured French text (roughly 600 to 1200 words, organized in sections) - on a separate **review** track, never touching your public site yet.

4. **Private preview, right away**: Baudrier deploys the article to a private preview - a separate address, reachable only from an already-authorized location (your company VPN, by default), whatever the public site's own state is. You read the real, styled page there; there is no long text to review in the chat.

5. **Your verdict**: after reading the preview, you choose to publish it for real, ask for more changes, or leave it waiting (nothing is lost, you can resume anytime).

6. **Publishing**: if you publish, Baudrier deploys the article to your real, public site, then removes the preview - the review is over, and the next article recreates it automatically.

7. **Telling search engines**: once public, Baudrier notifies search engines that support instant notification (Bing and a few others) that the article exists, so it gets found faster - skipped automatically if your site is still access-restricted.

## What it creates for you

- One new **article page**, written and structured for you
- An updated **RSS feed** and **sitemap**, automatically
- A **private preview** to check before anyone else sees it
- A faster start on search-engine discovery, when applicable

## Prerequisites

- A **site vitrine** with the blog installed (`/add-blog`)
- Nothing else - Baudrier handles the writing, the review branch, and both deploys

## Tips

{{callout:warning|This skill only creates}}
`/blogpost` never touches an article that is already published. To change wording, fix a typo, or remove an old article, just ask Baudrier directly in the chat, then request `/deploy` - the same way you would edit any other page on your site.
{{/callout}}

{{callout:info|Two deploys, then a cleanup}}
Publishing an article always goes through a private preview first, then production - two short deploys, a few minutes each. After publication the preview is removed, so it costs nothing at all; while an article waits, the preview scales down to nothing between checks.
{{/callout}}

{{callout:tip|The "waiting" state is not a loss}}
If you choose to leave an article pending after the preview, it stays saved on Baudrier's internal review track. Nothing disappears - come back with `/blogpost` whenever you are ready to finish it.
{{/callout}}

## Landing sites only

`/add-blog` and `/blogpost` are the two skills reserved for a site vitrine; on an application project they refuse with a clear explanation, and your application stays fully usable through ordinary chat and `/deploy`.
