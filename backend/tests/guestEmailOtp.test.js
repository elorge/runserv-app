'use strict';
// M16.1: email OTP (Brevo/Resend) as the primary guest verification channel.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env, makeHttp, codeIn } = require('./helpers/emailEnv');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

process.env.JWT_SECRET = 'test-secret';
const identity = require('../src/services/guestIdentity.service');
const outbox = require('../src/services/emailOutbox.service');

const EMAIL = 'Ada.Obi@Example.COM';
const PHONE = '08012345678';
const ask = (over = {}) => identity.requestEmailOtp({ email: EMAIL, phone: PHONE, countryCode: 'NG', ip: '9.9.9.9', env, ...over });
const send = async (r, http = makeHttp()) => { await outbox.processForOtp(r._otpId, { env, http }); return http; };
const issue = async (over = {}) => { const r = await ask(over); const http = await send(r); return { r, code: codeIn(http.calls[0]), http }; };
const verify = (code, over = {}) => identity.verifyEmailOtp({ email: EMAIL, code, ip: '9.9.9.9', env, ...over });

beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('requestEmailOtp', () => {
  test('queues one purpose-bound challenge + one outbox row in the same operation, with a neutral answer', async () => {
    const r = await ask();
    expect(r).toMatchObject({ channel: 'EMAIL', deliveryState: 'QUEUED', expiresInS: 300, resendAfterS: 60, message: 'If the address is valid, a code has been sent.' });
    expect(r.email).toMatch(/^a\*+@example\.com$/);
    const otp = mockDb._t('guestOtp'); expect(otp).toHaveLength(1);
    expect(otp[0]).toMatchObject({ channel: 'EMAIL', purpose: 'GUEST_BOOKING_VERIFY', email: 'ada.obi@example.com', contactPhone: '+2348012345678' });
    expect(otp[0].phone ?? null).toBeNull();
    expect(mockDb._t('emailOutbox')).toHaveLength(1);
    expect(mockDb._t('emailOutbox')[0]).toMatchObject({ kind: 'GUEST_OTP', otpId: otp[0].id, status: 'PENDING' });
  });
  test('the email is trimmed and lowercased consistently: different spellings are ONE identity', async () => {
    await ask({ email: '  ADA.OBI@example.com ' });
    await expect(ask({ email: 'ada.obi@EXAMPLE.com', now: Date.now() })).rejects.toMatchObject({ code: 'OTP_COOLDOWN' });
  });
  test('rejects malformed addresses, a bad phone contact and an unsupported country', async () => {
    for (const email of ['', 'nope', 'a@b', 'a b@c.com', 'a@@c.com', 'a..b@c.com', '<x>@c.com']) await expect(ask({ email })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(ask({ phone: '123' })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await expect(ask({ countryCode: 'ZZ' })).rejects.toMatchObject({ code: 'UNSUPPORTED_COUNTRY' });
    expect(mockDb._t('guestOtp')).toHaveLength(0);
  });
  test('the code is never stored, never returned, never in the outbox and never in the audit trail', async () => {
    const { r, code } = await issue();
    expect(JSON.stringify(r)).not.toContain(code);
    expect(JSON.stringify(mockDb._t('guestOtp'))).not.toContain(code);
    expect(JSON.stringify(mockDb._t('emailOutbox'))).not.toContain(code);
    expect(JSON.stringify(mockDb._calls.audit)).not.toContain(code);
    expect(mockDb._t('guestOtp')[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('the dedicated OTP secret is mandatory: there is no fallback to JWT_SECRET', async () => {
    await expect(ask({ env: { ...env, GUEST_OTP_HASH_SECRET: undefined } })).rejects.toMatchObject({ code: 'GUEST_SECRET_MISSING' });
    await expect(ask({ env: { ...env, NODE_ENV: 'production', GUEST_OTP_HASH_SECRET: env.JWT_SECRET, GUEST_HASH_SECRET: 'x' } })).rejects.toMatchObject({ code: 'GUEST_SECRET_MISSING' });
  });
  test('the channel is dark unless BOTH the flag and the channel list enable it', async () => {
    await expect(ask({ env: { ...env, GUEST_EMAIL_OTP_ENABLED: 'false' } })).rejects.toMatchObject({ code: 'OTP_CHANNEL_DISABLED' });
    await expect(ask({ env: { ...env, GUEST_OTP_CHANNEL: 'sms' } })).rejects.toMatchObject({ code: 'OTP_CHANNEL_DISABLED' });
    expect(identity.enabledChannels(env)).toEqual(['EMAIL']);
    expect(identity.enabledChannels({ ...env, GUEST_OTP_CHANNEL: 'email,sms', GUEST_SMS_OTP_ENABLED: 'true' })).toEqual(['EMAIL', 'PHONE']);
    expect(identity.enabledChannels({ ...env, GUEST_SMS_OTP_ENABLED: 'true' })).toEqual(['EMAIL']);       // flag without the channel list: still off
  });
  test('a registered account, or a blocked guest, gets the SAME neutral answer and nothing is queued (no enumeration)', async () => {
    mockDb._t('user').push({ id: 'u1', email: 'ada.obi@example.com', authProvider: 'PASSWORD' });
    const a = await ask(); expect(a).toMatchObject({ channel: 'EMAIL', message: 'If the address is valid, a code has been sent.' });
    expect(mockDb._t('guestOtp')).toHaveLength(0); expect(mockDb._t('emailOutbox')).toHaveLength(0);
    mockDb._t('user').length = 0;
    mockDb._t('guestIdentity').push({ id: 'i1', email: 'ada.obi@example.com', countryCode: 'NG', userId: 'u2', blockedAt: new Date() });
    const b = await ask({ ip: '8.8.8.8' }); expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort().filter((k) => k !== 'deliveryState').concat([]).sort());
    expect(mockDb._t('guestOtp')).toHaveLength(0);
  });
  test('a new request invalidates the previous challenge in the same transaction (one live challenge)', async () => {
    const a = await issue(); const t = Date.now() + 61000;
    const b = await ask({ now: t }); await outbox.processForOtp(b._otpId, { env, http: makeHttp(), now: new Date(t) });
    const rows = mockDb._t('guestOtp'); expect(rows.filter((r) => !r.supersededAt && !r.consumedAt)).toHaveLength(1);
    await expect(verify(a.code, { now: t })).rejects.toMatchObject({ code: expect.stringMatching(/OTP_EXPIRED|OTP_WRONG/) });
  });
  test('cooldown, per-address hourly cap and per-IP cap', async () => {
    let t = Date.now();
    await ask({ now: t });
    await expect(ask({ now: t + 1000 })).rejects.toMatchObject({ code: 'OTP_COOLDOWN', statusCode: 429 });
    for (let i = 1; i < 5; i += 1) { t += 61000; await ask({ now: t, ip: `1.1.1.${i}` }); }
    await expect(ask({ now: t + 61000 })).rejects.toMatchObject({ code: 'OTP_PHONE_LIMIT' });
    mockDb = makeFakeGuestPrisma();
    for (let n = 0; n < 20; n += 1) await ask({ email: `user${n}@example.com` });
    await expect(ask({ email: 'user99@example.com' })).rejects.toMatchObject({ code: 'OTP_IP_LIMIT' });
  });
  test('optional global daily cap', async () => {
    const e = { ...env, GUEST_OTP_DAILY_CAP: '2' };
    await ask({ env: e, email: 'a1@example.com' }); await ask({ env: e, email: 'a2@example.com' });
    await expect(ask({ env: e, email: 'a3@example.com' })).rejects.toMatchObject({ code: 'OTP_DAILY_CAP' });
  });
});

describe('send arbitration under concurrency', () => {
  test('10 simultaneous sends for one address: exactly one challenge and one email job survive', async () => {
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => ask()));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    res.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('OTP_COOLDOWN'));
    expect(mockDb._t('guestOtp')).toHaveLength(1); expect(mockDb._t('emailOutbox')).toHaveLength(1);
  });
  test('FORCED INTERLEAVING between the limit check and the insert: the second request cannot slip through', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    let aReachedInsert; const reached = new Promise((r) => { aReachedInsert = r; });
    // Request A pauses exactly between "lookup" and "insert". Request B starts while A is paused.
    const a = ask({ hooks: { afterChecks: async () => { aReachedInsert(); await gate; } } });
    await reached;
    let bSettled = false;
    const b = ask().then((x) => { bSettled = true; return x; }, (e) => { bSettled = true; throw e; });
    await new Promise((r) => setTimeout(r, 30));
    expect(bSettled).toBe(false);                    // B is blocked on the database lock: it has not even run its own check yet
    expect(mockDb._t('guestOtp')).toHaveLength(0);   // A has not inserted
    release();
    await expect(a).resolves.toBeDefined();
    await expect(b).rejects.toMatchObject({ code: 'OTP_COOLDOWN' });   // B now SEES A's committed row
    expect(mockDb._t('guestOtp')).toHaveLength(1); expect(mockDb._t('emailOutbox')).toHaveLength(1);
  });
  test('parallel sends across many addresses from one IP never exceed the per-IP cap', async () => {
    await Promise.allSettled(Array.from({ length: 40 }, (_, i) => ask({ email: `p${i}@example.com` })));
    expect(mockDb._t('guestOtp').length).toBeLessThanOrEqual(20);
  });
  test('a failed transaction leaves neither a challenge nor an email job behind', async () => {
    const real = mockDb.emailOutbox.create;
    mockDb.emailOutbox.create = async () => { throw new Error('db down'); };
    await expect(ask()).rejects.toThrow('db down');
    mockDb.emailOutbox.create = real;
    expect(mockDb._t('guestOtp')).toHaveLength(0); expect(mockDb._t('emailOutbox')).toHaveLength(0);
  });
});

describe('verifyEmailOtp', () => {
  test('EMAIL ARRIVES, the correct code verifies, a guest session is issued, phone is NOT marked verified', async () => {
    const { code, http } = await issue();
    expect(http.calls[0].body.to).toEqual([{ email: 'ada.obi@example.com' }]);
    expect(http.calls[0].body.textContent).toMatch(/expires in 5 minutes/); expect(http.calls[0].body.textContent).toMatch(/Do not share/);
    const r = await verify(code);
    expect(r.session).toMatch(/^gs_[A-Za-z0-9_-]{43}$/);
    expect(r).toMatchObject({ channel: 'EMAIL', emailVerified: true, phoneVerified: false });
    const ident = mockDb._t('guestIdentity')[0];
    expect(ident).toMatchObject({ email: 'ada.obi@example.com', contactPhone: '+2348012345678', verifiedChannel: 'EMAIL' });
    expect(ident.phone).toBeNull(); expect(ident.phoneVerifiedAt).toBeNull(); expect(ident.emailVerifiedAt).toBeInstanceOf(Date);
    const user = mockDb._t('user').find((u) => u.id === ident.userId);
    expect(user).toMatchObject({ authProvider: 'GUEST', role: 'CUSTOMER' }); expect(user.email).toMatch(/@guest\.runserv\.invalid$/);
    expect(mockDb._t('guestSession')[0].tokenHash).not.toContain(r.session);
  });
  test('wrong code: atomic count down, generic error, no session', async () => {
    const { code } = await issue(); const bad = code === '000000' ? '111111' : '000000';
    await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_WRONG', attemptsLeft: 4, statusCode: 400 });
    expect(mockDb._t('guestSession')).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_WRONG' });
    await expect(verify(bad)).rejects.toMatchObject({ code: 'OTP_LOCKED', statusCode: 429 });
    await expect(verify(code)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });
  test('20 PARALLEL wrong guesses spend at most the configured maximum', async () => {
    const { code } = await issue(); const bad = code === '000000' ? '111111' : '000000';
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => verify(bad)));
    expect(res.every((r) => r.status === 'rejected')).toBe(true);
    expect(mockDb._t('guestOtp')[0].attempts).toBe(identity.CFG.MAX_ATTEMPTS);
    expect(res.filter((r) => r.reason.code === 'OTP_WRONG').length).toBeLessThanOrEqual(identity.CFG.MAX_ATTEMPTS);
    await expect(verify(code)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });
  test('the attempt budget is configurable (GUEST_OTP_MAX_ATTEMPTS)', async () => {
    const e = { ...env, GUEST_OTP_MAX_ATTEMPTS: '2' };
    const r = await ask({ env: e }); await outbox.processForOtp(r._otpId, { env: e, http: makeHttp() });
    await expect(verify('000000', { env: e })).rejects.toBeDefined(); await expect(verify('000000', { env: e })).rejects.toBeDefined();
    await expect(verify('000000', { env: e })).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });
  test('an expired code is refused, then a new one can be requested once the policy allows', async () => {
    const { code } = await issue();
    await expect(verify(code, { now: Date.now() + 6 * 60 * 1000 })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    await expect(ask({ now: Date.now() + 6 * 60 * 1000 })).resolves.toBeDefined();
  });
  test('TTL follows GUEST_OTP_TTL_SECONDS', async () => {
    const e = { ...env, GUEST_OTP_TTL_SECONDS: '120' };
    const r = await ask({ env: e }); expect(r.expiresInS).toBe(120);
  });
  test('single use: the same code twice in parallel opens exactly one session', async () => {
    const { code } = await issue();
    const res = await Promise.allSettled([verify(code), verify(code), verify(code)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(mockDb._t('guestSession')).toHaveLength(1);
  });
  test('purpose separation: a phone code, a login-style code or another address cannot answer an email challenge', async () => {
    const { code } = await issue();
    await expect(identity.verifyEmailOtp({ email: 'someone.else@example.com', code, env })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    mockDb._t('guestOtp')[0].purpose = 'LOGIN';
    await expect(verify(code)).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });
  test('malformed code never reaches the lookup; unknown address gets the same generic error as an expired code', async () => {
    await expect(verify('12ab56')).rejects.toMatchObject({ code: 'INVALID_CODE_FORMAT' });
    await expect(verify('123456')).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });
  test('verifying again for the same address reuses ONE identity and ONE user row', async () => {
    const a = await issue(); await verify(a.code);
    const t = Date.now() + 61000; const r = await ask({ now: t }); const h = makeHttp(); await outbox.processForOtp(r._otpId, { env, http: h, now: new Date(t) });
    await verify(codeIn(h.calls[0]), { now: t });
    expect(mockDb._t('guestIdentity')).toHaveLength(1); expect(mockDb._t('user')).toHaveLength(1);
  });
  test('an address that became a registered account in the meantime never gets a guest session', async () => {
    const { code } = await issue();
    mockDb._t('user').push({ id: 'reg', email: 'ada.obi@example.com', authProvider: 'PASSWORD' });
    await expect(verify(code)).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    expect(mockDb._t('guestSession')).toHaveLength(0);
  });
  test('requireGuestSession works for an email identity: contact phone, email and verified channel are exposed, phone stays a contact', async () => {
    const { code } = await issue(); const { session } = await verify(code);
    const req = { headers: { authorization: `Guest ${session}` } }; let nexted = false;
    await identity.requireGuestSession(req, { status: () => ({ json: () => {} }) }, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(req.guest).toMatchObject({ email: 'ada.obi@example.com', phone: '+2348012345678', verifiedChannel: 'EMAIL' });
  });
  test('SESSION RECOVERY: after the session expires, re-verifying the same email lands on the SAME identity (so the same bookings, no duplicate)', async () => {
    const a = await issue(); const first = await verify(a.code);
    const identityId = mockDb._t('guestIdentity')[0].id;
    mockDb._t('guestBooking').push({ id: 'b1', reference: 'RS-ABC123', identityId, idempotencyKey: 'k1', service: 'RIDE' });
    mockDb._t('guestSession')[0].expiresAt = new Date(Date.now() - 1000);
    const t = Date.now() + 61000; const r = await ask({ now: t }); const h = makeHttp(); await outbox.processForOtp(r._otpId, { env, http: h, now: new Date(t) });
    const second = await verify(codeIn(h.calls[0]), { now: t });
    expect(second.session).not.toBe(first.session);
    const ident = mockDb._t('guestIdentity'); expect(ident).toHaveLength(1); expect(ident[0].id).toBe(identityId);
    const newSession = mockDb._t('guestSession').find((s) => s.expiresAt > new Date());
    expect(newSession.identityId).toBe(identityId);                          // the booking is reachable: ownership is by identity
    expect(mockDb._t('guestBooking')).toHaveLength(1);
  });
});
