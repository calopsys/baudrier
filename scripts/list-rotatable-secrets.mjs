#!/usr/bin/env node
// list-rotatable-secrets.mjs - List the secrets that CAN actually be rotated
// for the current Scaleway project, classified by how each one is rotated.
//
// Rewritten for the Scaleway stack (CONTRACT.md §2, §3). The old version of
// this script parsed the local `.env` file, because on the previous stack
// every rotatable secret was mirrored there. That assumption no longer
// holds: per scripts/setup-db.mjs, `DATABASE_URL` is stored ONLY in Scaleway
// Secret Manager and deliberately never written to a local file ("the
// operator never connects to a database" - CONTRACT.md §4). Secret Manager
// is therefore the only reliable source of truth for "what secrets does
// this project actually have" - this script queries it directly via
// scripts/scaleway/secrets.mjs#listSecrets(), instead of grepping `.env`.
//
// Usage (run from the project root, needs SCW_* credentials - see
// scripts/scaleway/_scw-auth.mjs):
//   node list-rotatable-secrets.mjs           human-readable menu
//   node list-rotatable-secrets.mjs --json    machine-readable array
//
// The classification table (ROTATABLE) is also imported by
// scripts/rotate-secret.mjs, which does the actual rotation - this file is
// the single source of truth for "what is a known secret and how is it
// rotated", so the two scripts can't drift.

import { listSecrets } from "./scaleway/secrets.mjs";
import { pathToFileURL } from "node:url";

/**
 * Known secret keys and how each is rotated. Strategies:
 *
 *   "auto-generate" - self-managed, no third party involved. A fresh random
 *     value is generated locally and stored. No IAM key is minted.
 *
 *   "iam-single" - backed by a Scaleway IAM Application API key. Rotating
 *     means minting a NEW key under that Application (via iam.mjs) and
 *     storing its secretKey under `key`, then revoking the old key(s).
 *
 *   "iam-pair" - like "iam-single" but the minted key's `accessKey` AND
 *     `secretKey` are both stored, under `key` and `pairKey` respectively.
 *
 *   "vapid-pair" - a Web Push VAPID keypair (public/private), generated via
 *     the `web-push` npm package that lives in the PROJECT's own
 *     node_modules (see scripts/generate-vapid-keys.mjs, which this script
 *     does not duplicate - it is invoked as a separate step by the
 *     rotate-secret skill).
 *
 *   "external" - issued by an external dashboard (not Scaleway), but stored
 *     like every other secret in this app's own Scaleway Project (CONTRACT.md
 *     §2 "Secret Manager naming"). Never mirrored into any container or Job -
 *     read live by local operator tooling only, so rotating it needs no
 *     redeploy.
 *
 * `containerLikely` is a hint only (used for the human menu's wording) -
 * scripts/rotate-secret.mjs never trusts it: it always checks the actual
 * deployed container's `secret_environment_variables` before deciding
 * whether a redeploy is needed (see that file's `syncToContainer()`).
 */
export const ROTATABLE = [
  {
    key: "DATABASE_URL",
    category: "database",
    label: "Connexion à la base de données (Serverless SQL Database)",
    strategy: "database-url",
    containerLikely: true,
    jobNote: "Le Job de migration référence Secret Manager nativement : il lira la nouvelle valeur au prochain déploiement, sans action supplémentaire.",
  },
  {
    key: "STORAGE_ACCESS_KEY",
    pairKey: "STORAGE_SECRET_KEY",
    category: "storage",
    label: "Clé Object Storage (accès + secret)",
    strategy: "iam-pair",
    iamAppName: "<project>-storage",
    permissionSets: ["ObjectStorageFullAccess"],
    containerLikely: true,
  },
  {
    key: "AUTH_SECRET",
    category: "auth",
    label: "Secret de session NextAuth/Auth.js",
    strategy: "auto-generate",
    format: "base64url",
    length: 44,
    containerLikely: true,
  },
  {
    key: "CRON_SECRET",
    category: "internal",
    label: "Jeton de protection des tâches planifiées (/api/cron/*)",
    strategy: "auto-generate",
    format: "hex",
    length: 32,
    containerLikely: true,
  },
  {
    key: "ACCESS_BYPASS_TOKEN",
    category: "internal",
    label: "Jeton du harnais pour traverser le filtre IP (smoke tests)",
    strategy: "auto-generate",
    format: "hex",
    length: 32,
    containerLikely: true,
  },
  {
    key: "VAPID_PUBLIC_KEY",
    pairKey: "VAPID_PRIVATE_KEY",
    category: "push",
    label: "Clés Web Push (VAPID, publique + privée)",
    strategy: "vapid-pair",
    containerLikely: true,
  },
  {
    key: "SCW_GENERATIVE_API_KEY",
    category: "ai",
    label: "Clé Scaleway Generative APIs",
    strategy: "iam-single",
    iamAppName: "baudrier-agents-<project-id>",
    permissionSets: ["GenerativeApisModelAccess"],
    containerLikely: false,
    jobNote: "Si un agent (Serverless Job) l'utilise, il référence Secret Manager nativement : nouvelle valeur prise en compte à sa prochaine exécution, sans redéploiement.",
  },
  {
    key: "TEM_API_SECRET_KEY",
    category: "email-agent",
    label: "Clé Transactional Email de l'agent autonome",
    strategy: "iam-single",
    iamAppName: "baudrier-agents-<project-id>",
    permissionSets: ["TransactionalEmailEmailApiCreate"],
    containerLikely: false,
    jobNote: "Utilisée par le Job de l'agent (voir templates/agent/mail.ts) : référence Secret Manager nativement, nouvelle valeur prise en compte à sa prochaine exécution.",
  },
  {
    key: "MATOMO_TOKEN",
    category: "external",
    label: "Jeton API Matomo",
    strategy: "external",
    dashboardUrl: "https://matomo.org/faq/how-to/create-api-user-in-matomo/",
  },
  {
    key: "PAGESPEED_API_KEY",
    category: "external",
    label: "Clé Google PageSpeed Insights",
    strategy: "external",
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "GSC_SERVICE_ACCOUNT",
    category: "external",
    label: "Clé de compte de service Google Search Console",
    strategy: "external",
    dashboardUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
  },
];

const CATEGORY_TITLES = {
  database: "🗄️ Base de données",
  storage: "📦 Stockage de fichiers",
  auth: "🔐 Connexion",
  internal: "⚙️ Interne au projet",
  push: "🔔 Notifications push",
  ai: "🤖 IA / Generative APIs",
  "email-agent": "📧 Agent - email",
  external: "🔑 Comptes externes",
};

const CATEGORY_ORDER = ["database", "storage", "auth", "internal", "push", "ai", "email-agent", "external"];

function findEntry(key) {
  return ROTATABLE.find((e) => e.key === key || e.pairKey === key) || null;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  // Secrets actually present in this project's Secret Manager (region
  // fr-par, per-app Project - see CONTRACT.md §2 "Secret Manager naming").
  let present = new Set();
  let secretManagerReachable = true;
  try {
    const secrets = await listSecrets();
    present = new Set(secrets.map((s) => s.name));
  } catch (e) {
    secretManagerReachable = false;
    if (!asJson) {
      console.log(`⚠️ Could not reach Scaleway Secret Manager: ${e.message}`);
      console.log("Falling back to the static catalog (presence in this project could not be verified).\n");
    }
  }

  const rows = ROTATABLE.map((entry) => {
    const exists = present.has(entry.key) || (entry.pairKey ? present.has(entry.pairKey) : false);
    return { ...entry, exists, verifiable: secretManagerReachable };
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const known = rows.filter((r) => r.exists);
  const unknown = rows.filter((r) => !r.exists);

  if (known.length === 0) {
    console.log("Aucun secret rotatable trouvé dans ce projet pour l'instant.");
  } else {
    console.log("Voici les clés que vous pouvez renouveler pour ce projet :\n");
    const byCategory = {};
    for (const r of known) {
      (byCategory[r.category] ??= []).push(r);
    }
    let n = 0;
    for (const cat of CATEGORY_ORDER) {
      const items = byCategory[cat];
      if (!items || items.length === 0) continue;
      console.log(`**${CATEGORY_TITLES[cat]}**`);
      for (const r of items) {
        n += 1;
        const names = r.pairKey ? `${r.key} + ${r.pairKey}` : r.key;
        console.log(`  ${n}. ${r.label} (\`${names}\`)`);
        if (r.strategy === "auto-generate") console.log("     - renouvellement automatique, aucune action de votre part");
        if (r.strategy === "database-url") console.log("     - ⚠️ coupe les connexions actives quelques secondes le temps du redéploiement");
        if (r.strategy === "external") console.log(`     - à régénérer sur ${r.dashboardUrl}, puis je la stocke pour vous`);
      }
      console.log("");
    }
    console.log("Dites-moi le numéro (ou le nom de la clé) à renouveler.");
  }

  if (unknown.length > 0) {
    console.log(`\n(${unknown.length} type(s) de secret connus mais absents de ce projet, ignorés : ${unknown.map((r) => r.key).join(", ")})`);
  }
}

/**
 * Look up how a single key is rotated, by exact key or pairKey. Used by
 * scripts/rotate-secret.mjs so the two scripts never disagree.
 * @param {string} key
 * @returns {object|null}
 */
export function classify(key) {
  return findEntry(key);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.log(`⚠️ ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  });
}
