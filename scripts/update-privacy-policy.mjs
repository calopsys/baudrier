#!/usr/bin/env node
// update-privacy-policy.mjs - Idempotently add or remove subprocessors in
// the project's RGPD subprocessors registry.
//
// Architecture:
//   - Data lives in `<web-root>/src/lib/subprocessors.json` (just an array of
//     entries). The script edits this file deterministically.
//   - A thin TS wrapper at `<web-root>/src/lib/subprocessors.ts` re-exports
//     the JSON with a typed signature. The page imports from the TS file.
//   - The page itself (`src/app/.../politique-de-confidentialite/page.tsx`)
//     is generated once by /bootstrap as a pure renderer over the registry.
//     It is never touched by this script - only the data file is.
//
// Usage:
//   node update-privacy-policy.mjs --add scaleway
//   node update-privacy-policy.mjs --add scaleway-sdb --add scaleway-object-storage
//   node update-privacy-policy.mjs --remove matomo
//   node update-privacy-policy.mjs --list
//   node update-privacy-policy.mjs --catalog
//
// Runs from the project root (where package.json or apps/web/package.json lives).
//
// IMPORTANT: everything below the CATALOG is guarded behind the standard
// `if (import.meta.url === pathToFileURL(process.argv[1]).href)` CLI check (same
// convention as scripts/scaleway/*.mjs). Merely `import()`-ing this module
// (e.g. from tooling that wants to introspect it) must be side-effect-free -
// it must NOT parse argv, detect a web root, or call process.exit. Before
// this guard existed, any bare import from a directory with no
// package.json/apps/web/package.json (e.g. this plugin repo's own root)
// crashed the whole process via detectWebRoot()'s process.exit(1), which is
// exactly the failure the harness's own smoke test caught.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// ─── Catalogue des sous-traitants connus ──────────────────────────────────
// Toutes les valeurs sont en français : ce produit est mono-lingue par
// conception (CONTRACT.md §1 - "The product is French-only. There is no
// i18n."). Une précédente version de ce script portait un mécanisme
// `i18n`/`--add-i18n` pour traduire ces champs ; il n'a jamais été appelé par
// aucun autre skill (le seul template de page existant,
// templates/privacy-policy/plain.tsx, est également mono-lingue) et
// référençait un skill /add-i18n depuis retiré du fork. Retiré ici plutôt
// que laissé comme code mort qui contredit CONTRACT.md.
//
// Les entrées correspondent une-pour-une aux appels `--add <key>` faits par
// les skills /add-* du plugin (grep fait sur tout le dépôt pour la liste
// exacte des clés utilisées) :
//   - scaleway                 <- /bootstrap (hébergement Serverless Containers)
//   - scaleway-sdb             <- /add-db (Serverless SQL Database)
//   - scaleway-object-storage  <- /add-storage (Object Storage)
//   - scaleway-tem             <- /add-email (Transactional Email)
//   - scaleway-generative      <- détecté par rgpd-audit.mjs (Generative APIs, LLM/embeddings)
//   - matomo                   <- /add-analytics (mesure d'audience cookieless)
//
// Les quatre entrées Scaleway partagent la même entité juridique (Scaleway
// SAS, société française, région fr-par = Paris) mais sont déclarées
// séparément car chacune correspond à une finalité de traitement distincte
// (hébergement applicatif, base de données, stockage de fichiers, email) -
// c'est la pratique attendue pour un registre RGPD, même quand le
// sous-traitant technique est identique. C'est aussi ce que les skills
// appelantes attendent (quatre clés distinctes, câblées en dur).
const CATALOG = {
  scaleway: {
    name: "Scaleway SAS",
    address: "8 rue de la Ville l'Évêque, 75008 Paris, France",
    country: "FR",
    purpose:
      "Hébergement de l'application (Scaleway Serverless Containers) et du registre d'images Docker (Container Registry), région Paris (fr-par)",
    dataTypes: ["Adresses IP", "Logs applicatifs et d'accès", "Cookies de session (si authentification activée)"],
    retention: "Logs conservés selon la politique de rétention de Scaleway Cockpit (30 jours par défaut, configurable)",
    legalBasis: "Exécution du contrat (art. 6.1.b RGPD)",
    isEUResident: true,
    transferMechanism:
      "Aucun transfert hors UE : hébergement à 100% en France (région fr-par, Paris), Scaleway SAS est une société de droit français.",
    privacyUrl: "https://www.scaleway.com/en/privacy-policy/",
    dpaUrl: "https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf",
  },
  "scaleway-sdb": {
    name: "Scaleway SAS",
    address: "8 rue de la Ville l'Évêque, 75008 Paris, France",
    country: "FR",
    purpose: "Hébergement de la base de données PostgreSQL (Scaleway Serverless SQL Database), région Paris (fr-par)",
    dataTypes: ["Toutes les données applicatives stockées en base"],
    retention:
      "Durée de vie du projet (suppression sur demande) ; sauvegarde automatique quotidienne, rétention 7 jours",
    legalBasis: "Exécution du contrat (art. 6.1.b RGPD)",
    isEUResident: true,
    transferMechanism: "Aucun transfert hors UE : base de données hébergée en France (région fr-par).",
    privacyUrl: "https://www.scaleway.com/en/privacy-policy/",
    dpaUrl: "https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf",
  },
  "scaleway-object-storage": {
    name: "Scaleway SAS",
    address: "8 rue de la Ville l'Évêque, 75008 Paris, France",
    country: "FR",
    purpose: "Stockage et distribution de fichiers (objets uploadés par les utilisateurs), région Paris (fr-par)",
    dataTypes: ["Fichiers uploadés par les utilisateurs", "Métadonnées (nom, type MIME, taille)"],
    retention: "Durée de vie du projet (suppression sur demande, ou immédiate si l'application supprime l'objet)",
    legalBasis: "Exécution du contrat (art. 6.1.b RGPD)",
    isEUResident: true,
    transferMechanism: "Aucun transfert hors UE : stockage hébergé en France (région fr-par).",
    privacyUrl: "https://www.scaleway.com/en/privacy-policy/",
    dpaUrl: "https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf",
  },
  "scaleway-tem": {
    name: "Scaleway SAS",
    address: "8 rue de la Ville l'Évêque, 75008 Paris, France",
    country: "FR",
    purpose:
      "Envoi d'emails transactionnels (notifications, réinitialisation de mot de passe, formulaire de contact) via Scaleway Transactional Email (TEM), région Paris (fr-par)",
    dataTypes: ["Adresse email destinataire", "Contenu des emails envoyés"],
    retention: "Historique d'envoi et de consommation conservé selon le tableau de bord Scaleway TEM",
    legalBasis: "Exécution du contrat (art. 6.1.b RGPD)",
    isEUResident: true,
    transferMechanism: "Aucun transfert hors UE : service hébergé en France (région fr-par).",
    privacyUrl: "https://www.scaleway.com/en/privacy-policy/",
    dpaUrl: "https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf",
  },
  "scaleway-generative": {
    name: "Scaleway SAS",
    address: "8 rue de la Ville l'Évêque, 75008 Paris, France",
    country: "FR",
    purpose:
      "Fonctions d'assistance / intelligence artificielle de l'application (Scaleway Generative APIs - modèles de langage et embeddings), région Paris (fr-par) : le contenu envoyé par ces fonctions est transmis au modèle pour générer une réponse",
    dataTypes: ["Le contenu traité par ces fonctions (texte saisi ou généré, selon les fonctionnalités activées)"],
    retention: "Selon la politique de rétention de Scaleway Generative APIs (voir la documentation Scaleway)",
    legalBasis: "Exécution du contrat (art. 6.1.b RGPD)",
    isEUResident: true,
    transferMechanism: "Aucun transfert hors UE : traitement hébergé en France (région fr-par), Scaleway SAS est une société de droit français.",
    privacyUrl: "https://www.scaleway.com/en/privacy-policy/",
    dpaUrl: "https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf",
  },
  matomo: {
    name: "InnoCraft Limited (Matomo Cloud) ou hébergement propre",
    address: "7 Waterloo Quay, PO Box 625, 6140 Wellington, Nouvelle-Zélande (si Matomo Cloud)",
    country: "NZ",
    purpose:
      "Mesure d'audience anonyme et sans cookies (Matomo), dispensée de bandeau de consentement selon les critères d'exemption de la CNIL. Si l'instance est Matomo Cloud, le sous-traitant est InnoCraft Limited (Nouvelle-Zélande) ; si Matomo est auto-hébergé (par exemple sur un conteneur Scaleway du projet), aucun sous-traitant supplémentaire n'est introduit et les données restent couvertes par l'entrée Scaleway déjà présente dans ce registre.",
    dataTypes: [
      "Pages visitées",
      "Référent (source de trafic)",
      "Type d'appareil / navigateur (User-Agent)",
      "Pays approximatif (adresse IP anonymisée immédiatement après géolocalisation, jamais conservée)",
    ],
    retention: "Données agrégées uniquement ; aucune donnée individuellement identifiable conservée",
    legalBasis:
      "Intérêt légitime - mesure d'audience anonyme dispensée de consentement (exemption CNIL, tracking sans cookie)",
    isEUResident: false,
    transferMechanism:
      "Si Matomo Cloud : InnoCraft Limited est basée en Nouvelle-Zélande, un pays bénéficiant d'une décision d'adéquation de la Commission européenne - aucune clause contractuelle type additionnelle requise. Les données sont techniquement stockées dans l'UE (Allemagne, avec sauvegardes en Irlande). Si auto-hébergé : aucun transfert, les données restent sur l'infrastructure choisie par le projet (typiquement Scaleway, France).",
    privacyUrl: "https://matomo.org/matomo-cloud-privacy-policy/",
    dpaUrl: "https://matomo.org/matomo-cloud-dpa/",
    requiresConsent: false,
  },
};

/* ------------------------------------------------------------------------ CLI */
// Everything below only runs when this file is executed directly (`node
// update-privacy-policy.mjs ...`), never on a bare `import()`/`import ... from`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // ─── Args parsing ───────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const adds = [];
  const removes = [];
  let action = "update";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--add") {
      adds.push(args[++i]);
    } else if (a === "--remove") {
      removes.push(args[++i]);
    } else if (a === "--list") {
      action = "list";
    } else if (a === "--catalog") {
      action = "catalog";
    } else if (a === "--help" || a === "-h") {
      action = "help";
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }

  if (action === "help") {
    console.log(`Usage:
  node update-privacy-policy.mjs --add <key> [--add <key>...]
  node update-privacy-policy.mjs --remove <key>
  node update-privacy-policy.mjs --list
  node update-privacy-policy.mjs --catalog

Known keys: ${Object.keys(CATALOG).join(", ")}`);
    process.exit(0);
  }

  if (action === "catalog") {
    console.log(JSON.stringify(CATALOG, null, 2));
    process.exit(0);
  }

  // ─── Project root detection ─────────────────────────────────────────────
  const detectWebRoot = () => {
    const cwd = process.cwd();
    if (existsSync(join(cwd, "apps/web/package.json"))) return join(cwd, "apps/web");
    if (existsSync(join(cwd, "package.json"))) return cwd;
    console.error("[update-privacy-policy] Cannot detect web root: no package.json at ./ or ./apps/web/");
    process.exit(1);
  };

  const WEB_ROOT = detectWebRoot();
  const DATA_FILE = join(WEB_ROOT, "src/lib/subprocessors.json");
  const TS_WRAPPER = join(WEB_ROOT, "src/lib/subprocessors.ts");

  // ─── Load registry ───────────────────────────────────────────────────────
  const loadRegistry = () => {
    if (!existsSync(DATA_FILE)) return [];
    try {
      return JSON.parse(readFileSync(DATA_FILE, "utf8"));
    } catch (e) {
      console.error(`[update-privacy-policy] Cannot parse ${DATA_FILE}: ${e.message}`);
      process.exit(1);
    }
  };

  // ─── Save registry ───────────────────────────────────────────────────────
  const saveRegistry = (registry) => {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(registry, null, 2) + "\n", "utf8");

    // Ensure the TS wrapper is up to date. We rewrite it every time so the
    // exported type stays in sync with the JSON shape (e.g. when we extend the
    // schema with new optional fields).
    const tsContent = `import data from "./subprocessors.json";

export type Subprocessor = {
  key: string;
  name: string;
  address: string;
  country: string;
  purpose: string;
  dataTypes: string[];
  retention: string;
  legalBasis: string;
  isEUResident: boolean;
  transferMechanism: string | null;
  privacyUrl: string;
  dpaUrl?: string;
  requiresConsent?: boolean;
  // Hand-added for a subprocessor rgpd-audit.mjs cannot grep-detect (e.g.
  // openfreemap - no dependency, no env var, no source string to look for).
  // The audit's stale filter skips any key marked this way.
  manual?: boolean;
};

export const SUBPROCESSORS: Subprocessor[] = data;
`;
    writeFileSync(TS_WRAPPER, tsContent, "utf8");
  };

  // ─── Actions ──────────────────────────────────────────────────────────────
  const registry = loadRegistry();

  if (action === "list") {
    if (registry.length === 0) {
      console.log("(empty)");
    } else {
      for (const e of registry) console.log(`  ${e.key.padEnd(20)} ${e.name}`);
    }
    process.exit(0);
  }

  const reports = [];

  for (const key of adds) {
    if (!CATALOG[key]) {
      console.error(`[update-privacy-policy] Unknown key: ${key}`);
      console.error(`Known: ${Object.keys(CATALOG).join(", ")}`);
      process.exit(2);
    }
    const entry = { key, ...CATALOG[key] };
    const idx = registry.findIndex((e) => e.key === key);
    if (idx >= 0) {
      registry[idx] = entry;
      reports.push(`replaced  ${key}`);
    } else {
      registry.push(entry);
      reports.push(`added     ${key}`);
    }
  }

  for (const key of removes) {
    const idx = registry.findIndex((e) => e.key === key);
    if (idx >= 0) {
      registry.splice(idx, 1);
      reports.push(`removed   ${key}`);
    } else {
      reports.push(`skip      ${key} (not present)`);
    }
  }

  if (adds.length === 0 && removes.length === 0) {
    console.error("Nothing to do. Use --add, --remove, --list or --catalog.");
    process.exit(2);
  }

  saveRegistry(registry);

  console.log(`[update-privacy-policy] ${DATA_FILE}`);
  for (const r of reports) console.log(`  ${r}`);
  console.log(`Total: ${registry.length} subprocessor(s)`);
}
