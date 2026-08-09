'use strict';

const config = require('./config');

// Lazily-created SMTP transport (cached across warm serverless invocations).
let _smtp = null;
function smtpTransport() {
  if (_smtp) return _smtp;
  // Required lazily so the app runs even if nodemailer isn't installed.
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  _smtp = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    // Fail fast instead of hanging a serverless request if SMTP is unreachable.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return _smtp;
}

/**
 * Send an email. Delivery order: SMTP (e.g. Google Workspace) → Resend →
 * disabled (log & skip). The in-app queues remain the source of truth, so
 * nothing breaks when email is off. The owner is CC'd unless ccOwner === false.
 */
async function sendEmail({ to, subject, html, text, ccOwner = true }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const cc =
    ccOwner && config.ownerEmail && !recipients.includes(config.ownerEmail)
      ? [config.ownerEmail]
      : [];
  if (!recipients.length && !cc.length) return { skipped: true };

  // 1) SMTP — send through your own mailbox (Google Workspace / Gmail).
  if (config.smtpHost && config.smtpUser && config.smtpPass) {
    try {
      await smtpTransport().sendMail({
        from: config.mailFrom,
        to: recipients.length ? recipients : cc,
        cc: recipients.length ? cc : undefined,
        subject,
        html,
        text: text || undefined,
      });
      return { ok: true };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notify] smtp error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // 2) Resend HTTP API.
  if (config.resendApiKey) {
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
        return { ok: false, error: `HTTP ${res.status}: ${body}` };
      }
      return { ok: true };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notify] email error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // 3) Not configured — log and skip.
  // eslint-disable-next-line no-console
  console.log(`[notify] (email disabled) "${subject}" -> ${recipients.join(', ')}`);
  return { skipped: true };
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

/** Notification helpers for each workflow step. */
const notify = {
  // Diagnostic: send a simple test email and return the transport result.
  async test(to) {
    return sendEmail({
      to,
      ccOwner: false,
      subject: 'Purchase System — test email',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#1e3a8a">Email is working ✅</h2>
        <p>This is a test message from your Purchase Management System. If you can read
           this, outgoing email is set up correctly.</p>
        <p style="color:#64748b;font-size:12px;margin-top:20px">Paramount Home Collections — Purchase Management System</p>
      </div>`,
    });
  },
  // Confirmation to the person who raised the requisition.
  async acknowledged(req, to) {
    await sendEmail({
      to,
      ccOwner: false,
      subject: `Requisition ${req.req_number} received`,
      html: wrap(
        'Requisition received',
        `<p>Hi ${esc(req.requested_by_name || 'there')},</p>
         <p>Your requisition <b>${req.req_number}</b> has been submitted and sent to the
            purchase team for sourcing and approval. You'll get an email once it is
            approved or rejected.</p>`,
        req
      ),
    });
  },
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
