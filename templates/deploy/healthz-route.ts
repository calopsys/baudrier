// deploy/healthz-route.ts - copied by bootstrap-init.mjs to
// src/app/api/healthz/route.ts.
//
// Plain, non-tRPC health endpoint. proxy.ts exempts it with an EXACT
// pathname match (not a prefix) so the external keep-alive ping (see
// setup-cron-worker.mjs) can bypass the IP-allowlist gate without opening
// the tRPC-batching bypass the old /api/trpc/healthcheck prefix match had.

export function GET() {
  return Response.json({ ok: true });
}
