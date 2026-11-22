// backend/src/routes/emailWebhook.routes.js — POST /api/email-webhooks/{brevo,resend}. Mounted with express.raw (signature needs the exact bytes).
// Always answers 200 to a verified event (even an unknown one) so providers do not retry forever; 401/503 when authenticity fails.
'use strict';
const express = require('express');
const auth = require('../services/emailWebhookAuth.service');
const outbox = require('../services/emailOutbox.service');

const router = express.Router();
const parse = (raw) => { try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return null; } };
const handle = (provider, verify) => async (req, res) => {
  const v = verify(req);
  if (!v.ok) return res.status(v.status).json({ success: false, message: 'Webhook rejected.' });
  const body = parse(req.body); if (!body) return res.status(400).json({ success: false });
  const events = Array.isArray(body) ? body : [body];                                   // Brevo can batch
  for (const b of events) { const ev = outbox.normaliseWebhook(provider, b, req.headers); if (ev) await outbox.applyDeliveryEvent(provider, ev); }
  return res.status(200).json({ success: true });
};
router.post('/brevo', handle('brevo', (req) => auth.verifyBrevo(req.headers)));
router.post('/resend', handle('resend', (req) => auth.verifyResend(req.headers, req.body)));
module.exports = router;
