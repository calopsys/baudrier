import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// -----------------------------------------------------------------------------
// IP allowlist gate (CONTRACT.md §6).
//
// This is an APPLICATION-LAYER gate, not a firewall. Scaleway Serverless
// Containers have no network-level IP filtering: DNS still resolves, TLS
// still completes, and every request reaches this proxy (Next 16's rename
// of middleware) before being rejected here. Spoof-resistance of
// X-Forwarded-For is UNVERIFIED on this product. Never describe this to a
// user as a firewall or as airtight - it stops casual/accidental access,
// nothing more.
// -----------------------------------------------------------------------------

// There is NO built-in allowlist. An unset or empty ACCESS_ALLOWED_IPS
// means nobody passes the IP gate while ACCESS_RESTRICTED is on (fail
// closed). bootstrap-init.mjs writes the operator's detected egress address
// into ACCESS_ALLOWED_IPS at container creation; a hardcoded default here
// would ship every new project reachable only from one machine's VPN
// (verified on a live run). The matcher below must handle both address
// families correctly, a naive string-prefix match is not acceptable
// (e.g. "163.172.162.2" is not "163.172.162.25/32" despite sharing a
// prefix).

// Always exempt, regardless of ACCESS_RESTRICTED:
//  - /.well-known/acme-challenge/ : custom-domain TLS uses an HTTP-01
//    challenge with a hard 3-minute window (CONTRACT.md §1). Blocking it
//    here makes the domain land in a permanently unrecoverable `error`
//    state - there is no retry that fixes it after the window closes.
//  - /api/healthz (EXACT match, not a prefix) : the external keep-alive ping
//    (see setup-cron-worker.mjs) does not originate from the VPN, so it must
//    bypass the IP gate. This used to be a startsWith() match on
//    "/api/trpc/healthcheck" - a tRPC PREFIX is unsafe here because a
//    batched call bundles paths with a comma, e.g.
//    "/api/trpc/healthcheck.ping,admin.setRoles?batch=1" also starts with
//    that prefix, which let an unauthenticated caller reach ANY procedure
//    smuggled into the same batch. A plain, non-tRPC route with an exact
//    pathname match has no batching syntax to exploit.
const ALWAYS_ALLOWED_PREFIXES = ["/.well-known/acme-challenge/"];
const HEALTHZ_PATH = "/api/healthz";

/* --------------------------------- IPv4 ---------------------------------- */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv4InCidr(ip: string, network: string, prefixLen: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null) return false;
  if (prefixLen === 0) return true;
  // NB: `<<` shift amounts are taken mod 32 in JS, so `32 - prefixLen` must
  // never be allowed to reach 32 here - the prefixLen === 0 case above
  // handles that, everything else is in [1, 32].
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/* --------------------------------- IPv6 ---------------------------------- */

function ipv6GroupsToBigInt(groups: string[]): bigint | null {
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return result;
}

/** Expands "::" compression and parses a full IPv6 address into a 128-bit
 * integer. Does not support IPv4-mapped forms (e.g. "::ffff:1.2.3.4") -
 * X-Forwarded-For on this platform does not produce those. */
function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes(".")) return null;

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null; // more than one "::" is invalid

  if (doubleColonParts.length === 2) {
    const [headStr, tailStr] = doubleColonParts;
    const head = headStr ? headStr.split(":") : [];
    const tail = tailStr ? tailStr.split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    // Array.from, not Array(n).fill(): the latter is any[] and trips the
    // no-unsafe-argument lint rule in the generated app.
    return ipv6GroupsToBigInt([...head, ...Array.from({ length: missing }, () => "0"), ...tail]);
  }

  return ipv6GroupsToBigInt(ip.split(":"));
}

function ipv6InCidr(ip: string, network: string, prefixLen: number): boolean {
  const ipBig = ipv6ToBigInt(ip);
  const netBig = ipv6ToBigInt(network);
  if (ipBig === null || netBig === null) return false;
  if (prefixLen === 0) return true;
  const fullMask = (1n << 128n) - 1n;
  const hostBits = 128 - prefixLen;
  const mask = fullMask ^ ((1n << BigInt(hostBits)) - 1n);
  return (ipBig & mask) === (netBig & mask);
}

/* -------------------------------- shared ---------------------------------- */

/** Real CIDR matching for both IPv4 and IPv6, no dependencies. A bare IP
 * (no "/prefix") is treated as an exact /32 or /128 match. */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slashIndex = cidr.lastIndexOf("/");
  const network = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const isV6 = network.includes(":");
  const maxPrefix = isV6 ? 128 : 32;
  const prefixLen = slashIndex === -1 ? maxPrefix : Number(cidr.slice(slashIndex + 1));

  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > maxPrefix) return false;
  if (isV6 !== ip.includes(":")) return false; // address family mismatch

  return isV6 ? ipv6InCidr(ip, network, prefixLen) : ipv4InCidr(ip, network, prefixLen);
}

function isAllowed(ip: string, allowlist: string[]): boolean {
  return allowlist.some((cidr) => ipMatchesCidr(ip, cidr));
}

function getAllowedCidrs(): string[] {
  const raw = process.env.ACCESS_ALLOWED_IPS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Which X-Forwarded-For entry this app treats as "the client". 0 = the FIRST
// entry, on the assumption that Scaleway's ingress PREPENDS the real client
// address and any hop after it is an intermediate proxy. Scaleway's actual
// append-vs-replace behaviour for XFF is UNVERIFIED on this product as of
// this writing - the empirical test happens at the next live deploy (see
// CONTRACT.md). Until confirmed, treat every consumer of resolveClientIp()
// as an application-level filter, never as a security boundary: a header a
// client can influence must not be the sole gate on anything that matters
// (it still isn't here - it's one input to the IP allowlist below, and to
// rate-limit keys, both of which degrade to "less precise", not "bypassed
// entirely", if this assumption turns out wrong).
const TRUSTED_HOP = 0;

/** Single shared X-Forwarded-For resolver - every template that needs "the
 * client's IP" (this gate, rate limiters, login logging) must go through
 * this function instead of re-deriving its own `.split(",")[0]` parse, so a
 * future correction to TRUSTED_HOP only has to happen in one place. Accepts
 * anything with a Headers-like `.get()` - a NextRequest's `.headers`, or the
 * `next/headers` `headers()` result used by server actions. */
export function resolveClientIp(headers: { get(name: string): string | null }): string | null {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return null;
  const entries = xff.split(",").map((s) => s.trim()).filter(Boolean);
  // A guard, not `entries[TRUSTED_HOP] || null` (trips prefer-nullish-coalescing)
  // and not `?? null` (an empty string must also become null).
  const entry = entries[TRUSTED_HOP];
  if (!entry) return null;
  return entry;
}

// Pre-shared harness token: the deploy/bootstrap smoke tests run from the
// Claude Code web sandbox, whose egress address is a shared, changing pool -
// it can never be allowlisted by IP. A request carrying the exact value of
// ACCESS_BYPASS_TOKEN in the x-baudrier-access-token header passes the gate
// for every method, like an allowed IP would. Fail closed: no configured
// token (or a suspiciously short one) means no bypass path exists at all.
// Hand-rolled XOR compare because this file must not depend on node:crypto
// (timingSafeEqual) to stay runtime-agnostic; the XOR keeps comparison time
// independent of where the first mismatching character sits.
const MIN_BYPASS_TOKEN_LENGTH = 32;

function bypassTokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_BYPASS_TOKEN_LENGTH) return false;
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Logged once, at import time (not per-request) - a misbuilt production
// container that somehow ships without NODE_ENV=production must be loud
// about running with the IP gate bypassed, not silently open.
if (process.env.NODE_ENV !== "production" && process.env.ACCESS_RESTRICTED !== "false") {
  console.warn("[proxy] NODE_ENV is not 'production' - the IP-allowlist gate bypasses every request.");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // `next dev` sets NODE_ENV to "development"; a production build never
  // does. Locally there is no X-Forwarded-For, so the fail-closed gate below
  // would 403 every local request, and the built-in allowlist cannot help -
  // ACCESS_ALLOWED_IPS is a deployment secret, not something a local `.env`
  // carries.
  if (process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  if (pathname === HEALTHZ_PATH) {
    return NextResponse.next();
  }

  if (ALWAYS_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Fail CLOSED: an unset var, a typo'd value, or any value other than the
  // exact literal "false" is treated as restricted. A missing/garbage
  // ACCESS_RESTRICTED must never silently publish an app - unset used to be
  // read as "not restricted" here, which meant every container born without
  // the var explicitly set (e.g. freshly created, before the harness had a
  // chance to flip it) was reachable by anyone on the internet.
  if (process.env.ACCESS_RESTRICTED === "false") {
    return NextResponse.next();
  }

  if (bypassTokenMatches(request.headers.get("x-baudrier-access-token"), process.env.ACCESS_BYPASS_TOKEN)) {
    return NextResponse.next();
  }

  const clientIp = resolveClientIp(request.headers);
  if (clientIp && isAllowed(clientIp, getAllowedCidrs())) {
    return NextResponse.next();
  }

  // Echoes only the requester's own observed address, never a third party's.
  // It lets an operator see, from outside, exactly which address the gate
  // saw - useful because a machine often has both an IPv4 and an IPv6
  // address, and the family that failed is otherwise invisible in the 403.
  return new NextResponse(
    "Accès refusé : votre adresse IP n’est pas autorisée à consulter cette application.",
    {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-baudrier-client-ip": clientIp ?? "none",
      },
    },
  );
}

// Runs on every request except the framework's own static asset routes
// (nothing to gate there, and gating them would only add latency to every
// chunk/image load). The ACME challenge and /api/healthz paths are
// deliberately NOT excluded via the matcher - they must still reach this
// proxy so the exemption checks above can explicitly let them through.
// Excluding them here instead would make those checks dead code and bury
// the intent.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
