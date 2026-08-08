// agent/mail.ts - Minimal Scaleway Transactional Email (TEM) client for the
// agent Job process.
//
// The agent runs as its own Scaleway Serverless Job (apps/<agent-name>/), a
// separate process from the Next.js app, so it can't import the app's own
// mail helper - it talks to the TEM HTTP API directly instead. This mirrors
// how the operator-side scripts/scaleway/tem.mjs works, but with an
// application-scoped IAM key instead of the harness's own SCW_SECRET_KEY
// (the deployed Job must never hold full-project harness credentials).
//
// API: POST https://api.scaleway.com/transactional-email/v1alpha1/regions/{region}/emails
// Auth: X-Auth-Token: <IAM Application API secret key>
// Docs: https://www.scaleway.com/en/docs/transactional-email/api-cli/send-emails-with-api/
//
// TEM constraints enforced by the API itself (see also tools/send-email.ts,
// which checks the same limits up front so the agent gets a fast, clear
// error instead of an opaque 4xx): subject >= 10 characters, max 3
// recipients per email, no templating engine.
//
// Required env vars (secret references on the Job definition):
//   - TEM_API_ACCESS_KEY / TEM_API_SECRET_KEY : IAM Application key scoped to
//     Transactional Email only (NOT the harness's own SCW_ACCESS_KEY/SCW_SECRET_KEY).
//     NOTE: these two names are not yet in CONTRACT.md's env var table - the
//     harness currently only lists TEM_SENDER_EMAIL/TEM_SENDER_NAME for the
//     generated app. Flagged for reconciliation with whichever skill owns
//     TEM provisioning (add-email) - see this agent's handoff report.
//   - TEM_SENDER_EMAIL / TEM_SENDER_NAME : verified TEM sender (CONTRACT.md §2)
//   - SCW_DEFAULT_PROJECT_ID : the Scaleway Project id (required in the request body)
//   - SCW_DEFAULT_REGION : defaults to "fr-par" if unset

const TEM_API_BASE = "https://api.scaleway.com/transactional-email/v1alpha1/regions";

// ─── Types ────────────────────────────────────────────────────────────
export interface SendMailOptions {
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
}

// ─── Send ─────────────────────────────────────────────────────────────
export async function sendMail(opts: SendMailOptions): Promise<void> {
  const secretKey = process.env.TEM_API_SECRET_KEY;
  const projectId = process.env.SCW_DEFAULT_PROJECT_ID;
  const region = process.env.SCW_DEFAULT_REGION ?? "fr-par";
  const senderEmail = process.env.TEM_SENDER_EMAIL;
  const senderName = process.env.TEM_SENDER_NAME;

  if (!secretKey || !projectId || !senderEmail) {
    throw new Error(
      "TEM_API_SECRET_KEY, SCW_DEFAULT_PROJECT_ID and TEM_SENDER_EMAIL are required to send email.",
    );
  }
  if (opts.subject.length < 10) {
    throw new Error(`Transactional Email rejects subjects under 10 characters (got ${opts.subject.length}).`);
  }
  if (opts.to.length > 3) {
    throw new Error(`Transactional Email accepts at most 3 recipients per email (got ${opts.to.length}).`);
  }

  const body: Record<string, unknown> = {
    project_id: projectId,
    from: { email: senderEmail, ...(senderName ? { name: senderName } : {}) },
    to: opts.to,
    subject: opts.subject,
    html: opts.htmlContent,
    ...(opts.textContent ? { text: opts.textContent } : {}),
    ...(opts.replyTo
      ? { additional_headers: [{ key: "Reply-To", value: opts.replyTo.email }] }
      : {}),
  };

  const res = await fetch(`${TEM_API_BASE}/${region}/emails`, {
    method: "POST",
    headers: {
      "X-Auth-Token": secretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Transactional Email API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Failure notification ─────────────────────────────────────────────
export async function sendAgentFailureEmail(opts: {
  agentName: string;
  invocationId: string;
  reason: string;
}): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn("[agent] sendAgentFailureEmail: ADMIN_EMAIL not set, skipping notification");
    return;
  }
  const dashboardUrl = process.env.APP_URL
    ? `${process.env.APP_URL}/admin/agents/${opts.agentName}/invocations/${opts.invocationId}`
    : null;
  const html = `
    <div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;max-width:600px;">
      <h2 style="color:#1A1410;">⚠️ Ton agent <code>${escape(opts.agentName)}</code> a un problème</h2>
      <p><strong>Raison :</strong> ${escape(opts.reason)}</p>
      <p><strong>Invocation :</strong> <code>${escape(opts.invocationId)}</code></p>
      ${dashboardUrl ? `<p><a href="${escape(dashboardUrl)}" style="color:#8B5CF6;">Voir le détail dans le dashboard →</a></p>` : ""}
      <p style="color:#7A7168;font-size:13px;margin-top:24px;">Cet email vient de ton agent Baudrier. Si l’erreur est due au plafond budgétaire, l’agent reste en pause jusqu’au prochain cycle (jour ou mois selon le plafond touché).</p>
    </div>
  `;
  try {
    await sendMail({
      to: [{ email: adminEmail }],
      subject: `[Agent ${opts.agentName}] Erreur ou plafond atteint`,
      htmlContent: html,
    });
  } catch (e) {
    console.error("[agent] Failed to send failure email:", e);
  }
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
