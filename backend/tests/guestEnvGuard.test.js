'use strict';
jest.mock('../src/lib/prisma', () => ({}));
const { productionProblems, guestProblems } = require('../src/utils/envGuard');

const base = { NODE_ENV: 'production', REQUIRE_STAFF_MFA: 'true', MFA_ENCRYPTION_KEY: 'm'.repeat(32), JWT_SECRET: 'j'.repeat(40), DATABASE_URL: 'postgres://x', CLIENT_URL: 'https://a.com', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', OSRM_URL: 'https://osrm.example.com' };
const good = { ...base, GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', GUEST_QUOTE_SECRET: 'q'.repeat(40), GUEST_HASH_SECRET: 'h'.repeat(40), GUEST_TRACKING_BASE_URL: 'https://api.example.com/t', GUEST_OTP_CHANNEL: 'email', GUEST_EMAIL_OTP_ENABLED: 'true', GUEST_OTP_HASH_SECRET: 'o'.repeat(40), BREVO_ENABLED: 'true', BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'no-reply@example.com', RESEND_ENABLED: 'true', RESEND_API_KEY: 'k', RESEND_SENDER_EMAIL: 'no-reply@example.com' };

describe('guest production env validation', () => {
  test('guest features dark: no guest requirements', () => { expect(guestProblems(base)).toEqual([]); expect(productionProblems(base)).toEqual([]); });
  test('a complete configuration passes', () => { expect(productionProblems(good)).toEqual([]); });
  test('booking without planning is refused', () => { expect(guestProblems({ ...good, GUEST_PLANNING_ENABLED: 'false' }).join()).toMatch(/requires GUEST_PLANNING_ENABLED/); });
  test('missing or weak quote secret', () => {
    expect(guestProblems({ ...good, GUEST_QUOTE_SECRET: '' }).join()).toMatch(/GUEST_QUOTE_SECRET/);
    expect(guestProblems({ ...good, GUEST_QUOTE_SECRET: 'short' }).join()).toMatch(/GUEST_QUOTE_SECRET/);
  });
  test('hash secret: required, strong, and separate', () => {
    expect(guestProblems({ ...good, GUEST_HASH_SECRET: '' }).join()).toMatch(/GUEST_HASH_SECRET/);
    expect(guestProblems({ ...good, GUEST_HASH_SECRET: good.JWT_SECRET }).join()).toMatch(/must differ/);
    expect(guestProblems({ ...good, GUEST_HASH_SECRET: good.GUEST_QUOTE_SECRET }).join()).toMatch(/must differ/);
  });
  test('tracking URL must be absolute https', () => {
    ['', 'http://api.example.com/t', '/t', 'not a url'].forEach((u) => expect(guestProblems({ ...good, GUEST_TRACKING_BASE_URL: u }).join()).toMatch(/GUEST_TRACKING_BASE_URL/));
  });
  test('M16.1: booking needs a verification channel; email is enough and SMS is no longer required', () => {
    expect(guestProblems({ ...good, GUEST_EMAIL_OTP_ENABLED: 'false' }).join()).toMatch(/needs a verification channel/);
    expect(guestProblems(good).join()).not.toMatch(/SMS|TERMII/);
  });
  test('M16.1: SMS settings are checked only when SMS OTP is deliberately enabled (flag AND channel list)', () => {
    const sms = { ...good, GUEST_OTP_CHANNEL: 'email,sms', GUEST_SMS_OTP_ENABLED: 'true' };
    expect(guestProblems(sms).join()).toMatch(/ENABLE_SMS_DELIVERY/);
    expect(guestProblems({ ...sms, ENABLE_SMS_DELIVERY: 'true' }).join()).toMatch(/TERMII/);
    expect(guestProblems({ ...sms, ENABLE_SMS_DELIVERY: 'true', TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'R' })).toEqual([]);
    expect(guestProblems({ ...good, GUEST_OTP_CHANNEL: 'email,sms' }).join()).toMatch(/lists sms but GUEST_SMS_OTP_ENABLED/);
  });
  test('M16.1: the OTP hash secret is dedicated: required, strong, never reused, no JWT fallback', () => {
    expect(guestProblems({ ...good, GUEST_OTP_HASH_SECRET: '' }).join()).toMatch(/GUEST_OTP_HASH_SECRET/);
    expect(guestProblems({ ...good, GUEST_OTP_HASH_SECRET: good.JWT_SECRET }).join()).toMatch(/must differ/);
    expect(guestProblems({ ...good, GUEST_OTP_HASH_SECRET: good.GUEST_HASH_SECRET }).join()).toMatch(/must differ/);
  });
  test('M16.1: email providers must be enabled and configured; base URLs must be the providers own https hosts', () => {
    expect(guestProblems({ ...good, BREVO_ENABLED: 'false', RESEND_ENABLED: 'false' }).join()).toMatch(/at least one provider/);
    expect(guestProblems({ ...good, BREVO_API_KEY: '' }).join()).toMatch(/BREVO_API_KEY/);
    expect(guestProblems({ ...good, RESEND_API_KEY: '' }).join()).toMatch(/RESEND_API_KEY/);
    expect(guestProblems({ ...good, BREVO_API_BASE_URL: 'https://evil.example.com/v3' }).join()).toMatch(/BREVO_API_BASE_URL/);
    expect(guestProblems({ ...good, BREVO_API_BASE_URL: 'https://api.brevo.com/v3' })).toEqual([]);
    expect(guestProblems({ ...good, BREVO_DAILY_ALLOCATION: '-1' }).join()).toMatch(/BREVO_DAILY_ALLOCATION/);
  });
  test('development and test are not constrained', () => { expect(productionProblems({ NODE_ENV: 'development', GUEST_BOOKING_ENABLED: 'true' })).toEqual([]); });
  test('production has no JWT fallback for the hash or quote secret', () => {
    jest.isolateModules(() => {
      const id = require('../src/services/guestIdentity.service');
      expect(() => id.keyed('otp', 'x', { NODE_ENV: 'production', JWT_SECRET: 'j'.repeat(40) })).toThrow(/not configured/);
      expect(() => id.keyed('otp', 'x', { NODE_ENV: 'test', JWT_SECRET: 'jwt' })).not.toThrow();
      const q = require('../src/services/guestQuote.service');
      expect(() => q.signQuote({ id: 'a' }, { NODE_ENV: 'production', JWT_SECRET: 'j'.repeat(40) })).toThrow();
    });
  });
});
