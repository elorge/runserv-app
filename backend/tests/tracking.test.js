'use strict';
// M10: consent, ping validation, staleness, rounding and the public profile subset.
const T = require('../src/services/tracking.service');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const consented = (o = {}) => ({ locationConsentAt: new Date(NOW - 1000), locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null, ...o });

describe('consent', () => {
  test('current wording, not withdrawn = valid', () => expect(T.hasValidConsent(consented())).toBe(true));
  test('never consented', () => expect(T.hasValidConsent({})).toBe(false));
  test('null profile', () => expect(T.hasValidConsent(null)).toBe(false));
  test('changed wording means asked again', () => {
    const p = consented({ locationConsentVersion: '2020-old' });
    expect(T.hasValidConsent(p)).toBe(false);
    expect(T.consentState(p)).toMatchObject({ granted: false, needsReconsent: true, required: T.CONSENT_VERSION });
  });
  test('withdrawn after granting', () => expect(T.hasValidConsent(consented({ locationConsentRevokedAt: new Date(NOW) }))).toBe(false));
  test('granted again after withdrawing', () => expect(T.hasValidConsent(consented({ locationConsentRevokedAt: new Date(NOW - 5000) }))).toBe(true));
});

describe('validatePing', () => {
  const ok = (raw, prev, now = NOW) => T.validatePing(raw, prev, now);
  test('accepts a good fix and keeps heading/speed/accuracy', () => {
    const r = ok({ lat: 6.6, lng: 3.35, accuracy: 12, heading: 360, speed: 8 });
    expect(r.ok).toBe(true);
    expect(r.fix).toMatchObject({ lat: 6.6, lng: 3.35, accuracy: 12, heading: 0, speed: 8 });
  });
  test.each([[{ lat: 91, lng: 0 }], [{ lat: 'x', lng: 3 }], [{ lat: 0, lng: 0 }], [{}], [null]])('bad coordinates %j', (raw) => expect(ok(raw)).toEqual({ ok: false, reason: 'BAD_COORDS' }));
  test('accepts latitude/longitude names too', () => expect(ok({ latitude: 6.5, longitude: 3.3 }).ok).toBe(true));
  test('vague accuracy is rejected', () => expect(ok({ lat: 6.5, lng: 3.3, accuracy: 250 }).reason).toBe('LOW_ACCURACY'));
  test('old ping is rejected', () => expect(ok({ lat: 6.5, lng: 3.3, timestamp: NOW - 60000 }).reason).toBe('STALE_PING'));
  test('ping from the future is rejected', () => expect(ok({ lat: 6.5, lng: 3.3, timestamp: NOW + 60000 }).reason).toBe('FUTURE_PING'));
  test('garbage heading/speed are dropped, not fatal', () => {
    const r = ok({ lat: 6.5, lng: 3.3, heading: -5, speed: 999 });
    expect(r.ok).toBe(true); expect(r.fix.heading).toBeNull(); expect(r.fix.speed).toBeNull();
  });
  test('an impossible jump is rejected', () => {
    const prev = { lat: 6.5, lng: 3.3, at: NOW - 2000 };
    expect(ok({ lat: 6.9, lng: 3.3 }, prev).reason).toBe('TOO_FAST');   // ~44 km in 2 s
  });
  test('normal driving is accepted', () => {
    const prev = { lat: 6.5, lng: 3.3, at: NOW - 5000 };
    expect(ok({ lat: 6.5002, lng: 3.3, accuracy: 10 }, prev).ok).toBe(true);
  });
  test('a stationary phone wobbling by 20 m is accepted', () => {
    const prev = { lat: 6.5, lng: 3.3, at: NOW - 2000 };
    expect(ok({ lat: 6.50018, lng: 3.3, accuracy: 25 }, prev).ok).toBe(true);
  });
  test('pings faster than the minimum gap are dropped', () => {
    expect(ok({ lat: 6.5, lng: 3.3 }, { lat: 6.5, lng: 3.3, at: NOW - 200 }).reason).toBe('TOO_SOON');
  });
  test('after a long silence a big move is not called a jump', () => {
    expect(ok({ lat: 6.9, lng: 3.3 }, { lat: 6.5, lng: 3.3, at: NOW - 600000 }).ok).toBe(true);
  });
});

describe('staleness, rounding and distance', () => {
  test('fresh within 90 s, stale after', () => {
    expect(T.isFresh(new Date(NOW - 30000), NOW)).toBe(true);
    expect(T.isFresh(new Date(NOW - 91000), NOW)).toBe(false);
    expect(T.isFresh(null, NOW)).toBe(false);
  });
  test('approx rounds to about 110 m', () => {
    expect(T.approx(6.601812)).toBe(6.602);
    expect(T.haversineM(6.601812, 3.351499, T.approx(6.601812), T.approx(3.351499))).toBeLessThan(80);
    expect(T.approx(NaN)).toBeNull();
  });
});

describe('pickup details', () => {
  test('keeps a valid source, accuracy and capture time', () => {
    const r = T.sanitizePickup({ pickupSource: 'gps', pickupAccuracy: 12, pickupCapturedAt: new Date(NOW - 5000).toISOString() }, NOW);
    expect(r).toMatchObject({ pickupSource: 'GPS', pickupAccuracyM: 12 });
    expect(r.pickupCapturedAt).toBeInstanceOf(Date);
  });
  test('drops odd values instead of failing the booking', () => {
    expect(T.sanitizePickup({ pickupSource: 'TELEPATHY', pickupAccuracy: -4, pickupCapturedAt: 'yesterday-ish' }, NOW)).toEqual({ pickupSource: null, pickupAccuracyM: null, pickupCapturedAt: null });
    expect(T.sanitizePickup({}, NOW).pickupSource).toBeNull();
  });
});

describe('what a customer may see', () => {
  const profile = { vehicleType: 'CAR', vehicleMake: 'Toyota', vehiclePlate: 'LND-1', rating: 4.8, licenseNumber: 'L-1', govtIdUrl: 'x', guarantorIdUrl: 'y', insuranceUrl: 'z', currentLat: 6.5, currentLng: 3.3 };
  test('public subset has no documents or coordinates', () => {
    const p = T.publicDriverProfile(profile);
    expect(p).toMatchObject({ vehicleType: 'CAR', vehiclePlate: 'LND-1', rating: 4.8 });
    for (const k of ['licenseNumber', 'govtIdUrl', 'guarantorIdUrl', 'insuranceUrl', 'currentLat', 'currentLng']) expect(p).not.toHaveProperty(k);
  });
  test('prisma select never asks for the sensitive columns', () => {
    for (const k of ['licenseNumber', 'licenseImageUrl', 'govtIdUrl', 'guarantorLetterUrl', 'insuranceUrl', 'currentLat', 'currentLng']) {
      expect(T.DRIVER_PUBLIC_SELECT).not.toHaveProperty(k); expect(T.PARTNER_PUBLIC_SELECT).not.toHaveProperty(k);
    }
  });
  test('assigned location: exact only while consented, online and has a fix; stale flag after 90 s', () => {
    const base = consented({ isOnline: true, currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date(NOW - 10000), locationHeading: 90 });
    expect(T.assignedLocation(base, NOW)).toMatchObject({ lat: 6.5, lng: 3.3, heading: 90, stale: false });
    expect(T.assignedLocation({ ...base, lastLocationAt: new Date(NOW - 120000) }, NOW).stale).toBe(true);
    expect(T.assignedLocation({ ...base, locationConsentAt: null }, NOW)).toBeNull();
    expect(T.assignedLocation({ ...base, isOnline: false }, NOW)).toBeNull();
    expect(T.assignedLocation({ ...base, currentLat: null }, NOW)).toBeNull();
  });
  test('nearby filter requires consent on current wording and a recent fix', () => {
    const w = T.nearbyWhere(NOW);
    expect(w).toMatchObject({ isApproved: true, isOnline: true, locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null });
    expect(w.lastLocationAt.gte.getTime()).toBe(NOW - T.STALE_AFTER_MS);
  });
});
