# /unpublish

Restricts your app back to VPN-only access. Undoes `/publish`.

## When to use it

- If you published by mistake, or want to take the site offline for the public while you keep working on it.
- Before making changes you don't want visitors to see mid-edit.

## What it does

Restores the default access restriction: only requests coming from the office VPN reach the app; everyone else gets a plain "access denied" message instead of the site.

## What happens

1. You confirm which environment to restrict (production or a preview).
2. The assistant warns that `seo-perf`, `eco-audit`, and `gsc` stop working correctly while restricted (they need Google to reach the site).
3. The restriction is turned back on and the site redeploys with the new setting.

## Tips

{{callout:info|Not a total lockdown}}
This restores the same soft, application-level gate every app ships with by default - it's a courtesy boundary, not network-level blocking.
{{/callout}}

## Landing sites (site vitrine)

`/unpublish` applies identically to a landing site: the redeploy that follows restarts the container and re-reads the access gate, whether it's implemented in Next.js's `proxy.ts` or in a landing site's Caddyfile.
