#!/usr/bin/env node
// costs.mjs - real spend for the app's Scaleway Project (billing.mjs) plus
// Transactional Email consumption (tem.mjs getConsumption), with limits shown
// against a hardcoded reference table.
//
// IMPORTANT: Scaleway exposes no quota-vs-limit API anywhere in this stack -
// there is no endpoint that says "you've used X of your Y allowance" for TEM
// caps or the Serverless Containers free tier. REFERENCE_LIMITS below is a
// manually maintained table, not a live read, and every place this script
// prints it says so explicitly - never present it as current usage.
//
// billing.mjs's getProjectCosts({from,to}) is billing-PERIOD scoped
// (YYYY-MM), not an arbitrary date range - see that file's header comment.
// This script exposes the same granularity: --from/--to accept "YYYY-MM" (or
// anything Date can parse), defaulting to the current month; --months N is a
// convenience for "the last N calendar months up to now".

import { requireCredentials, resolveProjectId as resolveScwProjectId, deriveAppName } from "./scaleway/_scw-auth.mjs";
import { getProjectCosts } from "./scaleway/billing.mjs";
import { getConsumption as getTemConsumption } from "./scaleway/tem.mjs";
import { credentialShape } from "./scaleway/app-credentials.mjs";
import { pathToFileURL } from "node:url";

// BillingReadOnly (CONTRACT.md §1) is organization-scoped, so a Project-scoped
// key (credentialShape() === "project") 403s on getProjectCosts(). The spend
// figure is then unavailable, not the whole command: TEM consumption still
// works on a Project-scoped key, so the command degrades instead of failing.
const BILLING_UNAVAILABLE_MESSAGE =
  "Le montant dépensé nécessite un droit de niveau organisation (BillingReadOnly) que cette clé Scaleway " +
  "ne porte pas. Consultez le montant réel dans la console Scaleway, rubrique Facturation.";

// The APP's own Project, not the operator's default one - resolved by name
// (CONTRACT.md §2, §7: app repos carry no Scaleway metadata at all).
// SCW_DEFAULT_PROJECT_ID is the operator's default Project and reports the
// wrong numbers when this script runs inside an app directory, unless that
// env var IS the intended override (resolveProjectId() honours it before any
// by-name lookup).
async function resolveProjectId(creds) {
  const explicit = flag("project-id");
  if (typeof explicit === "string") return { projectId: explicit, projectSource: "flag" };
  try {
    const projectId = await resolveScwProjectId({ appName: deriveAppName() });
    return { projectId, projectSource: "name-lookup" };
  } catch {
    // no override, no session cache, and the by-name lookup failed (missing
    // rights or no match) - fall through to the operator's default Project
    return { projectId: creds.projectId, projectSource: "default-project" };
  }
}

// Manually maintained - refresh by hand if Scaleway changes these (see file
// header: there is no API to read them live).
//   - TEM caps: CONTRACT.md §3 / Scaleway TEM docs (pre-KYC vs post-KYC).
//   - Serverless Containers free tier: scaleway.com/en/pricing/serverless/
//     (checked 2026-07-30): 200,000 vCPU-s and 400,000 GB-s per account per
//     month before billing starts.
const REFERENCE_LIMITS = [
  { service: "Transactional Email (TEM)", limit: "500 emails/mois, 2 domaines (avant KYC)", note: "passe à 5 000 emails/mois et 5 domaines après vérification d'identité" },
  { service: "Transactional Email (TEM)", limit: "3 destinataires max par email", note: "pas de contournement API" },
  { service: "Serverless Containers", limit: "200 000 vCPU-s + 400 000 GB-s gratuits/mois", note: "par compte, tous conteneurs confondus" },
  { service: "Container Registry", limit: "aucune politique de rétention", note: "le harnais purge lui-même les anciens tags via /deploy" },
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

if (argv.includes("--help")) {
  console.log(
    "usage: costs.mjs [--from YYYY-MM] [--to YYYY-MM] [--months N] [--project-id ID]\n" +
      "  --from / --to    billing periods (YYYY-MM), default: current month\n" +
      "  --months N       convenience: last N calendar months up to now (overridden by --from/--to)\n" +
      "  --project-id     default: the app's Project resolved by name (repo name),\n" +
      "                   then SCW_DEFAULT_PROJECT_ID as a last resort\n",
  );
  process.exit(0);
}

function computeFromTo() {
  let from = flag("from");
  let to = flag("to");
  if (from || to) return { from, to };
  const months = Number(flag("months", 1));
  const now = new Date();
  to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { from, to };
}

/* --------------------------------------------------------------- helpers */

// tem.mjs's getConsumption() passes through TEM's /project-consumption
// response verbatim - its exact field names aren't nailed down in this
// codebase, so extract defensively instead of assuming one shape.
function extractEmailCount(raw) {
  if (!raw || typeof raw !== "object") return null;
  for (const key of ["sent_count", "emails_sent", "total_sent", "sent", "count"]) {
    if (typeof raw[key] === "number") return raw[key];
  }
  return null;
}

/* ---------------------------------------------------------------- main */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (async () => {
    const creds = requireCredentials();
    const { projectId, projectSource } = await resolveProjectId(creds);
    const { from, to } = computeFromTo();

    if (projectSource === "default-project") {
      console.log(
        "⚠️ Projet Scaleway de cette application introuvable par nom : les coûts affichés sont ceux du projet " +
          "Scaleway par défaut de l’opérateur, pas forcément ceux d’une application. Lancez cette commande " +
          "depuis le dossier d’un projet (dépôt git), ou passez --project-id.",
      );
    }
    console.log(`▸ calcul des coûts réels du projet Scaleway ${projectId} (${from} → ${to})`);
    // credentialShape() itself can throw (e.g. shape_deadlock) - a probe
    // failure must not take the whole command down, so it degrades to
    // "unknown" and falls through to the 403 catch below instead.
    let shape = "unknown";
    try {
      shape = await credentialShape();
    } catch {
      shape = "unknown";
    }
    let costs = null;
    if (shape === "project") {
      console.log(`⚠️ ${BILLING_UNAVAILABLE_MESSAGE}`);
    } else {
      try {
        costs = await getProjectCosts({ projectId, from, to });
        console.log(`✅ ${costs.totalAmount} ${costs.currency} au total sur la période`);
      } catch (e) {
        if (e?.status !== 403) throw e;
        console.log(`⚠️ ${BILLING_UNAVAILABLE_MESSAGE}`);
      }
    }

    console.log("▸ récupération de la consommation Transactional Email (TEM)");
    let temRaw = null;
    let temError = null;
    try {
      temRaw = await getTemConsumption({ projectId });
    } catch (e) {
      temError = e.message;
    }
    const emailsSent = extractEmailCount(temRaw);
    if (temError) console.log(`⚠️ consommation TEM indisponible: ${temError}`);
    else console.log(`✅ TEM: ${emailsSent === null ? "consommation lue (détail brut ci-dessous)" : `${emailsSent} email(s) envoyé(s)`}`);

    console.log("\n────────────────────────────────────────────────────────");
    console.log(`Coûts Scaleway - projet ${projectId} - ${from} → ${to}`);
    console.log("────────────────────────────────────────────────────────");
    if (costs) {
      console.log(`Total : ${costs.totalAmount} ${costs.currency}`);
      if (costs.byCategory.length) {
        console.log("\nPar service :");
        for (const c of [...costs.byCategory].sort((a, b) => b.amount - a.amount)) {
          console.log(`  - ${c.category}: ${round2(c.amount)} ${costs.currency}`);
        }
      } else {
        console.log("\nAucune ligne de coût sur cette période (compte probablement dans son quota gratuit).");
      }
      if (costs.byPeriod.length > 1) {
        console.log("\nPar mois :");
        for (const p of costs.byPeriod) console.log(`  - ${p.billingPeriod}: ${round2(p.amount)} ${costs.currency}`);
      }
    } else {
      console.log(`Total : indisponible. ${BILLING_UNAVAILABLE_MESSAGE}`);
    }

    console.log(
      `\nEmail transactionnel (TEM) : ${emailsSent === null ? "détail non normalisé, voir JSON" : `${emailsSent} email(s) envoyé(s) ce mois-ci`}`,
    );

    console.log(
      "\n⚠️  Les limites ci-dessous sont des valeurs de référence FIXES, maintenues à la main dans ce script -\n" +
        "    Scaleway ne fournit aucune API pour lire l'usage en temps réel par rapport à un quota.\n" +
        "    Elles ne reflètent PAS votre consommation réelle, seulement ce que Scaleway autorise en général.",
    );
    for (const l of REFERENCE_LIMITS) {
      console.log(`  - ${l.service} : ${l.limit} (${l.note})`);
    }
    console.log("────────────────────────────────────────────────────────");

    console.log(
      JSON.stringify({
        ok: true,
        projectId,
        projectSource,
        from,
        to,
        currency: costs?.currency ?? null,
        totalAmount: costs?.totalAmount ?? null,
        byCategory: costs?.byCategory ?? [],
        byPeriod: costs?.byPeriod ?? [],
        billingUnavailable: costs === null ? BILLING_UNAVAILABLE_MESSAGE : null,
        tem: { emailsSent, raw: temRaw, error: temError },
        referenceLimits: REFERENCE_LIMITS,
        referenceLimitsAreLive: false,
      }),
    );
  })().catch((e) => {
    console.log(`⚠️ ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message, type: e.type, details: e.details }));
    process.exitCode = 1;
  });
}
