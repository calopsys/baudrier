#!/usr/bin/env node
// tem.mjs - Scaleway Transactional Email (TEM).
//
// Thin adapter over @scaleway/sdk's Tem v1alpha1 API (see CONTRACT.md §3).
// Docs: https://www.scaleway.com/en/developers/api/transactional-email
//       https://www.scaleway.com/en/docs/transactional-email/concepts/
//
// Confirmed shape of the SDK's `Domain` type (this is where the DNS records
// to publish actually live - NOT a separate "records" endpoint):
//   { id, name, status, spfConfig, dkimConfig,
//     records: { spf:{name,value}, dkim:{name,value}, dmarc:{name,value}, mx:{name,value} },
//     statistics: {...}, reputation: {...}, ... }
// Domain status enum (confirmed from the SDK's types.gen.d.ts): unknown,
// checked, unchecked, invalid, locked, revoked, pending, autoconfiguring.
//
// TEM constraints enforced here per CONTRACT.md:
//   - subject must be >= 10 characters
//   - at most 10 recipients per email (Scaleway's default "Maximum number of
//     recipients per email" on the Essential plan; custom-definable higher on
//     request - see
//     https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/,
//     verified 2026-07-30). An earlier revision of this file wrongly used 3 -
//     that was never Scaleway's documented default and has been corrected.
//   - domain verification can take up to 48h after DNS records are published
//   - quotas are plan-based, not KYC-gated: the default Essential plan is
//     300 free emails/month across up to 5 domains (pay-as-you-go beyond
//     that); the Scale plan is a fixed-price tier with 100K emails/month,
//     unlimited domains, a dedicated IP. See
//     https://www.scaleway.com/en/docs/transactional-email/how-to/manage-tem-plans/
//     (verified 2026-07-30). The API does not expose these as a queryable
//     limit - they are enforced server-side and surfaced only as a 429/403 at
//     send time - so we document them here and in ensureDomain()'s JSDoc
//     rather than pretend to check them client-side.

import { ScwError, requireCredentials, api, sdkCall } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";

const TEM_PRODUCT = "Tem";
const TEM_VERSION = "v1alpha1";
const MIN_SUBJECT_LENGTH = 10;
const MAX_RECIPIENTS = 10;

function normalizeDomain(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    spfConfig: d.spfConfig,
    dkimConfig: d.dkimConfig,
    createdAt: d.createdAt,
    lastError: d.lastError,
    raw: d,
  };
}

/**
 * Find-or-create a TEM domain (idempotent).
 *
 * IMPORTANT: verification is asynchronous and can take **up to 48 hours**
 * after the SPF/DKIM/DMARC/MX records reported by getDomainRecords() are
 * published (use checkDomain() to nudge a re-check once you believe DNS has
 * propagated - see dns.mjs#waitForPropagation).
 *
 * The default Essential plan is capped at **300 free emails/month across up
 * to 5 domains** (pay-as-you-go beyond that free allowance); the paid Scale
 * plan raises this to 100K emails/month with unlimited domains. This is a
 * plan choice, not a KYC gate. These caps are enforced by Scaleway
 * server-side (surfaced as an error on create/send, not queryable via API).
 *
 * Endpoint: GET  /transactional-email/v1alpha1/regions/{region}/domains        (find)
 *           POST /transactional-email/v1alpha1/regions/{region}/domains        (create)
 * @param {string} domain
 * @param {object} [opts]
 * @param {boolean} [opts.autoconfig=false]  let Scaleway attempt to auto-publish DNS records (only works for Scaleway-managed zones)
 * @param {string} [opts.projectId]
 * @returns {Promise<{id:string,status:string}>}
 */
export async function ensureDomain(domain, opts = {}) {
  const creds = requireCredentials();
  const temApi = await api(TEM_PRODUCT, TEM_VERSION);
  const rows = await sdkCall(() =>
    temApi.listDomains({ projectId: opts.projectId || creds.projectId, name: domain }).all(),
  );
  const found = rows.find((d) => d.name === domain);
  if (found) return normalizeDomain(found);

  const created = await sdkCall(() =>
    temApi.createDomain({
      projectId: opts.projectId || creds.projectId,
      domainName: domain,
      autoconfig: opts.autoconfig ?? false,
    }),
  );
  return normalizeDomain(created);
}

/**
 * Get the SPF/DKIM/DMARC/MX records the caller must publish (via
 * dns.mjs#upsertRecords) to authenticate this domain for sending.
 * Endpoint: GET /transactional-email/v1alpha1/regions/{region}/domains/{domain_id}
 *           (records live under the domain resource's `records` field)
 * @param {string} domainId
 * @returns {Promise<Array<{name:string,type:string,value:string}>>}
 */
export async function getDomainRecords(domainId) {
  const temApi = await api(TEM_PRODUCT, TEM_VERSION);
  const res = await sdkCall(() => temApi.getDomain({ domainId }));
  const records = res?.records || {};
  return Object.entries(records)
    .filter(([, v]) => v && (v.name || v.value))
    .map(([type, v]) => ({ name: v.name, type: type.toUpperCase(), value: v.value }));
}

/**
 * Ask Scaleway to re-check DNS for this domain right now (rather than waiting
 * for its automatic recheck schedule). Call this after dns.mjs confirms the
 * records from getDomainRecords() have propagated.
 * Endpoint: POST /transactional-email/v1alpha1/regions/{region}/domains/{domain_id}/check
 * @param {string} domainId
 * @returns {Promise<object>} the domain, with its refreshed status
 */
export async function checkDomain(domainId) {
  const temApi = await api(TEM_PRODUCT, TEM_VERSION);
  const res = await sdkCall(() => temApi.checkDomain({ domainId }));
  return normalizeDomain(res);
}

/**
 * Send a transactional email. Validates TEM's hard limits client-side first
 * (subject length, recipient count) so a mistake fails fast with a clear
 * message instead of a confusing 400 from the API.
 * Endpoint: POST /transactional-email/v1alpha1/regions/{region}/emails
 * @param {object} o
 * @param {{email:string,name?:string}} o.from
 * @param {Array<{email:string,name?:string}>} o.to  max 10 recipients
 * @param {string} o.subject  must be >= 10 characters
 * @param {string} [o.text]
 * @param {string} [o.html]
 * @param {object} [o.opts]
 * @param {string} [o.opts.projectId]
 * @param {Array<{email:string,name?:string}>} [o.opts.cc]
 * @param {Array<{email:string,name?:string}>} [o.opts.bcc]
 * @param {Array<{name:string,type:string,content:string}>} [o.opts.attachments]  base64-encoded content
 * @returns {Promise<object>} the created email resource
 */
export async function sendEmail({ from, to, subject, text, html, opts = {} }) {
  if (typeof subject !== "string" || subject.length < MIN_SUBJECT_LENGTH) {
    throw new ScwError(
      `TEM rejects subjects under ${MIN_SUBJECT_LENGTH} characters (got ${subject?.length ?? 0}). ` +
        `Write a real subject line, not a placeholder.`,
      { type: "invalid_subject" },
    );
  }
  if (!Array.isArray(to) || to.length === 0) {
    throw new ScwError("sendEmail requires at least one recipient in `to`.", { type: "invalid_recipients" });
  }
  if (to.length > MAX_RECIPIENTS) {
    throw new ScwError(
      `TEM allows at most ${MAX_RECIPIENTS} recipients per email (got ${to.length}). ` +
        `Send separate emails, or use cc/bcc if that fits your use case.`,
      { type: "too_many_recipients" },
    );
  }
  if (!text && !html) {
    throw new ScwError("sendEmail requires `text` and/or `html` body content.", { type: "empty_body" });
  }

  const creds = requireCredentials();
  const temApi = await api(TEM_PRODUCT, TEM_VERSION);
  return sdkCall(() =>
    temApi.createEmail({
      projectId: opts.projectId || creds.projectId,
      from,
      to,
      subject,
      text: text || "",
      html: html || "",
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.bcc ? { bcc: opts.bcc } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    }),
  );
}

/**
 * Endpoint: GET /transactional-email/v1alpha1/regions/{region}/project-consumption
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @returns {Promise<object>}
 */
export async function getConsumption(opts = {}) {
  const creds = requireCredentials();
  const temApi = await api(TEM_PRODUCT, TEM_VERSION);
  return sdkCall(() => temApi.getProjectConsumption({ projectId: opts.projectId || creds.projectId }));
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
        case "ensure-domain": {
          const domain = rest[0];
          if (!domain) throw new Error("usage: tem.mjs ensure-domain <domain>");
          console.log(`▸ ensuring TEM domain "${domain}"...`);
          const d = await ensureDomain(domain);
          console.log(`✅ domain ${d.id} (status: ${d.status})`);
          console.log(JSON.stringify(d));
          break;
        }
        case "records": {
          const domainId = rest[0];
          if (!domainId) throw new Error("usage: tem.mjs records <domain-id>");
          const records = await getDomainRecords(domainId);
          console.log(`▸ ${records.length} record(s) to publish`);
          console.log(JSON.stringify({ domainId, records }));
          break;
        }
        case "check": {
          const domainId = rest[0];
          if (!domainId) throw new Error("usage: tem.mjs check <domain-id>");
          console.log(`▸ triggering DNS re-check for ${domainId}...`);
          const d = await checkDomain(domainId);
          console.log(`✅ status: ${d.status}`);
          console.log(JSON.stringify(d));
          break;
        }
        case "send": {
          const fromEmail = flag("from");
          const toEmail = flag("to");
          const subject = flag("subject");
          const text = flag("text", "");
          if (!fromEmail || !toEmail || !subject) {
            throw new Error('usage: tem.mjs send --from a@x.com --to b@y.com --subject "..." [--text "..."]');
          }
          console.log(`▸ sending email...`);
          const res = await sendEmail({
            from: { email: fromEmail },
            to: [{ email: toEmail }],
            subject,
            text,
          });
          console.log(`✅ sent`);
          console.log(JSON.stringify(res));
          break;
        }
        case "consumption": {
          const c = await getConsumption();
          console.log(`▸ consumption`);
          console.log(JSON.stringify(c));
          break;
        }
        default:
          console.log(
            "usage: tem.mjs <ensure-domain|records|check|send|consumption> ...\n" +
              "  ensure-domain <domain>\n" +
              "  records <domain-id>\n" +
              "  check <domain-id>\n" +
              '  send --from a@x.com --to b@y.com --subject "..." [--text "..."]\n' +
              "  consumption",
          );
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      console.log(JSON.stringify({ error: e.message, type: e.type, status: e.status }));
      process.exit(1);
    }
  })();
}
