'use strict';

const config = require('./config');

/**
 * Send an email via Resend if configured; otherwise log and skip (the in-app
 * queues remain the source of truth, so nothing breaks without email). The
 * owner is always CC'd so they get a copy on their Google Workspace.
 */
async function sendEmail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const cc = config.ownerEmail && !recipients.includes(config.ownerEmail) ? [config.ownerEmail] : [];

  if (!config.resendApiKey) {
    // eslint-disable-next-line no-console
    console.log(`[notify] (email disabled) "${subject}" -> ${recipients.join(', ')}`);
    return { skipped: true };
  }
  if (!recipients.length && !cc.length) return { skipped: true };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.mailFrom,
        to: recipients.length ? recipients : cc,
        cc: recipients.length ? cc : undefined,
        subject,
        html,
        text: text || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // eslint-disable-next-line no-console
      console.error(`[notify] email failed (${res.status}): ${body}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] email error:', err.message);
    return { ok: false };
  }
}

function wrap(title, bodyHtml, req) {
  const link = `${config.appUrl}/#/requisitions/${req.id}`;
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
      <h2 style="color:#1e3a8a">${title}</h2>
      ${bodyHtml}
      <p style="margin-top:18px">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
          Open requisition ${req.req_number}
        </a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:20px">Paramount Home Collections — Purchase Management System</p>
    </div>`;
}

/** Fire-and-forget notification helpers for each workflow step. */
const notify = {
  async submitted(req, recipients) {
    await sendEmail({
      to: recipients,
      subject: `New requisition ${req.req_number} needs sourcing`,
      html: wrap(
        'New requisition to source',
        `<p><b>${req.req_number}</b> was raised by <b>${esc(req.requested_by_name)}</b>
          (${esc(req.department || '—')}) and needs vendor rates.</p>`,
        req
      ),
    });
  },
  async sourced(req, recipients) {
    await sendEmail({
      to: recipients,
      subject: `Requisition ${req.req_number} — approval needed`,
      html: wrap(
        'Requisition needs your final approval',
        `<p>The purchaser proposed vendor <b>${esc(req.proposed_vendor_name || '—')}</b>
          for <b>${req.req_number}</b> (total ${esc(req.awarded_total_display || '')}).</p>
         <p>Please approve to allow the PO to be made.</p>`,
        req
      ),
    });
  },
  async decided(req, recipients, approved) {
    await sendEmail({
      to: recipients,
      subject: `Requisition ${req.req_number} ${approved ? 'approved' : 'rejected'}`,
      html: wrap(
        `Requisition ${approved ? 'approved' : 'rejected'}`,
        `<p><b>${req.req_number}</b> was ${approved ? 'approved for purchase' : 'rejected'}.${
          req.decision_note ? ` Note: ${esc(req.decision_note)}` : ''
        }</p>`,
        req
      ),
    });
  },
  async poMade(req, recipients) {
    await sendEmail({
      to: recipients,
      subject: `Requisition ${req.req_number} — PO made`,
      html: wrap('Purchase order made', `<p>The PO for <b>${req.req_number}</b> has been made.</p>`, req),
    });
  },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendEmail, notify };
