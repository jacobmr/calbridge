/**
 * Outbound email via Resend (https://resend.com).
 *
 * Configured via two env vars — both optional. If RESEND_API_KEY is unset,
 * sendEmail returns { sent: false, reason: 'not_configured' } and the
 * caller falls back to whatever manual flow makes sense (e.g. invite
 * shows a copy-link). This lets dev environments work without an API key.
 *
 *   RESEND_API_KEY     — re_... from the Resend dashboard
 *   EMAIL_FROM         — verified sender, e.g. "MiCal <invites@mical.net>"
 *                        (defaults to "MiCal <noreply@mical.net>")
 *
 * The Resend domain has to be verified before from-addresses on it work.
 * Domain setup is a one-time thing; see docs/DEPLOYMENT.md.
 */

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "MiCal <noreply@mical.net>";

/**
 * Send an email via Resend.
 *
 * @param {{ to: string|string[], subject: string, html: string, text?: string,
 *           replyTo?: string }} args
 * @returns {Promise<{ sent: boolean, id?: string, reason?: string }>}
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "not_configured" };
  }
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        sent: false,
        reason: `resend_${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data.id };
  } catch (e) {
    return { sent: false, reason: `network: ${e.message || String(e)}` };
  }
}

/**
 * Trivial HTML escape for inserting user-supplied strings into email bodies.
 * Email is plaintext-equivalent for security purposes — but we still don't
 * want display names with `<script>` to break rendering or hide content.
 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build + send the group invitation email. Returns the same shape as
 * sendEmail. We deliberately keep the template inline in this file —
 * one email type, no templating system worth pulling in.
 */
export async function sendGroupInviteEmail({
  toEmail,
  inviterName,
  inviterEmail,
  groupName,
  groupType, // 'family' | 'team'
  inviteUrl,
}) {
  const noun = groupType === "team" ? "team" : "family";
  const inviterLabel = inviterName || inviterEmail || "Someone";
  const subject = `${inviterLabel} invited you to their ${noun} on MiCal`;

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a202c;background:#f5f7fa;margin:0;padding:32px 16px;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
    <div style="font-size:1.6rem;font-weight:800;color:#0f4c81;letter-spacing:-0.02em;margin-bottom:24px;">
      Mi<span style="color:#00c2a8;">Cal</span>
    </div>
    <h1 style="font-size:1.4rem;font-weight:700;margin:0 0 16px;color:#1a202c;letter-spacing:-0.01em;">
      ${esc(inviterLabel)} invited you to their ${noun}
    </h1>
    <p style="color:#4a5568;line-height:1.55;margin:0 0 24px;font-size:0.98rem;">
      <strong>${esc(groupName)}</strong> uses MiCal — a calendar bridge that lets ${noun} members see each other's schedules across Google, Outlook, and other providers, with privacy you control.
    </p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${esc(inviteUrl)}" style="display:inline-block;background:#00c2a8;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:1rem;">
        Accept invitation
      </a>
    </p>
    <p style="color:#718096;line-height:1.5;font-size:0.85rem;margin:24px 0 0;">
      You'll sign in with Google or Outlook — no separate password to remember. After signing in, you'll be added to <strong>${esc(groupName)}</strong> automatically.
    </p>
    <p style="color:#718096;line-height:1.5;font-size:0.8rem;margin:16px 0 0;">
      If the button doesn't work, copy this link into your browser:<br>
      <a href="${esc(inviteUrl)}" style="color:#0f4c81;word-break:break-all;">${esc(inviteUrl)}</a>
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px;">
    <p style="color:#a0aec0;font-size:0.75rem;line-height:1.5;margin:0;">
      You received this because ${esc(inviterEmail || inviterLabel)} entered your email when adding members to their MiCal ${noun}. The invitation expires in 30 days.
    </p>
  </div>
</body></html>`;

  const text = [
    `${inviterLabel} invited you to their ${noun} "${groupName}" on MiCal.`,
    "",
    `Accept the invitation: ${inviteUrl}`,
    "",
    "MiCal is a calendar bridge that lets family/team members see each other's schedules across Google, Outlook, and other providers — with privacy you control. You'll sign in with Google or Outlook (no separate password). The invitation expires in 30 days.",
  ].join("\n");

  return sendEmail({
    to: toEmail,
    subject,
    html,
    text,
    replyTo: inviterEmail || undefined,
  });
}

/**
 * Build + send the poll-winner notification. Goes to every responder once
 * the organizer picks a slot, so they know which time was selected. Same
 * inline-template approach as the group invite email.
 */
export async function sendPollWinnerEmail({
  toEmail,
  recipientName,
  organizerName,
  organizerEmail,
  pollTitle,
  whenLabel,
  locationText,
  pollUrl,
}) {
  const subject = `Time picked: "${pollTitle}" — ${whenLabel}`;
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const where = locationText
    ? `<p style="color:#4a5568;line-height:1.55;margin:0 0 8px;font-size:0.98rem;"><strong>Where:</strong> ${esc(locationText)}</p>`
    : "";

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a202c;background:#f5f7fa;margin:0;padding:32px 16px;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
    <div style="font-size:1.6rem;font-weight:800;color:#0f4c81;letter-spacing:-0.02em;margin-bottom:24px;">
      Mi<span style="color:#00c2a8;">Cal</span>
    </div>
    <h1 style="font-size:1.4rem;font-weight:700;margin:0 0 16px;color:#1a202c;letter-spacing:-0.01em;">
      A time has been picked
    </h1>
    <p style="color:#4a5568;line-height:1.55;margin:0 0 16px;font-size:0.98rem;">
      ${esc(greeting)} ${esc(organizerName || "the organizer")} picked a time for <strong>${esc(pollTitle)}</strong>.
    </p>
    <p style="color:#4a5568;line-height:1.55;margin:0 0 8px;font-size:0.98rem;">
      <strong>When:</strong> ${esc(whenLabel)}
    </p>
    ${where}
    <p style="color:#4a5568;line-height:1.55;margin:16px 0 24px;font-size:0.98rem;">
      You should also see a calendar invite from ${esc(organizerName || organizerEmail || "the organizer")} in your inbox.
    </p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${esc(pollUrl)}" style="display:inline-block;background:#0f4c81;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:0.95rem;">
        View poll
      </a>
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px;">
    <p style="color:#a0aec0;font-size:0.75rem;line-height:1.5;margin:0;">
      You received this because you responded to a meeting poll on MiCal.
    </p>
  </div>
</body></html>`;

  const text = [
    `${organizerName || "The organizer"} picked a time for "${pollTitle}".`,
    "",
    `When:  ${whenLabel}`,
    locationText ? `Where: ${locationText}` : null,
    "",
    "You should also see a calendar invite in your inbox.",
    "",
    `View poll: ${pollUrl}`,
  ]
    .filter((l) => l != null)
    .join("\n");

  return sendEmail({
    to: toEmail,
    subject,
    html,
    text,
    replyTo: organizerEmail || undefined,
  });
}
