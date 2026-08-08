// agent/tools/http-fetch.ts - Generic HTTP fetch tool.
//
// Lets the agent call any HTTP(S) endpoint. Useful for: fetching RSS feeds,
// hitting external APIs the agent needs to inspect, posting to webhooks.
//
// Safety:
//   - HTTP/HTTPS only (no file://, gopher://, etc.)
//   - SSRF guard: refuses localhost and private/loopback/link-local/metadata
//     IP ranges (resolves the hostname first, so a public name pointing at an
//     internal IP is also blocked). Redirects are followed manually (up to 5
//     hops), re-running this same check on every Location target - a public
//     URL that later 302s to a blocked address is refused mid-chain, not just
//     checked once at the start.
//   - 30 s timeout
//   - 1 MB response cap (agents shouldn't reason over 10 MB blobs anyway)
//   - Returns body as text. JSON gets parsed in the agent's reasoning if needed.

import type { ToolDefinition } from "./types.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// True for loopback, private, link-local (incl. cloud metadata 169.254.169.254),
// CGNAT, and unspecified addresses - the SSRF danger ranges.
function isBlockedIp(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true;
  if (/^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // link-local + unique-local IPv6
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;       // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

const definition: ToolDefinition = {
  name: "http_fetch",
  description:
    "Fetch any HTTP(S) URL and return the response body as text. Use this to read RSS feeds, hit external REST APIs, or fetch web pages. Supports GET (default), POST, PUT, DELETE, PATCH. Times out after 30 seconds. Response capped at 1 MB.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch. Must start with http:// or https://.",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        description: "HTTP method. Defaults to GET.",
      },
      headers: {
        type: "object",
        description:
          "Optional HTTP headers (e.g. {\"Authorization\":\"Bearer ...\"}). Don't include 'Host' or 'Content-Length'.",
        additionalProperties: { type: "string" },
      },
      body: {
        type: "string",
        description: "Optional request body (string). For JSON, stringify it yourself and set Content-Type header.",
      },
    },
    required: ["url"],
  },
};

/** Throws with a user-facing message iff `url` is not safe to fetch. */
async function assertUrlIsSafe(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`only http:// and https:// URLs are allowed. Got: ${url.slice(0, 60)}`);
  }

  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error(`invalid URL: ${url.slice(0, 60)}`);
  }
  const lowerHost = host.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal")
  ) {
    throw new Error(`refusing to fetch internal host: ${host}`);
  }
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    for (const rec of addrs) {
      if (isBlockedIp(rec.address)) {
        throw new Error(`refusing to fetch a private/internal address (${rec.address}) for host ${host}.`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refusing to fetch")) throw e;
    throw new Error(`could not resolve host: ${host}`);
  }
}

const MAX_REDIRECTS = 5;

async function handler(input: Record<string, unknown>): Promise<string> {
  const method = String(input.method ?? "GET").toUpperCase();
  const headers = (input.headers as Record<string, string>) ?? {};
  const body = input.body !== undefined ? String(input.body) : undefined;

  let url = String(input.url ?? "");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);

  try {
    // `redirect: "manual"` + a bounded loop, re-validating each hop: the SSRF
    // guard must run again on every Location target, not just the URL the
    // agent supplied - the default redirect-follow behaviour would otherwise
    // let a public, allowed URL 302 the request straight to a blocked address.
    // Definite-assignment: only reachable unassigned on hop 0, when
    // `hop > MAX_REDIRECTS` is always false, so the early-return branches
    // below that read `res` never run before the first fetch.
    let res!: Response;
    for (let hop = 0; ; hop++) {
      await assertUrlIsSafe(url);

      if (hop > MAX_REDIRECTS) {
        await res.body?.cancel().catch(() => {});
        return `Error: too many redirects (> ${MAX_REDIRECTS}) following ${url.slice(0, 60)}`;
      }

      res = await fetch(url, {
        method,
        headers,
        body,
        signal: ac.signal,
        redirect: "manual",
      });

      if (res.status < 300 || res.status >= 400 || !res.headers.has("location")) break;

      const location = res.headers.get("location")!;
      try {
        url = new URL(location, url).toString();
      } catch {
        await res.body?.cancel().catch(() => {});
        return `Error: redirect to an invalid Location header: ${location.slice(0, 60)}`;
      }
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return `Empty response (HTTP ${res.status})`;
    }

    let received = 0;
    const chunks: Uint8Array[] = [];
    const MAX_BYTES = 1_048_576; // 1 MB
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return `Error: response exceeded 1 MB cap. Use a more specific URL or pagination. Status was HTTP ${res.status}.`;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return `HTTP ${res.status} ${res.statusText}\n${text}`;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return `Error: request timed out after 30 seconds`;
    }
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(t);
  }
}

export const tool = { definition, handler };
