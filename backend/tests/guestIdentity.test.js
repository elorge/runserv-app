'use strict';
// Stage 2: phone ownership. OTP expiry / cooldown / caps / attempt lock / single use, keyed hashes at rest, opaque guest session.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

process.env.JWT_SECRET = 'test-secret';
const identity = require('../src/services/guestIdentity.service');

const env = { JWT_SECRET: 'test-secret', ENABLE_SMS_DELIVERY: 'true', NODE_ENV: 'test' };
const PHONE = '+2348012345678';
const codeFrom = (sms) => /(\d{6})/.exec(sms.send.mock.calls.at(-1)[1])[1];
const ask = (over = {}, sms = { send: jest.fn() }) => identity.requestOtp({ phone: PHONE, countryCode: 'NG', ip: '9.9.9.9', env, sms, ...over }).then((r) => ({ r, sms }));

beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('requestOtp', () => {
  test('sends a 6-digit code by SMS and never returns it', async () => {
    const { r, sms } = await ask();
    expect(sms.send).toHaveBeenCalledWith(PHONE, expect.stringMatching(/\d{6}/));
    expect(r.devCode).toBeUndefined(); expect(JSON.stringify(r)).not.toMatch(/\d{6}/);
    expect(r.expiresInS).toBe(300); expect(r.resendAfterS).toBe(60);
  });
  test('the code is stored only as a keyed hash', async () => {
    const { sms } = await ask(); const code = codeFrom(sms);
    const row = mockDb._t('guestOtp')[0];
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(row)).not.toContain(code);
  });
  test('rejects a bad number and an unsupported country', async () => {
    await expect(ask({ phone: '12345' })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await expect(ask({ countryCode: 'ZZ' })).rejects.toMatchObject({ code: 'UNSUPPORTED_COUNTRY' });
  });
  test('refuses a number that belongs to a registered account (no path into someone else\'s account)', async () => {
    mockDb._t('user').push({ id: 'u1', phone: PHONE, authProvider: 'PASSWORD' });
    await expect(ask()).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS', statusCode: 409 });
  });
  test('a number that only ever had a guest identity is fine', async () => {
    mockDb._t('user').push({ id: 'u1', phone: PHONE, authProvider: 'GUEST' });
    await expect(ask()).resolves.toBeDefined();
  });
  test('resend cooldown, then allowed again', async () => {
    await ask();
    await expect(ask()).rejects.toMatchObject({ code: 'OTP_COOLDOWN', statusCode: 429 });
    await expect(ask({ now: Date.now() + 61000 })).resolves.toBeDefined();
  });
  test('per-phone hourly cap (5)', async () => {
    let t = Date.now();
    for (let i = 0; i < 5; i += 1) { await ask({ now: t, ip: `1.1.1.${i}` }); t += 61000; }
    await expect(ask({ now: t })).rejects.toMatchObject({ code: 'OTP_PHONE_LIMIT' });
  });
  test('per-IP hourly cap (20) across different numbers', async () => {
    let n = 0;
    for (; n < 20; n += 1) await ask({ phone: `+23480123${String(10000 + n)}`.slice(0, 14) });
    await expect(ask({ phone: '+2348099999999' })).rejects.toMatchObject({ code: 'OTP_IP_LIMIT' });
  });
  test('a blocked number gets nothing', async () => {
    mockDb._t('guestIdentity').push({ id: 'i1', phone: PHONE, countryCode: 'NG', userId: 'u1', blockedAt: new Date() });
    await expect(ask()).rejects.toMatchObject({ code: 'GUEST_BLOCKED', statusCode: 403 });
  });
  test('production without SMS exposes no code and fails closed (and the unsent code is discarded)', async () => {
    await expect(identity.requestOtp({ phone: PHONE, countryCode: 'NG', env: { JWT_SECRET: 'x', GUEST_HASH_SECRET: 'h'.repeat(40), NODE_ENV: 'production' } })).rejects.toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE', statusCode: 503 });
    expect(mockDb._t('guestOtp')).toHaveLength(0);
  });
  test('development without SMS returns the code (and only there)', async () => {
    const r = await identity.requestOtp({ phone: PHONE, countryCode: 'NG', env: { JWT_SECRET: 'x', NODE_ENV: 'development' } });
    expect(r.devCode).toMatch(/^\d{6}$/);
  });
  test('an SMS provider failure is reported and does not burn the quota', async () => {
    const sms = { send: jest.fn().mockRejectedValue(new Error('provider down')) };
    await expect(ask({}, sms)).rejects.toMatchObject({ code: 'OTP_SEND_FAILED', statusCode: 502 });
    expect(mockDb._t('guestOtp')).toHaveLength(0);
  });
});

describe('verifyOtp', () => {
  const verify = (code, over = {}) => identity.verifyOtp({ phone: PHONE, countryCode: 'NG', code, ip: '9.9.9.9', env, ...over });

  test('correct code opens a session and creates a guest identity + non-login User', async () => {
    const { sms } = await ask();
    const r = await verify(codeFrom(sms));
    expect(r.session).toMatch(/^gs_[A-Za-z0-9_-]{43}$/);
    const ident = mockDb._t('guestIdentity')[0]; const user = mockDb._t('user').find((u) => u.id === ident.userId);
    expect(ident.phone).toBe(PHONE);
    expect(user).toMatchObject({ authProvider: 'GUEST', role: 'CUSTOMER', phone: PHONE });
    expect(user.email).toMatch(/@guest\.runserv\.invalid$/);
    expect(mockDb._t('guestSession')[0].tokenHash).not.toContain(r.session);          // token stored only as a keyed hash
  });
  test('a local-format number maps to the same identity as the +234 form', async () => {
    const sms = { send: jest.fn() };
    await identity.requestOtp({ phone: '08012345678', countryCode: 'NG', env, sms });
    const r = await identity.verifyOtp({ phone: '08012345678', countryCode: 'NG', code: codeFrom(sms), env });
    expect(r.phone).toMatch(/678$/);
    expect(mockDb._t('guestIdentity')[0].phone).toBe('+2348012345678');
  });
  test('wrong code counts down, then locks even for the right code', async () => {
    const { sms } = await ask(); const good = codeFrom(sms); const bad = good === '000000' ? '111111' : '000000';
    await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_WRONG', attemptsLeft: 4 });
    for (let i = 0; i < 3; i += 1) await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_WRONG' });
    await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_LOCKED', statusCode: 429 });
    await expect(verify(good)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });
  test('an expired code is refused', async () => {
    const { sms } = await ask();
    await expect(verify(codeFrom(sms), { now: Date.now() + 6 * 60 * 1000 })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });
  test('a code works once (no replay)', async () => {
    const { sms } = await ask(); const code = codeFrom(sms);
    await verify(code);
    await expect(verify(code)).rejects.toMatchObject({ code: 'OTP_EXPIRED' });          // consumed codes are not candidates any more
  });
  test('a malformed code never reaches the lookup', async () => {
    await ask();
    await expect(verify('12ab56')).rejects.toMatchObject({ code: 'INVALID_CODE_FORMAT' });
  });
  test('verifying twice for the same number reuses one identity', async () => {
    const a = await ask(); await verify(codeFrom(a.sms));
    const b = await ask({ now: Date.now() + 61000 }); await verify(codeFrom(b.sms));
    expect(mockDb._t('guestIdentity')).toHaveLength(1); expect(mockDb._t('user')).toHaveLength(1);
  });
  test('writes an audit trail (no codes in it)', async () => {
    const { sms } = await ask(); const code = codeFrom(sms); await verify(code);
    const events = mockDb._calls.audit.map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['OTP_REQUESTED', 'OTP_VERIFIED']));
    expect(JSON.stringify(mockDb._calls.audit)).not.toContain(code);
  });
});

describe('requireGuestSession middleware', () => {
  const run = async (authorization) => {
    const req = { headers: authorization ? { authorization } : {} }; let status; let body; let nexted = false;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
    await identity.requireGuestSession(req, res, () => { nexted = true; });
    return { req, status, body, nexted };
  };
  const session = async () => { const { sms } = await ask(); return (await identity.verifyOtp({ phone: PHONE, countryCode: 'NG', code: codeFrom(sms), env })).session; };

  test('a valid Guest token sets req.guest and never req.user', async () => {
    const r = await run(`Guest ${await session()}`);
    expect(r.nexted).toBe(true); expect(r.req.guest).toMatchObject({ phone: PHONE, countryCode: 'NG' }); expect(r.req.user).toBeUndefined();
  });
  test('a Bearer scheme, no header, or a garbage token is refused', async () => {
    const s = await session();
    expect((await run(`Bearer ${s}`)).status).toBe(401);
    expect((await run()).status).toBe(401);
    expect((await run('Guest gs_short')).status).toBe(401);
    expect((await run(`Guest gs_${'A'.repeat(43)}`)).body.code).toBe('GUEST_SESSION_EXPIRED');
  });
  test('expired, revoked and blocked sessions are refused', async () => {
    const s = await session();
    mockDb._t('guestSession')[0].expiresAt = new Date(Date.now() - 1000);
    expect((await run(`Guest ${s}`)).body.code).toBe('GUEST_SESSION_EXPIRED');
    mockDb._t('guestSession')[0].expiresAt = new Date(Date.now() + 100000); mockDb._t('guestSession')[0].revokedAt = new Date();
    expect((await run(`Guest ${s}`)).status).toBe(401);
    mockDb._t('guestSession')[0].revokedAt = null; mockDb._t('guestIdentity')[0].blockedAt = new Date();
    expect((await run(`Guest ${s}`)).body.code).toBe('GUEST_BLOCKED');
  });
});
