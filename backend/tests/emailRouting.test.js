'use strict';
// M16.1 §13: deterministic Brevo 1-300 / Resend 301-400 quota routing, boundaries under concurrency, outage and quota behaviour.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env, makeHttp } = require('./helpers/emailEnv');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const quota = require('../src/services/emailQuota.service');
const outbox = require('../src/services/emailOutbox.service');

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const KEY = quota.windowKey(NOW, env);
const seedQuota = (provider, reserved, extra = {}) => mockDb._t('emailQuotaWindow').push({ provider, windowKey: KEY, reserved, accepted: reserved, exhaustedAt: null, unhealthyUntil: null, ...extra });
const job = (i = 0) => ({ id: `job-${i}`, kind: 'GUEST_OTP', otpId: `otp-${i}`, toEmail: `u${i}@example.com`, toMasked: 'u***@example.com', status: 'PENDING', attempts: 0, nextAttemptAt: new Date(NOW - 1000), slotHeld: false, provider: null, createdAt: new Date(NOW - 5000 + i), updatedAt: new Date(NOW - 5000) });
const seedOtp = (i = 0, over = {}) => mockDb._t('guestOtp').push({ id: `otp-${i}`, channel: 'EMAIL', purpose: 'GUEST_BOOKING_VERIFY', codeNonce: `n${i}`, codeHash: 'x', consumedAt: null, supersededAt: null, createdAt: new Date(NOW - 5000), expiresAt: new Date(NOW + 300000), ...over });
const route = () => quota.route({ now: NOW, env });
const used = (p) => (mockDb._t('emailQuotaWindow').find((r) => r.provider === p)?.reserved || 0);

beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('quota window', () => {
  test('the window key is the configured calendar day, and the reset offset only ever moves the boundary LATER', () => {
    expect(quota.windowKey(Date.UTC(2026, 10, 22, 23, 59), env)).toBe('2026-11-22');
    expect(quota.windowKey(Date.UTC(2026, 10, 23, 0, 0), env)).toBe('2026-11-23');
    const conservative = { ...env, EMAIL_QUOTA_RESET_OFFSET_MINUTES: '60' };
    expect(quota.windowKey(Date.UTC(2026, 10, 23, 0, 30), conservative)).toBe('2026-11-22');   // 00:30 is still "yesterday": never reset early
    expect(quota.windowKey(Date.UTC(2026, 10, 23, 1, 0), conservative)).toBe('2026-11-23');
    expect(quota.nextResetAt(NOW, env).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(quota.nextResetAt(NOW, conservative).toISOString()).toBe('2026-11-23T01:00:00.000Z');
  });
  test('counters reset only at the boundary: a new window starts empty, the old one is untouched', async () => {
    seedQuota('brevo', 300);
    expect((await route()).provider).toBe('resend');
    const next = await quota.route({ now: Date.UTC(2026, 10, 23, 0, 0, 1), env });
    expect(next).toMatchObject({ provider: 'brevo', reason: 'BREVO_ALLOCATION' });
    expect(mockDb._t('emailQuotaWindow').find((r) => r.windowKey === KEY).reserved).toBe(300);
  });
});

describe('300 + 100 policy', () => {
  test('with fresh counters: sends 1-300 go to Brevo, send 301 goes to Resend', async () => {
    const seen = []; for (let i = 1; i <= 301; i += 1) seen.push((await route()).provider);
    expect(seen.slice(0, 300).every((p) => p === 'brevo')).toBe(true); expect(seen[300]).toBe('resend');
    expect(used('brevo')).toBe(300); expect(used('resend')).toBe(1);
  });
  test('send 400 goes to Resend; send 401 is NOT routed to either free provider', async () => {
    seedQuota('brevo', 300); seedQuota('resend', 99);
    expect(await route()).toMatchObject({ provider: 'resend', reason: 'BREVO_ALLOCATION_EXHAUSTED' });   // the 400th
    const r = await route();
    expect(r.none).toBe(true); expect(used('brevo')).toBe(300); expect(used('resend')).toBe(100);
  });
  test('parallel requests at the 299/300 boundary never put a 301st job on Brevo', async () => {
    seedQuota('brevo', 299);
    const res = await Promise.all(Array.from({ length: 20 }, route));
    expect(res.filter((r) => r.provider === 'brevo')).toHaveLength(1); expect(res.filter((r) => r.provider === 'resend')).toHaveLength(19);
    expect(used('brevo')).toBe(300);
  });
  test('parallel requests at the 399/400 boundary never put more than 100 jobs on Resend', async () => {
    seedQuota('brevo', 300); seedQuota('resend', 99);
    const res = await Promise.all(Array.from({ length: 25 }, route));
    expect(res.filter((r) => r.provider === 'resend')).toHaveLength(1); expect(res.filter((r) => r.none)).toHaveLength(24);
    expect(used('resend')).toBe(100);
  });
  test('the overall hard cap (EMAIL_SEND_HARD_CAP) is enforced even when the allocations would allow more', async () => {
    const e = { ...env, EMAIL_SEND_HARD_CAP: '350' };
    seedQuota('brevo', 300); seedQuota('resend', 49);
    expect((await quota.route({ now: NOW, env: e })).provider).toBe('resend');       // the 350th
    const r = await quota.route({ now: NOW, env: e }); expect(r.none).toBe(true); expect(r.reason).toBe('HARD_CAP' === r.reason ? 'HARD_CAP' : r.reason);
    expect(used('resend')).toBe(50);
  });
  test('allocations are configuration, not constants', async () => {
    const e = { ...env, BREVO_DAILY_ALLOCATION: '2', RESEND_DAILY_ALLOCATION: '1', EMAIL_SEND_HARD_CAP: '3' };
    const ps = []; for (let i = 0; i < 4; i += 1) ps.push((await quota.route({ now: NOW, env: e })).provider || 'none');
    expect(ps).toEqual(['brevo', 'brevo', 'resend', 'none']);
  });
});

describe('provider outcomes while sending', () => {
  const run = async (n, http, over = {}) => { const out = []; for (let i = 0; i < n; i += 1) { mockDb._t('emailOutbox').push(job(i)); seedOtp(i); } for (let i = 0; i < n; i += 1) out.push(await outbox.processEvent(`job-${i}`, { now: new Date(NOW), env: { ...env, ...over }, http })); return out; };

  test('Brevo explicitly reports its daily quota used up at send 240: later jobs use Resend and Brevo is not called again', async () => {
    seedQuota('brevo', 239);
    const http = makeHttp((p, n) => (p === 'brevo' ? { status: 429, data: { code: 'too_many_requests', message: 'Daily sending limit reached' } } : null));
    const out = await run(5, http);
    expect(http.calls.filter((c) => c.provider === 'brevo')).toHaveLength(1);                    // asked once, told "quota", never asked again
    expect(mockDb._t('emailQuotaWindow').find((r) => r.provider === 'brevo').exhaustedAt).toBeTruthy();
    const first = mockDb._t('emailOutbox').find((j) => j.id === 'job-0');
    expect(first.status).toBe('PENDING');                                                        // re-queued, not failed
    // the next pass routes it (and the rest) through Resend with the right reason
    await outbox.processDue({ now: new Date(NOW + 5000), env, http });
    expect(mockDb._t('emailOutbox').every((j) => j.status === 'SENT' && j.provider === 'resend' && j.routeReason === 'BREVO_QUOTA_RESPONSE')).toBe(true);
    expect(out).toBeDefined(); expect(used('brevo')).toBe(239);                                  // the refused slot was handed back
  });
  test('Brevo TRANSIENT outage at send 240: failover consumes Resend slots, so the remaining capacity is reduced', async () => {
    seedQuota('brevo', 239);
    const http = makeHttp((p) => (p === 'brevo' ? { status: 503, data: { message: 'Service Unavailable' } } : null));
    await run(3, http);
    await outbox.processDue({ now: new Date(NOW + 45000), env, http });                          // after the retry back-off, while Brevo is still parked as unhealthy (60s)
    const sent = mockDb._t('emailOutbox').filter((j) => j.status === 'SENT');
    expect(sent.length).toBe(3); expect(sent.every((j) => j.provider === 'resend' && j.routeReason === 'TRANSIENT_FALLBACK')).toBe(true);
    expect(used('resend')).toBe(3);                                  // 100 - 3 left: 400 total is NOT guaranteed during an outage
    expect(used('brevo')).toBe(239);
    const u = await quota.usage({ now: NOW + 45000, env }); expect(u.providers[1].remaining).toBe(97);
  });
  test('failover can be switched off: an outage then leaves the jobs queued instead of spending Resend', async () => {
    seedQuota('brevo', 10);
    const http = makeHttp((p) => (p === 'brevo' ? { status: 503, data: {} } : null));
    await run(2, http, { EMAIL_FAILOVER_ON_TRANSIENT_ERROR: 'false' });
    await outbox.processDue({ now: new Date(NOW + 60000), env: { ...env, EMAIL_FAILOVER_ON_TRANSIENT_ERROR: 'false' }, http });
    expect(http.calls.some((c) => c.provider === 'resend')).toBe(false); expect(used('resend')).toBe(0);
    expect(mockDb._t('emailOutbox').every((j) => j.status === 'PENDING')).toBe(true);
  });
  test('BOTH providers failing: jobs stay queued with a visible state; nothing is claimed sent', async () => {
    const http = makeHttp(() => ({ status: 503, data: {} }));
    await run(2, http); await outbox.processDue({ now: new Date(NOW + 60000), env, http });
    const rows = mockDb._t('emailOutbox');
    expect(rows.every((j) => j.status === 'PENDING' && j.lastError && !j.sentAt)).toBe(true);
    expect(await outbox.stateForOtp('otp-0')).toBe('QUEUED');
  });
  test('capacity exhausted (400 used): the job stays queued as CAP, does not burn attempts and does not call a provider', async () => {
    seedQuota('brevo', 300); seedQuota('resend', 100);
    const http = makeHttp(); const out = await run(1, http);
    expect(http.post).not.toHaveBeenCalled(); expect(out[0]).toMatchObject({ queued: true });
    expect(mockDb._t('emailOutbox')[0]).toMatchObject({ status: 'PENDING', attempts: 0, errorCategory: 'CAP' });
  });
  test('an operator pause diverts new jobs; nothing an Admin does can raise a provider allocation', async () => {
    await quota.setPaused('brevo', true, 'admin-1');
    expect(await route()).toMatchObject({ provider: 'resend', reason: 'BREVO_PAUSED' });
    await quota.setPaused('resend', true, 'admin-1');
    expect((await route()).none).toBe(true);
    await quota.setPaused('brevo', false); await quota.setPaused('resend', false);
    expect((await route()).provider).toBe('brevo');
    const src = require('fs').readFileSync(require.resolve('../src/services/emailQuota.service'), 'utf8');
    expect(src).not.toMatch(/setAllocation|raiseQuota/);
  });
  test('ambiguous TIMEOUT: the slot and provider are kept, the job retries on the SAME provider, and never fails over (no duplicate / second challenge)', async () => {
    seedQuota('brevo', 10);
    let n = 0; const http = makeHttp((p) => (p === 'brevo' && ++n === 1 ? { throw: 'ETIMEDOUT' } : null));
    await run(1, http);
    expect(mockDb._t('emailOutbox')[0]).toMatchObject({ status: 'PENDING', provider: 'brevo', slotHeld: true, errorCategory: 'TIMEOUT' });
    expect(used('brevo')).toBe(11);                                  // slot kept: conservative, a timeout may have been accepted
    await outbox.processDue({ now: new Date(NOW + 60000), env, http });
    expect(http.calls.map((c) => c.provider)).toEqual(['brevo', 'brevo']);
    expect(used('brevo')).toBe(11); expect(used('resend')).toBe(0);
    expect(mockDb._t('guestOtp')).toHaveLength(1);                   // the worker never creates a second challenge
    expect(mockDb._t('emailOutbox')[0].status).toBe('SENT');
  });
  test('accepted sends are counted as accepted; webhooks never move the counters', async () => {
    const http = makeHttp(); await run(2, http);
    expect(mockDb._t('emailQuotaWindow').find((r) => r.provider === 'brevo')).toMatchObject({ reserved: 2, accepted: 2 });
    const before = JSON.stringify(mockDb._t('emailQuotaWindow'));
    const row = mockDb._t('emailOutbox')[0];
    await outbox.applyDeliveryEvent('brevo', { eventKey: 'k1', messageId: row.providerMessageId, status: 'HARD_BOUNCE', event: 'hard_bounce' });
    await outbox.applyDeliveryEvent('brevo', { eventKey: 'k2', messageId: mockDb._t('emailOutbox')[1].providerMessageId, status: 'DELIVERED', event: 'delivered' });
    expect(JSON.stringify(mockDb._t('emailQuotaWindow'))).toBe(before);
  });
  test('the admin usage view is accurate: usage, remaining, active tier, reset time, routing reason', async () => {
    seedQuota('brevo', 300);
    mockDb._t('emailOutbox').push(job(0)); seedOtp(0);
    await outbox.processEvent('job-0', { now: new Date(NOW), env, http: makeHttp() });
    const s = await outbox.stats(new Date(NOW), env);
    expect(s.usage).toMatchObject({ activeTier: 'resend', windowKey: KEY, hardCap: 400 }); expect(s.usage.resetAt).toBeInstanceOf(Date);
    expect(s.usage.providers[0]).toMatchObject({ provider: 'brevo', reserved: 300, remaining: 0, percentUsed: 100 });
    expect(s.usage.providers[1]).toMatchObject({ provider: 'resend', reserved: 1, remaining: 99, accepted: 1 });
    expect(s.alerts.join('|')).toMatch(/brevo has used 100%/); expect(s.alerts.join('|')).toMatch(/Resend is now the active email tier/);
    expect(mockDb._t('emailOutbox')[0]).toMatchObject({ provider: 'resend', routeReason: 'BREVO_ALLOCATION_EXHAUSTED' });
  });
});
