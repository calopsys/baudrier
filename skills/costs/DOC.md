# /costs

Shows what your app is actually costing you on Scaleway.

## When to use it

- Whenever you want a real answer to "how much is this costing me", not a guess.
- Before deciding whether to scale up, keep an app always-on, or clean things up.

## What it shows

- **Your real total spend** for the current month (or a range you ask for), pulled directly from Scaleway's billing.
- **A breakdown by service** - hosting, database, email, etc. - so you know where the money goes.
- **Email usage** for the period.
- **Reference limits** for things Scaleway doesn't meter live (like free-tier caps) - clearly marked as fixed reference numbers, not your actual usage, since no provider API exists to check that.

## A note on time ranges

Scaleway's billing only breaks down by whole calendar month - not by day or by arbitrary date range. If you ask for costs over the "last two weeks", expect the assistant to explain that limitation and give you the current month's total instead.

## Tips

{{callout:info|Free tier still shows €0}}
If a service shows no cost, it usually means you're still within Scaleway's free monthly allowance for it - not that something's broken.
{{/callout}}
