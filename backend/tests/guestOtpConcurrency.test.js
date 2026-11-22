'use strict';
// M16: OTP limits must hold under PARALLEL requests, not just sequential ones.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

process.env.JWT_SECRET = 'test-secret';
const identity = require('../src/services/guestIdentity.service');

const env = { JWT_SECRET: 'test-secret', ENABLE_SMS_DELIVERY: 'true', NODE_ENV: 'test' };
const PHONE = '+2348012345678';
const ask = (sms, over = {}) => identity.requestOtp({ phone: PHONE, countryCode: 'NG', ip: '9.9.9.9', env, sms, ...over });
const settle = (ps) => Promise.allSettled(ps);

beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('parallel OTP requests', () => {
  test('10 simultaneous sends for one number: at most one code survives the cooldown', async () => {
    const sms = { send: jest.fn() };
    const res = await settle(Array.from({ length: 10 }, () => ask(sms)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(mockDb._t('guestOtp')).toHaveLength(1);
    res.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('OTP_COOLDOWN'));
  });

  test('parallel sends can never exceed the hourly per-phone cap', async () => {
    const sms = { send: jest.fn() };
    // Pre-load 3 earlier codes (all older than the cooldown) so only 2 more may be issued this hour.
    const old = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) mockDb._t('guestOtp').push({ id: `o${i}`, phone: PHONE, countryCode: 'NG', codeHash: 'x', attempts: 0, consumedAt: null, createdAt: new Date(old + i * 1000), expiresAt: new Date(Date.now() + 1e5) });
    // Different clock offsets so the cooldown does not mask the hourly cap.
    const res = await settle(Array.from({ length: 8 }, (_, i) => ask(sms, { now: Date.now() + (i + 1) * 61000 })));
    const sentRows = mockDb._t('guestOtp').length;
    expect(sentRows).toBeLessThanOrEqual(5);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(sentRows - 3);
  });

  test('parallel sends from one IP across numbers never exceed the per-IP cap (20)', async () => {
    const sms = { send: jest.fn() };
    const phones = Array.from({ length: 30 }, (_, i) => `+23480123${String(10000 + i)}`.slice(0, 14));
    await settle(phones.map((p) => ask(sms, { phone: p })));
    expect(mockDb._t('guestOtp').length).toBeLessThanOrEqual(20);
  });
});

describe('parallel OTP verification', () => {
  const issue = async () => {
    const sms = { send: jest.fn() };
    await ask(sms);
    return /(\d{6})/.exec(sms.send.mock.calls.at(-1)[1])[1];
  };
  const verify = (code) => identity.verifyOtp({ phone: PHONE, countryCode: 'NG', code, ip: '9.9.9.9', env });

  test('20 parallel wrong guesses spend at most 5 attempts and then lock the code', async () => {
    const good = await issue();
    const wrong = good === '000000' ? '111111' : '000000';
    const res = await settle(Array.from({ length: 20 }, () => verify(wrong)));
    expect(res.every((r) => r.status === 'rejected')).toBe(true);
    expect(mockDb._t('guestOtp')[0].attempts).toBeLessThanOrEqual(identity.CFG.MAX_ATTEMPTS);
    expect(res.filter((r) => r.reason.code === 'OTP_WRONG').length).toBeLessThanOrEqual(identity.CFG.MAX_ATTEMPTS);
    // Even the CORRECT code is refused once the budget is spent.
    await expect(verify(good)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });

  test('the same correct code verified twice in parallel opens exactly one session', async () => {
    const good = await issue();
    const res = await settle([verify(good), verify(good), verify(good)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mockDb._t('guestSession')).toHaveLength(1);
  });

  test('a consumed code cannot be reused afterwards', async () => {
    const good = await issue();
    await verify(good);
    await expect(verify(good)).rejects.toBeDefined();
  });
});
