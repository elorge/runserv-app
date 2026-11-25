'use strict';
// WP-07: GUEST_HASH_SECRET is required whenever the registered/recipient email handover flow is enabled, even with guest booking OFF.
jest.mock('../src/lib/prisma', () => ({}));
const { productionProblems, guestProblems } = require('../src/utils/envGuard');

const base = { NODE_ENV: 'production', REQUIRE_STAFF_MFA: 'true', MFA_ENCRYPTION_KEY: 'm'.repeat(32), JWT_SECRET: 'j'.repeat(40), DATABASE_URL: 'postgres://x', CLIENT_URL: 'https://a.com', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', OSRM_URL: 'https://osrm.example.com' };
const emailFlow = { ...base, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true', BREVO_ENABLED: 'true', BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'a@b.co', POD_CODE_TTL_HOURS: '24', PARCEL_PILOT_SCOPE: 'guest_only' };
const hashed = (o) => guestProblems(o).filter((x) => /GUEST_HASH_SECRET/.test(x));

describe('WP-07 GUEST_HASH_SECRET rule', () => {
  test('email delivery notifications on, guest booking off, no secret: refused', () => {
    expect(hashed(emailFlow)).toHaveLength(1);
    expect(productionProblems(emailFlow).join()).toMatch(/GUEST_HASH_SECRET/);
  });
  test('PARCEL_PILOT_SCOPE=guest_and_registered alone requires it', () => {
    expect(hashed({ ...base, PARCEL_PILOT_SCOPE: 'guest_and_registered' }).length).toBe(1);
  });
  test('weak or placeholder secret is refused', () => {
    expect(hashed({ ...emailFlow, GUEST_HASH_SECRET: 'short' })).toHaveLength(1);
    expect(hashed({ ...emailFlow, GUEST_HASH_SECRET: 'secret' + 'x'.repeat(40) })).toHaveLength(1);
  });
  test('must be distinct from JWT / quote / OTP secrets', () => {
    expect(hashed({ ...emailFlow, GUEST_HASH_SECRET: emailFlow.JWT_SECRET }).join()).toMatch(/must differ/);
    expect(hashed({ ...emailFlow, GUEST_QUOTE_SECRET: 'q'.repeat(40), GUEST_HASH_SECRET: 'q'.repeat(40) }).join()).toMatch(/must differ/);
    expect(hashed({ ...emailFlow, GUEST_OTP_HASH_SECRET: 'o'.repeat(40), GUEST_HASH_SECRET: 'o'.repeat(40) }).join()).toMatch(/must differ/);
  });
  test('a strong distinct secret passes', () => {
    expect(hashed({ ...emailFlow, GUEST_HASH_SECRET: 'h'.repeat(40) })).toEqual([]);
    expect(productionProblems({ ...emailFlow, GUEST_HASH_SECRET: 'h'.repeat(40) })).toEqual([]);
  });
  test('flow off: no requirement; guest booking on reports the secret once, not twice', () => {
    expect(hashed(base)).toEqual([]);
    const booking = { ...emailFlow, GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', GUEST_QUOTE_SECRET: 'q'.repeat(40), GUEST_TRACKING_BASE_URL: 'https://a.com/t' };
    expect(hashed(booking)).toHaveLength(1);
  });
  test('non-production is relaxed', () => { expect(productionProblems({ ...emailFlow, NODE_ENV: 'test' })).toEqual([]); });
});
