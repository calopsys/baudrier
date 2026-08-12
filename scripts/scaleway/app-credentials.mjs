#!/usr/bin/env node
// app-credentials.mjs - the operator's own Scaleway key, handed to the app
// (CONTRACT.md §1, §2).
//
// The harness gets two credential shapes and no delegation:
//   - Cas A: the environment's key is an organization admin. /bootstrap
//     mints one scoped IAM key per service connection into Secret Manager
//     (iam.mjs). The environment key never reaches the app.
//   - Cas B: the environment's key is an IAM application scoped to a single
//     Project. The harness mints nothing; that same key serves every
//     connection, permanently, and does reach the app (storage, AI, email).
//     This is why the module is named for what it now is, not for a
//     temporary dev state - the name used to be dev-credentials.mjs.
//
// operatorKeyAsAppCredential() below is the ONLY function in the repository
// that may read SCW_SECRET_KEY and hand it out as an application credential.
// It always probes organization reach first (check-scw-permissions.mjs) and
// refuses when the key has any: an organization-scoped key must never become
// an app credential.

import { loadCredentials, requireCredentials, api, sdkCall, ScwError } from "./_scw-auth.mjs";
import { probeOrgReach } from "../check-scw-permissions.mjs";
import { pathToFileURL } from "node:url";

/**
 * Resolve the IAM principal behind the operator's own personal key, for use
 * as the "username" half of a Serverless SQL Database connection string
 * (CONTRACT.md §4 - the DB "user" is an IAM Application id, or here, the
 * operator's own user/application id).
 *
 * In Cas B this is the NORMAL path for every database connection, not a
 * fallback: one Project-scoped key serves every addon, permanently, so
 * there is nothing else to fall back from.
 *
 * SCW_DEFAULT_APPLICATION_ID is tried first: credentialShape() defines Cas B
 * by the fact that this same key gets a 403 reading its own IAM record, so
 * the key cannot fetch its own principal id. Only when that variable is
 * unset does this fall back to the IAM read.
 *
 * SDK call: Iam.getAPIKey({ accessKey }) - the key object carries `userId`
 * for a user-held key, or `applicationId` for an application-held one.
 * @returns {Promise<{principalId:string, secretKey:string}>}
 */
export async function devDbCredentials() {
  const creds = requireCredentials();

  if (creds.applicationId) return { principalId: creds.applicationId, secretKey: creds.secretKey };

  const iam = await api("Iam", "v1alpha1");
  let key;
  try {
    key = await sdkCall(() => iam.getAPIKey({ accessKey: creds.accessKey }));
  } catch (e) {
    if (e?.type !== "permission_denied" && e?.status !== 403 && e?.status !== 401) throw e;
    throw new ScwError(
      `Impossible de lire votre clé IAM (${e.status ?? "?"} ${e.message}). Il ne manque que ` +
        "l’identifiant de l’application IAM qui porte cette clé, ce qui n’est pas un secret. " +
        "Dans la console Scaleway : IAM → Clés API → repérez la ligne de votre SCW_ACCESS_KEY, " +
        "ouvrez l’application qui porte cette clé, et copiez son identifiant. Définissez ensuite " +
        "SCW_DEFAULT_APPLICATION_ID avec cette valeur dans l’environnement, puis relancez.",
      { type: "needs_application_id", status: e.status, details: { cause: e.message, causeStatus: e.status } },
    );
  }

  // Any IAM principal id works as the Serverless SQL username, user or
  // application - the harness normally hands out application-held keys.
  const principalId = key?.userId || key?.applicationId;
  if (!principalId) {
    throw new ScwError(
      "Impossible de déterminer le principal IAM de votre clé personnelle : " +
        "ni identifiant utilisateur ni identifiant application n’a été trouvé.",
      { type: "principal_unresolved" },
    );
  }
  return { principalId, secretKey: creds.secretKey };
}

// Memoised for the LIFETIME OF THIS PROCESS ONLY. A permission verdict is not
// an identifier - unlike the Project-id cache in _scw-auth.mjs, this must
// never be written to disk or outlive the process (CONTRACT.md §7).
let _probe = null;
function probeOnce() {
  if (!_probe) _probe = probeOrgReach();
  return _probe;
}

/**
 * A key with ProjectManager but no IAMManager: it has organization reach but
 * cannot mint a scoped key, and it cannot be handed to an app either. Both
 * exits fix the key's shape, not the code around it.
 */
function deadlockError() {
  return new ScwError(
    "Cette clé peut agir au niveau de l’organisation mais ne peut pas créer de clés IAM " +
      "déléguées : il lui manque la permission IAMManager. Deux solutions sont possibles : " +
      "ajoutez la permission IAMManager à cette clé, ou utilisez une clé restreinte à un seul " +
      "Project et renseignez SCW_DEFAULT_PROJECT_ID.",
    { type: "shape_deadlock" },
  );
}

/**
 * Which credential shape the operator's key has, without requesting the
 * credential pair itself - a skill calls this to branch before it acts
 * (mint a scoped key itself vs. call operatorKeyAsAppCredential()).
 * Throws `shape_deadlock` for the one shape that lets no branch proceed:
 * organization reach with no minting right (see deadlockError() above).
 * @returns {Promise<"org"|"project"|"unknown">}
 */
export async function credentialShape() {
  const probe = await probeOnce();
  if (!probe.conclusive) return "unknown";
  if (probe.orgReach && !probe.canMint) throw deadlockError();
  return probe.orgReach ? "org" : "project";
}

/**
 * The ONLY function in the repository that may read the operator's own
 * SCW_SECRET_KEY and hand it out as an application credential.
 *
 * Always probes organization reach first (probeOrgReach()) and refuses
 * before ever reading the credential pair:
 *   1. an inconclusive probe fails closed (`shape_unknown`) - never guess;
 *   2. organization reach with no minting right is the deadlock shape
 *      (`shape_deadlock`);
 *   3. any other organization reach is refused outright (`org_key_refused`) -
 *      that key must mint a scoped key instead;
 *   4. otherwise the key is Project-scoped (Cas B) and its pair is returned.
 * @param {{purpose:string}} args  short consumer name for the refusal
 *   message, e.g. "object-storage", "generative-api", "transactional-email",
 *   "database"
 * @returns {Promise<{accessKey:string, secretKey:string}>}
 */
export async function operatorKeyAsAppCredential({ purpose }) {
  const probe = await probeOnce();

  if (!probe.conclusive) {
    throw new ScwError(
      `Impossible de vérifier avec certitude la portée de votre clé Scaleway : la vérification ` +
        `a échoué autrement que par un refus net. Par prudence, elle n’est pas transmise comme ` +
        `identifiant pour « ${purpose} ». Réessayez ; si le problème persiste, vérifiez la ` +
        `connexion réseau vers l’API Scaleway.`,
      { type: "shape_unknown" },
    );
  }

  if (probe.orgReach) {
    if (!probe.canMint) throw deadlockError();
    throw new ScwError(
      `Votre clé Scaleway a une portée d’organisation : une clé d’organisation ne doit jamais ` +
        `servir d’identifiant d’application, ici pour « ${purpose} ». Utilisez /bootstrap pour ` +
        `créer une clé IAM dédiée à ce Project, ou fournissez une clé restreinte à un seul ` +
        `Project (SCW_DEFAULT_PROJECT_ID).`,
      { type: "org_key_refused" },
    );
  }

  const { accessKey, secretKey } = loadCredentials();
  return { accessKey, secretKey };
}

/* ------------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case "shape": {
        const shape = await credentialShape();
        console.log(JSON.stringify({ ok: true, shape }));
        break;
      }
      default:
        console.log("usage: node app-credentials.mjs shape");
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.log(`⚠️ ${err.message}`);
    console.log(JSON.stringify({ ok: false, type: err.type, reason: err.message }));
    process.exitCode = 1;
  });
}
