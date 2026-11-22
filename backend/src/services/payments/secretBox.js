// backend/src/services/payments/secretBox.js
// Encrypts provider secrets that staff enter through the Admin (AES-256-GCM). The key lives ONLY in the backend environment
// (PAYMENT_SECRETS_KEY = 32 random bytes, base64). Without it, secret entry is refused and provider secrets stay env-only.
// Plaintext never leaves this module except to the adapter that needs it, and is never returned by any API.
'use strict';
const crypto = require('crypto');

const key = () => {
  const raw = process.env.PAYMENT_SECRETS_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
};

const isConfigured = () => !!key();

const encrypt = (plain) => {
  const k = key();
  if (!k) throw Object.assign(new Error('PAYMENT_SECRETS_KEY is not configured.'), { code: 'NO_SECRET_KEY' });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
};

const decrypt = (blob) => {
  const k = key();
  if (!k || !blob?.ct) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(blob.iv, 'base64'));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
};

module.exports = { isConfigured, encrypt, decrypt };
