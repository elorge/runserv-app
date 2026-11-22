'use strict';
jest.mock('../src/lib/prisma', () => ({}));
const ENV = { NODE_ENV: 'test', JWT_SECRET: 'test-secret', GUEST_PLANNING_ENABLED: 'true' };
const guest = require('../src/services/guestQuote.service');

const base = { service: 'RIDE', vehicleType: 'CAR', fare: 1500, currency: 'NGN', countryCode: 'NG', distanceM: 5000, durationS: 900 };

describe('guest quote signing', () => {
  test('a fresh quote verifies and carries id + expiry', () => {
    const q = guest.signQuote(base, { now: 1000, env: ENV });
    expect(q.id).toMatch(/^gq_[0-9a-f]{24}$/);
    expect(q.expiresAt).toBe(1000 + guest.QUOTE_TTL_MS);
    expect(guest.verifyQuote(q, { now: 2000, env: ENV })).toEqual({ ok: true });
  });
  test('expired quote is rejected', () => {
    const q = guest.signQuote(base, { now: 1000, env: ENV });
    expect(guest.verifyQuote(q, { now: 1000 + guest.QUOTE_TTL_MS, env: ENV })).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  test('tampering with the fare (client-submitted total) is rejected', () => {
    const q = guest.signQuote(base, { now: 1000, env: ENV });
    expect(guest.verifyQuote({ ...q, fare: 100 }, { now: 1001, env: ENV }).reason).toBe('BAD_SIGNATURE');
    expect(guest.verifyQuote({ ...q, expiresAt: q.expiresAt + 9e9 }, { now: 1001, env: ENV }).reason).toBe('BAD_SIGNATURE');
  });
  test('a different secret cannot verify, a missing signature is refused', () => {
    const q = guest.signQuote(base, { now: 1000, env: ENV });
    expect(guest.verifyQuote(q, { now: 1001, env: { NODE_ENV: 'test', JWT_SECRET: 'other' } }).ok).toBe(false);
    expect(guest.verifyQuote({ ...q, signature: undefined }, { now: 1001, env: ENV }).reason).toBe('MISSING_SIGNATURE');
    expect(guest.verifyQuote({ ...q, signature: 'zz' }, { now: 1001, env: ENV }).ok).toBe(false);
  });
});

describe('guest planning flag', () => {
  test('off by default', () => { expect(guest.planningEnabled({})).toBe(false); expect(guest.planningEnabled({ GUEST_PLANNING_ENABLED: 'true' })).toBe(true); });
});

describe('parcel eligibility', () => {
  test('light parcel fits a motorcycle', () => expect(guest.parcelEligibility({ vehicleType: 'MOTORCYCLE', category: 'SMALL', weightKg: 2, longestSideCm: 30 }).ok).toBe(true));
  test('heavy / oversize parcels are blocked with a reason', () => {
    expect(guest.parcelEligibility({ vehicleType: 'MOTORCYCLE', weightKg: 25 }).reason).toBe('TOO_HEAVY');
    expect(guest.parcelEligibility({ vehicleType: 'MOTORCYCLE', longestSideCm: 90 }).reason).toBe('TOO_LARGE');
    expect(guest.parcelEligibility({ vehicleType: 'VAN', weightKg: 25, longestSideCm: 90 }).ok).toBe(true);
  });
  test('bad input is refused', () => {
    expect(guest.parcelEligibility({ vehicleType: 'BOAT' }).reason).toBe('UNSUPPORTED_VEHICLE');
    expect(guest.parcelEligibility({ vehicleType: 'CAR', weightKg: -1 }).reason).toBe('INVALID_WEIGHT');
    expect(guest.parcelEligibility({ vehicleType: 'CAR', category: 'HUGE' }).reason).toBe('UNKNOWN_CATEGORY');
  });
});

describe('POST /api/guest/quote controller', () => {
  const run = async (body, { enabled = true, route } = {}) => {
    jest.resetModules();
    process.env.JWT_SECRET = 'test-secret';
    if (enabled) process.env.GUEST_PLANNING_ENABLED = 'true'; else delete process.env.GUEST_PLANNING_ENABLED;
    jest.doMock('../src/services/maps/routing.service', () => ({ valid: (p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude), routeBetween: jest.fn(async () => route === undefined ? { coords: [{ latitude: 6.5, longitude: 3.3 }], distanceM: 5000, durationS: 900, provider: 'osrm' } : route) }));
    jest.doMock('../src/utils/fareEngine', () => ({
      getSettings: async () => ({ currency: 'NGN' }),
      estimateFare: async (km, v) => ({ estimatedFare: 1500, surgeMultiplier: 1, baseFare: 500, distanceCharge: 650, timeCharge: 250, bookingFee: 100, currency: 'NGN', countryCode: 'NG' }),
      calculateDeliveryFee: async () => ({ estimatedFee: 900, baseFee: 500, distanceCharge: 300, weightCharge: 100, currency: 'NGN', countryCode: 'NG' }),
    }));
    const c = require('../src/controllers/guest.controller');
    let out; const res = { set() { return this; }, json(v) { out = v; return this; } };
    try { await c.quote({ body }, res); return out; } catch (e) { return { error: e }; }
  };
  const P = { pickup: { latitude: 6.5, longitude: 3.3 }, destination: { latitude: 6.6, longitude: 3.4 } };

  test('refuses when the flag is off', async () => expect((await run(P, { enabled: false })).error.code).toBe('GUEST_PLANNING_DISABLED'));
  test('returns provider route values + signed, expiring quotes; never trusts client distance', async () => {
    const r = await run({ ...P, distanceKm: 1, fare: 1 });
    expect(r.data.preview).toBe(true);
    expect(r.data.route.distanceM).toBe(5000);
    expect(r.data.options.length).toBeGreaterThan(0);
    for (const o of r.data.options) expect(guest.verifyQuote(o.quote, { env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret' } }).ok).toBe(true);
  });
  test('no route => explicit error, not an invented distance', async () => expect((await run(P, { route: null })).error.code).toBe('ROUTE_UNAVAILABLE'));
  test('parcel too heavy for a motorcycle is listed as unavailable with a reason', async () => {
    const r = await run({ ...P, service: 'PARCEL', parcel: { category: 'LARGE', weightKg: 25 } });
    expect(r.data.unavailable.find((u) => u.vehicleType === 'MOTORCYCLE').reason).toBe('TOO_HEAVY');
    expect(r.data.prohibited.length).toBeGreaterThan(0);
  });
});
