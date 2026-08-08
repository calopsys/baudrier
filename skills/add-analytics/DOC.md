# /add-analytics

Enables **Matomo** audience measurement on your site. Runs **cookieless by default**: no cookies, no personal data, and no consent banner blocking your visitors - just a discreet way for them to opt out if they want.

## When to use it

- You want to **measure your site's audience** (number of visitors, most viewed pages, traffic sources, visit duration)
- You want analytics **without the RGPD/cookie-banner hassle** for your visitors
- You already have (or are willing to create) a Matomo account - Matomo Cloud or self-hosted

## How it goes

1. **Check**: if Matomo is already in place, Baudrier offers you a menu (switch instance/site, reinstall the opt-out control, exclude admin routes, etc.).

2. **Your Matomo instance**: unlike most Baudrier features, Matomo isn't hosted for you. You give Baudrier your **Matomo URL** and **site ID** - either from Matomo Cloud (matomo.cloud) or a self-hosted instance you already have. If you have neither yet, Baudrier points you to matomo.org to get started.

3. **Pushing the variables**: `NEXT_PUBLIC_MATOMO_URL` and `NEXT_PUBLIC_MATOMO_SITE_ID` are pushed to your local `.env` and to your hosted app's secrets.

4. **A one-time check on your side**: Baudrier asks you to confirm "Anonymize visitor's IP addresses" is enabled in your Matomo admin (usually the default already). This can't be done remotely, but it's what keeps the setup exempt from a consent banner.

5. **Creating the MatomoAnalytics component**: a React component that loads Matomo **cookieless** (`disableCookies`) from the very first visit - no waiting for a click. It **automatically excludes the admin routes** (`/admin`) from tracking, and Baudrier offers to also exclude your authenticated areas (dashboard, members area, account).

6. **Creating the opt-out control**: a small, hidden-by-default panel reachable from a "Manage anonymous tracking" link in your footer. Visitors can turn tracking off for themselves at any time - required even though no prior consent is needed for cookieless measurement.

7. **Updating the legal pages**: Baudrier updates your privacy policy to mention Matomo and the opt-out.

## Why no cookie-consent banner?

Cookie-based analytics (like classic Google Analytics) require prior consent because they store an identifier on the visitor's device. Matomo configured **cookieless** doesn't - no identifying cookie is set, no cross-session tracking, no data shared with third parties. Under CNIL's exemption criteria for audience-measurement tools, that combination is exempt from prior consent: a clear notice plus an easy opt-out is enough, which is exactly what this skill installs. If your project later needs cookie-based tracking (cross-device recognition, long funnels), that's a deliberate step up that needs a real consent gate - ask Baudrier explicitly if you get there.

## What it creates for you

- The `NEXT_PUBLIC_MATOMO_URL` and `NEXT_PUBLIC_MATOMO_SITE_ID` variables in `.env` + your app's secrets
- A `MatomoAnalytics` component that tracks cookieless from the first visit, excluding the admin routes (and any authenticated area you choose to exclude)
- An `AnalyticsOptOut` component (hidden by default, opened from the footer link) with your site's design
- An update to the **privacy policy** to mention Matomo and the opt-out

## Prerequisites

- The project must be in Next.js (typically initialized by `/bootstrap`)
- A Matomo instance (Matomo Cloud account, or a self-hosted install) - Baudrier does not create this for you

## Tips

{{callout:info|Why cookieless is the default}}
Cookieless removes the whole consent-banner burden for your visitors while staying RGPD-compliant, as long as tracking stays strictly anonymous audience measurement. Baudrier sets this up by default and explains the trade-off if you ever want more (e.g. cookie-based cross-device tracking).
{{/callout}}

{{callout:warning|Matomo isn't provisioned by Baudrier}}
Unlike your database or your storage bucket, Matomo lives outside Scaleway. You need your own Matomo Cloud account or self-hosted instance; Baudrier only wires the tracking code to it.
{{/callout}}

{{callout:tip|Your admin visits do not skew your stats}}
Tracking is disabled on the admin routes (`/admin`): when you manage your site, your own sessions are not counted as visitors. You can extend this exclusion to your authenticated areas (dashboard, members area, account) - Baudrier offers it during the installation.
{{/callout}}
