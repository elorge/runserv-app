// backend/src/services/guestIdentity.service.js
//
// M16.1: identity is now CHANNEL-EXPLICIT. EMAIL is the primary verification channel (Brevo/Resend via the email outbox); PHONE (SMS) stays
// available behind GUEST_SMS_OTP_ENABLED. A challenge records its channel and purpose (GUEST_BOOKING_VERIFY); a guest identity records which
// channel verified it and when. Email verification NEVER marks the phone verified: the phone is an unverified operational contact.
// Send arbitration is a database lock (pg_advisory_xact_lock) keyed by the keyed hash of the identity + purpose (and one per IP), so
// cooldown, hourly caps and "one live challenge" are decided inside one protected operation instead of by after-the-fact ranking.
//
// Stage 2 of the guest-booking plan: PHONE OWNERSHIP. A guest proves they control a number with a one-time code, and receives a
// short-lived OPAQUE session token (not a JWT, sent as "Authorization: Guest <token>"), so it can never be replayed against the
// authenticated routes, which only accept "Bearer <jwt>".
//
// Controls (guide §4.1): code expiry, resend cooldown, per-phone and per-IP send caps, attempt limit with lock-out, single use
// (atomic), keyed hashes at rest (a leaked table cannot be brute-forced offline without the server secret), audit trail.
// A number that already belongs to a registered account is refused: guests never get a path into someone else's account.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { DIAL_CODES } = require('../utils/msisdn');
const { checkPhoneForCountry, normalizePhoneForStorage, phoneCandidates } = require('../utils/phone');
const { COUNTRY_CENTERS } = require('../utils/countryGeo');

const PURPOSE = 'GUEST_BOOKING_VERIFY';
const CHANNELS = Object.freeze({ EMAIL: 'EMAIL', PHONE: 'PHONE' });
const CFG = {
  OTP_LENGTH: 6,
  OTP_TTL_MS: 5 * 60 * 1000,
  RESEND_COOLDOWN_MS: 60 * 1000,
  MAX_SENDS_PER_PHONE_HOUR: 5,
  MAX_SENDS_PER_IP_HOUR: 20,
  MAX_ATTEMPTS: 5,
  SESSION_TTL_MS: 2 * 60 * 60 * 1000,
};
const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** The defaults above, overridden by GUEST_OTP_TTL_SECONDS / GUEST_OTP_MAX_ATTEMPTS / GUEST_OTP_RESEND_COOLDOWN_SECONDS. */
const cfg = (env = process.env) => ({
  ...CFG,
  OTP_TTL_MS: pos(env.GUEST_OTP_TTL_SECONDS, CFG.OTP_TTL_MS / 1000) * 1000,
  MAX_ATTEMPTS: Math.floor(pos(env.GUEST_OTP_MAX_ATTEMPTS, CFG.MAX_ATTEMPTS)),
  RESEND_COOLDOWN_MS: pos(env.GUEST_OTP_RESEND_COOLDOWN_SECONDS, CFG.RESEND_COOLDOWN_MS / 1000) * 1000,
  MAX_SENDS_PER_EMAIL_HOUR: Math.floor(pos(env.GUEST_OTP_MAX_SENDS_PER_EMAIL_HOUR, CFG.MAX_SENDS_PER_PHONE_HOUR)),
  DAILY_CAP: Math.floor(Number(env.GUEST_OTP_DAILY_CAP) || 0),     // 0 = off (the email hard cap in emailQuota still applies)
});
const truthy = (v) => String(v || '').toLowerCase() === 'true';
/** Which OTP channels are deliberately enabled: needs BOTH the per-channel flag and the GUEST_OTP_CHANNEL list (default "email"). */
const channelEnabled = (channel, env = process.env) => {
  const list = String(env.GUEST_OTP_CHANNEL || 'email').toLowerCase().split(',').map((x) => x.trim());
  if (channel === CHANNELS.EMAIL) return truthy(env.GUEST_EMAIL_OTP_ENABLED) && list.includes('email');
  if (channel === CHANNELS.PHONE) return truthy(env.GUEST_SMS_OTP_ENABLED) && list.includes('sms');
  return false;
};
const enabledChannels = (env = process.env) => Object.values(CHANNELS).filter((c) => channelEnabled(c, env));

const err = (message, status, code, extra = {}) => Object.assign(new AppError(message, status), { code, ...extra });

const hashSecret = (env = process.env) => {
  // M16: development/test may fall back to JWT_SECRET; production must have its own GUEST_HASH_SECRET.
  const s = env.GUEST_HASH_SECRET || (require('../utils/envGuard').isProduction(env) ? '' : env.JWT_SECRET);
  if (!s) throw err('Guest verification is not configured.', 503, 'GUEST_SECRET_MISSING');
  return `guest-hash:${s}`;
};
/** Keyed hash (HMAC-SHA256). `purpose` separates uses so one hash can never stand in for another. */
const keyed = (purpose, value, env = process.env) => crypto.createHmac('sha256', hashSecret(env)).update(`${purpose}:${value}`).digest('hex');
const safeEqualHex = (a, b) => { const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const ipHash = (ip, env = process.env) => (ip ? keyed('ip', ip, env).slice(0, 32) : null);

/** Canonical E.164 ("+2348012345678") for a number already accepted by checkPhoneForCountry. */
const toE164 = (phone, countryCode) => {
  const cc = String(countryCode).toUpperCase();
  const dial = DIAL_CODES[cc];
  const stored = normalizePhoneForStorage(phone, cc);
  if (stored.startsWith('+')) return stored;
  return `+${dial}${stored.replace(/^0+/, '')}`;
};

const maskPhone = (p) => (p ? `${p.slice(0, 4)}${'*'.repeat(Math.max(0, p.length - 7))}${p.slice(-3)}` : '');

const audit = async (event, { identityId = null, bookingId = null, ip = null, meta = null } = {}) => {
  try { await prisma.guestAuditEvent.create({ data: { event, identityId, bookingId, ipHash: ipHash(ip), meta } }); }
  catch (e) { console.error('[guest-audit] failed to write', event, e.message); }   // an audit failure must never break the user's request
};

const generateCode = () => Array.from({ length: CFG.OTP_LENGTH }, () => crypto.randomInt(0, 10)).join('');

/** Deliver the code. SMS only when ENABLE_SMS_DELIVERY=true. Without SMS the code is exposed ONLY in NODE_ENV=development. */
async function deliverCode(phone, code, env = process.env, sms = require('./termii.service')) {
  const smsOn = String(env.ENABLE_SMS_DELIVERY).toLowerCase() === 'true';
  if (smsOn) {
    await sms.send(phone, `Your Runserv code: ${code}. Valid for ${Math.round(CFG.OTP_TTL_MS / 60000)} mins. Don't share it with anyone.`);
    return { devCode: undefined };
  }
  if (env.NODE_ENV === 'development') return { devCode: code };
  throw err('Phone verification is not available right now. Please try again later.', 503, 'OTP_DELIVERY_UNAVAILABLE');
}

/** Run `fn(tx)` inside one transaction that first takes transaction-scoped advisory locks (sorted, so two requests can never deadlock). */
async function withLocks(keys, fn) {
  const sorted = [...new Set(keys.filter(Boolean))].sort();
  return prisma.$transaction(async (tx) => {
    for (const k of sorted) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 15000 });
}

/** The send limits, evaluated INSIDE the lock. Returns null (allowed) or { event, code, message, extra }. */
async function sendLimit(tx, { where, ipH, now, c, perHour, since }) {
  const last = await tx.guestOtp.findFirst({ where, orderBy: { createdAt: 'desc' } });
  if (last && now - new Date(last.createdAt).getTime() < c.RESEND_COOLDOWN_MS) {
    const retryAfterS = Math.ceil((c.RESEND_COOLDOWN_MS - (now - new Date(last.createdAt).getTime())) / 1000);
    return { event: 'OTP_COOLDOWN', code: 'OTP_COOLDOWN', message: `Please wait ${retryAfterS}s before asking for another code.`, extra: { retryAfterS } };
  }
  if ((await tx.guestOtp.count({ where: { ...where, createdAt: { gte: since } } })) >= perHour) return { event: 'OTP_PHONE_LIMIT', code: 'OTP_PHONE_LIMIT', message: 'Too many codes requested for this address or number. Please try again later.' };
  if (ipH && (await tx.guestOtp.count({ where: { ipHash: ipH, createdAt: { gte: since } } })) >= c.MAX_SENDS_PER_IP_HOUR) return { event: 'OTP_IP_LIMIT', code: 'OTP_IP_LIMIT', message: 'Too many codes requested from this device. Please try again later.' };
  return null;
}

/** Step 1 (PHONE / SMS): ask for a code. Never reveals the code (outside development). */
async function requestOtp({ phone, countryCode = 'NG', ip, now = Date.now(), env = process.env, sms } = {}) {
  const cc = String(countryCode || 'NG').toUpperCase();
  if (!COUNTRY_CENTERS[cc]) throw err('Unsupported country.', 400, 'UNSUPPORTED_COUNTRY');
  const chk = checkPhoneForCountry(phone, cc);
  if (!chk.ok) throw err(chk.reason, 400, 'INVALID_PHONE');
  const e164 = toE164(phone, cc);
  const c = cfg(env);

  await assertNoRegisteredAccount(e164, cc);
  const identity = await prisma.guestIdentity.findUnique({ where: { phone: e164 } });
  if (identity?.blockedAt) throw err('This number cannot be used for guest bookings. Please contact support.', 403, 'GUEST_BLOCKED');

  const since = new Date(now - 60 * 60 * 1000);
  const ipH = ipHash(ip, env);
  const code = generateCode();
  // M16.1: lookup and insert happen under one DB lock per number (and per IP). A second request for the same number waits, then sees the
  // committed row and is refused by the cooldown. There is no window between "check" and "insert" any more.
  const out = await withLocks([`otp:phone:${e164}`, ipH && `otpip:${ipH}`], async (tx) => {
    const lost = await sendLimit(tx, { where: { phone: e164 }, ipH, now, c, perHour: c.MAX_SENDS_PER_PHONE_HOUR, since });
    if (lost) return { lost };
    const row = await tx.guestOtp.create({ data: { phone: e164, countryCode: cc, channel: CHANNELS.PHONE, purpose: PURPOSE, codeHash: keyed('otp', `${e164}:${code}`, env), expiresAt: new Date(now + c.OTP_TTL_MS), ipHash: ipH } });
    return { row };
  });
  if (out.lost) {
    await audit(out.lost.event, { identityId: identity?.id, ip, meta: { ...(out.lost.extra || {}), channel: 'PHONE' } });
    throw err(out.lost.message, 429, out.lost.code, out.lost.extra || {});
  }
  const row = out.row;
  let delivered;
  try { delivered = await deliverCode(e164, code, env, sms); }
  catch (e) {
    await prisma.guestOtp.delete({ where: { id: row.id } }).catch(() => {});      // a code nobody received must not count against them
    if (e.code === 'OTP_DELIVERY_UNAVAILABLE') throw e;
    console.error('[guest-otp] SMS failed:', e.message);
    throw err('We could not send the code. Please check the number and try again.', 502, 'OTP_SEND_FAILED');
  }
  await audit('OTP_REQUESTED', { identityId: identity?.id, ip, meta: { phone: maskPhone(e164), channel: 'PHONE' } });
  return { channel: CHANNELS.PHONE, phone: maskPhone(e164), expiresInS: c.OTP_TTL_MS / 1000, resendAfterS: c.RESEND_COOLDOWN_MS / 1000, ...(delivered.devCode ? { devCode: delivered.devCode } : {}) };
}

// ── EMAIL channel ────────────────────────────────────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
/** trim + lowercase, then validate. Returns the canonical address or null. */
const normalizeEmail = (raw) => {
  const e = String(raw || '').trim().toLowerCase();
  return e.length <= 254 && e.length >= 6 && EMAIL_RE.test(e) && !e.includes('..') ? e : null;
};
const maskEmail = (e) => require('./emailOutbox.service').maskEmail(e);

/** A DEDICATED secret for OTP hashing: no fallback to JWT_SECRET or GUEST_HASH_SECRET, in any environment. */
const otpSecret = (env = process.env) => {
  const s = env.GUEST_OTP_HASH_SECRET;
  if (!s) throw err('Email verification is not configured.', 503, 'GUEST_SECRET_MISSING');
  if (require('../utils/envGuard').isProduction(env) && (s === env.JWT_SECRET || s === env.GUEST_HASH_SECRET)) throw err('Email verification is not configured.', 503, 'GUEST_SECRET_MISSING');
  return `guest-otp:${s}`;
};
const keyedOtp = (purpose, value, env = process.env) => crypto.createHmac('sha256', otpSecret(env)).update(`${purpose}:${value}`).digest('hex');
const emailIdentityKey = (email, env = process.env) => keyedOtp('idkey', `${CHANNELS.EMAIL}:${PURPOSE}:${email}`, env);
/** The email code is DERIVED from (secret, challenge id, nonce): the outbox needs only the challenge id, and no raw code is ever stored or logged. */
const deriveEmailCode = (otp, env = process.env) => {
  const d = crypto.createHmac('sha256', otpSecret(env)).update(`code:${otp.id}:${otp.codeNonce}`).digest();
  return String(d.readUInt32BE(0) % 10 ** CFG.OTP_LENGTH).padStart(CFG.OTP_LENGTH, '0');
};

/**
 * Step 1 (EMAIL): ask for a code. The answer is always the same neutral shape, whether or not the address belongs to a registered or
 * blocked account (nothing is queued for those). Rate-limit refusals are the only visible difference.
 * `hooks.afterChecks` is a test seam between the limit checks and the insert (used to force the race interleaving).
 */
async function requestEmailOtp({ email, phone, countryCode = 'NG', ip, now = Date.now(), env = process.env, hooks = {} } = {}) {
  if (!channelEnabled(CHANNELS.EMAIL, env)) throw err('Email verification is not available right now.', 503, 'OTP_CHANNEL_DISABLED');
  const cc = String(countryCode || 'NG').toUpperCase();
  if (!COUNTRY_CENTERS[cc]) throw err('Unsupported country.', 400, 'UNSUPPORTED_COUNTRY');
  const addr = normalizeEmail(email);
  if (!addr) throw err('Enter a valid email address.', 400, 'INVALID_EMAIL');
  const chk = checkPhoneForCountry(phone, cc);
  if (!chk.ok) throw err(chk.reason, 400, 'INVALID_PHONE');
  const contact = toE164(phone, cc);
  const c = cfg(env);
  const idKey = emailIdentityKey(addr, env);
  const ipH = ipHash(ip, env);
  const since = new Date(now - 60 * 60 * 1000);
  const response = (extra = {}) => ({ channel: CHANNELS.EMAIL, email: maskEmail(addr), expiresInS: c.OTP_TTL_MS / 1000, resendAfterS: c.RESEND_COOLDOWN_MS / 1000, message: 'If the address is valid, a code has been sent.', ...extra });

  const out = await withLocks([`otp:${PURPOSE}:${idKey}`, ipH && `otpip:${ipH}`, c.DAILY_CAP > 0 && 'otp:global'], async (tx) => {
    // Registered or blocked: answer neutrally and queue nothing (no enumeration through this endpoint).
    const owner = await tx.user.findFirst({ where: { email: { equals: addr, mode: 'insensitive' }, NOT: { authProvider: 'GUEST' } }, select: { id: true } });
    const ident = await tx.guestIdentity.findUnique({ where: { email: addr } });
    if (owner || ident?.blockedAt) return { silent: owner ? 'ACCOUNT_EXISTS' : 'GUEST_BLOCKED', identityId: ident?.id };
    const lost = await sendLimit(tx, { where: { identityKey: idKey, purpose: PURPOSE }, ipH, now, c, perHour: c.MAX_SENDS_PER_EMAIL_HOUR, since });
    if (lost) return { lost, identityId: ident?.id };
    if (c.DAILY_CAP > 0 && (await tx.guestOtp.count({ where: { channel: CHANNELS.EMAIL, createdAt: { gte: new Date(now - 24 * 3600 * 1000) } } })) >= c.DAILY_CAP) {
      return { lost: { event: 'OTP_DAILY_CAP', code: 'OTP_DAILY_CAP', message: 'We cannot send codes right now. Please try again later.' } };
    }
    if (hooks.afterChecks) await hooks.afterChecks();
    // One live challenge per identity + purpose: the previous one is invalidated in the SAME transaction.
    await tx.guestOtp.updateMany({ where: { identityKey: idKey, purpose: PURPOSE, consumedAt: null, supersededAt: null }, data: { supersededAt: new Date(now) } });
    const id = crypto.randomUUID(); const codeNonce = crypto.randomBytes(16).toString('hex');
    const code = deriveEmailCode({ id, codeNonce }, env);
    await tx.guestOtp.create({ data: { id, channel: CHANNELS.EMAIL, purpose: PURPOSE, identityKey: idKey, email: addr, contactPhone: contact, countryCode: cc, codeNonce, codeHash: keyedOtp('otp', `${idKey}:${code}`, env), expiresAt: new Date(now + c.OTP_TTL_MS), ipHash: ipH, createdAt: new Date(now) } });
    await require('./emailOutbox.service').enqueueOtpTx(tx, { otpId: id, email: addr });   // committed together with the challenge
    return { otpId: id, identityId: ident?.id, devCode: env.NODE_ENV === 'development' && !require('./emailProviders.service').isConfigured('brevo', env) ? code : undefined };
  });

  if (out.silent) { await audit('OTP_EMAIL_SUPPRESSED', { identityId: out.identityId, ip, meta: { reason: out.silent } }); return response(); }
  if (out.lost) {
    await audit(out.lost.event, { identityId: out.identityId, ip, meta: { ...(out.lost.extra || {}), channel: 'EMAIL' } });
    throw err(out.lost.message, 429, out.lost.code, out.lost.extra || {});
  }
  await audit('OTP_REQUESTED', { identityId: out.identityId, ip, meta: { channel: 'EMAIL', email: maskEmail(addr) } });
  return { ...response(), deliveryState: 'QUEUED', ...(out.devCode ? { devCode: out.devCode } : {}), _otpId: out.otpId };   // _otpId is for the controller (kick the outbox); stripped before the response
}

/** A registered (non-guest) account owns this number: refuse, never merge. */
async function assertNoRegisteredAccount(e164, cc) {
  const dial = DIAL_CODES[cc];
  const candidates = [...new Set([e164, ...phoneCandidates(e164, dial, cc)])];
  const owner = await prisma.user.findFirst({ where: { phone: { in: candidates }, NOT: { authProvider: 'GUEST' } }, select: { id: true } });
  if (owner) throw err('This number already has a Runserv account. Please sign in to book.', 409, 'ACCOUNT_EXISTS');
}

/** Step 2: check the code; on success find-or-create the guest identity and open a session. */
async function verifyOtp({ phone, countryCode = 'NG', code, ip, now = Date.now(), env = process.env } = {}) {
  const c = cfg(env);
  const cc = String(countryCode || 'NG').toUpperCase();
  const chk = checkPhoneForCountry(phone, cc);
  if (!chk.ok || !/^\d{6}$/.test(String(code || ''))) throw err('Enter the 6-digit code we sent you.', 400, 'INVALID_CODE_FORMAT');
  const e164 = toE164(phone, cc);

  const otp = await prisma.guestOtp.findFirst({ where: { phone: e164, channel: CHANNELS.PHONE, consumedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!otp || now >= new Date(otp.expiresAt).getTime()) {
    await audit('OTP_EXPIRED_OR_MISSING', { ip });
    throw err('That code has expired. Please request a new one.', 400, 'OTP_EXPIRED');
  }
  // M16: the attempt budget is spent ATOMICALLY before the code is compared. Parallel guesses cannot all read the same
  // "attempts" value: the conditional increment only succeeds while attempts < MAX and the code is still unconsumed.
  const gate = await prisma.guestOtp.updateMany({ where: { id: otp.id, consumedAt: null, attempts: { lt: c.MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (gate.count !== 1) {
    const cur = await prisma.guestOtp.findUnique({ where: { id: otp.id } });
    if (cur?.consumedAt) throw err('That code has already been used. Please request a new one.', 400, 'OTP_USED');
    await audit('OTP_LOCKED', { ip, meta: { phone: maskPhone(e164) } });
    throw err('Too many wrong attempts. Please request a new code.', 429, 'OTP_LOCKED');
  }
  if (!safeEqualHex(otp.codeHash, keyed('otp', `${e164}:${code}`, env))) {
    const after = await prisma.guestOtp.findUnique({ where: { id: otp.id } });
    const left = Math.max(0, c.MAX_ATTEMPTS - (after?.attempts ?? otp.attempts + 1));
    await audit('OTP_WRONG_CODE', { ip, meta: { phone: maskPhone(e164), attemptsLeft: left } });
    throw err(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.', left > 0 ? 400 : 429, left > 0 ? 'OTP_WRONG' : 'OTP_LOCKED', { attemptsLeft: left });
  }
  // Single use, race-safe: only one concurrent verify can flip consumedAt.
  const used = await prisma.guestOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date(now) } });
  if (used.count !== 1) throw err('That code has already been used. Please request a new one.', 400, 'OTP_USED');

  await assertNoRegisteredAccount(e164, cc);
  const identity = await findOrCreateIdentity(e164, cc, now);
  if (identity.blockedAt) throw err('This number cannot be used for guest bookings. Please contact support.', 403, 'GUEST_BLOCKED');
  const session = await openSession(identity.id, now, env);
  await audit('OTP_VERIFIED', { identityId: identity.id, ip });
  return { session: session.token, expiresAt: session.expiresAt, phone: maskPhone(e164), countryCode: cc, converted: !!identity.convertedAt, channel: CHANNELS.PHONE, phoneVerified: true, emailVerified: false };
}

/** Step 2 (EMAIL): check the code; on success find-or-create the email identity and open a session. Generic errors: no hint about the address. */
async function verifyEmailOtp({ email, code, ip, now = Date.now(), env = process.env } = {}) {
  if (!channelEnabled(CHANNELS.EMAIL, env)) throw err('Email verification is not available right now.', 503, 'OTP_CHANNEL_DISABLED');
  const c = cfg(env);
  const addr = normalizeEmail(email);
  if (!addr || !/^\d{6}$/.test(String(code || ''))) throw err('Enter the 6-digit code we sent you.', 400, 'INVALID_CODE_FORMAT');
  const idKey = emailIdentityKey(addr, env);

  // Only the newest, unconsumed, unreplaced challenge for THIS email + purpose can be answered.
  const otp = await prisma.guestOtp.findFirst({ where: { identityKey: idKey, purpose: PURPOSE, channel: CHANNELS.EMAIL, consumedAt: null, supersededAt: null }, orderBy: { createdAt: 'desc' } });
  if (!otp || now >= new Date(otp.expiresAt).getTime()) {
    await audit('OTP_EXPIRED_OR_MISSING', { ip, meta: { channel: 'EMAIL' } });
    throw err('That code is not valid or has expired. Please request a new one.', 400, 'OTP_EXPIRED');
  }
  // Atomic attempt budget (same rule as phone): the increment only succeeds below the maximum, before the code is compared.
  const gate = await prisma.guestOtp.updateMany({ where: { id: otp.id, consumedAt: null, supersededAt: null, attempts: { lt: c.MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (gate.count !== 1) {
    const cur = await prisma.guestOtp.findUnique({ where: { id: otp.id } });
    if (cur?.consumedAt || cur?.supersededAt) throw err('That code is not valid or has expired. Please request a new one.', 400, 'OTP_EXPIRED');
    await audit('OTP_LOCKED', { ip, meta: { channel: 'EMAIL' } });
    throw err('Too many wrong attempts. Please request a new code.', 429, 'OTP_LOCKED');
  }
  if (!safeEqualHex(otp.codeHash, keyedOtp('otp', `${idKey}:${code}`, env))) {
    const after = await prisma.guestOtp.findUnique({ where: { id: otp.id } });
    const left = Math.max(0, c.MAX_ATTEMPTS - (after?.attempts ?? otp.attempts + 1));
    await audit('OTP_WRONG_CODE', { ip, meta: { channel: 'EMAIL', attemptsLeft: left } });
    throw err(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.', left > 0 ? 400 : 429, left > 0 ? 'OTP_WRONG' : 'OTP_LOCKED', { attemptsLeft: left });
  }
  const used = await prisma.guestOtp.updateMany({ where: { id: otp.id, consumedAt: null, supersededAt: null }, data: { consumedAt: new Date(now) } });
  if (used.count !== 1) throw err('That code is not valid or has expired. Please request a new one.', 400, 'OTP_EXPIRED');

  const owner = await prisma.user.findFirst({ where: { email: { equals: addr, mode: 'insensitive' }, NOT: { authProvider: 'GUEST' } }, select: { id: true } });
  if (owner) throw err('That code is not valid or has expired. Please request a new one.', 400, 'OTP_EXPIRED');   // a registered address never gets a guest session
  const identity = await findOrCreateEmailIdentity(addr, otp.contactPhone, otp.countryCode, now);
  if (identity.blockedAt) throw err('That code is not valid or has expired. Please request a new one.', 400, 'OTP_EXPIRED');
  const session = await openSession(identity.id, now, env);
  await audit('OTP_VERIFIED', { identityId: identity.id, ip, meta: { channel: 'EMAIL' } });
  const contact = identity.contactPhone || otp.contactPhone;
  return { session: session.token, expiresAt: session.expiresAt, channel: CHANNELS.EMAIL, email: maskEmail(addr), phone: maskPhone(contact), countryCode: identity.countryCode, converted: !!identity.convertedAt, emailVerified: true, phoneVerified: false };
}

/** Find-or-create by VERIFIED email. The phone is stored as an unverified contact; it is never written to the unique `phone` column. */
async function findOrCreateEmailIdentity(addr, contactPhone, cc, now) {
  const existing = await prisma.guestIdentity.findUnique({ where: { email: addr } });
  if (existing) {
    return prisma.guestIdentity.update({ where: { id: existing.id }, data: { contactPhone: contactPhone || existing.contactPhone, emailVerifiedAt: new Date(now) } });
  }
  const userId = crypto.randomUUID();
  const password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  try {
    return await prisma.$transaction(async (tx) => {
      // The User row may carry the contact number only if no other account already owns it (User.phone is unique).
      const taken = contactPhone ? await tx.user.findFirst({ where: { phone: contactPhone }, select: { id: true } }) : null;
      await tx.user.create({ data: { id: userId, email: `guest-${userId}@guest.runserv.invalid`, phone: taken ? null : contactPhone || null, password, authProvider: 'GUEST', firstName: 'Guest', lastName: 'Customer', role: 'CUSTOMER', countryCode: cc, isVerified: false } });
      return tx.guestIdentity.create({ data: { phone: null, email: addr, contactPhone: contactPhone || null, countryCode: cc, userId, verifiedAt: new Date(now), verifiedChannel: CHANNELS.EMAIL, emailVerifiedAt: new Date(now) } });
    });
  } catch (e) {
    if (e?.code === 'P2002') { const again = await prisma.guestIdentity.findUnique({ where: { email: addr } }); if (again) return again; }   // two verifies raced
    throw e;
  }
}

async function findOrCreateIdentity(e164, cc, now) {
  const existing = await prisma.guestIdentity.findUnique({ where: { phone: e164 } });
  if (existing) return existing;
  const userId = crypto.randomUUID();
  // The guest's User row: cannot sign in (random password nobody holds, authProvider GUEST is refused by every sign-in route).
  const password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, email: `guest-${userId}@guest.runserv.invalid`, phone: e164, password, authProvider: 'GUEST', firstName: 'Guest', lastName: 'Customer', role: 'CUSTOMER', countryCode: cc, isVerified: false } });
      return tx.guestIdentity.create({ data: { phone: e164, countryCode: cc, userId, verifiedAt: new Date(now), verifiedChannel: CHANNELS.PHONE, phoneVerifiedAt: new Date(now) } });
    });
  } catch (e) {
    if (e?.code === 'P2002') { const again = await prisma.guestIdentity.findUnique({ where: { phone: e164 } }); if (again) return again; }   // two verifies raced
    throw e;
  }
}

async function openSession(identityId, now = Date.now(), env = process.env) {
  const token = `gs_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now + CFG.SESSION_TTL_MS);
  await prisma.guestSession.create({ data: { identityId, tokenHash: keyed('session', token, env), expiresAt } });
  return { token, expiresAt };
}

/** Middleware: "Authorization: Guest <token>" → req.guest. Never touches req.user. */
const requireGuestSession = async (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    const m = /^Guest (gs_[A-Za-z0-9_-]{43})$/.exec(h);
    if (!m) return res.status(401).json({ success: false, code: 'GUEST_SESSION_REQUIRED', message: 'Please verify to continue.' });
    const row = await prisma.guestSession.findUnique({ where: { tokenHash: keyed('session', m[1]) }, include: { identity: true } });
    if (!row || row.revokedAt || Date.now() >= new Date(row.expiresAt).getTime()) {
      return res.status(401).json({ success: false, code: 'GUEST_SESSION_EXPIRED', message: 'Your verification has expired. Please verify again.' });
    }
    if (row.identity.blockedAt) return res.status(403).json({ success: false, code: 'GUEST_BLOCKED', message: 'This number cannot be used for guest bookings. Please contact support.' });
    // `phone` is the operational contact number (verified only when verifiedChannel is PHONE); `email` is set for email identities.
    req.guest = { sessionId: row.id, identityId: row.identityId, userId: row.identity.userId, phone: row.identity.phone || row.identity.contactPhone || null, email: row.identity.email || null, verifiedChannel: row.identity.verifiedChannel || 'PHONE', countryCode: row.identity.countryCode, convertedAt: row.identity.convertedAt };
    return next();
  } catch (e) { return next(e); }
};

const revokeAllSessions = (identityId) => prisma.guestSession.updateMany({ where: { identityId, revokedAt: null }, data: { revokedAt: new Date() } });

module.exports = { CFG, cfg, PURPOSE, CHANNELS, channelEnabled, enabledChannels, normalizeEmail, maskEmail, otpSecret, keyedOtp, emailIdentityKey, deriveEmailCode, withLocks, requestEmailOtp, verifyEmailOtp, hashSecret, keyed, safeEqualHex, ipHash, toE164, maskPhone, audit, requestOtp, verifyOtp, openSession, requireGuestSession, revokeAllSessions, assertNoRegisteredAccount };
