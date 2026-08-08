// src/server/mail.ts
//
// Sends transactional email via Scaleway Transactional Email (TEM) - the only
// email provider in this harness (see CONTRACT.md). TEM has no templating
// engine on its side (unlike some other providers): you render the full HTML
// yourself before calling sendMail().
//
// TEM also enforces two hard limits server-side. Both are checked here first
// so a mistake fails fast with a clear French message instead of an opaque
// 400 from the API:
//   - the subject must be at least 10 characters
//   - at most 3 recipients per email
//
// `TEM_SENDER_EMAIL` / `TEM_SENDER_NAME` are written to this project's
// Scaleway Secret Manager (and mirrored into the container's
// `secret_environment_variables` at deploy time, see CONTRACT.md §1) by the
// /add-email skill, once its Scaleway TEM domain has been verified.
//
// Sending requires an authenticated call to the TEM API (`X-Auth-Token`).
// That credential is `TEM_API_SECRET_KEY`: a dedicated, IAM-scoped API key
// carrying only the TransactionalEmail permission set, minted per project and
// stored in Secret Manager. It is deliberately NOT the operator's own Scaleway
// secret key, which can administer the whole Project and must never reach a
// running app. This mirrors how `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`
// scope Object Storage access.

const TEM_API_URL =
  "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails";
const MIN_SUBJECT_LENGTH = 10;
const MAX_RECIPIENTS = 3;

/**
 * Escape user-provided or error-derived text before inserting it into an
 * email's HTML body (`<`, `>`, `&`, `"`, `'`). TEM does not run any
 * server-side templating pass on the body, so - unlike some other providers -
 * there is no `{{`/`}}` trap to defuse here; standard HTML-escaping is enough.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface SendMailOptions {
  /** One address, or up to 3 - TEM rejects more. */
  to: string | string[];
  /** Must be >= 10 characters - TEM rejects shorter subjects with a 400. */
  subject: string;
  html?: string;
  text?: string;
  from?: { email: string; name?: string };
}

/**
 * Send a transactional email via Scaleway TEM. Throws a plain-French `Error`
 * on any of TEM's hard limits (subject length, recipient count, empty body)
 * before ever calling the API, and on an API-level failure.
 */
export async function sendMail(options: SendMailOptions): Promise<void> {
  const recipients = (Array.isArray(options.to) ? options.to : [options.to]).filter(
    (addr): addr is string => Boolean(addr),
  );

  if (!options.subject || options.subject.length < MIN_SUBJECT_LENGTH) {
    throw new Error(
      `Le sujet d’un email doit contenir au moins ${MIN_SUBJECT_LENGTH} caractères ` +
        `(reçu : ${options.subject?.length ?? 0} caractère(s)). Scaleway TEM refuse les sujets trop courts.`,
    );
  }
  if (recipients.length === 0) {
    throw new Error("sendMail nécessite au moins un destinataire.");
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(
      `Scaleway TEM autorise au maximum ${MAX_RECIPIENTS} destinataires par email ` +
        `(reçu : ${recipients.length}). Envoyez plusieurs emails séparés, ou utilisez la fonctionnalité cc/bcc.`,
    );
  }
  if (!options.html && !options.text) {
    throw new Error("sendMail nécessite un contenu `html` et/ou `text`.");
  }

  const apiKey = process.env.TEM_API_SECRET_KEY;
  if (!apiKey) {
    throw new Error(
      "Impossible d’envoyer cet email : la clé Scaleway (TEM_API_SECRET_KEY) n’est pas configurée sur ce serveur.",
    );
  }
  if (!process.env.TEM_SENDER_EMAIL) {
    throw new Error(
      "Impossible d’envoyer cet email : aucune adresse d’expédition configurée (TEM_SENDER_EMAIL manquante). Lancez /add-email.",
    );
  }

  const res = await fetch(TEM_API_URL, {
    method: "POST",
    headers: {
      "X-Auth-Token": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: options.from ?? {
        email: process.env.TEM_SENDER_EMAIL,
        name: process.env.TEM_SENDER_NAME ?? "App",
      },
      to: recipients.map((email) => ({ email })),
      subject: options.subject,
      ...(options.text ? { text: options.text } : {}),
      ...(options.html ? { html: options.html } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Échec de l’envoi de l’email (Scaleway TEM, HTTP ${res.status}). ` +
        `Le domaine d’envoi est peut-être encore en cours de vérification (jusqu’à 48h). ${body}`.trim(),
    );
  }
}
