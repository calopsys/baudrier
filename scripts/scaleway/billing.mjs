#!/usr/bin/env node
// billing.mjs - Scaleway Billing / consumption.
//
// Talks to the official @scaleway/sdk (`Billing` v2beta1 - NOT v2, which only
// has budgets; consumption lives in v2beta1) via `api()`/`sdkCall()` from
// _scw-auth.mjs. Billing is Organization-scoped, global (no region parameter).
// Reference: https://www.scaleway.com/en/developers/api/billing/
//
// DEVIATION from CONTRACT.md §3: `getProjectCosts({projectId, from, to})` implies
// an arbitrary date range, but the underlying SDK call (`listConsumptions`)
// only accepts a single `billingPeriod` filter at monthly granularity
// (YYYY-MM) - there is no start/end date parameter on this API. We bridge the
// gap by enumerating every calendar month between `from` and `to` (inclusive)
// and summing per-project consumption across them. `from`/`to` accept
// anything `new Date()` can parse (ISO date, "YYYY-MM", a Date instance);
// both default to the current month if omitted.
//
// The SDK's `ListConsumptionsResponseConsumption` type does not carry a
// project-name field the old raw-JSON response had (`project_name`), even
// though the raw payload's `project_id` survives as `projectId` - confirmed
// by reading the SDK's own unmarshalling code, which builds the object from
// an explicit field list that omits it. getConsumption()'s returned
// `items[].projectName` is therefore always `null` now; the key stays for
// shape compatibility but Scaleway's SDK simply does not surface that value
// on this endpoint. Flagging this rather than silently dropping the key.

import { api, sdkCall, requireCredentials, ScwError } from "./_scw-auth.mjs";
import { pathToFileURL } from "node:url";

const round2 = (n) => Math.round(n * 100) / 100;

function moneyToNumber(money) {
  if (!money) return 0;
  const units = Number(money.units || 0);
  const nanos = Number(money.nanos || 0);
  return units + nanos / 1e9;
}

function toYearMonth(input) {
  if (typeof input === "string" && /^\d{4}-\d{2}$/.test(input)) return input;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) {
    throw new ScwError(`invalid date: ${input}`, { type: "invalid_argument" });
  }
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every "YYYY-MM" billing period from `from` to `to`, inclusive, both optional. */
function enumerateBillingPeriods(from, to) {
  const start = from ? toYearMonth(from) : toYearMonth(new Date());
  const end = to ? toYearMonth(to) : toYearMonth(new Date());
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  const periods = [];
  while (y < ey || (y === ey && m <= em)) {
    periods.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  if (periods.length === 0) periods.push(start);
  return periods;
}

/**
 * Sum a Project's consumption across every calendar month between `from` and
 * `to` (see DEVIATION note above). Requires `organizationId` (from
 * credentials by default) because the consumptions endpoint is
 * Organization-scoped and filtered down to a Project.
 * SDK call: Billing.listConsumptions({ organizationId, projectId, billingPeriod })
 * @param {{projectId?:string, from?:string|Date, to?:string|Date, organizationId?:string}} [args]
 * @returns {Promise<{projectId:string, from:string, to:string, currency:string,
 *   totalAmount:number, byCategory:Array<{category:string, amount:number}>,
 *   byPeriod:Array<{billingPeriod:string, amount:number}>}>}
 */
export async function getProjectCosts({ projectId, from, to, organizationId } = {}) {
  const creds = requireCredentials();
  const proj = projectId || creds.projectId;
  const orgId = organizationId || creds.organizationId;
  if (!proj) throw new ScwError("getProjectCosts requires projectId", { type: "invalid_argument" });
  const billing = await api("Billing", "v2beta1");

  const periods = enumerateBillingPeriods(from, to);
  const byCategory = new Map();
  const byPeriod = [];
  let currency = null;

  for (const billingPeriod of periods) {
    const fetched = await sdkCall(() =>
      billing.listConsumptions({ organizationId: orgId, projectId: proj, billingPeriod }).all(),
    );
    // The server-side projectId filter cannot be trusted: a live run returned
    // Organization-wide rows despite it. Each row carries its own projectId,
    // so filter here - only the requested Project's rows are summed.
    const items = fetched.filter((item) => item.projectId === proj);
    let periodTotal = 0;
    for (const item of items) {
      const amount = moneyToNumber(item.value);
      currency = currency || item.value?.currencyCode || null;
      periodTotal += amount;
      byCategory.set(item.categoryName, (byCategory.get(item.categoryName) || 0) + amount);
    }
    byPeriod.push({ billingPeriod, amount: round2(periodTotal) });
  }

  return {
    projectId: proj,
    from: periods[0],
    to: periods[periods.length - 1],
    currency: currency || "EUR",
    totalAmount: round2(byPeriod.reduce((s, p) => s + p.amount, 0)),
    byCategory: [...byCategory.entries()].map(([category, amount]) => ({ category, amount: round2(amount) })),
    byPeriod,
  };
}

/**
 * Current billing period consumption. Scoped to a Project when `opts.projectId`
 * (or the ambient SCW_DEFAULT_PROJECT_ID) is set; otherwise Organization-wide.
 * SDK call: Billing.listConsumptions({ organizationId, projectId, billingPeriod })
 * @param {{projectId?:string, organizationId?:string, billingPeriod?:string}} [opts]
 */
export async function getConsumption(opts = {}) {
  const creds = requireCredentials();
  const proj = opts.projectId || creds.projectId;
  const orgId = opts.organizationId || creds.organizationId;
  const billingPeriod = opts.billingPeriod || toYearMonth(new Date());
  const billing = await api("Billing", "v2beta1");

  const fetched = await sdkCall(() =>
    billing.listConsumptions({ organizationId: orgId, projectId: proj, billingPeriod }).all(),
  );
  // Same client-side filter as getProjectCosts - the server-side projectId
  // filter returned Organization-wide rows on a live run. Without a proj the
  // caller asked for the Organization view, so everything passes.
  const items = proj ? fetched.filter((item) => item.projectId === proj) : fetched;

  let total = 0;
  let currency = null;
  for (const item of items) {
    total += moneyToNumber(item.value);
    currency = currency || item.value?.currencyCode || null;
  }

  return {
    billingPeriod,
    currency: currency || "EUR",
    totalAmount: round2(total),
    items: items.map((i) => ({
      category: i.categoryName,
      product: i.productName,
      resource: i.resourceName,
      sku: i.sku,
      projectId: i.projectId,
      // Not surfaced by the SDK's listConsumptions unmarshalling - see the
      // DEVIATION note at the top of this file.
      projectName: null,
      amount: round2(moneyToNumber(i.value)),
    })),
  };
}

/* ------------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "costs": {
        const [projectId, from, to] = rest;
        console.log(`▸ summing costs for project ${projectId || "(default)"}`);
        const res = await getProjectCosts({ projectId, from, to });
        console.log(`✅ ${res.totalAmount} ${res.currency} across ${res.byPeriod.length} period(s)`);
        console.log(JSON.stringify({ ok: true, ...res }));
        break;
      }
      case "consumption": {
        const [projectId, billingPeriod] = rest;
        console.log(`▸ fetching consumption for ${billingPeriod || "current period"}`);
        const res = await getConsumption({ projectId, billingPeriod });
        console.log(`✅ ${res.totalAmount} ${res.currency} (${res.items.length} line item(s))`);
        console.log(JSON.stringify({ ok: true, ...res }));
        break;
      }
      default:
        console.log("usage: node billing.mjs <costs|consumption> [PROJECT_ID] [FROM] [TO]");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, type: err.type, details: err.details }));
    process.exitCode = 1;
  });
}
