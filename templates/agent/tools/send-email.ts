// agent/tools/send-email.ts - Send a transactional email from the agent.
//
// Wraps mail.ts, this worker's thin Scaleway Transactional Email (TEM)
// client. The FROM address is fixed to the project's configured TEM sender -
// agents can't impersonate. Sending from a verified domain to an arbitrary
// recipient is a phishing primitive, so who the agent can send TO is also
// restricted, not just who it sends AS.
//
// Safety:
//   - Recipient allowlist: AGENT_EMAIL_ALLOWED_RECIPIENTS (comma-separated).
//     Unset falls back to ADMIN_EMAIL only. Neither set -> refuse (a tool
//     result telling the agent the operator must configure one of them).
//   - Per-run send cap (module-level counter - a runaway loop must not turn
//     into a spam/phishing engine even against an allowed recipient).
//   - Mirrors CONTRACT.md §3 TEM constraints, enforced again here so a bad
//     agent call fails fast with a clear tool_result instead of a 4xx from
//     the API: subject 10-200 chars, at most 3 recipients per email, body
//     capped at 100 KB (truncated with notice), HTML escaping via mail.ts.

import type { ToolDefinition } from "./types.js";
import { sendMail } from "../mail.js";

const MAX_SENDS_PER_RUN = 5;
let sendCount = 0;

/** Resets the per-run send counter. Call once at the start of each run
 * (loop.ts's runAgent) - the counter is module-level and would otherwise
 * cap lifetime sends across cron ticks and continuous-mode runs. */
export function resetSendCount(): void {
  sendCount = 0;
}

/** Comma-separated allowlist from AGENT_EMAIL_ALLOWED_RECIPIENTS, or ADMIN_EMAIL
 * alone when unset. Empty means "not configured" - the caller must refuse. */
function allowedRecipients(): string[] {
  const raw = process.env.AGENT_EMAIL_ALLOWED_RECIPIENTS;
  if (raw) return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const adminEmail = process.env.ADMIN_EMAIL;
  return adminEmail ? [adminEmail.trim().toLowerCase()] : [];
}

const definition: ToolDefinition = {
  name: "send_email",
  description:
    "Send an email to one or more recipients (max 3). Use this when the agent's job involves notifying someone - sending a daily digest, replying to an inquiry, alerting an admin. The FROM address is fixed to the project's configured sender (you can't impersonate). Subject must be at least 10 characters (Transactional Email requirement). Plain-text body is wrapped in a minimal HTML template.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string", description: "Recipient email address" },
        description: "List of recipient email addresses (1 to 3 - Transactional Email limit).",
      },
      subject: {
        type: "string",
        description: "Email subject line (10 to 200 chars - Transactional Email rejects shorter subjects).",
      },
      body: {
        type: "string",
        description: "Email body in plain text. Newlines are preserved as <br>. (Max 100 KB.)",
      },
      replyTo: {
        type: "string",
        description: "Optional Reply-To address (e.g. so the recipient can reply directly to a user).",
      },
    },
    required: ["to", "subject", "body"],
  },
};

async function handler(input: Record<string, unknown>): Promise<string> {
  const to = Array.isArray(input.to) ? (input.to as string[]) : [];
  const subject = String(input.subject ?? "").slice(0, 200);
  let body = String(input.body ?? "");
  const replyTo = input.replyTo ? String(input.replyTo) : undefined;

  if (to.length === 0) return `Error: 'to' must contain at least one email address`;
  if (to.length > 3) return `Error: 'to' must contain at most 3 addresses (Transactional Email limit, got ${to.length})`;
  if (!subject) return `Error: 'subject' is required`;
  if (subject.length < 10) return `Error: 'subject' must be at least 10 characters (Transactional Email requirement, got ${subject.length})`;
  if (!body) return `Error: 'body' is required`;

  const allowlist = allowedRecipients();
  if (allowlist.length === 0) {
    return (
      "Error: no recipient is configured for this agent. Set AGENT_EMAIL_ALLOWED_RECIPIENTS " +
      "(comma-separated addresses) - or ADMIN_EMAIL as a fallback - before this tool can send email. " +
      "Tell the operator to configure one of them."
    );
  }
  const disallowed = to.filter((email) => !allowlist.includes(email.trim().toLowerCase()));
  if (disallowed.length > 0) {
    return `Error: recipient(s) not in the allowed list: ${disallowed.join(", ")}. Add them to AGENT_EMAIL_ALLOWED_RECIPIENTS if this is intentional.`;
  }
  if (sendCount >= MAX_SENDS_PER_RUN) {
    return `Error: this run already sent ${sendCount} email(s), the per-run cap (${MAX_SENDS_PER_RUN}). Refusing to send more.`;
  }

  if (body.length > 100_000) {
    body = body.slice(0, 100_000) + "\n\n[truncated by agent send-email tool: body exceeded 100 KB]";
  }

  const htmlContent = `<div style="font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.6; color: #1A1410;">${
    body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />")
  }</div>`;

  try {
    await sendMail({
      to: to.map((email) => ({ email })),
      subject,
      htmlContent,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    });
    sendCount++;
    console.log(`[agent:send_email] to=${to.join(",")} subject="${subject}" count=${sendCount}/${MAX_SENDS_PER_RUN}`);
    return `OK: email sent to ${to.length} recipient(s)`;
  } catch (e) {
    return `Error sending email: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const tool = { definition, handler };
