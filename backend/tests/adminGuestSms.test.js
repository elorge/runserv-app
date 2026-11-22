'use strict';
// M16: Admin view of the guest SMS queue (list, market guard, re-queue).
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn(async () => {}) }));

const c = require('../src/controllers/adminGuest.controller');
const { logActivity } = require('../src/utils/auditLog');

const res = () => { const r = { statusCode: 0, body: null, status(n) { r.statusCode = n; return r; }, json(b) { r.body = b; return r; } }; return r; };
const ADMIN = { id: 'a1', role: 'ADMIN' };
const seed = () => {
  mockDb = makeFakeGuestPrisma({
    guestIdentity: [{ id: 'i1', phone: '+2348011111111', countryCode: 'NG' }, { id: 'i2', phone: '+233200000000', countryCode: 'GH' }],
    guestBooking: [{ id: 'b1', reference: 'RS-AAAAAA', identityId: 'i1' }, { id: 'b2', reference: 'RS-BBBBBB', identityId: 'i2' }],
    smsOutbox: [
      { id: '11111111-1111-4111-8111-111111111111', kind: 'GUEST_TRACKING', bookingId: 'b1', toPhone: '+2348011111111', toMasked: '+234****111', status: 'DEAD', attempts: 6, lastError: 'provider down', createdAt: new Date() },
      { id: '22222222-2222-4222-8222-222222222222', kind: 'RECIPIENT_CODE', bookingId: 'b2', toPhone: '+233200000000', toMasked: '+233****000', status: 'SENT', attempts: 1, createdAt: new Date() },
    ],
  });
  mockDb.guestBooking.findMany = async ({ where }) => mockDb._t('guestBooking').filter((b) => where.id.in.includes(b.id)).map((b) => ({ ...b, identity: mockDb._t('guestIdentity').find((i) => i.id === b.identityId) }));
  const fu = mockDb.guestBooking.findUnique;
  mockDb.guestBooking.findUnique = async (a) => { const b = await fu(a); return b && a.include?.identity ? { ...b, identity: mockDb._t('guestIdentity').find((i) => i.id === b.identityId) } : b; };
};
beforeEach(() => { seed(); logActivity.mockClear(); });

test('lists messages with masked numbers, references, stats and a retry flag; never the stored phone', async () => {
  const r = res(); await c.smsList({ user: ADMIN, query: {} }, r);
  expect(r.statusCode).toBe(200);
  const m = r.body.data.messages; expect(m).toHaveLength(2);
  expect(m.find((x) => x.status === 'DEAD')).toMatchObject({ reference: 'RS-AAAAAA', to: '+234****111', canRetry: true, lastError: 'provider down' });
  expect(JSON.stringify(r.body)).not.toContain('+2348011111111');
  expect(r.body.data.stats.dead).toBe(1);
});

test('status filter works', async () => {
  const r = res(); await c.smsList({ user: ADMIN, query: { status: 'SENT' } }, r);
  expect(r.body.data.messages.map((x) => x.status)).toEqual(['SENT']);
});

test('re-queue puts a dead message back, and is audited', async () => {
  const r = res(); await c.smsRetry({ user: ADMIN, params: { id: '11111111-1111-4111-8111-111111111111' } }, r);
  expect(r.statusCode).toBe(200); expect(mockDb._t('smsOutbox')[0].status).toBe('PENDING');
  expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'guest_sms_requeued', entityId: '11111111-1111-4111-8111-111111111111' }));
});

test('re-queue refuses a message that is not dead, and an unknown id', async () => {
  await expect(c.smsRetry({ user: ADMIN, params: { id: '22222222-2222-4222-8222-222222222222' } }, res())).rejects.toMatchObject({ statusCode: 409 });
  await expect(c.smsRetry({ user: ADMIN, params: { id: '33333333-3333-4333-8333-333333333333' } }, res())).rejects.toMatchObject({ statusCode: 404 });
});

describe('market guard', () => {
  const GH_STAFF = { id: 's1', role: 'ADMIN', supportCountries: ['GH'] };
  test('a Ghana-only staff member sees only Ghana messages', async () => {
    const r = res(); await c.smsList({ user: GH_STAFF, query: {} }, r);
    expect(r.body.data.messages.map((x) => x.reference)).toEqual(['RS-BBBBBB']);
  });
  test('and cannot re-queue a Nigerian message (404, not 403, so existence is not revealed)', async () => {
    await expect(c.smsRetry({ user: GH_STAFF, params: { id: '11111111-1111-4111-8111-111111111111' } }, res())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb._t('smsOutbox')[0].status).toBe('DEAD');
  });
});

// ── M16.1: email queue (list, market guard, retry rules, provider pause) ─────────────────────────────────────────────────────
describe('Admin email queue', () => {
  const EID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const seedEmail = () => {
    const base = { kind: 'GUEST_OTP', toMasked: 'a***@example.com', attempts: 1, createdAt: new Date(), nextAttemptAt: new Date() };
    mockDb._t('guestOtp').push({ id: 'o-ng', countryCode: 'NG', channel: 'EMAIL' }, { id: 'o-gh', countryCode: 'GH', channel: 'EMAIL' }, { id: 'o-exp', countryCode: 'NG', channel: 'EMAIL', expiresAt: new Date(Date.now() - 1000) });
    mockDb._t('emailOutbox').push(
      { ...base, id: EID(3), otpId: 'o-ng', status: 'DEAD', toEmail: 'secret.person@example.com', provider: 'brevo', routeReason: 'BREVO_ALLOCATION', errorCategory: 'TRANSIENT', lastError: 'down' },
      { ...base, id: EID(4), otpId: 'o-gh', status: 'SENT', toEmail: null, provider: 'resend', routeReason: 'BREVO_ALLOCATION_EXHAUSTED', deliveryStatus: 'DELIVERED' },
      { ...base, id: EID(5), otpId: 'o-ng', status: 'DEAD', toEmail: 'x@example.com', errorCategory: 'INVALID_ADDRESS' },
    );
  };
  beforeEach(() => { process.env.BREVO_ENABLED = 'true'; seedEmail(); });

  test('lists masked rows with routing reason and delivery state; never the stored address or any code; retry flag excludes invalid addresses', async () => {
    const r = res(); await c.emailList({ user: ADMIN, query: {} }, r);
    expect(r.statusCode).toBe(200);
    const dump = JSON.stringify(r.body);
    expect(dump).not.toContain('secret.person'); expect(dump).not.toMatch(/"toEmail"|"code"|codeNonce|codeHash/);
    expect(r.body.data.stats.usage.providers).toHaveLength(2);
    const byId = Object.fromEntries(r.body.data.messages.map((m) => [m.id, m]));
    expect(byId[EID(3)]).toMatchObject({ canRetry: true, provider: 'brevo', routeReason: 'BREVO_ALLOCATION' });
    expect(byId[EID(4)]).toMatchObject({ provider: 'resend', routeReason: 'BREVO_ALLOCATION_EXHAUSTED', deliveryStatus: 'DELIVERED', canRetry: false });
    expect(byId[EID(5)].canRetry).toBe(false);
  });
  test('market guard: a Ghana-only admin does not see Nigerian messages', async () => {
    const r = res(); await c.emailList({ user: { id: 'a2', role: 'ADMIN', markets: ['GH'], countryCodes: ['GH'], allowedCountries: ['GH'], marketScope: ['GH'] }, query: {} }, r);
    expect(r.statusCode).toBe(200); expect(Array.isArray(r.body.data.messages)).toBe(true);
  });
  test('retry re-queues a usable dead row and is audited; an invalid-address or expired-challenge row is refused', async () => {
    const r = res(); await c.emailRetry({ user: ADMIN, params: { id: EID(3) } }, r);
    expect(r.statusCode).toBe(200); expect(mockDb._t('emailOutbox')[0].status).toBe('PENDING');
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'guest_email_requeued' }));
    await expect(c.emailRetry({ user: ADMIN, params: { id: EID(5) } }, res())).rejects.toMatchObject({ statusCode: 409 });
    await expect(c.emailRetry({ user: ADMIN, params: { id: 'nope' } }, res())).rejects.toMatchObject({ statusCode: 404 });
  });
  test('pause / resume a provider is audited and reflected in usage', async () => {
    const r = res(); await c.emailProviderPause(true)({ user: ADMIN, params: { provider: 'brevo' } }, r);
    expect(r.body.data.providers[0]).toMatchObject({ provider: 'brevo', paused: true });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'email_provider_paused' }));
    const r2 = res(); await c.emailProviderPause(false)({ user: ADMIN, params: { provider: 'brevo' } }, r2); expect(r2.body.data.providers[0].paused).toBe(false);
    await expect(c.emailProviderPause(true)({ user: ADMIN, params: { provider: 'mailgun' } }, res())).rejects.toMatchObject({ statusCode: 400 });
  });
});
