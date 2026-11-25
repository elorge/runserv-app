'use strict';
// WP-08 review: push delivery, device-token endpoints, durable ops alerts, admin alert guards.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn(async () => {}) }));
process.env.JWT_SECRET = 'test-secret';
const push = require('../src/services/push.service');
const ops = require('../src/services/opsAlert.service');
const devices = require('../src/controllers/notification.controller');
const alerts = require('../src/controllers/adminAlerts.controller');
const { logActivity } = require('../src/utils/auditLog');

const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const fails = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };
const noSleep = async () => {};
const reply = (list) => ({ sendEachForMulticast: jest.fn(async ({ tokens }) => ({ responses: tokens.map((t) => { const x = list[t] || { ok: true }; return x.ok ? { success: true } : { success: false, error: { code: x.code } }; }) })) });

beforeEach(async () => { mockDb = makeFakeGuestPrisma(); push._resetForTests({}); jest.clearAllMocks(); });

describe('push.service', () => {
  const addTok = (token, userId = 'u1') => mockDb.deviceToken.create({ data: { userId, token, platform: 'android' } });

  test('no credentials: logged no-op, never throws', async () => {
    expect(await push.sendToUser('u1', { title: 't', body: 'b' })).toMatchObject({ skipped: 'NO_CREDENTIALS' });
  });
  test('sends to every active device, skips revoked ones', async () => {
    await addTok('a'); await addTok('b'); await mockDb.deviceToken.create({ data: { userId: 'u1', token: 'c', platform: 'ios', revokedAt: new Date() } });
    const m = reply({}); push._resetForTests({ messagingClient: m, sleepFn: noSleep });
    const r = await push.sendToUser('u1', { title: 't', body: 'b', type: 'ride_accepted', data: { rideId: 'r1', secret: 'x' } });
    expect(r).toMatchObject({ sent: 2, failed: 0 });
    const msg = m.sendEachForMulticast.mock.calls[0][0];
    expect(msg.tokens.sort()).toEqual(['a', 'b']); expect(msg.data).toMatchObject({ route: 'ride', rideId: 'r1' }); expect(msg.data.secret).toBeUndefined();
  });
  test('unregistered token is revoked; a mismatched-credential error is NOT treated as a dead token', async () => {
    await addTok('dead'); await addTok('cfg');
    push._resetForTests({ messagingClient: reply({ dead: { code: 'messaging/registration-token-not-registered' }, cfg: { code: 'messaging/mismatched-credential' } }), sleepFn: noSleep });
    const r = await push.sendToUser('u1', { title: 't', body: 'b' });
    expect(r).toMatchObject({ failed: 2, revoked: 1 });
    const rows = mockDb._t('deviceToken');
    expect(rows.find((x) => x.token === 'dead').revokedAt).toBeTruthy(); expect(rows.find((x) => x.token === 'cfg').revokedAt).toBeNull();
  });
  test('transient per-token errors are retried then succeed', async () => {
    await addTok('a');
    let n = 0; const m = { sendEachForMulticast: jest.fn(async () => (++n < 2 ? { responses: [{ success: false, error: { code: 'messaging/unavailable' } }] } : { responses: [{ success: true }] })) };
    push._resetForTests({ messagingClient: m, sleepFn: noSleep });
    expect(await push.sendToUser('u1', { title: 't', body: 'b' })).toMatchObject({ sent: 1, failed: 0 });
    expect(m.sendEachForMulticast).toHaveBeenCalledTimes(2);
  });
  test('network-level failure (app/network-error) is retried; auth failure is not', async () => {
    await addTok('a');
    const net = { sendEachForMulticast: jest.fn(async () => { const e = new Error('x'); e.code = 'app/network-error'; throw e; }) };
    push._resetForTests({ messagingClient: net, sleepFn: noSleep });
    await push.sendToUser('u1', { title: 't', body: 'b' });
    expect(net.sendEachForMulticast).toHaveBeenCalledTimes(3);
    const auth = { sendEachForMulticast: jest.fn(async () => { const e = new Error('x'); e.code = 'messaging/authentication-error'; throw e; }) };
    push._resetForTests({ messagingClient: auth, sleepFn: noSleep });
    const r = await push.sendToUser('u1', { title: 't', body: 'b' });
    expect(auth.sendEachForMulticast).toHaveBeenCalledTimes(1); expect(r.failed).toBe(1);
    expect(mockDb._t('deviceToken')[0].revokedAt).toBeNull();
  });
  test('routeFor maps notification types', () => {
    expect(push.routeFor('delivery_completed')).toBe('delivery'); expect(push.routeFor('wallet_credited')).toBe('wallet');
    expect(push.routeFor('ops_x')).toBe('ops_alert'); expect(push.routeFor('whatever')).toBe('notifications');
  });
});

describe('device endpoints', () => {
  const user = { id: 'u1' };
  test('register validates, upserts, reassigns the token to the new user and replaces a rotated token of the same device', async () => {
    expect((await fails(() => devices.registerDevice({ user, body: { token: 123, platform: 'ios' } }, res()))).statusCode).toBe(400);
    expect((await fails(() => devices.registerDevice({ user, body: { token: 't1', platform: 'palm' } }, res()))).statusCode).toBe(400);
    await devices.registerDevice({ user, body: { token: 't1', platform: 'android', deviceId: 'd1' } }, res());
    await devices.registerDevice({ user, body: { token: 't2', platform: 'android', deviceId: 'd1' } }, res());   // FCM rotated the token
    let rows = mockDb._t('deviceToken');
    expect(rows.find((x) => x.token === 't1').revokedAt).toBeTruthy(); expect(rows.find((x) => x.token === 't2').revokedAt).toBeNull();
    await devices.registerDevice({ user: { id: 'u2' }, body: { token: 't2', platform: 'android' } }, res());      // other user logs in on the same phone
    rows = mockDb._t('deviceToken'); expect(rows.find((x) => x.token === 't2')).toMatchObject({ userId: 'u2', revokedAt: null });
  });
  test('unregister only revokes the caller\'s own tokens', async () => {
    await devices.registerDevice({ user, body: { token: 't1', platform: 'ios' } }, res());
    expect((await fails(() => devices.unregisterDevice({ user, body: {}, query: {} }, res()))).statusCode).toBe(400);
    const other = res(); await devices.unregisterDevice({ user: { id: 'u9' }, body: { token: 't1' }, query: {} }, other);
    expect(other.body.data.revoked).toBe(0); expect(mockDb._t('deviceToken')[0].revokedAt).toBeNull();
    const mine = res(); await devices.unregisterDevice({ user, body: { token: 't1' }, query: {} }, mine);
    expect(mine.body.data.revoked).toBe(1);
  });
});

describe('ops alerts', () => {
  const env = { OPS_ALERTS_ENABLED: 'true' };
  const staff = async () => { await mockDb.user.create({ data: { id: 's1', phone: '+2348000000001', role: 'SUPER_ADMIN' } }); await mockDb.user.create({ data: { id: 's2', phone: '+2348000000002', role: 'ADMIN', adminDepartment: null, supportCountries: ['NG'] } }); await mockDb.user.create({ data: { id: 's3', phone: '+2348000000003', role: 'ADMIN', adminDepartment: null, supportCountries: ['GH'] } }); };
  const registered = async () => { await mockDb.user.create({ data: { id: 'c1', phone: '+2348011111111', countryCode: 'NG' } }); await mockDb.delivery.create({ data: { id: 'd1abcdef-0000', customerId: 'c1' } }); };

  test('deduplicates per open key, notifies in-market staff once, durable rows record SENT', async () => {
    await staff(); await registered();
    const a = await ops.recipientHandoverFailed({ deliveryId: 'd1abcdef-0000', why: 'SMS_DEAD', category: 'SMS_FAILED', env });
    const b = await ops.recipientHandoverFailed({ deliveryId: 'd1abcdef-0000', why: 'SMS_DEAD', category: 'SMS_FAILED', env });
    expect(a.notified).toBe(2); expect(b.deduped).toBe(true);
    expect(mockDb._t('opsAlert')).toHaveLength(1); expect(mockDb._t('opsAlert')[0].occurrences).toBe(2);
    expect(mockDb._t('opsAlertDelivery')).toEqual([expect.objectContaining({ channel: 'IN_APP', status: 'SENT' })]);
    expect(JSON.stringify(mockDb._t('opsAlert'))).not.toMatch(/\+234|@/);
  });
  test('SMS dead-letter on a registered parcel resolves the market from the delivery (not by mistaking its id for a booking)', async () => {
    await staff(); await registered();
    await mockDb.smsOutbox.create({ data: { kind: 'RECIPIENT_CODE', deliveryId: 'd1abcdef-0000', toPhone: null, status: 'PENDING', attempts: 99 } });
    const { processEvent } = require('../src/services/smsOutbox.service');
    await processEvent(mockDb._t('smsOutbox')[0].id, { env: { SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'true' }, sms: { send: async () => { throw new Error('boom'); } } });
    await new Promise((r) => setTimeout(r, 20));
    const al = mockDb._t('opsAlert')[0];
    expect(al.data).toMatchObject({ deliveryId: 'd1abcdef-0000', countryCode: 'NG', why: 'SMS_DEAD' });
    expect(al.message).toMatch(/PRCL-/);
  });
  test('webhook failure is FAILED (never SENT), retried by the worker with backoff, then recovers', async () => {
    await staff(); await registered();
    const axios = require('axios'); const spy = jest.spyOn(axios, 'post').mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 500 } }));
    const wenv = { ...env, OPS_ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' };
    const r = await ops.recipientHandoverFailed({ deliveryId: 'd1abcdef-0000', why: 'EMAIL_DEAD', env: wenv });
    expect(r.webhook).toBe('FAILED'); expect(r.notified).toBeGreaterThan(0);
    const d = mockDb._t('opsAlertDelivery').find((x) => x.channel === 'WEBHOOK');
    expect(d).toMatchObject({ status: 'FAILED', lastError: 'HTTP_500', sentAt: null }); expect(d.nextAttemptAt).toBeTruthy();
    spy.mockResolvedValue({ status: 204 });
    const out = await ops.processDue({ now: new Date(Date.now() + 3600e3), env: wenv });
    expect(out.recovered).toBe(1); expect(mockDb._t('opsAlertDelivery').find((x) => x.channel === 'WEBHOOK')).toMatchObject({ status: 'SENT', lastError: null });
    spy.mockRestore();
  });
  test('non-https webhook and no recipients are never reported SENT', async () => {
    expect((await ops.postWebhook('x', { OPS_ALERT_WEBHOOK_URL: 'http://insecure.example.com' })).status).toBe('REJECTED_NOT_HTTPS');
    await registered();     // no staff at all
    const r = await ops.recipientHandoverFailed({ deliveryId: 'd1abcdef-0000', why: 'EMAIL_DEAD', env });
    expect(r.notified).toBe(0); expect(mockDb._t('opsAlertDelivery')[0]).toMatchObject({ status: 'FAILED', lastError: 'NO_RECIPIENTS' });
    expect(mockDb._calls.audit.some((e) => e.event === 'OPS_ALERT_FAILED')).toBe(true); expect(mockDb._calls.audit.some((e) => e.event === 'OPS_ALERT_SENT')).toBe(false);
  });
  test('stale OPEN alert escalates once to super admins; acknowledged alert does not', async () => {
    await staff(); await registered();
    await ops.recipientHandoverFailed({ deliveryId: 'd1abcdef-0000', why: 'EMAIL_DEAD', env });
    const later = new Date(Date.now() + 31 * 60e3);
    expect((await ops.processDue({ now: later, env })).escalated).toBe(1);
    expect((await ops.processDue({ now: later, env })).escalated).toBe(0);
    const esc = mockDb._t('notification').filter((n) => /ESCALATED/.test(n.title)); expect(esc.map((n) => n.userId)).toEqual(['s1']);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'ops_alert_escalated' }));
  });
});

describe('admin alerts', () => {
  const seed = async () => { await mockDb.opsAlert.create({ data: { id: 'ng', kind: 'K', dedupeKey: 'a', title: 't', message: 'm', data: { countryCode: 'NG' } } }); await mockDb.opsAlert.create({ data: { id: 'gh', kind: 'K', dedupeKey: 'b', title: 't', message: 'm', data: { countryCode: 'GH' } } }); await mockDb.opsAlert.create({ data: { id: 'nomkt', kind: 'K', dedupeKey: 'c', title: 't', message: 'm', data: {} } }); };
  const limited = { id: 'a1', role: 'ADMIN', adminDepartment: null, supportCountries: ['NG'] };
  test('routes carry auth + role + department guards', () => {
    const router = require('../src/routes/adminAlerts.routes');
    expect(router.stack.length).toBeGreaterThanOrEqual(3 + 4);
  });
  test('country-limited staff cannot read, acknowledge or resolve another market\'s alert', async () => {
    await seed();
    expect((await fails(() => alerts.getOne({ user: limited, params: { id: 'gh' } }, res()))).statusCode).toBe(404);
    expect((await fails(() => alerts.getOne({ user: limited, params: { id: 'nomkt' } }, res()))).statusCode).toBe(404);
    expect((await fails(() => alerts.acknowledge({ user: limited, params: { id: 'gh' } }, res()))).statusCode).toBe(404);
    expect((await fails(() => alerts.resolve({ user: limited, params: { id: 'gh' }, body: { note: 'fixed it' } }, res()))).statusCode).toBe(404);
    expect(mockDb._t('opsAlert').find((a) => a.id === 'gh').status).toBe('OPEN');
  });
  test('acknowledge / resolve work in scope, are audited, and are idempotent-safe', async () => {
    await seed(); const sup = { id: 'root', role: 'SUPER_ADMIN' };
    const r = res(); await alerts.acknowledge({ user: limited, params: { id: 'ng' } }, r); expect(r.body.data.alert.status).toBe('ACKNOWLEDGED');
    expect((await fails(() => alerts.acknowledge({ user: limited, params: { id: 'ng' } }, res()))).statusCode).toBe(409);
    expect((await fails(() => alerts.resolve({ user: sup, params: { id: 'ng' }, body: { note: 'x' } }, res()))).statusCode).toBe(400);
    await alerts.resolve({ user: sup, params: { id: 'ng' }, body: { note: 'sender confirmed address' } }, res());
    expect((await fails(() => alerts.resolve({ user: sup, params: { id: 'ng' }, body: { note: 'again again' } }, res()))).statusCode).toBe(409);
    expect(logActivity.mock.calls.map((c) => c[0].action)).toEqual(['ops_alert_acknowledged', 'ops_alert_resolved']);
  });
  test('list applies the market filter for limited staff and none for super admin', async () => {
    const spy = jest.spyOn(mockDb.opsAlert, 'findMany');
    await alerts.list({ user: limited, query: {} }, res());
    expect(JSON.stringify(spy.mock.calls[0][0].where)).toContain('"countryCode"');
    await alerts.list({ user: { id: 'root', role: 'SUPER_ADMIN' }, query: {} }, res());
    expect(spy.mock.calls[1][0].where.AND).toBeUndefined();
  });
});
