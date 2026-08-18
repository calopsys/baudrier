#!/usr/bin/env node
// dns.mjs - Scaleway Domains and DNS. This harness only ever manages DNS zones
// for EXTERNAL domains (bought elsewhere, delegated to Scaleway) - see
// CONTRACT.md. It never registers/transfers a domain through Scaleway.
//
// Thin adapter over @scaleway/sdk's Domainv2beta1 `API` class (NOT
// `RegistrarAPI`/`UnauthenticatedRegistrarAPI` - the DNS-zone/record methods
// live on plain `API`, and are named with a capital "DNS": listDNSZones,
// createDNSZone, listDNSZoneRecords, updateDNSZoneRecords,
// clearDNSZoneRecords, listDNSZoneNameservers). Not region-scoped - domains
// are global, and the SDK's `Domainv2beta1.API` declares no `LOCALITY`.
// Docs: https://www.scaleway.com/en/developers/api/domains-and-dns
//       https://www.scaleway.com/en/docs/domains-and-dns/how-to/add-external-domain/
//       https://www.scaleway.com/en/docs/domains-and-dns/how-to/manage-dns-records/
//
// Confirmed facts:
//   - Scaleway's authoritative nameservers are ns0.dom.scw.cloud and
//     ns1.dom.scw.cloud. A domain is "delegated" once its registrar-level NS
//     records point at those two hosts.
//   - `updateDNSZoneRecords` takes a `changes` array of {add|set|delete|clear}
//     operations (SDK type `RecordChange`); `set` replaces all data for a
//     record matched by {name,type} (`RecordChangeSet.idFields`), which is
//     exactly what makes re-running upsertRecords() idempotent. There is no
//     separate "delete records" endpoint - deleteRecords() below calls the
//     same updateDNSZoneRecords with `delete`-type changes, same as before.
//   - Trailing-dot requirement for CNAME/MX/NS/ALIAS `data`: NOT formally
//     documented by the SDK's types (`DomainRecord.data` is just `string`,
//     with no wire-format note) or found spelled out as a hard requirement in
//     Scaleway's docs. What IS confirmed: the API reference's own example
//     JSON for records shows `data` values for these types written with a
//     trailing dot (e.g. `"data": "filtered-domain.com."`), and prose next to
//     it notes that a non-FQDN CNAME has the zone appended automatically
//     (i.e. the API is forgiving of missing dots for at least CNAME). Given
//     that: sending an explicit trailing dot matches the documented example
//     and cannot hurt even where the API would auto-complete it, so
//     normalizeRecordData() below keeps adding it defensively for
//     CNAME/MX/NS/ALIAS - but this remains a conservative choice, not a
//     documented hard requirement for MX/NS/ALIAS specifically.
//
// NS delegation and propagation checks use node:dns/promises exclusively
// (resolveNs / Resolver#resolve*). We deliberately do NOT shell out to `dig`
// or `nslookup`: neither is guaranteed present on the sandbox image, and a
// Node stdlib call needs no external binary at all (CONTRACT.md §7).

import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { ScwError, api, sdkCall, pollUntil } from "./_scw-auth.mjs";

const DOMAIN_PRODUCT = "Domain";
const DOMAIN_VERSION = "v2beta1";
const SCW_NAMESERVERS = ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"];
/** Public resolvers used for waitForPropagation, so we see what the internet
 * sees rather than a possibly-stale local/ISP cache. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

const stripDot = (s) => (typeof s === "string" ? s.replace(/\.$/, "") : s);

/**
 * Whether a DNS zone already exists in this Scaleway Project for `domain`
 * (i.e. someone has already run "add external domain" for it).
 * Endpoint: GET /domain/v2beta1/dns-zones?domain={domain}
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function zoneExists(domain) {
  const domainApi = await api(DOMAIN_PRODUCT, DOMAIN_VERSION);
  const zones = await sdkCall(() => domainApi.listDNSZones({ domain }).all());
  return zones.some((z) => z.domain === domain && (!z.subdomain || z.subdomain === ""));
}

/**
 * Check whether `domain`'s registrar-level NS delegation points at Scaleway.
 * Resolves NS records for the domain with node:dns/promises (no external
 * `dig`/`nslookup` dependency) and checks that both
 * ns0.dom.scw.cloud and ns1.dom.scw.cloud are present. Never throws - domains
 * with no NS records, that don't resolve, etc. simply resolve to `false`.
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function isDelegatedToScaleway(domain) {
  try {
    const ns = await dns.resolveNs(domain);
    const lower = ns.map((h) => stripDot(h).toLowerCase());
    return SCW_NAMESERVERS.every((h) => lower.includes(h));
  } catch {
    return false;
  }
}

/**
 * List every record in a domain's DNS zone.
 * Endpoint: GET /domain/v2beta1/dns-zones/{dns_zone}/records
 * @param {string} domain
 * @returns {Promise<Array<{id,name,type,data,ttl,priority}>>}
 */
export async function listRecords(domain) {
  const domainApi = await api(DOMAIN_PRODUCT, DOMAIN_VERSION);
  return sdkCall(() => domainApi.listDNSZoneRecords({ dnsZone: domain }).all());
}

/** Records with these types must carry a trailing dot in `data` (RFC 1035 FQDN). */
const TRAILING_DOT_TYPES = new Set(["CNAME", "MX", "NS", "ALIAS"]);

function normalizeRecordData(type, data) {
  if (TRAILING_DOT_TYPES.has(String(type).toUpperCase()) && typeof data === "string" && !data.endsWith(".")) {
    return `${data}.`;
  }
  return data;
}

/**
 * Idempotently upsert records: each {name,type} pair is entirely replaced
 * with the given data via the `set` change operation (matched by
 * `idFields`), so re-running this with the same input is a no-op against a
 * stable zone.
 * Endpoint: PATCH /domain/v2beta1/dns-zones/{dns_zone}/records (updateDNSZoneRecords)
 * @param {string} domain
 * @param {Array<{name:string,type:string,data:string,ttl?:number,priority?:number}>} records
 */
export async function upsertRecords(domain, records) {
  const domainApi = await api(DOMAIN_PRODUCT, DOMAIN_VERSION);
  const changes = records.map((r) => ({
    set: {
      idFields: { name: r.name, type: r.type },
      records: [
        {
          name: r.name,
          type: r.type,
          data: normalizeRecordData(r.type, r.data),
          ttl: r.ttl ?? 300,
          priority: r.priority,
        },
      ],
    },
  }));
  return sdkCall(() =>
    domainApi.updateDNSZoneRecords({
      dnsZone: domain,
      changes,
      // This harness never wants upsertRecords()/deleteRecords() to create a
      // brand-new zone as a side effect - zone creation is a separate,
      // explicit step (see the /add-domain-style skills that call
      // createDNSZone). Existing zone required.
      disallowNewZoneCreation: true,
    }),
  );
}

/**
 * Delete specific records (matched by {name,type}).
 * Endpoint: PATCH /domain/v2beta1/dns-zones/{dns_zone}/records (updateDNSZoneRecords) -
 * there is no separate delete-records endpoint; `changes` with a `delete`
 * entry is how the API expresses it, same as before.
 * @param {string} domain
 * @param {Array<{name:string,type:string}>} records
 */
export async function deleteRecords(domain, records) {
  const domainApi = await api(DOMAIN_PRODUCT, DOMAIN_VERSION);
  const changes = records.map((r) => ({
    delete: { idFields: { name: r.name, type: r.type } },
  }));
  return sdkCall(() =>
    domainApi.updateDNSZoneRecords({
      dnsZone: domain,
      changes,
      disallowNewZoneCreation: true,
    }),
  );
}

const RESOLVERS_BY_TYPE = {
  A: (r, fqdn) => r.resolve4(fqdn),
  AAAA: (r, fqdn) => r.resolve6(fqdn),
  CNAME: (r, fqdn) => r.resolveCname(fqdn),
  NS: (r, fqdn) => r.resolveNs(fqdn),
  TXT: async (r, fqdn) => (await r.resolveTxt(fqdn)).map((chunks) => chunks.join("")),
  MX: async (r, fqdn) => (await r.resolveMx(fqdn)).map((m) => m.exchange),
};

/**
 * This exists because Scaleway's HTTP-01 custom-domain challenge has a hard
 * 3-minute window and an unrecoverable `error` state on failure (see
 * CONTRACT.md) - the caller MUST confirm DNS has actually propagated before
 * calling container.mjs#addCustomDomain, never just assume upsertRecords()
 * took effect immediately.
 *
 * Polls public resolvers (1.1.1.1, 8.8.8.8) via node:dns/promises - no shell
 * dependency - until `fqdn`'s records of `type` include
 * `expect` (trailing dots ignored on both sides).
 *
 * @param {string} fqdn
 * @param {object} o
 * @param {"A"|"AAAA"|"CNAME"|"NS"|"TXT"|"MX"} o.type
 * @param {string} o.expect
 * @param {number} [o.timeoutMs=180000]  3 minutes, matching the HTTP-01 window
 * @returns {Promise<string[]>} the matching resolved value set
 */
export async function waitForPropagation(fqdn, { type, expect, timeoutMs = 180_000 }) {
  const resolveFn = RESOLVERS_BY_TYPE[String(type).toUpperCase()];
  if (!resolveFn) throw new ScwError(`waitForPropagation: unsupported record type "${type}"`, { type: "bad_input" });

  const resolver = new dns.Resolver();
  resolver.setServers(PUBLIC_RESOLVERS);
  const wantedStripped = stripDot(expect).toLowerCase();

  return pollUntil(
    async () => {
      let values;
      try {
        values = await resolveFn(resolver, fqdn);
      } catch {
        return null;
      }
      const hit = values.some((v) => stripDot(v).toLowerCase() === wantedStripped);
      return hit ? values : null;
    },
    { timeoutMs, intervalMs: 5000, label: `${type} ${fqdn} -> ${expect}` },
  );
}

/* --------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
  };

  (async () => {
    try {
      switch (cmd) {
        case "zone-exists": {
          const domain = rest[0];
          if (!domain) throw new Error("usage: dns.mjs zone-exists <domain>");
          const exists = await zoneExists(domain);
          console.log(exists ? `✅ zone exists for ${domain}` : `⚠️ no zone for ${domain}`);
          console.log(JSON.stringify({ domain, exists }));
          break;
        }
        case "delegated": {
          const domain = rest[0];
          if (!domain) throw new Error("usage: dns.mjs delegated <domain>");
          const delegated = await isDelegatedToScaleway(domain);
          console.log(delegated ? `✅ ${domain} delegated to Scaleway` : `⚠️ ${domain} not delegated to Scaleway`);
          console.log(JSON.stringify({ domain, delegated }));
          break;
        }
        case "list-records": {
          const domain = rest[0];
          if (!domain) throw new Error("usage: dns.mjs list-records <domain>");
          const records = await listRecords(domain);
          console.log(`▸ ${records.length} record(s)`);
          console.log(JSON.stringify({ domain, records }));
          break;
        }
        case "upsert-records": {
          const domain = rest[0];
          const json = flag("json");
          if (!domain || !json) throw new Error('usage: dns.mjs upsert-records <domain> --json \'[{"name":"","type":"A","data":"1.2.3.4"}]\'');
          const records = JSON.parse(json);
          console.log(`▸ upserting ${records.length} record(s) on ${domain}...`);
          await upsertRecords(domain, records);
          console.log(`✅ upserted`);
          console.log(JSON.stringify({ domain, upserted: records.length }));
          break;
        }
        case "wait-propagation": {
          const fqdn = rest[0];
          const type = flag("type");
          const expect = flag("expect");
          if (!fqdn || !type || !expect) throw new Error("usage: dns.mjs wait-propagation <fqdn> --type A --expect 1.2.3.4 [--timeout ms]");
          console.log(`▸ waiting for ${fqdn} ${type} = ${expect}...`);
          const values = await waitForPropagation(fqdn, { type, expect, timeoutMs: Number(flag("timeout", 180_000)) });
          console.log(`✅ propagated`);
          console.log(JSON.stringify({ fqdn, type, values }));
          break;
        }
        default:
          console.log(
            "usage: dns.mjs <zone-exists|delegated|list-records|upsert-records|wait-propagation> ...\n" +
              "  zone-exists <domain>\n" +
              "  delegated <domain>\n" +
              "  list-records <domain>\n" +
              "  upsert-records <domain> --json '[...]'\n" +
              "  wait-propagation <fqdn> --type A --expect 1.2.3.4 [--timeout ms]",
          );
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      console.log(JSON.stringify({ error: e.message, type: e.type, status: e.status }));
      process.exit(1);
    }
  })();
}
