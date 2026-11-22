// backend/src/services/podCode.service.js
//
// M16.2.1: the RECIPIENT HAND-OVER CODE lifecycle (guide §5, action plan P1.1). One module owns generate / derive / expire / rotate, so the rules
// cannot drift between booking, email, SMS, courier verification and Admin.
//
//   * UNPREDICTABLE: a fresh 128-bit random nonce per code; the 6 digits are HMAC(secret, deliveryId:nonce). Without the server secret the
//     nonce reveals nothing, and no two codes of a delivery are related (the old code was a pure function of the delivery id).
//   * HASHED AT REST: only a keyed hash (podHash) and the nonce are stored. The plaintext code is never persisted, logged or audited; the outbox
//     worker re-derives it at send time (same pattern as the guest email OTP).
//   * EXPIRY: POD_CODE_TTL_HOURS. Not set in code: unset means "no expiry" and production start-up refuses delivery email without it (envGuard).
//   * ROTATION: one conditional UPDATE swaps nonce + hash + expiry and resets the attempt counter. The WHERE clause names the OLD hash, so two
//     concurrent rotations cannot both win and a verification racing a rotation cannot succeed with the old code.
//   * RESEND is a different action (deliveryComms.resendRecipient): same active code, refused when it has expired or was never usable.
'use strict';
const crypto = require('crypto');
const identity = require('./guestIdentity.service');

const CODE_LENGTH = 6;

/** Expiry window in ms, or null when no policy is configured. An invalid value is treated as "not configured" (and envGuard blocks production). */
function ttlMs(env = process.env) {
  const raw = env.POD_CODE_TTL_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const h = Number(raw);
  return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? Math.round(h * 3600 * 1000) : null;
}
const ttlConfigured = (env = process.env) => ttlMs(env) !== null;

/** Keyed hash bound to the delivery id (a hash copied from one delivery is useless on another). Same formula as before: legacy rows still verify. */
const podHash = (deliveryId, code, env = process.env) => identity.keyed('pod', `${deliveryId}:${code}`, env);

/** M16.2.1 derivation: HMAC(secret, deliveryId : nonce) -> 6 digits. 48 bits reduced mod 10^6: bias below 4e-9. */
const deriveCode = (deliveryId, nonce, env = process.env) => {
  const n = crypto.createHmac('sha256', `pod-code-v2:${identity.hashSecret(env)}`).update(`${deliveryId}:${nonce}`).digest().readUIntBE(0, 6) % (10 ** CODE_LENGTH);
  return String(n).padStart(CODE_LENGTH, '0');
};

/** Pre-M16.2.1 derivation (pure function of the delivery id). Kept ONLY so deliveries created before the upgrade keep working until rotated. */
const legacyCode = (deliveryId, env = process.env) => {
  const n = crypto.createHmac('sha256', `guest-pod:${identity.hashSecret(env)}`).update(String(deliveryId)).digest().readUIntBE(0, 6) % (10 ** CODE_LENGTH);
  return String(n).padStart(CODE_LENGTH, '0');
};

/** A brand-new active code for a delivery: { nonce, code, hash, expiresAt }. `code` goes to the notification worker's render only. */
function generate(deliveryId, { now = Date.now(), env = process.env } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const code = deriveCode(deliveryId, nonce, env);
  const ttl = ttlMs(env);
  return { nonce, code, hash: podHash(deliveryId, code, env), expiresAt: ttl ? new Date(now + ttl) : null };
}

/** The plaintext code of a delivery's CURRENT lifecycle, for the notification worker / the (opt-in) sender screen. Never for Admin. */
const codeFor = (delivery, env = process.env) => (delivery.podCodeNonce ? deriveCode(delivery.id, delivery.podCodeNonce, env) : legacyCode(delivery.id, env));

const isExpired = (delivery, now = Date.now()) => !!delivery.podCodeExpiresAt && now >= new Date(delivery.podCodeExpiresAt).getTime();

/** What Admin may know about the code: a state, never a value. NOT_REQUIRED | VERIFIED | LOCKED | EXPIRED | ACTIVE. */
function stateOf(delivery, now = Date.now(), maxAttempts = 5) {
  if (!delivery?.podCodeHash) return 'NOT_REQUIRED';
  if (delivery.podVerifiedAt) return 'VERIFIED';
  if ((delivery.podCodeAttempts || 0) >= maxAttempts) return 'LOCKED';
  if (isExpired(delivery, now)) return 'EXPIRED';
  return 'ACTIVE';
}

/** Admin-safe description of the code lifecycle (no code, no hash, no nonce). */
const lifecycleView = (delivery, now = Date.now(), maxAttempts = 5) => ({
  state: stateOf(delivery, now, maxAttempts), version: delivery?.podCodeVersion ?? 1, expiresAt: delivery?.podCodeExpiresAt ?? null,
  rotatedAt: delivery?.podCodeRotatedAt ?? null, legacy: !!delivery?.podCodeHash && !delivery?.podCodeNonce, expiryPolicyConfigured: ttlConfigured(),
});

module.exports = { CODE_LENGTH, ttlMs, ttlConfigured, podHash, deriveCode, legacyCode, generate, codeFor, isExpired, stateOf, lifecycleView };
