#!/usr/bin/env node
// cockpit.mjs - Scaleway Cockpit (Loki-compatible logs, LogQL).
//
// ensureToken() talks to the official @scaleway/sdk (`Cockpit` v1 -
// RegionalAPI, NOT the default API class - Cockpit is one of the products
// that splits into GlobalAPI/RegionalAPI) via `api()`/`sdkCall()` from
// _scw-auth.mjs.
// Reference: https://www.scaleway.com/en/developers/api/cockpit/regional-api/
//
// queryLogs() is one of CONTRACT.md §3's three documented exceptions and
// uses a plain fetch, not scwFetch: Cockpit's own API has no "get logs"
// endpoint, so the flow is two hops:
//   1. Cockpit RegionalAPI: create/find a Token (a Cockpit-scoped secret key)
//      and look up the Project's logs Data Source, whose `url` is a
//      Loki-compatible base URL (looks like https://logs.cockpit.fr-par.scw.cloud).
//   2. Talk directly to that URL using the standard Loki HTTP API
//      (`/loki/api/v1/query_range`) authenticated with the Cockpit token.
//      This is a different host than api.scaleway.com, and live-verified
//      2026-08: the gateway 403s on X-Auth-Token plus the standard
//      OAuth-style bearer header (what scwFetch sends by default), and
//      answers 200 on a bare X-Token header. scwFetch cannot cleanly drop
//      its default header, so step 2 uses a plain fetch instead.
//
// A Cockpit token's secret is a write-once reveal, exactly like an IAM API
// key: the create response has a `secretKey` field, but nothing else ever
// returns it again. To make ensureToken() genuinely idempotent (the harness
// reruns these) we persist the token's secret in Secret Manager under a
// conventional name ("COCKPIT_TOKEN" by default) the first time we create
// one, then read it back on every subsequent call instead of minting a new
// token. This mirrors how DATABASE_URL/IAM keys are handled elsewhere in the
// harness (CONTRACT.md §4) and avoids leaking a new token on every rerun.

import { api, sdkCall, requireCredentials, ScwError, REGION, slugify, sleep } from "./_scw-auth.mjs";
import { getSecret, putSecret, secretExists } from "./secrets.mjs";
import { pathToFileURL } from "node:url";

/**
 * SDK call: Cockpit.RegionalAPI.listDataSources({ region, projectId, types: ["logs"] })
 * Prefers the Scaleway-managed logs data source over any external/custom one.
 */
async function findLogsDataSource(region, projectId) {
  const cockpit = await api("Cockpit", "v1", "RegionalAPI");
  const sources = await sdkCall(() =>
    cockpit.listDataSources({ region, projectId, types: ["logs"] }).all(),
  );
  const logsSources = sources.filter((s) => s.type === "logs");
  return logsSources.find((s) => s.origin === "scaleway") || logsSources[0] || null;
}

/**
 * Find-or-create a Cockpit token for the Project and resolve the logs Data
 * Source URL. See the file header for why "find" means "read back from
 * Secret Manager" rather than re-listing Cockpit tokens.
 * SDK calls:
 *   Cockpit.RegionalAPI.listDataSources({ region, projectId, types: ["logs"] })
 *   Cockpit.RegionalAPI.createToken({ region, projectId, name, tokenScopes })
 * @param {{projectId?:string, region?:string, secretName?:string}} [opts]
 * @returns {Promise<{token:string, logsUrl:string}>}
 */
export async function ensureToken(opts = {}) {
  const creds = requireCredentials();
  const region = opts.region || creds.region || REGION;
  const projectId = opts.projectId || creds.projectId;
  const secretName = opts.secretName || "COCKPIT_TOKEN";

  const dataSource = await findLogsDataSource(region, projectId);
  if (!dataSource) {
    throw new ScwError(`no logs data source found for project ${projectId} in ${region} (Cockpit not provisioned yet?)`, {
      type: "not_found",
      details: { projectId, region },
    });
  }

  const secretOpts = { projectId, region };
  if (await secretExists(secretName, secretOpts)) {
    const token = await getSecret(secretName, secretOpts);
    return { token, logsUrl: dataSource.url };
  }

  const cockpit = await api("Cockpit", "v1", "RegionalAPI");
  const created = await sdkCall(() =>
    cockpit.createToken({
      region,
      projectId,
      name: slugify(`baudrier-logs-${projectId}`),
      tokenScopes: ["read_only_logs", "read_only_metrics"],
    }),
  );
  if (!created?.secretKey) {
    throw new ScwError("Cockpit token creation did not return a secretKey", { type: "unexpected_response" });
  }
  await putSecret(secretName, created.secretKey, secretOpts);
  return { token: created.secretKey, logsUrl: dataSource.url };
}

/** Accepts a Date, an ISO/parsable string, or a relative duration like "15m"/"1h"/"2d". */
function parseSince(since) {
  if (!since) return new Date(Date.now() - 3600_000);
  if (since instanceof Date) return since;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(since).trim());
  if (m) {
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    return new Date(Date.now() - Number(m[1]) * mult);
  }
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) {
    throw new ScwError(`invalid "since" value: ${since}`, { type: "invalid_argument" });
  }
  return d;
}

/**
 * Run a LogQL query against the Project's Cockpit logs Data Source (standard
 * Loki HTTP API, not a Scaleway-specific endpoint - Cockpit's logs backend
 * IS Loki). Authenticates with a bare `X-Token` header - see the file header
 * for the live-verified reason this is a plain fetch, not scwFetch.
 * Endpoint: GET {logsUrl}/loki/api/v1/query_range?query=&start=&end=&limit=&direction=
 * @param {{query:string, since?:string|Date, limit?:number, opts?:object}} args
 * @returns {Promise<Array<{timestamp:string, labels:object, line:string}>>}
 */
export async function queryLogs({ query, since, limit = 100, opts } = {}) {
  if (!query) throw new ScwError("queryLogs requires a LogQL query string", { type: "invalid_argument" });
  const { token, logsUrl } = await ensureToken(opts);
  const start = parseSince(since);
  const end = new Date();

  const url = new URL(`${logsUrl.replace(/\/+$/, "")}/loki/api/v1/query_range`);
  const params = { query, start: start.toISOString(), end: end.toISOString(), limit, direction: "backward" };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { "X-Token": token, "User-Agent": "baudrier" };

  const retries = 3;
  let lastErr, res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (e) {
      lastErr = new ScwError(`network error calling ${url.pathname}: ${e.message}`, { type: "network", apiPath: url.pathname });
      res = null;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ScwError(`Cockpit logs API ${res.status} on ${url.pathname}`, { status: res.status, type: "retryable", apiPath: url.pathname });
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw lastErr;

  const text = await res.text();
  if (!res.ok) {
    throw new ScwError(`Cockpit logs API ${res.status} on ${url.pathname}: ${text.slice(0, 200)}`, { status: res.status, apiPath: url.pathname });
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  const streams = parsed?.data?.result || [];
  const entries = [];
  for (const stream of streams) {
    for (const [tsNanos, line] of stream.values || []) {
      entries.push({
        timestamp: new Date(Number(BigInt(tsNanos) / 1_000_000n)).toISOString(),
        labels: stream.stream || {},
        line,
      });
    }
  }
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return entries.slice(0, limit);
}

/* ------------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "token": {
        console.log("▸ ensuring Cockpit token");
        const res = await ensureToken();
        console.log(`✅ token ready, logs data source ${res.logsUrl}`);
        console.log(JSON.stringify({ ok: true, logsUrl: res.logsUrl, tokenLength: res.token.length }));
        break;
      }
      case "query": {
        const [query, since, limitArg] = rest;
        if (!query) throw new ScwError('usage: node cockpit.mjs query \'{app="myapp"}\' [SINCE] [LIMIT]', { type: "usage" });
        console.log(`▸ querying logs: ${query}`);
        const entries = await queryLogs({ query, since, limit: limitArg ? Number(limitArg) : undefined });
        console.log(`✅ ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
        console.log(JSON.stringify({ ok: true, entries }));
        break;
      }
      default:
        console.log("usage: node cockpit.mjs <token|query> [args]");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, type: err.type, details: err.details }));
    process.exitCode = 1;
  });
}
