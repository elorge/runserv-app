'use strict';
process.env.NODE_ENV = 'test';
const { errorHandler, AppError } = require('../src/middleware/errorHandler');

const run = (err) => { let body; let status; const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } }; errorHandler(err, { method: 'GET', originalUrl: '/x', ip: '1.1.1.1', user: null, headers: {} }, res, () => {}); return { status, body }; };
const mk = (message, statusCode, code, extra = {}) => Object.assign(new AppError(message, statusCode), { code, ...extra });

describe('error codes the mobile apps may see', () => {
  test.each(['QUOTE_EXPIRED', 'OTP_WRONG', 'OTP_COOLDOWN', 'GUEST_SESSION_EXPIRED', 'GUEST_DAILY_LIMIT', 'POD_REQUIRED', 'POD_LOCKED', 'PARCEL_WEIGHT_REQUIRED', 'RECIPIENT_PHONE_INVALID', 'IDEMPOTENCY_MISMATCH', 'EMAIL_TAKEN', 'ROUTE_UNAVAILABLE', 'NOT_CANCELLABLE', 'ACTIVE_BOOKING_EXISTS'])('%s is exposed', (code) => {
    expect(run(mk('m', 400, code)).body.code).toBe(code);
  });
  test('wrong-code attempts left is exposed with POD codes only', () => {
    expect(run(mk('m', 400, 'POD_WRONG', { attemptsLeft: 3 })).body).toMatchObject({ code: 'POD_WRONG', attemptsLeft: 3 });
    expect(run(mk('m', 400, 'SOMETHING_ELSE', { attemptsLeft: 3 })).body.attemptsLeft).toBeUndefined();
  });
  test('internal / provider / database codes stay hidden', () => {
    for (const code of ['P2002', 'ECONNREFUSED', 'SOME_INTERNAL', undefined]) expect(run(mk('boom', 400, code)).body.code).toBeUndefined();
  });
  test('existing ORG_/PHONE_/LOCATION_ behaviour is unchanged', () => {
    for (const code of ['ORG_NOT_ALLOWED', 'PHONE_TAKEN', 'LOCATION_CONSENT_REQUIRED']) expect(run(mk('m', 403, code)).body.code).toBe(code);
  });
});
