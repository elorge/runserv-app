// backend/src/services/guestQuote.service.js
//
// Guest journey planning (Stage 1 of the guest-booking plan). PREVIEW ONLY: nothing here creates a ride or delivery.
// (Stage 3, services/guestBooking.service.js, consumes verifyQuote; the quote is bound to the exact pickup, destination and parcel.)
//   - quotes are built from a REAL provider route + the server rate card (never client-supplied distance or fare);
//   - every quote carries a server id, issuedAt and expiresAt, and an HMAC signature, so a later guest-confirmation stage can
//     re-verify it without trusting the client (verifyQuote). A signed preview is NOT a booking and NOT a guaranteed fare;
//   - parcel quotes are checked against the vehicle's approved capacity before a price is shown.
'use strict';
const crypto = require('crypto');

const QUOTE_TTL_MS = 10 * 60 * 1000;

/** Max parcel weight (kg) and longest side (cm) each vehicle may carry. Conservative defaults; tune per market before enabling. */
const PARCEL_CAPACITY = {
  MOTORCYCLE: { maxKg: 10, maxSideCm: 50 },
  TRICYCLE:   { maxKg: 150, maxSideCm: 120 },
  CAR:        { maxKg: 40, maxSideCm: 100 },
  VAN:        { maxKg: 500, maxSideCm: 250 },
};
const PARCEL_CATEGORIES = ['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE'];
/** Never carried, whatever the vehicle. Shown to the sender before a parcel quote. */
const PROHIBITED_PARCEL_ITEMS = ['weapons or ammunition', 'illegal drugs', 'explosives, flammable or hazardous materials', 'live animals', 'cash or valuables you cannot afford to lose'];

const SERVICES = ['RIDE', 'PARCEL'];

const secret = (env = process.env) => {
  const s = env.GUEST_QUOTE_SECRET || (require('../utils/envGuard').isProduction(env) ? '' : env.JWT_SECRET);   // M16: no JWT fallback in production
  if (!s) { const e = new Error('GUEST_QUOTE_SECRET is not configured'); e.code = 'QUOTE_SECRET_MISSING'; throw e; }
  return `guest-quote:${s}`;
};

/** GUEST_PLANNING_ENABLED must be "true" to serve guest quotes (default OFF: release deliberately). */
const planningEnabled = (env = process.env) => String(env.GUEST_PLANNING_ENABLED || '').toLowerCase() === 'true';

/**
 * Can this parcel travel on this vehicle? Returns { ok, reason? }. `weightKg` and `longestSideCm` optional (category-only ok).
 */
function parcelEligibility({ vehicleType, category, weightKg, longestSideCm }) {
  const cap = PARCEL_CAPACITY[vehicleType];
  if (!cap) return { ok: false, reason: 'UNSUPPORTED_VEHICLE', message: 'This vehicle is not available for parcels.' };
  if (category && !PARCEL_CATEGORIES.includes(category)) return { ok: false, reason: 'UNKNOWN_CATEGORY', message: 'Choose a valid parcel category.' };
  const kg = weightKg == null ? null : Number(weightKg);
  if (kg != null && (!Number.isFinite(kg) || kg <= 0)) return { ok: false, reason: 'INVALID_WEIGHT', message: 'Enter a valid parcel weight.' };
  if (kg != null && kg > cap.maxKg) return { ok: false, reason: 'TOO_HEAVY', message: `Too heavy for this vehicle (max ${cap.maxKg} kg). Choose a larger vehicle.` };
  const side = longestSideCm == null ? null : Number(longestSideCm);
  if (side != null && (!Number.isFinite(side) || side <= 0)) return { ok: false, reason: 'INVALID_SIZE', message: 'Enter a valid parcel size.' };
  if (side != null && side > cap.maxSideCm) return { ok: false, reason: 'TOO_LARGE', message: `Too large for this vehicle (longest side max ${cap.maxSideCm} cm). Choose a larger vehicle.` };
  return { ok: true };
}

/** GUEST_BOOKING_ENABLED must ALSO be "true" (and planning on) before a verified guest can create a booking. Default OFF. */
const bookingEnabled = (env = process.env) => planningEnabled(env) && String(env.GUEST_BOOKING_ENABLED || '').toLowerCase() === 'true';

/** Stable key for a point: 5 decimals ≈ 1 m. The quote is bound to it, so a cheap quote cannot be reused for a different trip. */
const coordKey = (p) => {
  const la = Number(p?.latitude); const ln = Number(p?.longitude);
  return Number.isFinite(la) && Number.isFinite(ln) ? `${la.toFixed(5)},${ln.toFixed(5)}` : null;
};
/** Stable key for the parcel a parcel quote was priced for (weight changes the fee, size/category change eligibility). */
const parcelKey = (parcel) => {
  if (!parcel) return null;
  const n = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2));
  return `${String(parcel.category || '').toUpperCase()}|${n(parcel.weightKg)}|${n(parcel.longestSideCm)}`;
};

const canonical = (p) => JSON.stringify([p.id, p.service, p.vehicleType, p.fare, p.currency, p.countryCode, p.distanceM, p.durationS, p.issuedAt, p.expiresAt, p.pickupKey ?? null, p.destKey ?? null, p.parcelKey ?? null]);
const sign = (payload, env = process.env) => crypto.createHmac('sha256', secret(env)).update(canonical(payload)).digest('hex');

/** Builds a signed quote payload. `now` injectable for tests. */
function signQuote({ service, vehicleType, fare, currency, countryCode, distanceM, durationS, pickup, destination, parcel }, { now = Date.now(), env = process.env } = {}) {
  const payload = {
    id: `gq_${crypto.randomBytes(12).toString('hex')}`, service, vehicleType, fare, currency, countryCode,
    distanceM: Math.round(distanceM), durationS: Math.round(durationS), issuedAt: now, expiresAt: now + QUOTE_TTL_MS,
    pickupKey: coordKey(pickup), destKey: coordKey(destination), parcelKey: service === 'PARCEL' ? parcelKey(parcel) : null,
  };
  return { ...payload, signature: sign(payload, env) };
}

/** Constant-time signature check + expiry. Returns { ok, reason? }. Used by the (future) guest-confirmation stage. */
function verifyQuote(q, { now = Date.now(), env = process.env } = {}) {
  if (!q || typeof q.signature !== 'string') return { ok: false, reason: 'MISSING_SIGNATURE' };
  let expected;
  try { expected = sign(q, env); } catch { return { ok: false, reason: 'UNAVAILABLE' }; }
  const a = Buffer.from(expected, 'hex'); const b = Buffer.from(q.signature, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!(now < q.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  return { ok: true };
}

module.exports = { QUOTE_TTL_MS, PARCEL_CAPACITY, PARCEL_CATEGORIES, PROHIBITED_PARCEL_ITEMS, SERVICES, planningEnabled, bookingEnabled, coordKey, parcelKey, parcelEligibility, signQuote, verifyQuote };
