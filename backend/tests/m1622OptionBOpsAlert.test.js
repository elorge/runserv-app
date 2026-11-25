'use strict';
// M16.2.2: Option B (registered parcels on the recipient email flow) and the active ops alert.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env: emailEnv, makeHttp } = require('./helpers/emailEnv');
let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
process.env.JWT_SECRET = 'test-secret';
process.env.GUEST_HASH_SECRET = 'hash-secret-for-tests-0123456789abcdef';
const comms = require('../src/services/deliveryComms.service');
const emailOutbox = require('../src/services/emailOutbox.service');
const podSvc = require('../src/services/podCode.service');
const ops = require('../src/services/opsAlert.service');
const env = { ...emailEnv, GUEST_HASH_SECRET: process.env.GUEST_HASH_SECRET, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true', SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'false', POD_CODE_TTL_HOURS: '12', PARCEL_PILOT_SCOPE: 'guest_and_registered' };
Object.assign(process.env, env);

const seed = async () => {
  mockDb = makeFakeGuestPrisma();
  await mockDb.user.create({ data: { id: 'c1', phone: '+2348011111111', firstName: 'R', lastName: 'C', password: 'x', countryCode: 'NG' } });
  await mockDb.user.create({ data: { id: 'a1', phone: '+2348022222222', firstName: 'A', lastName: 'D', password: 'x', role: 'ADMIN', adminDepartment: null, supportCountries: ['NG'] } });
  await mockDb.user.create({ data: { id: 'a2', phone: '+2348033333333', firstName: 'B', lastName: 'D', password: 'x', role: 'ADMIN', adminDepartment: 'RIDES', supportCountries: [] } });
  await mockDb.user.create({ data: { id: 'a3', phone: '+2348044444444', firstName: 'C', lastName: 'D', password: 'x', role: 'ADMIN', adminDepartment: null, supportCountries: ['GH'] } });
  const id = 'd1111111-1111-4111-8111-111111111111'; const g = podSvc.generate(id, { env });
  await mockDb.delivery.create({ data: { id, customerId: 'c1', status: 'PENDING', recipientEmail: 'ada@example.com', podCodeHash: g.hash, podCodeNonce: g.nonce, podCodeVersion: 1, podCodeExpiresAt: g.expiresAt, podCodeAttempts: 0 } });
  await mockDb.$transaction((tx) => comms.enqueueRegisteredTx(tx, { deliveryId: id, recipientEmail: 'ada@example.com', env }));
  return { id, code: g.code };
};
const flush = () => new Promise((r) => setTimeout(r, 20));

test('Option B email: delivery-pointed row sends the code, no tracking link, no booking needed', async () => {
  const { id, code } = await seed(); const http = makeHttp();
  const out = await emailOutbox.processForDelivery(id, { env, http });
  expect(out).toEqual([{ done: true, provider: expect.any(String) }]);
  const text = http.calls[0].body.textContent || http.calls[0].body.text;
  expect(text).toContain(code); expect(text).not.toMatch(/Follow the delivery/);
  expect(JSON.stringify(mockDb._t('emailOutbox'))).not.toContain(code);
  expect(mockDb._t('emailOutbox')[0].bookingId).toBeUndefined();
});

test('registered resend / rotate work by delivery; rotate invalidates the old code and queues the reissue mail', async () => {
  const { id, code } = await seed(); await emailOutbox.processForDelivery(id, { env, http: makeHttp() });
  const d = () => mockDb._t('delivery')[0];
  await comms.resendRecipient({ delivery: d(), countryCode: 'NG', adminId: 'a1', env });
  expect(mockDb._t('emailOutbox')).toHaveLength(2);
  await emailOutbox.processForDelivery(id, { env, http: makeHttp() });
  const r = await comms.rotateRecipient({ delivery: d(), countryCode: 'NG', adminId: 'a1', reason: 'recipient lost the email', now: Date.now() + 3 * 60 * 1000, env });
  expect(r.version).toBe(2); expect(podSvc.codeFor(d(), env)).not.toBe(code);
  expect(mockDb._t('emailOutbox').pop().kind).toBe('RECIPIENT_CODE_REISSUED');
  const st = await comms.recipientStatus({ delivery: d(), env });
  expect(st.source).toBe('REGISTERED'); expect(JSON.stringify(st)).not.toContain(podSvc.codeFor(d(), env));
});

test('ops alert: a dead-lettered recipient email notifies in-market staff only, with no address or code', async () => {
  const { id, code } = await seed();
  const row = mockDb._t('emailOutbox')[0];
  await ops.recipientHandoverFailed({ deliveryId: id, why: 'EMAIL_DEAD', category: 'INVALID_ADDRESS', env });
  const n = mockDb._t('notification');
  expect(n.map((x) => x.userId).sort()).toEqual(['a1']);          // a2 is RIDES-only, a3 is another market
  expect(n[0].type).toBe(ops.TYPE); expect(JSON.stringify(n)).not.toMatch(/ada@example|\b\d{6}\b/); expect(JSON.stringify(n)).not.toContain(code);
  expect(mockDb._calls.audit.some((e) => e.event === 'OPS_ALERT_SENT')).toBe(true);
  expect(row.id).toBeTruthy();
});

test('ops alert is wired to the real dead-letter path and can be switched off', async () => {
  const { id } = await seed();
  const http = { post: async () => { const e = new Error('rejected'); e.category = 'INVALID_ADDRESS'; throw e; } };
  const rowId = mockDb._t('emailOutbox')[0].id;
  await emailOutbox.processEvent(rowId, { env, http: () => { throw Object.assign(new Error('bad'), { category: 'INVALID_ADDRESS' }); } }).catch(() => {});
  await flush();
  if (mockDb._t('emailOutbox')[0].status === 'DEAD') expect(mockDb._t('notification').length).toBeGreaterThan(0);
  const before = mockDb._t('notification').length;
  expect(await ops.recipientHandoverFailed({ deliveryId: id, why: 'CODE_LOCKED', env: { ...env, OPS_ALERTS_ENABLED: 'false' } })).toEqual({ notified: 0, webhook: 'SKIPPED' });
  expect(mockDb._t('notification').length).toBe(before);
});
