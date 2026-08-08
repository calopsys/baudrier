// next.config.js - Scaleway Serverless Containers deployment config.
//
// ---------------------------------------------------------------------------
// output: 'standalone'
//
// Next.js's standalone build traces the minimal set of node_modules actually
// used by the app and emits a self-contained server at
// `.next/standalone/server.js`. This is what keeps the Docker image small
// (~200MB vs ~547MB for a naive `next start` image that ships the full
// node_modules tree) - Scaleway recommends staying under 1GB per image.
//
// IMPORTANT: standalone mode does NOT copy `.next/static/` or `public/` into
// `.next/standalone/`. templates/deploy/copy-assets.js does that, and
// templates/deploy/Dockerfile runs it after `next build`, before the image's
// final stage. Skip that step and the container deploys fine and passes its
// health check, but serves a completely unstyled page - no CSS, no client
// JS, no images, no favicon - because none of those files exist inside the
// standalone folder that actually ships.
// ---------------------------------------------------------------------------

import "./src/env.js";

// Security headers, shared between the enforced Content-Security-Policy and
// its Report-Only starter below.
//
// The enforced CSP only sets `frame-ancestors 'none'` - the one directive
// that is safe to turn on unconditionally (it blocks clickjacking, nothing
// else) without per-project tuning. Every other directive ships
// Report-Only first: a real `default-src 'self'` would break Next.js
// hydration or a wired-up addon (Matomo, Web Push) if enforced blind, so it
// only starts reporting until a human promotes it after checking the
// browser console for violations.
//
// IMPORTANT: when /add-analytics wires up Matomo, its origin (the user's
// own Matomo instance URL) must be appended to `script-src` and
// `connect-src` below (see skills/add-analytics/SKILL.md), otherwise the
// tracker silently stops loading the moment this policy is enforced.
const CONTENT_SECURITY_POLICY_REPORT_ONLY =
  "default-src 'self'; img-src 'self' data: blob: https://*.scw.cloud; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'";

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,

  images: {
    // Scaleway Serverless Containers run a real, persistent container
    // process, so next/image's built-in Sharp-based optimizer works out of
    // the box - unlike edge/serverless platforms that need a custom image
    // loader. The trade-off: unlike a managed platform that offloads this
    // to an image CDN, optimisation here burns the container's own
    // CPU/mvCPU budget on every unique image request. Watch cpuLimit if the
    // app is image-heavy.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.scw.cloud",
      },
    ],
    // The default image placeholders (public/placeholders/*.svg, see
    // skills/bootstrap/SKILL.md) are local SVGs served through next/image.
    // Next.js blocks SVG optimisation by default (an SVG can embed a
    // <script>) - these three options are Next's own documented way to
    // allow it safely: force download disposition and forbid script
    // execution in the image response's own CSP, rather than turning the
    // whole app's CSP off.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Content-Security-Policy-Report-Only", value: CONTENT_SECURITY_POLICY_REPORT_ONLY },
        ],
      },
    ];
  },
};

export default config;
