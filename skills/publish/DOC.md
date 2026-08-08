# /publish

Makes your app reachable by anyone on the internet, not just from the office VPN.

## When to use it

- When you're ready for real visitors to see the site.
- Before running `seo-perf`, `eco-audit`, or `gsc` - all three need Google to actually be able to load your site, which isn't possible while it's restricted to the VPN.

## What it does

By default, every app built with this harness only answers requests coming from the office VPN - a simple, honest safety net so you don't accidentally show unfinished work to the world. `/publish` turns that off for the environment you choose (production or a preview), so the site becomes reachable by anyone with the link.

The assistant always shows a clear warning and asks you to confirm before making this change - it's not something that happens by accident.

## What happens

1. You confirm which environment to publish (production or a preview) and confirm the warning.
2. The access restriction is lifted and the site redeploys with the new setting.
3. The assistant checks the new setting took effect and gives you the live, now-public URL.

## Undo

Run `/unpublish` at any time to restore the VPN-only restriction.

## Tips

{{callout:warning|Not a firewall}}
The access restriction (on or off) is an application-level check, not network-level filtering. Turning it back on with `/unpublish` is a sensible default for unfinished work, but treat it as a courtesy gate, not airtight security.
{{/callout}}

{{callout:info|Why some tools need this}}
`seo-perf`, `eco-audit`, and `gsc` all work by having an external service (typically Google) fetch your site. If the site only answers VPN traffic, those fetches fail or report wrong results - publishing first avoids that.
{{/callout}}
