// backend/src/services/mfa.service.js
// Authenticator-app sign-in (TOTP, RFC 6238) for staff, plus one-time backup codes. No third-party package: HMAC-SHA1, 6 digits,
// 30-second steps, one step of clock drift allowed. A code can be used once (the last accepted step is remembered), the secret is
// stored encrypted (AES-256-GCM), backup codes are stored only as hashes, and repeated wrong codes lock the account for a while.
'use strict';
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');

const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT'];
const isStaff = (role) => STAFF_ROLES.includes(role);
/** OFF until the admin sign-in screen has its authenticator step; then set REQUIRE_STAFF_MFA=true to make it mandatory for staff. */
const required = (env = process.env) => env.REQUIRE_STAFF_MFA === 'true';

// ── base32 (RFC 4648) ───────────────────────────────────────────────────────────────────────────
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = 0; let v = 0; let out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(v << (5 - bits)) & 31]; return out; };
const b32decode = (s) => { let bits = 0; let v = 0; const out = []; for (const c of String(s).toUpperCase().replace(/=+$/, '')) { const i = A.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };

// ── TOTP ────────────────────────────────────────────────────────────────────────────────────────
const hotp = (secret, counter) => {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
};
const stepOf = (now = Date.now()) => Math.floor(now / 30000);
/** @returns {number|null} the matching step (so the caller can refuse a replay), or null */
const checkTotp = (secretB32, code, now = Date.now()) => {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = b32decode(secretB32); const step = stepOf(now);
  for (const d of [0, -1, 1]) { const a = Buffer.from(hotp(secret, step + d)); const b = Buffer.from(c); if (crypto.timingSafeEqual(a, b)) return step + d; }
  return null;
};

// ── secret storage ──────────────────────────────────────────────────────────────────────────────
const key = (env = process.env) => crypto.createHash('sha256').update(String(env.MFA_ENCRYPTION_KEY || env.BANK_SECRETS_KEY || env.JWT_SECRET || '')).digest();
const seal = (plain, env = process.env) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(env), iv); const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return ['m1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':'); };
const open = (blob, env = process.env) => { const [v, iv, tag, ct] = String(blob || '').split(':'); if (v !== 'm1') return null; try { const d = crypto.createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'); } catch { return null; } };

const hashCode = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const newBackupCodes = () => Array.from({ length: 8 }, () => { const r = crypto.randomBytes(5).toString('hex').toUpperCase(); return `${r.slice(0, 5)}-${r.slice(5)}`; });

// ── brute-force guard (per user, in memory: 5 wrong codes → 15 minutes) ─────────────────────────
const fails = new Map();
const guard = (userId, now = Date.now()) => { const f = fails.get(userId); if (f && f.until > now) throw new AppError('Too many wrong codes. Try again in a few minutes.', 429); };
const miss = (userId, now = Date.now()) => { const f = fails.get(userId) || { n: 0, until: 0 }; f.n += 1; if (f.n >= 5) { f.until = now + 15 * 60000; f.n = 0; } fails.set(userId, f); };
const clear = (userId) => fails.delete(userId);

// ── flows ───────────────────────────────────────────────────────────────────────────────────────
const setup = async ({ user }) => {
  if (!isStaff(user.role)) throw new AppError('Two-step sign-in is for staff accounts.', 403);
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabled: true, email: true } });
  if (fresh?.mfaEnabled) throw new AppError('Two-step sign-in is already on. Disable it first to enrol a new device.', 409);
  const secret = b32encode(crypto.randomBytes(20));
  await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: seal(secret), mfaEnabled: false } });
  const label = encodeURIComponent(`Runserv:${fresh?.email || user.id}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Runserv&algorithm=SHA1&digits=6&period=30` };
};

const enable = async ({ user, code, req }) => {
  guard(user.id);
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecretEnc: true, mfaEnabled: true } });
  if (!row?.mfaSecretEnc) throw new AppError('Start the set-up first.', 400);
  if (row.mfaEnabled) throw new AppError('Already enabled.', 409);
  const step = checkTotp(open(row.mfaSecretEnc) || '', code);
  if (step === null) { miss(user.id); throw new AppError('That code is not right. Check the time on your phone and try again.', 400); }
  clear(user.id);
  const codes = newBackupCodes();
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaLastStep: step, mfaEnrolledAt: new Date(), mfaBackupHashes: codes.map(hashCode) } });
  await logActivity({ userId: user.id, action: 'mfa_enabled', entityType: 'User', entityId: user.id, details: {}, req });
  return { backupCodes: codes };      // shown ONCE
};

/** Completes sign-in: a current app code, or a backup code (each usable once). */
const verify = async ({ user, code, backupCode, req }) => {
  guard(user.id);
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabled: true, mfaSecretEnc: true, mfaLastStep: true, mfaBackupHashes: true } });
  if (!row?.mfaEnabled) throw new AppError('Two-step sign-in is not set up for this account.', 400);
  if (backupCode) {
    const h = hashCode(backupCode);
    if (!row.mfaBackupHashes.includes(h)) { miss(user.id); throw new AppError('That backup code is not valid.', 400); }
    // Remove it with a conditional update so the same code cannot be used by two requests.
    const r = await prisma.user.updateMany({ where: { id: user.id, mfaBackupHashes: { has: h } }, data: { mfaBackupHashes: row.mfaBackupHashes.filter((x) => x !== h) } });
    if (r.count !== 1) throw new AppError('That backup code was just used.', 409);
    clear(user.id);
    await logActivity({ userId: user.id, action: 'mfa_backup_code_used', entityType: 'User', entityId: user.id, details: { remaining: row.mfaBackupHashes.length - 1 }, req });
    return { via: 'backup', backupCodesLeft: row.mfaBackupHashes.length - 1 };
  }
  const step = checkTotp(open(row.mfaSecretEnc) || '', code);
  // A code that was already used (or is older than the last one used) is refused: it may have been seen over a shoulder.
  if (step === null || (row.mfaLastStep != null && step <= row.mfaLastStep)) { miss(user.id); throw new AppError('That code is not right or was already used. Wait for the next one.', 400); }
  const r = await prisma.user.updateMany({ where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
  if (r.count !== 1) throw new AppError('That code was just used.', 409);
  clear(user.id);
  return { via: 'app' };
};

const disable = async ({ user, password, code, req }) => {
  if (required()) throw new AppError('Two-step sign-in is mandatory for staff and cannot be switched off.', 403);
  await verify({ user, code, req });
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaBackupHashes: [], mfaLastStep: null } });
  await logActivity({ userId: user.id, action: 'mfa_disabled', entityType: 'User', entityId: user.id, details: {}, req });
};

/** A Super Admin clears a colleague's lost device. They must enrol again at the next sign-in. */
const reset = async ({ targetId, actor, req }) => {
  if (targetId === actor) throw new AppError('Ask another Super Admin to reset your own device.', 403);
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
  if (!t) throw new AppError('User not found.', 404);
  await prisma.user.update({ where: { id: targetId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaBackupHashes: [], mfaLastStep: null, passwordChangedAt: new Date() } });   // also ends their current sessions
  await logActivity({ userId: actor, action: 'mfa_reset', entityType: 'User', entityId: targetId, details: {}, req });
};

module.exports = { STAFF_ROLES, isStaff, required, b32encode, b32decode, hotp, checkTotp, stepOf, seal, open, hashCode, setup, enable, verify, disable, reset, _fails: fails };
