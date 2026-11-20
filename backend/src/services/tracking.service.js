// backend/src/services/tracking.service.js
// The rules for live location: who has agreed to share it, which GPS pings are believable, when a position is too old
// to show, and how precisely it may be shown. Pure functions (no database) so they are easy to test; the controllers and
// the socket handler call them.
'use strict';

// Bump this string whenever the consent wording on the phone changes: every driver is then asked to agree again.
const CONSENT_VERSION = '2026-11-v1';

const STALE_AFTER_MS      = 90 * 1000;   // a position older than this is not "live" and is not shown
const MAX_PING_AGE_MS     = 30 * 1000;   // a ping whose own timestamp is older than this is rejected
const MAX_FUTURE_SKEW_MS  = 10 * 1000;   // a clock a little ahead is tolerated, a lot ahead is not
const MAX_ACCURACY_M      = 100;         // a fix worse than 100 m is too vague to place a car on a road
const MAX_SPEED_MS        = 70;          // 252 km/h: faster than this between two pings is a GPS jump, not driving
const MIN_PING_GAP_MS     = 800;         // pings faster than this are dropped (flood guard on top of the socket one)
const APPROX_DECIMALS     = 3;           // ~110 m: what customers see of a driver before booking

const PICKUP_SOURCES = ['GPS', 'MAP_PIN', 'PLACE_SEARCH', 'SAVED_PLACE', 'MANUAL_ENTRY'];

const finite = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const inRange = (n, lo, hi) => n !== null && n >= lo && n <= hi;

/** Has this profile agreed to share its location, on the CURRENT wording, and not withdrawn since? */
const hasValidConsent = (p) => !!p
  && !!p.locationConsentAt
  && p.locationConsentVersion === CONSENT_VERSION
  && !(p.locationConsentRevokedAt && new Date(p.locationConsentRevokedAt) >= new Date(p.locationConsentAt));

const consentState = (p) => ({
  required:  CONSENT_VERSION,
  granted:   hasValidConsent(p),
  version:   p?.locationConsentVersion ?? null,
  grantedAt: p?.locationConsentAt ?? null,
  revokedAt: p?.locationConsentRevokedAt ?? null,
  needsReconsent: !!p?.locationConsentAt && p.locationConsentVersion !== CONSENT_VERSION,
});

/** Is the last stored position recent enough to call live? */
const isFresh = (lastLocationAt, now = Date.now()) => {
  if (!lastLocationAt) return false;
  const t = new Date(lastLocationAt).getTime();
  return Number.isFinite(t) && now - t <= STALE_AFTER_MS && t - now <= MAX_FUTURE_SKEW_MS;
};

/** Round a coordinate so it shows a neighbourhood, not a doorway (3 decimals ≈ 110 m). */
const approx = (n) => (Number.isFinite(n) ? Number(n.toFixed(APPROX_DECIMALS)) : null);

/** Great-circle distance in metres. */
const haversineM = (aLat, aLng, bLat, bLng) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * Check one GPS ping from a driver/courier phone.
 *   raw  – what the phone sent: { lat, lng, accuracy?, heading?, speed?, timestamp? }  (speed in m/s)
 *   prev – the last accepted fix: { lat, lng, at } or null
 * Returns { ok:true, fix } or { ok:false, reason } where reason is one of
 * BAD_COORDS | LOW_ACCURACY | ACCURACY_REQUIRED | STALE_PING | FUTURE_PING | TOO_FAST | TOO_SOON.
 *
 * Accuracy policy (M12, guide §15.2): a fix with NO accuracy value is tolerated for ordinary in-trip pings (older clients,
 * some devices) but is NOT enough to put a driver into the dispatch pool. Callers that gate dispatch pass
 * { requireAccuracy: true } and get ACCURACY_REQUIRED, which the app maps to "wait for a precise GPS fix".
 */
const validatePing = (raw, prev = null, now = Date.now(), { requireAccuracy = false } = {}) => {
  const lat = finite(raw?.lat ?? raw?.latitude);
  const lng = finite(raw?.lng ?? raw?.longitude);
  if (!inRange(lat, -90, 90) || !inRange(lng, -180, 180)) return { ok: false, reason: 'BAD_COORDS' };
  if (lat === 0 && lng === 0) return { ok: false, reason: 'BAD_COORDS' };            // the classic "no fix" value

  const accuracy = finite(raw?.accuracy);
  if (accuracy !== null && (accuracy < 0 || accuracy > MAX_ACCURACY_M)) return { ok: false, reason: 'LOW_ACCURACY' };
  if (requireAccuracy && accuracy === null) return { ok: false, reason: 'ACCURACY_REQUIRED' };

  let at = now;
  if (raw?.timestamp !== undefined && raw?.timestamp !== null) {
    const t = typeof raw.timestamp === 'number' ? raw.timestamp : new Date(raw.timestamp).getTime();
    if (!Number.isFinite(t)) return { ok: false, reason: 'STALE_PING' };
    if (now - t > MAX_PING_AGE_MS) return { ok: false, reason: 'STALE_PING' };
    if (t - now > MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'FUTURE_PING' };
    at = Math.min(t, now);
  }

  if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lng) && prev.at) {
    const prevAt = new Date(prev.at).getTime();
    const dt = at - prevAt;
    if (dt >= 0 && dt < MIN_PING_GAP_MS) return { ok: false, reason: 'TOO_SOON' };
    if (dt > 0 && dt <= STALE_AFTER_MS) {
      const metres = haversineM(prev.lat, prev.lng, lat, lng);
      // Allow for the accuracy of both fixes so a stationary phone wobbling by 30 m is never "too fast".
      const slack = 50 + (accuracy ?? 0);
      if (metres > slack && (metres - slack) / (dt / 1000) > MAX_SPEED_MS) return { ok: false, reason: 'TOO_FAST' };
    }
  }

  const heading = finite(raw?.heading);
  const speed   = finite(raw?.speed);
  return {
    ok: true,
    fix: {
      lat, lng, at,
      accuracy: accuracy,
      heading:  inRange(heading, 0, 360) ? heading % 360 : null,
      speed:    inRange(speed, 0, MAX_SPEED_MS) ? speed : null,
    },
  };
};

/** Pickup details sent with a booking. Never trusted blindly; anything odd is dropped rather than rejecting the booking. */
const sanitizePickup = (body = {}, now = Date.now()) => {
  const src = String(body.pickupSource || '').toUpperCase();
  const acc = finite(body.pickupAccuracy ?? body.pickupAccuracyM);
  let capturedAt = null;
  if (body.pickupCapturedAt) {
    const t = new Date(body.pickupCapturedAt).getTime();
    if (Number.isFinite(t) && t <= now + MAX_FUTURE_SKEW_MS && now - t < 24 * 3600 * 1000) capturedAt = new Date(t);
  }
  return {
    pickupSource:     PICKUP_SOURCES.includes(src) ? src : null,
    pickupAccuracyM:  acc !== null && acc >= 0 && acc <= 5000 ? acc : null,
    pickupCapturedAt: capturedAt,
  };
};

/** The only parts of a driver / courier profile a customer may see on a trip (no licence, ID, guarantor, insurance, coordinates). */
const PUBLIC_DRIVER_FIELDS = ['vehicleType', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'vehiclePlate', 'rating', 'totalRides', 'numberOfSeats', 'vehicleSubType'];
const PUBLIC_PARTNER_FIELDS = ['vehicleType', 'vehiclePlate', 'rating', 'totalDeliveries', 'numberOfSeats', 'vehicleSubType'];

const toSelect = (fields) => Object.fromEntries(fields.map((f) => [f, true]));
/** Prisma `select` objects, so the database never returns the sensitive columns in the first place. */
const DRIVER_PUBLIC_SELECT  = toSelect(PUBLIC_DRIVER_FIELDS);
const PARTNER_PUBLIC_SELECT = toSelect(PUBLIC_PARTNER_FIELDS);
/** What the assigned customer needs from the person on their trip. */
const driverUserSelect  = { id: true, firstName: true, lastName: true, phone: true, profileImage: true, driverProfile: { select: DRIVER_PUBLIC_SELECT } };
const partnerUserSelect = { id: true, firstName: true, lastName: true, phone: true, profileImage: true, deliveryProfile: { select: PARTNER_PUBLIC_SELECT } };

const pick = (obj, fields) => { const o = {}; for (const f of fields) if (obj && f in obj) o[f] = obj[f]; return o; };
const publicDriverProfile  = (p) => (p ? pick(p, PUBLIC_DRIVER_FIELDS) : null);
const publicPartnerProfile = (p) => (p ? pick(p, PUBLIC_PARTNER_FIELDS) : null);

/** Exact position for the ASSIGNED customer only, and only while it is fresh and consented. Otherwise null. */
const assignedLocation = (profile, now = Date.now()) => {
  if (!profile || !hasValidConsent(profile) || !profile.isOnline) return null;
  if (!Number.isFinite(profile.currentLat) || !Number.isFinite(profile.currentLng)) return null;
  const fresh = isFresh(profile.lastLocationAt, now);
  return {
    lat: profile.currentLat, lng: profile.currentLng,
    heading: profile.locationHeading ?? null,
    accuracy: profile.locationAccuracy ?? null,
    updatedAt: profile.lastLocationAt ?? null,
    stale: !fresh,
  };
};

/** True when the profile has a recent, usable GPS fix stored (needed before anyone is dispatched to it). */
const hasUsableFix = (p, now = Date.now()) => !!p && Number.isFinite(p.currentLat) && Number.isFinite(p.currentLng) && isFresh(p.lastLocationAt, now);

/**
 * May this profile sit in the dispatch pool RIGHT NOW? Approved + online + consent on current wording + a fresh fix.
 * Used on reconnect and after every join, so an unapproved / withdrawn / location-less profile never receives requests.
 */
const canJoinDispatchPool = (p, now = Date.now()) => !!p && p.isApproved === true && p.isOnline === true && hasValidConsent(p) && hasUsableFix(p, now);

/** Statuses that mean "a trip is in progress" for each live role (single source of truth for guards). */
const ACTIVE_TRIP_STATUSES = {
  DRIVER: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'],
  DELIVERY_PARTNER: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'],
};

/**
 * Extra WHERE terms that make a profile write ATOMIC with the check it depends on (the database evaluates them in the
 * same statement as the write, so there is no read-then-write gap):
 *   consentedWhere()          – approved AND consent on the current wording AND not withdrawn
 *   notOnTripWhere(role)      – the user has no ride/delivery in progress
 */
const consentedWhere = () => ({ isApproved: true, locationConsentVersion: CONSENT_VERSION, locationConsentRevokedAt: null, locationConsentAt: { not: null } });
const notOnTripWhere = (role) => (role === 'DELIVERY_PARTNER'
  ? { user: { partnerDeliveries: { none: { status: { in: ACTIVE_TRIP_STATUSES.DELIVERY_PARTNER } } } } }
  : { user: { driverRides: { none: { status: { in: ACTIVE_TRIP_STATUSES.DRIVER } } } } });

/** Prisma filter for "could appear in a nearby list": consented on the current wording, online, recently located. */
const nearbyWhere = (now = Date.now()) => ({
  isApproved: true,
  isOnline: true,
  locationConsentVersion: CONSENT_VERSION,
  locationConsentRevokedAt: null,
  locationConsentAt: { not: null },
  currentLat: { not: null },
  currentLng: { not: null },
  lastLocationAt: { gte: new Date(now - STALE_AFTER_MS) },
});

module.exports = {
  CONSENT_VERSION, STALE_AFTER_MS, MAX_PING_AGE_MS, MAX_ACCURACY_M, MAX_SPEED_MS, APPROX_DECIMALS, PICKUP_SOURCES,
  hasValidConsent, consentState, isFresh, hasUsableFix, canJoinDispatchPool, ACTIVE_TRIP_STATUSES, consentedWhere, notOnTripWhere, approx, haversineM, validatePing, sanitizePickup,
  PUBLIC_DRIVER_FIELDS, PUBLIC_PARTNER_FIELDS, DRIVER_PUBLIC_SELECT, PARTNER_PUBLIC_SELECT, driverUserSelect, partnerUserSelect,
  publicDriverProfile, publicPartnerProfile, assignedLocation, nearbyWhere,
};
