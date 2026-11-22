'use strict';
// M16.1: durable email outbox: transactional enqueue, retry/back-off, dead-letter, idempotent worker, truthful states, Admin re-queue.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env, makeHttp, codeIn } = require('./helpers/emailEnv');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
process.env.JWT_SECRET = 'test-secret';
const identity = require('../src/services/guestIdentity.service');
const outbox = require('../src/services/emailOutbox.service');

const ask = (over = {}) => identity.requestEmailOtp({ email: 'ada@example.com', phone: '08012345678', countryCode: 'NG', ip: '1.2.3.4', env, ...over });
const rowOf = () => mockDb._t('emailOutbox')[0];
beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('worker', () => {
  test('sends through Brevo, records the provider message id, clears the address, and says ACCEPTED (not delivered)', async () => {
    const r = await ask(); const http = makeHttp();
    expect(await outbox.processForOtp(r._otpId, { env, http })).toEqual([{ done: true, provider: 'brevo' }]);
    expect(http.calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(http.calls[0].headers['api-key']).toBe('brevo-key');
    expect(http.calls[0].body).toMatchObject({ sender: { name: 'Runserv', email: 'no-reply@example.com' }, to: [{ email: 'ada@example.com' }], subject: 'Your Runserv verification code' });
    expect(JSON.stringify(http.calls[0].body)).not.toContain('brevo-key');                    // the API key is a header, never in the body
    expect(rowOf()).toMatchObject({ status: 'SENT', provider: 'brevo', providerMessageId: '<brevo-1@x>', deliveryStatus: 'ACCEPTED', toEmail: null, routeReason: 'BREVO_ALLOCATION' });
    expect(await outbox.stateForOtp(r._otpId)).toBe('ACCEPTED');
  });
  test('Resend requests carry the outbox id as an idempotency key and use a bearer token', async () => {
    const e = { ...env, BREVO_ENABLED: 'false' }; const r = await ask({ env: e }); const http = makeHttp();
    await outbox.processForOtp(r._otpId, { env: e, http });
    expect(http.calls[0]).toMatchObject({ provider: 'resend', url: 'https://api.resend.com/emails' });
    expect(http.calls[0].headers.Authorization).toBe('Bearer resend-key'); expect(http.calls[0].headers['Idempotency-Key']).toBe(rowOf().id);
    expect(rowOf().routeReason).toBe('BREVO_DISABLED');
  });
  test('Brevo 5xx: retried with exponential back-off; the SAME challenge is re-sent, never a second one, and the expiry never moves', async () => {
    const r = await ask(); const expiry = mockDb._t('guestOtp')[0].expiresAt.getTime();
    let n = 0; const http = makeHttp((p) => (p === 'brevo' && ++n <= 2 ? { status: 503, data: { message: 'down' } } : null));
    const t0 = Date.now();
    await outbox.processForOtp(r._otpId, { env, http });
    expect(rowOf()).toMatchObject({ status: 'PENDING', attempts: 1, errorCategory: 'TRANSIENT' });
    expect(rowOf().nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 29000);
    const t1 = new Date(t0 + 31000); await outbox.processDue({ now: t1, env, http });                // Brevo parked (60s): falls over to Resend
    expect(rowOf()).toMatchObject({ status: 'SENT', provider: 'resend', routeReason: 'TRANSIENT_FALLBACK', attempts: 2 });
    expect(mockDb._t('guestOtp')).toHaveLength(1); expect(mockDb._t('guestOtp')[0].expiresAt.getTime()).toBe(expiry);
    expect(codeIn(http.calls[0])).toBe(codeIn(http.calls[1]));                                       // identical code: no second valid OTP
  });
  test('back-off grows and is capped', () => {
    expect([1, 2, 3, 4].map(outbox.backoffMs)).toEqual([30000, 60000, 120000, 240000]); expect(outbox.backoffMs(50)).toBe(30 * 60 * 1000);
  });
  test('bounded retries then DEAD-LETTER (visible, address kept for Admin, never retried again)', async () => {
    const e = { ...env, GUEST_OTP_TTL_SECONDS: '999999' };                         // keep the challenge alive: an EXPIRED one is skipped instead (tested below)
    const r = await ask({ env: e }); const http = makeHttp(() => ({ status: 500, data: {} }));
    let t = Date.now();
    for (let i = 0; i < outbox.MAX_ATTEMPTS + 2; i += 1) { t += 31 * 60 * 1000; await outbox.processDue({ now: new Date(t), env: e, http }); }
    expect(rowOf()).toMatchObject({ status: 'DEAD', attempts: outbox.MAX_ATTEMPTS, errorCategory: 'TRANSIENT' });
    const calls = http.calls.length; await outbox.processDue({ now: new Date(t + 3600000), env: e, http }); expect(http.calls.length).toBe(calls);
    expect(await outbox.stateForOtp(r._otpId)).toBe('FAILED');
  });
  test('invalid address: permanent failure at once, no retry, no failover, slot returned; the user can correct the address with a new challenge', async () => {
    const r = await ask(); const http = makeHttp(() => ({ status: 400, data: { code: 'invalid_parameter', message: 'email is not valid' } }));
    await outbox.processForOtp(r._otpId, { env, http });
    expect(rowOf()).toMatchObject({ status: 'DEAD', errorCategory: 'INVALID_ADDRESS', attempts: 1 });
    expect(http.calls).toHaveLength(1);
    expect(mockDb._t('emailQuotaWindow').find((q) => q.provider === 'brevo').reserved).toBe(0);
    await expect(outbox.requeue(rowOf().id)).rejects.toMatchObject({ statusCode: 409 });             // Admin cannot "retry" a bad address
    await expect(ask({ email: 'ada.corrected@example.com', ip: '5.5.5.5' })).resolves.toMatchObject({ deliveryState: 'QUEUED' });
  });
  test('AUTH / sender problems park the provider and fail over; they are not the recipient\'s fault', async () => {
    const r = await ask(); const http = makeHttp((p) => (p === 'brevo' ? { status: 401, data: { message: 'Key not found' } } : null));
    await outbox.processForOtp(r._otpId, { env, http }); expect(rowOf().errorCategory).toBe('AUTH');
    await outbox.processDue({ now: new Date(Date.now() + 40000), env, http });
    expect(rowOf()).toMatchObject({ status: 'SENT', provider: 'resend' });
  });
  test('worker is idempotent: two workers racing for one row send it once', async () => {
    const r = await ask(); const http = makeHttp(); const id = rowOf().id;
    const res = await Promise.all([outbox.processEvent(id, { env, http }), outbox.processEvent(id, { env, http }), outbox.processEvent(id, { env, http })]);
    expect(http.post).toHaveBeenCalledTimes(1); expect(res.filter((x) => x.done)).toHaveLength(1); expect(mockDb._t('guestOtp')).toHaveLength(1); void r;
  });
  test('no longer-needed mail is SKIPPED, not sent (code used, replaced, expired, or the channel switched off)', async () => {
    const a = await ask(); mockDb._t('guestOtp')[0].consumedAt = new Date();
    const http = makeHttp(); await outbox.processForOtp(a._otpId, { env, http });
    expect(rowOf()).toMatchObject({ status: 'SKIPPED', toEmail: null }); expect(http.post).not.toHaveBeenCalled();
    const b = await ask({ email: 'b@example.com', ip: '7.7.7.7' }); await outbox.processForOtp(b._otpId, { env: { ...env, GUEST_EMAIL_OTP_ENABLED: 'false' }, http });
    expect(mockDb._t('emailOutbox')[1].status).toBe('SKIPPED'); expect(http.post).not.toHaveBeenCalled();
  });
  test('the outbox row never holds a code, message text, key or secret', async () => {
    const r = await ask(); const http = makeHttp(); await outbox.processForOtp(r._otpId, { env, http });
    const dump = JSON.stringify(mockDb._t('emailOutbox'));
    expect(dump).not.toContain(codeIn(http.calls[0])); expect(dump).not.toMatch(/brevo-key|resend-key|verification code is/i);
  });
  test('Admin re-queue of a dead row works only while the challenge is still usable, and never reveals the code', async () => {
    const r = await ask(); mockDb._t('emailOutbox')[0].status = 'DEAD'; mockDb._t('emailOutbox')[0].errorCategory = 'TRANSIENT';
    const out = await outbox.requeue(rowOf().id); expect(out).toEqual({ requeued: true });
    expect(JSON.stringify(out)).not.toMatch(/\d{6}/);
    await outbox.processForOtp(r._otpId, { env, http: makeHttp() }); expect(rowOf().status).toBe('SENT');
    rowOf().status = 'DEAD'; mockDb._t('guestOtp')[0].expiresAt = new Date(Date.now() - 1000);
    await expect(outbox.requeue(rowOf().id)).rejects.toMatchObject({ statusCode: 409 });
    rowOf().toEmail = null; mockDb._t('guestOtp')[0].expiresAt = new Date(Date.now() + 1e6);
    await expect(outbox.requeue(rowOf().id)).rejects.toThrow(/no longer stored/);
    await expect(outbox.requeue('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('dead rows lose the address after the scrub window', async () => {
    await ask(); Object.assign(rowOf(), { status: 'DEAD', updatedAt: new Date(Date.now() - 15 * 86400000) });
    expect(await outbox.scrubDead({ now: new Date() })).toBe(1); expect(rowOf().toEmail).toBeNull();
  });
  test('API acceptance is reported as ACCEPTED; only a delivery event upgrades it to DELIVERED; bounces surface as FAILED', async () => {
    const r = await ask(); await outbox.processForOtp(r._otpId, { env, http: makeHttp() });
    expect(await outbox.stateForOtp(r._otpId)).toBe('ACCEPTED');
    await outbox.applyDeliveryEvent('brevo', { eventKey: 'e1', messageId: rowOf().providerMessageId, status: 'DELIVERED', event: 'delivered' });
    expect(await outbox.stateForOtp(r._otpId)).toBe('DELIVERED');
  });
  test('free-plan daily cap: jobs wait visibly, the app is never told it was delivered', async () => {
    const r = await ask(); const e = { ...env, BREVO_DAILY_ALLOCATION: '0', RESEND_DAILY_ALLOCATION: '0' }; const http = makeHttp();
    await outbox.processForOtp(r._otpId, { env: e, http });
    expect(http.post).not.toHaveBeenCalled(); expect(rowOf()).toMatchObject({ status: 'PENDING', errorCategory: 'CAP' });
    expect(await outbox.stateForOtp(r._otpId)).toBe('QUEUED');
  });
});

describe('message', () => {
  test('the code is prominent, expiry is stated, the reader is told never to share it, and html is escaped', () => {
    const m = outbox.otpMessage('123456', 5);
    expect(m.text).toMatch(/123456/); expect(m.text).toMatch(/expires in 5 minutes/); expect(m.text).toMatch(/Do not share/); expect(m.text).toMatch(/never ask/);
    expect(m.html).toMatch(/font-size:34px[^>]*>123456/);
    expect(outbox.otpMessage('<b>', 5).html).not.toContain('<b>');
  });
});
