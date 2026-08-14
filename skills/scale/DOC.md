# /scale

Changes how much compute your deployed app gets, and whether it stays always-on or sleeps when idle.

## When to use it

- The app feels slow under real traffic.
- You want to stop cold starts entirely for a production app that gets constant visits.
- You want to reduce cost on an app that's rarely visited.

## The four sizes

| Size | Good for |
|---|---|
| S | Small apps, low traffic - the default |
| M | Growing traffic, more concurrent visitors |
| L | Busy apps |
| XL | Heavy, sustained traffic |

Each size moves three things together: CPU, memory, and how many requests a single instance handles at once. That last part matters more than it sounds: the smaller the size, the sooner a single instance gets overwhelmed, so smaller sizes intentionally cap concurrent requests lower - it's better to start a second instance a little early than to make visitors wait.

## Always-on vs. sleep when idle

Independent of size, you choose:
- **Sleep when idle (default)** - costs close to nothing between visits, but the very first visitor after a quiet period waits a few seconds for the app to wake up.
- **Always-on** - no wait, ever, but you pay for the chosen size continuously, even overnight with zero visitors.

## What it shows you

Before changing anything, the assistant shows your current size and a plain-language cost estimate for each option, computed from Scaleway's published pricing - so you can make an informed choice, not a guess.

## Vitrine (Astro) sites

A vitrine has no database, so the database section of this command does not apply to it. Its concurrency also stays fixed at 80 requests per instance at every size - a static site has no heavy processing to overwhelm an instance - so only the CPU/memory choice matters. Its production environment also starts always-on (no cold start on a public site with no backend); the assistant warns you before turning that off.

## Tips

{{callout:warning|Health checks don't keep a sleeping app awake}}
If you want an app to never cold-start without paying for always-on, a health-check or uptime monitor will NOT do it - Scaleway's health probes don't count as traffic. The only thing that keeps a scaled-to-zero app warm is a real, scheduled request (a Serverless Job doing an actual HTTP call on a timer).
{{/callout}}
