// backend/src/routes/smsWebhook.routes.js — POST /api/sms-webhooks/receipts. Mounted with express.raw (the signature needs the exact bytes).
// Verified events always answer 200 (even unknown/unmapped ones) so the provider does not retry forever; 401/503 when authenticity fails.
'use strict';
const express = require('express');
const { verifySms } = require('../services/smsWebhookAuth.service');
const sms = require('../services/smsOutbox.service');

const router = express.Router();
const DELIVERED = new Set(['delivered', 'delivrd', 'deliveredtoterminal', 'delivery_success']);
const FAILED = new Set(['failed', 'undelivered', 'undeliv', 'rejected', 'expired', 'deleted', 'unknown', 'delivery_failed', 'blocked']);
const parse = (raw) => { try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return null; } };

/** Map one provider payload to { providerMessageId, status } or null (pending/intermediate states are ignored — never moves a message). */
function normalise(b) {
  if (!b || typeof b !== 'object') return null;
  const id = b.message_id ?? b.messageId ?? b.MessageSid ?? b.id;
  const raw = String(b.status ?? b.message_status ?? b.MessageStatus ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (id == null || !raw) return null;
  const status = DELIVERED.has(raw) ? 'DELIVERED' : FAILED.has(raw) ? 'FAILED' : null;
  return status ? { providerMessageId: String(id).slice(0, 120), status } : null;
}

router.post('/receipts', async (req, res) => {
  const v = verifySms(req.headers, req.body);
  if (!v.ok) return res.status(v.status).json({ success: false, message: 'Webhook rejected.' });
  const body = parse(req.body); if (!body) return res.status(400).json({ success: false });
  const events = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [body];
  let applied = 0;
  for (const b of events.slice(0, 200)) {
    const ev = normalise(b); if (!ev) continue;
    try { if ((await sms.applyReceipt(ev)).applied) applied += 1; } catch (e) { return res.status(500).json({ success: false }); }   // 5xx => provider retries; applyReceipt is idempotent
  }
  return res.status(200).json({ success: true, applied });
});
router.normalise = normalise;
module.exports = router;
