#!/usr/bin/env node
// _destructive-guard.mjs - the last line of defense before this harness (or
// Claude driving it) is allowed to irreversibly destroy a database or a
// bucket.
//
// WHY THIS EXISTS - read this before touching the file:
//
//   - Once a bucket created by this harness has versioning enabled (see
//     object-storage.mjs's ensureBucketVersioning/ensureBucketLifecycle,
//     wired into ensureBucket), the bucket's version history IS the app's
//     only backup of its uploaded files. There is no separate backup product
//     behind Scaleway Object Storage. Deleting the bucket deletes every
//     version of every object, permanently, with nothing left to restore
//     from (see skills/add-storage for the app-side restore path that relies
//     on this history existing).
//   - Scaleway Serverless SQL Database does have automatic daily backups
//     with 7-day retention (confirmed:
//     https://www.scaleway.com/en/docs/serverless-sql-databases/how-to/manage-backups/,
//     "Serverless SQL Databases are automatically backed up every day at the
//     same time. Backups are stored for 7 days.") but there is NO on-demand
//     backup API - nothing in this harness can force a fresh backup right
///    before a deletion, and any database gone for longer than the 7-day
//     window (or deleted between two nightly backups) is unrecoverable
//     through Scaleway's own mechanism.
//
//   Both of those facts mean a mistaken, automated, or LLM-hallucinated call
//   to deleteDatabase()/deleteBucket() is - in practice - permanent, silent
//   data loss for the app's owner. Per direct user requirement: this harness
//   never removes a database or a bucket. This module is what makes that
//   true in code, not just in a comment: both delete functions call
//   assertDestructiveAllowed() as their first statement, before any API call,
//   so there is no path to the Scaleway API that skips this check.
//
// Contract
// --------
//   assertDestructiveAllowed(kind, resourceName)
//     kind:         "database" | "bucket"
//     resourceName: the exact identifier of the resource about to be
//                   destroyed (the value the caller itself uses to address
//                   it - a database id for sdb.mjs, a bucket name for
//                   object-storage.mjs)
//
//   Behaviour:
//     - By default, ALWAYS throws a ScwError. The message is in French (this
//       product is French-only, see CONTRACT.md §1), explains that the
//       harness never deletes databases or buckets, states why (this file's
//       header, condensed), and points at the Scaleway console to do it by
//       hand.
//     - The ONLY escape hatch: a human sets, in their OWN shell (never
//       written by this harness, never by Claude, never persisted anywhere
//       the harness controls), an environment variable naming the EXACT
//       resource:
//         BAUDRIER_ALLOW_DESTRUCTIVE="database:my-app-db"
//         BAUDRIER_ALLOW_DESTRUCTIVE="bucket:my-app-assets"
//       The comparison is a single strict `===` against `"<kind>:<resourceName>"`.
//       No prefix match, no substring match, no regex, no case-folding. A
//       generic value - "true", "1", "all", "*", or any string that isn't
//       precisely this resource's token - is NEVER honoured. There is no
//       blanket override, by construction: the only way to widen the escape
//       hatch is to literally list every resource name in the variable's
//       value, which defeats the point of a shortcut and makes the human's
//       intent unambiguous.
//     - When the override IS present and matches, this function logs loudly
//       (⚠️) naming the resource, then returns normally (does not throw).
//
// This file has no destructive capability itself - it only decides whether
// to let a caller proceed. It imports nothing but ScwError from
// _scw-auth.mjs and has no dependency on any npm package (plugin directory
// has no node_modules - see CONTRACT.md §3).

import { ScwError } from "./_scw-auth.mjs";

const CONSOLE_URL = "https://console.scaleway.com";
const VALID_KINDS = new Set(["database", "bucket"]);

/**
 * Refuse an irreversible deletion unless a human has set a resource-specific
 * override in their own shell. Throws (ScwError) to refuse; returns normally
 * to allow.
 *
 * @param {"database"|"bucket"} kind
 * @param {string} resourceName  the exact id/name the caller is about to delete
 */
export function assertDestructiveAllowed(kind, resourceName) {
  if (!VALID_KINDS.has(kind)) {
    throw new ScwError(
      `assertDestructiveAllowed: type invalide "${kind}" (attendu "database" ou "bucket") - erreur de programmation, ` +
        `pas une action refusée par garde-fou.`,
      { type: "invalid_argument" },
    );
  }
  if (typeof resourceName !== "string" || resourceName.length === 0) {
    throw new ScwError(
      `assertDestructiveAllowed: aucun nom de ressource fourni pour la suppression de type "${kind}" - ` +
        `impossible de vérifier un garde-fou sans savoir quelle ressource est visée.`,
      { type: "invalid_argument" },
    );
  }

  const token = `${kind}:${resourceName}`;
  const override = process.env.BAUDRIER_ALLOW_DESTRUCTIVE;

  if (override === token) {
    console.log(
      `⚠️  BAUDRIER_ALLOW_DESTRUCTIVE défini et honoré pour "${token}" - suppression autorisée par un humain, poursuite de l'appel API.`,
    );
    return;
  }

  const kindFr = kind === "database" ? "une base de données" : "un bucket";
  const whyFr =
    kind === "database"
      ? "Serverless SQL Database n'a pas d'API de sauvegarde à la demande : au-delà de la sauvegarde automatique " +
        "quotidienne (rétention 7 jours), une suppression est définitive et irrattrapable."
      : "l'historique des versions de ce bucket est l'unique sauvegarde des fichiers de cette application - " +
        "il n'existe aucun autre système de sauvegarde derrière Scaleway Object Storage.";

  throw new ScwError(
    `Suppression refusée : ce harness ne supprime jamais ${kindFr} ("${resourceName}"). ` +
      `Raison : ${whyFr} Cette action doit être faite manuellement, par un humain, dans la console Scaleway : ${CONSOLE_URL}. ` +
      `Si vous êtes cet humain, que vous avez conscience que c'est irréversible, et que vous voulez vraiment continuer : ` +
      `relancez la commande dans VOTRE PROPRE terminal (jamais via Claude) avec exactement ` +
      `BAUDRIER_ALLOW_DESTRUCTIVE="${token}" défini au préalable. Aucune autre valeur (ex: "true", "1", "all") n'est acceptée : ` +
      `la variable doit nommer cette ressource précise.`,
    { type: "destructive_action_refused", details: { kind, resourceName } },
  );
}
