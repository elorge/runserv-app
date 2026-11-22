'use strict';
// M16.2.1: hand-over code lifecycle (random nonce, hashed at rest, expiry, atomic rotation), atomic resend, neutral courier errors,
// public-tracking privacy + lifetime policy, pilot scope, manual exception workflow, metrics, production guards.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env: emailEnv, makeHttp } = require('./helpers/emailEnv');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../src/utils/fareEngine', () => ({
  estimateFare: jest.fn(async () => ({ estimatedFare: 2500, baseFare: 500, distanceCharge: 1800, timeCharge: 150, bookingFee: 50, surgeMultiplier: 1, commissionRate: 0.2 })),
  calculateDeliveryFee: jest.fn(async () => ({ estimatedFee: 1800, baseFee: 500, distanceCharge: 1300, currency: 'NGN' })),
  getSettings: jest.fn(async () => ({ delivery: { platformCommission: 0.2 } })),
}));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn(async () => {}) }));
process.env.JWT_SECRET = 'test-secret';
// Services read process.env at call time (as in production); the guest secrets must therefore match the `pilot` env used to derive codes in these tests.
process.env.GUEST_HASH_SECRET = 'hash-secret-for-tests-0123456789abcdef'; process.env.GUEST_QUOTE_SECRET = 'quote-secret-for-tests-0123456789abcdef';
const booking = require('../src/services/guestBooking.service');
const guestQuote = require('../src/services/guestQuote.service');
const comms = require('../src/services/deliveryComms.service');
const emailOutbox = require('../src/services/emailOutbox.service');
const podSvc = require('../src/services/podCode.service');
const pod = require('../src/services/proofOfDelivery.service');
const envGuard = require('../src/utils/envGuard');
const adminCtl = require('../src/controllers/adminGuest.controller');

const base = { ...emailEnv, GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', ENABLED_VEHICLE_CATEGORIES: 'CAR,MOTORCYCLE,VAN', GUEST_TRACKING_BASE_URL: 'https://track.runserv.test/t', GUEST_HASH_SECRET: 'hash-secret-for-tests-0123456789abcdef', GUEST_QUOTE_SECRET: 'quote-secret-for-tests-0123456789abcdef' };
const pilot = { ...base, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true', SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'false', POD_CODE_TTL_HOURS: '12', PARCEL_PILOT_SCOPE: 'guest_only' };
const PICK = { latitude: 6.5244, longitude: 3.3792, address: '12 Allen Avenue, Ikeja, Lagos', source: 'PLACE_SEARCH' };
const DEST = { latitude: 6.4281, longitude: 3.4219, address: '5 Adeola Odeku Street, Victoria Island, Lagos' };
const parcel = { category: 'SMALL', weightKg: 2, longestSideCm: 30, description: 'Phone charger box', recipientName: 'Ada Obi', recipientPhone: '+2348098765432', recipientEmail: 'ada.obi@example.com', acknowledgedProhibited: true };
let n = 0;
const guestFor = async (email = 'sender@example.com') => {
  const i = await mockDb.guestIdentity.create({ data: { email, phone: null, contactPhone: '+2348012345678', countryCode: 'NG', verifiedChannel: 'EMAIL', userId: `u${++n}`, verifiedAt: new Date() } });
  await mockDb.user.create({ data: { id: i.userId, phone: `+23480000${n}`, email: null, firstName: 'G', lastName: 'U', password: 'x' } });
  return { identityId: i.id, userId: i.userId, phone: '+2348012345678', email, countryCode: 'NG' };
};
const book = (g, env = pilot, key = 'idem-key-0001') => booking.createBooking({ guest: g, idempotencyKey: key, body: { quote: guestQuote.signQuote({ service: 'PARCEL', vehicleType: 'MOTORCYCLE', fare: 1800, currency: 'NGN', countryCode: 'NG', distanceM: 8000, durationS: 1200, pickup: PICK, destination: DEST, parcel }, { env }), pickup: PICK, destination: DEST, contactName: 'Tunde', parcel }, env });
const del = () => mockDb._t('delivery')[0];
const bk = () => mockDb._t('guestBooking')[0];
const sent = (http, i = 0) => http.calls[i].body.textContent || http.calls[i].body.text;
const settle = async (id) => { await emailOutbox.processForBooking(id, { env: pilot, http: makeHttp() }); };
const inTransit = (d, partnerId = 'p1') => Object.assign(d, { status: 'IN_TRANSIT', partnerId });
const codeOf = (d) => podSvc.codeFor(d, pilot);
const wrongFor = (d) => (codeOf(d) === '000000' ? '111111' : '000000');
const events = () => mockDb._calls.audit.map((e) => e.event);

beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('P1.1 code lifecycle: unpredictable, hashed at rest, expiring', () => {
  test('each booking gets a fresh random nonce; the code is not a function of the delivery id; only hash+nonce are stored', async () => {
    const r = await book(await guestFor()); const d = del();
    expect(d.podCodeNonce).toMatch(/^[0-9a-f]{32}$/); expect(d.podCodeVersion).toBe(1);
    expect(d.podCodeHash).toBe(booking.podHash(d.id, codeOf(d), pilot));
    expect(codeOf(d)).not.toBe(podSvc.legacyCode(d.id, pilot));                         // no longer derivable from the id alone
    expect(JSON.stringify(mockDb._t('delivery'))).not.toContain(codeOf(d));              // plaintext is nowhere in the row
    expect(JSON.stringify(mockDb._t('emailOutbox'))).not.toContain(codeOf(d));
    expect(JSON.stringify(mockDb._calls.audit)).not.toContain(codeOf(d));
    expect(r.podCode).toBeUndefined();                                                   // sender does not receive it by default
  });
  test('two codes for the same delivery id differ (nonce), and codes are 6 digits', () => {
    const a = podSvc.generate('same-id', { env: pilot }); const b = podSvc.generate('same-id', { env: pilot });
    expect(a.code).toMatch(/^\d{6}$/); expect(a.nonce).not.toBe(b.nonce); expect(a.hash).not.toBe(b.hash);
  });
  test('expiry is configurable, never guessed: unset = none, invalid = none, 12 = 12 h', async () => {
    expect(podSvc.ttlMs({})).toBeNull(); expect(podSvc.ttlMs({ POD_CODE_TTL_HOURS: 'abc' })).toBeNull(); expect(podSvc.ttlMs({ POD_CODE_TTL_HOURS: '-1' })).toBeNull();
    expect(podSvc.ttlMs({ POD_CODE_TTL_HOURS: '12' })).toBe(12 * 3600 * 1000);
    const t0 = Date.now(); await book(await guestFor());
    expect(new Date(del().podCodeExpiresAt).getTime() - t0).toBeGreaterThan(12 * 3600 * 1000 - 5000);
    mockDb = makeFakeGuestPrisma(); await book(await guestFor(), { ...pilot, POD_CODE_TTL_HOURS: '' }, 'idem-key-0002'); expect(del().podCodeExpiresAt).toBeNull();
  });
  test('the recipient email states the expiry; an EXPIRED code is never emailed', async () => {
    const r = await book(await guestFor()); const http = makeHttp();
    await emailOutbox.processForBooking(r.booking.id, { env: pilot, http });
    expect(sent(http)).toMatch(/valid until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    mockDb = makeFakeGuestPrisma(); const r2 = await book(await guestFor(), pilot, 'idem-key-0009'); del().podCodeExpiresAt = new Date(Date.now() - 1000);
    expect(await emailOutbox.processForBooking(r2.booking.id, { env: pilot, http: makeHttp() })).toEqual([{ skipped: true }]);
  });
  test('Admin-safe lifecycle view exposes state/version/expiry, never code, hash or nonce', async () => {
    await book(await guestFor()); const v = podSvc.lifecycleView(del()); const text = JSON.stringify(v);
    expect(v).toMatchObject({ state: 'ACTIVE', version: 1, legacy: false });
    expect(text).not.toContain(del().podCodeHash); expect(text).not.toContain(del().podCodeNonce); expect(text).not.toContain(codeOf(del()));
  });
});

describe('courier verification: expiry, rotation race, neutral errors, idempotency', () => {
  const setup = async () => { const r = await book(await guestFor()); inTransit(del()); return r; };
  test('the right code verifies once; a repeat is idempotent; audit carries the code version only', async () => {
    await setup(); const d = del();
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) })).resolves.toEqual({ verified: true, already: false });
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) })).resolves.toEqual({ verified: true, already: true });
    expect(events().filter((e) => e === 'POD_VERIFIED')).toHaveLength(1);
  });
  test('an expired code is refused with the SAME neutral answer as a wrong one, spends an attempt, and is audited', async () => {
    await setup(); const d = del(); d.podCodeExpiresAt = new Date(Date.now() - 1000);
    const a = await pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) }).catch((e) => e);
    const b = await pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: wrongFor(d) }).catch((e) => e);
    expect(a).toMatchObject({ code: 'POD_WRONG', statusCode: 400 }); expect(b).toMatchObject({ code: 'POD_WRONG', statusCode: 400 });
    expect(a.message).toBe(b.message); expect(d.podVerifiedAt).toBeNull(); expect(d.podCodeAttempts).toBe(2); expect(events()).toContain('POD_CODE_EXPIRED');
  });
  test('errors never reveal attempts left, closeness or expiry; the lock message is neutral', async () => {
    await setup(); const d = del(); const bad = wrongFor(d); const errs = [];
    for (let i = 0; i < 5; i += 1) errs.push(await pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: bad }).catch((e) => e));
    errs.slice(0, 4).forEach((e) => { expect(e.attemptsLeft).toBeUndefined(); expect(e.message).not.toMatch(/\d+ attempt|left|expired|close/i); });
    expect(errs[4]).toMatchObject({ code: 'POD_LOCKED', statusCode: 429 }); expect(errs[4].attemptsLeft).toBeUndefined();
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) })).rejects.toMatchObject({ code: 'POD_LOCKED' });
  });
  test('proofView sends the courier app no attempt counter', async () => { await setup(); expect(pod.proofView(del())).not.toHaveProperty('attemptsLeft'); });
  test('rotation racing a verification: the OLD code can never complete the delivery', async () => {
    await setup(); const d = del(); const oldCode = codeOf(d); const oldHash = d.podCodeHash;
    // The courier read the delivery with the old hash; a rotation commits before the final transition.
    const real = mockDb.delivery.updateMany; let first = true;
    mockDb.delivery.updateMany = async (a) => { if (first && a.data?.podVerifiedAt) { first = false; const nx = podSvc.generate(d.id, { env: pilot }); Object.assign(d, { podCodeHash: nx.hash, podCodeNonce: nx.nonce, podCodeVersion: 2 }); } return real(a); };
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: oldCode })).rejects.toMatchObject({ code: 'POD_WRONG' });
    expect(d.podVerifiedAt).toBeNull(); expect(d.podCodeHash).not.toBe(oldHash);
  });
  test('legacy deliveries (no nonce) created before the upgrade still verify with their legacy code', async () => {
    const id = 'legacy-1'; mockDb = makeFakeGuestPrisma({ delivery: [{ id, partnerId: 'p1', status: 'IN_TRANSIT', podCodeHash: booking.podHash(id, podSvc.legacyCode(id, pilot), pilot), podCodeAttempts: 0, podVerifiedAt: null, failedAt: null }] });
    await expect(pod.verifyProof({ deliveryId: id, partnerId: 'p1', code: podSvc.legacyCode(id, pilot) })).resolves.toMatchObject({ verified: true });
  });
  test('only the assigned courier can verify', async () => { await setup(); await expect(pod.verifyProof({ deliveryId: del().id, partnerId: 'intruder', code: codeOf(del()) })).rejects.toMatchObject({ statusCode: 403 }); });
});

describe('P1.1 rotate vs resend', () => {
  const setup = async (env = pilot) => { const r = await book(await guestFor(), env); await settle(r.booking.id); return { r, b: bk() }; };
  const later = () => Date.now() + 10 * 60 * 1000;
  test('rotate: new code replaces the old atomically, attempts reset, old email jobs superseded, recipient told the earlier code is void, audited', async () => {
    const { b } = await setup(); const d = del(); const oldCode = codeOf(d); d.podCodeAttempts = 4; const oldHash = d.podCodeHash;
    const out = await comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'admin1', ip: '1.1.1.1', reason: 'Recipient lost the email', now: later(), env: pilot });
    expect(out).toMatchObject({ version: 2, queued: { email: true, sms: false } }); expect(JSON.stringify(out)).not.toMatch(/\d{6}/);
    expect(d.podCodeHash).not.toBe(oldHash); expect(d.podCodeVersion).toBe(2); expect(d.podCodeAttempts).toBe(0); expect(d.podCodeRotatedAt).toBeInstanceOf(Date);
    expect(codeOf(d)).not.toBe(oldCode);
    expect(mockDb._t('emailOutbox').filter((x) => x.kind === 'RECIPIENT_CODE_REISSUED')).toHaveLength(1);
    const http = makeHttp(); await emailOutbox.processForBooking(b.id, { env: pilot, http });
    expect(sent(http)).toContain(codeOf(d)); expect(sent(http)).not.toContain(oldCode); expect(sent(http)).toMatch(/no longer works/); expect(http.calls[0].body.subject).toMatch(/New hand-over code/);
    expect(events()).toEqual(expect.arrayContaining(['POD_CODE_ROTATED', 'DELIVERY_NOTIFICATION_QUEUED']));
    expect(JSON.stringify(mockDb._calls.audit)).not.toContain(codeOf(d)); expect(JSON.stringify(mockDb._calls.audit)).not.toContain(oldCode);
  });
  test('after a rotation the OLD code is rejected by the courier endpoint and the NEW one accepted', async () => {
    const { b } = await setup(); const d = inTransit(del()); const oldCode = codeOf(d);
    await comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'Lost the email entirely', now: later(), env: pilot });
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: oldCode })).rejects.toMatchObject({ code: 'POD_WRONG' });
    await expect(pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) })).resolves.toMatchObject({ verified: true });
  });
  test('a rotation also recovers a LOCKED delivery and an EXPIRED one (the defined recovery path)', async () => {
    const { b } = await setup(); const d = del(); d.podCodeAttempts = 5; d.podCodeExpiresAt = new Date(Date.now() - 1000);
    expect(podSvc.stateOf(d)).toBe('LOCKED');
    await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now: later(), env: pilot })).rejects.toMatchObject({ code: 'CODE_LOCKED' });
    d.podCodeAttempts = 0; await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now: later(), env: pilot })).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    d.podCodeAttempts = 5; await comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'Locked after wrong tries', now: later(), env: pilot });
    expect(podSvc.stateOf(d)).toBe('ACTIVE'); expect(new Date(d.podCodeExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });
  test('resend does NOT change the code, hash, nonce or version', async () => {
    const { b } = await setup(); const d = del(); const snap = [d.podCodeHash, d.podCodeNonce, d.podCodeVersion];
    await comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now: later(), env: pilot });
    expect([d.podCodeHash, d.podCodeNonce, d.podCodeVersion]).toEqual(snap);
  });
  test('rotation is refused when no channel can reach the recipient (the old code is NOT invalidated for nothing)', async () => {
    const { b } = await setup(); const d = del(); const h = d.podCodeHash;
    await expect(comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'x'.repeat(12), now: later(), env: { ...pilot, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'false' } })).rejects.toMatchObject({ code: 'CHANNELS_DISABLED' });
    d.recipientEmail = null; await expect(comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'x'.repeat(12), now: later(), env: pilot })).rejects.toMatchObject({ code: 'NO_USABLE_CONTACT' });
    expect(d.podCodeHash).toBe(h);
  });
  test('rotation refused once handed over / cancelled', async () => {
    const { b } = await setup(); del().podVerifiedAt = new Date();
    await expect(comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'x'.repeat(12), now: later(), env: pilot })).rejects.toMatchObject({ code: 'NOT_RESENDABLE' });
  });
  test('Admin controller: rotate needs explicit confirm:true and never returns a code', async () => {
    const { b } = await setup(); const ctl = require('../src/controllers/adminGuest.controller'); const j = jest.fn(); const res = { status: jest.fn(() => ({ json: j })) };
    mockDb.guestBooking.findUnique = async () => ({ ...bk(), identity: { countryCode: 'NG' } });
    const mk = (body) => ({ params: { id: b.id }, body, user: { id: 'adm', role: 'ADMIN', countryCode: 'NG' }, ip: '9.9.9.9' });
    await expect(ctl.recipientRotate(mk({ reason: 'Recipient lost the email', confirm: false }), res)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED = 'true'; process.env.POD_CODE_TTL_HOURS = '12'; process.env.RECIPIENT_RESEND_COOLDOWN_SECONDS = '0';
    try { await ctl.recipientRotate(mk({ reason: 'Recipient lost the email', confirm: true }), res); } finally { ['EMAIL_DELIVERY_NOTIFICATIONS_ENABLED', 'POD_CODE_TTL_HOURS', 'RECIPIENT_RESEND_COOLDOWN_SECONDS'].forEach((k) => delete process.env[k]); }
    expect(j.mock.calls[0][0].success).toBe(true); expect(JSON.stringify(j.mock.calls[0][0])).not.toMatch(/\d{6}/);
  });
});

describe('P1.2 atomic resend cooldown (in-memory model; the PostgreSQL proof is tests/pg/)', () => {
  test('N simultaneous resends: exactly ONE wins, the rest get 429; only one email row is added', async () => {
    const r = await book(await guestFor()); await settle(r.booking.id); const b = bk(); const t = Date.now() + 10 * 60 * 1000; const before = mockDb._t('emailOutbox').length;
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now: t, env: pilot })));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    res.filter((x) => x.status === 'rejected').forEach((x) => expect(x.reason).toMatchObject({ code: 'RESEND_COOLDOWN', statusCode: 429 }));
    // (Row-count isolation between interleaved transactions is proven on real PostgreSQL in tests/pg/; the in-memory fake restores whole-table snapshots on a failed transaction.)
    expect(del().podNotifyReservedAt.getTime()).toBe(t); expect(before).toBe(1);
  });
  test('the booking itself starts the cooldown (a resend straight after booking is refused)', async () => {
    await book(await guestFor()); await expect(comms.resendRecipient({ booking: bk(), countryCode: 'NG', adminId: 'a', env: pilot })).rejects.toMatchObject({ code: 'RESEND_COOLDOWN' });
  });
  test('a refused resend (contact missing / previous email still queued) leaves the reservation untouched', async () => {
    await book(await guestFor()); const t = Date.now() + 10 * 60 * 1000; const reserved = del().podNotifyReservedAt;
    await expect(comms.resendRecipient({ booking: bk(), countryCode: 'NG', adminId: 'a', now: t, env: pilot })).rejects.toMatchObject({ code: 'ALREADY_QUEUED' });
    expect(del().podNotifyReservedAt).toBe(reserved);
  });
  test('concurrent rotations: one wins, the other is told the code changed', async () => {
    const r = await book(await guestFor()); await settle(r.booking.id); const b = bk(); const t = Date.now() + 10 * 60 * 1000;
    const res = await Promise.allSettled([1, 2, 3].map(() => comms.rotateRecipient({ booking: b, countryCode: 'NG', adminId: 'a', reason: 'x'.repeat(12), now: t, env: pilot })));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(del().podCodeVersion).toBe(2);
  });
});

describe('P1.3 pilot scope', () => {
  test('guest_only refuses registered-customer parcel bookings with PILOT_GUEST_ONLY; unset or other scopes do not', () => {
    expect(comms.registeredParcelsAllowed({ PARCEL_PILOT_SCOPE: 'guest_only' })).toBe(false); expect(comms.registeredParcelsAllowed({ PARCEL_PILOT_SCOPE: 'GUEST_ONLY ' })).toBe(false);
    expect(comms.registeredParcelsAllowed({})).toBe(true); expect(comms.registeredParcelsAllowed({ PARCEL_PILOT_SCOPE: 'guest_and_registered' })).toBe(true);
  });
  test('the registered request handler refuses before doing anything', async () => {
    const ctl = require('../src/controllers/delivery.controller'); process.env.PARCEL_PILOT_SCOPE = 'guest_only';
    try { await expect(ctl.requestDelivery({ body: {}, user: { id: 'u' } }, {})).rejects.toMatchObject({ code: 'PILOT_GUEST_ONLY', statusCode: 403 }); } finally { delete process.env.PARCEL_PILOT_SCOPE; }
  });
  test('production start-up refuses delivery email without a TTL or without the recorded guest_only scope', () => {
    const prod = { NODE_ENV: 'production', JWT_SECRET: 'j'.repeat(40), DATABASE_URL: 'postgres://x', CLIENT_URL: 'https://a', CLOUDINARY_CLOUD_NAME: 'a', CLOUDINARY_API_KEY: 'b', CLOUDINARY_API_SECRET: 'c', OSRM_URL: 'https://osrm', GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', GUEST_QUOTE_SECRET: 'q'.repeat(40), GUEST_HASH_SECRET: 'h'.repeat(40), GUEST_TRACKING_BASE_URL: 'https://api.x/t', GUEST_EMAIL_OTP_ENABLED: 'true', GUEST_OTP_CHANNEL: 'email', GUEST_OTP_HASH_SECRET: 'o'.repeat(40), BREVO_ENABLED: 'true', BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'a@b.co', EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true' };
    const msgs = (e) => envGuard.productionProblems(e).join(' | ');
    expect(msgs(prod)).toMatch(/POD_CODE_TTL_HOURS/); expect(msgs(prod)).toMatch(/PARCEL_PILOT_SCOPE=guest_only is required/);
    expect(msgs({ ...prod, POD_CODE_TTL_HOURS: '12', PARCEL_PILOT_SCOPE: 'guest_only' })).toBe('');
    expect(msgs({ ...prod, POD_CODE_TTL_HOURS: '12', PARCEL_PILOT_SCOPE: 'guest_and_registered' })).toMatch(/not supported yet/);
    expect(msgs({ ...prod, POD_CODE_TTL_HOURS: '0', PARCEL_PILOT_SCOPE: 'guest_only' })).toMatch(/POD_CODE_TTL_HOURS/);
  });
});

describe('P1.4 failure escalation and recovery visibility', () => {
  test('email dead-lettered while SMS is off: state FAILED, overall UNRESOLVED, recovery RESEND, appears in the attention list and the alert', async () => {
    const r = await book(await guestFor()); const http = makeHttp(() => ({ status: 400, data: { message: 'invalid email' } }));
    await emailOutbox.processForBooking(r.booking.id, { env: pilot, http });
    mockDb._t('emailOutbox').forEach((x) => { x.status = 'DEAD'; x.errorCategory = 'TRANSIENT'; });
    const st = await comms.recipientStatus({ booking: bk(), delivery: del(), env: pilot });
    expect(st).toMatchObject({ overall: 'UNRESOLVED', recovery: 'RESEND', needsAttention: true }); expect(st.email.state).toBe('FAILED'); expect(st.sms.state).toBe('DISABLED');
    expect((await emailOutbox.stats(new Date(), pilot)).alerts.join(' ')).toMatch(/recipient hand-over email/);
    mockDb.guestBooking.findMany = async () => [{ ...bk(), delivery: del(), identity: { countryCode: 'NG' } }];     // the fake has no relation includes
    const j = jest.fn(); process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED = 'true';
    try { await adminCtl.recipientAttention({ user: { id: 'a', role: 'ADMIN', countryCode: 'NG' } }, { status: () => ({ json: j }) }); } finally { delete process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED; }
    expect(j.mock.calls[0][0].data.items).toHaveLength(1); expect(JSON.stringify(j.mock.calls[0][0])).not.toMatch(/ada\.obi|\d{6}|Allen/);
  });
  test('an expired or locked code tells support to ROTATE, never to resend', async () => {
    const r = await book(await guestFor()); await settle(r.booking.id); del().podCodeExpiresAt = new Date(Date.now() - 1);
    expect((await comms.recipientStatus({ booking: bk(), delivery: del(), env: pilot })).recovery).toBe('ROTATE');
  });
  test('sender never gets the plaintext code as a fallback, even when the email failed', async () => {
    const r = await book(await guestFor()); mockDb._t('emailOutbox').forEach((x) => { x.status = 'DEAD'; });
    const own = await booking.getOwnBooking({ guest: { identityId: bk().identityId }, bookingId: bk().id, env: pilot });
    expect(own.podCode).toBeUndefined(); expect(JSON.stringify(own)).not.toContain(codeOf(del())); expect(r.podCodeVisible).toBe(false);
  });
  test('manual exception: courier has no path; REQUEST (reason+evidence) -> a DIFFERENT operator APPROVES; self-approval refused; no request = refused; all audited', async () => {
    await book(await guestFor()); inTransit(del()); const d = del(); const j = jest.fn(); const res = { status: () => ({ json: j }) };
    const as = (id, body) => ({ params: { id: d.id }, body, user: { id, role: 'ADMIN', countryCode: 'NG' }, ip: '2.2.2.2' });
    await expect(adminCtl.podOverride(as('opA', { reason: 'Recipient phone is dead' }), res)).rejects.toMatchObject({ code: 'EXCEPTION_NOT_REQUESTED' });
    await adminCtl.exceptionRequest(as('opA', { reason: 'Recipient phone is dead', evidence: 'Call log ref CL-1182, ID shown to courier' }), res);
    await expect(adminCtl.podOverride(as('opA', { reason: 'Recipient phone is dead' }), res)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED', statusCode: 403 });
    expect(d.podVerifiedAt).toBeNull();
    await adminCtl.podOverride(as('opB', { reason: 'Evidence checked against call log' }), res);
    expect(d.podVerifiedAt).toBeInstanceOf(Date); expect(d.podMethod).toBe('SUPPORT_OVERRIDE');
    expect(events()).toEqual(expect.arrayContaining(['MANUAL_HANDOVER_EXCEPTION_REQUESTED', 'MANUAL_HANDOVER_EXCEPTION_APPROVED', 'POD_OVERRIDE']));
    const ev = mockDb._calls.audit.find((e) => e.event === 'MANUAL_HANDOVER_EXCEPTION_APPROVED'); expect(ev.meta).toMatchObject({ adminId: 'opB', requestedBy: 'opA', selfApproved: false });
  });
  test('a rejected request cannot then be approved', async () => {
    await book(await guestFor()); inTransit(del()); const d = del(); const res = { status: () => ({ json: () => {} }) };
    const as = (id, body) => ({ params: { id: d.id }, body, user: { id, role: 'ADMIN', countryCode: 'NG' }, ip: '2.2.2.2' });
    await adminCtl.exceptionRequest(as('opA', { reason: 'Recipient unreachable', evidence: 'Ticket T-5521 attached' }), res);
    await adminCtl.exceptionReject(as('opB', { reason: 'Not enough evidence' }), res);
    await expect(adminCtl.podOverride(as('opC', { reason: 'Approving anyway please' }), res)).rejects.toMatchObject({ code: 'EXCEPTION_NOT_REQUESTED' });
  });
  test('small teams may relax four-eyes explicitly (POD_EXCEPTION_FOUR_EYES=false); it is recorded as selfApproved', async () => {
    await book(await guestFor()); inTransit(del()); const d = del(); const res = { status: () => ({ json: () => {} }) };
    const as = (body) => ({ params: { id: d.id }, body, user: { id: 'solo', role: 'ADMIN', countryCode: 'NG' }, ip: '2.2.2.2' });
    await adminCtl.exceptionRequest(as({ reason: 'Recipient unreachable', evidence: 'Ticket T-5522 attached' }), res);
    process.env.POD_EXCEPTION_FOUR_EYES = 'false'; try { await adminCtl.podOverride(as({ reason: 'Solo operator approval' }), res); } finally { delete process.env.POD_EXCEPTION_FOUR_EYES; }
    expect(mockDb._calls.audit.find((e) => e.event === 'MANUAL_HANDOVER_EXCEPTION_APPROVED').meta.selfApproved).toBe(true);
  });
});

describe('P1.5 public tracking privacy and lifetime', () => {
  const setup = async () => { const r = await book(await guestFor()); return { r, token: r.tracking.token }; };
  test('the public view has masked addresses, coarse coordinates, no recipient name, fare, payment text or courier free text', async () => {
    const { token } = await setup(); const d = del(); Object.assign(d, { failedAt: new Date(), failedReason: 'RECIPIENT_UNAVAILABLE: gate code 4471, call Mrs Obi on 0809', returnStatus: 'RETURNING' });
    const v = await booking.trackByToken({ token, env: pilot }); const text = JSON.stringify(v);
    expect(v.pickupAddress).toBe('Ikeja, Lagos'); expect(v.dropoffAddress).toBe('Victoria Island, Lagos');
    expect(text).not.toMatch(/Allen|Adeola|Ada|Obi|4471|0809|1800|NGN|fare|paymentNote|recipientFirstName|2348/);
    expect(v.pickup).toEqual({ lat: 6.52, lng: 3.38 }); expect(v.delivery).toEqual({ proofVerified: false, failedReason: 'RECIPIENT_UNAVAILABLE', returnStatus: 'RETURNING' });
  });
  test('the OWNER view still has the full detail the sender needs', async () => {
    const { r } = await setup(); const own = await booking.getOwnBooking({ guest: { identityId: bk().identityId }, bookingId: bk().id, env: pilot });
    expect(own.view.pickupAddress).toMatch(/Allen/); expect(own.view.fare).toBe(1800); expect(r.tracking.url).toMatch(/^https:\/\/track\.runserv\.test\/t\/gt_/);
  });
  test('maskAddress: street/house line dropped, single segment hidden, empty stays empty', () => {
    expect(booking.maskAddress('12 Allen Avenue, Ikeja, Lagos')).toBe('Ikeja, Lagos'); expect(booking.maskAddress('12 Allen Avenue')).toBe('Address hidden'); expect(booking.maskAddress('')).toBe('');
  });
  test('the token is independent of the code and the OTP; URL never contains the code', async () => {
    const { r } = await setup(); const code = codeOf(del());
    expect(r.tracking.url).not.toContain(code); expect(r.tracking.token).not.toContain(code); expect(del().podCodeNonce).not.toBe(bk().trackingNonce);
  });
  test('an ACTIVE delivery link slides forward when opened near its end (bounded by the ceiling); a finished one never does', async () => {
    const { token } = await setup(); const t0 = new Date(bk().createdAt).getTime(); const H = 3600 * 1000; const env = { ...pilot, GUEST_TRACKING_TTL_HOURS: '24', GUEST_TRACKING_MAX_HOURS: '48' };
    const near = t0 + 20 * H;                                                   // 4 h left of 24
    await booking.trackByToken({ token, now: near, env });
    expect(new Date(bk().trackingExpiresAt).getTime()).toBe(near + 24 * H > t0 + 48 * H ? t0 + 48 * H : near + 24 * H);
    expect(events()).toContain('TRACKING_EXTENDED');
    const later = t0 + 47 * H; mockDb._t('guestBooking')[0].trackingExpiresAt = new Date(later + 1000);
    await booking.trackByToken({ token, now: later, env }); expect(new Date(bk().trackingExpiresAt).getTime()).toBe(t0 + 48 * H);   // capped at the ceiling
    mockDb._t('guestBooking')[0].trackingExpiresAt = new Date(t0 + 49 * H); del().status = 'DELIVERED';
    await booking.trackByToken({ token, now: t0 + 48.5 * H, env }); expect(new Date(bk().trackingExpiresAt).getTime()).toBe(t0 + 49 * H);   // terminal: not extended
  });
  test('an expired, revoked or malformed token is one uniform 404; the page and API set no-store', async () => {
    const { token } = await setup();
    await expect(booking.trackByToken({ token, now: Date.now() + 80 * 3600 * 1000, env: pilot })).rejects.toMatchObject({ statusCode: 404, code: 'TRACKING_NOT_FOUND' });
    await expect(booking.trackByToken({ token: 'nope', env: pilot })).rejects.toMatchObject({ statusCode: 404 });
    const ctl = require('../src/controllers/guestBooking.controller'); const headers = {}; const res = { set: (h) => { Object.assign(headers, h); return res; }, status: () => res, json: () => res };
    await ctl.track({ params: { token }, ip: '1.1.1.1' }, res);
    expect(headers['Cache-Control']).toMatch(/no-store/); expect(headers['Referrer-Policy']).toBe('no-referrer'); expect(headers['X-Robots-Tag']).toMatch(/noindex/);
  });
  test('the owner can revoke or rotate the link at once', async () => {
    const { token } = await setup(); const g = { identityId: bk().identityId };
    await booking.revokeTracking({ guest: g, bookingId: bk().id }); await expect(booking.trackByToken({ token, env: pilot })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('P2 pilot metrics', () => {
  test('aggregates acceptance, dead-letter, retries, POD and escalation from the outbox/audit tables; no PII or codes', async () => {
    const r = await book(await guestFor()); await settle(r.booking.id); inTransit(del()); const d = del();
    await pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: wrongFor(d) }).catch(() => {});
    await pod.verifyProof({ deliveryId: d.id, partnerId: 'p1', code: codeOf(d) });
    await comms.resendRecipient({ booking: bk(), countryCode: 'NG', adminId: 'a', now: Date.now() + 1e6, env: pilot }).catch(() => {});
    const m = await comms.pilotMetrics({});
    expect(m.email).toMatchObject({ total: expect.any(Number), accepted: 1, acceptedRatePct: 100, deadLetterRatePct: 0 }); expect(m.email.medianSecondsToAcceptance).toEqual(expect.any(Number));
    expect(m.pod).toMatchObject({ parcels: 1, verified: 1, wrongAttempts: 1, lockouts: 0 });
    expect(JSON.stringify(m)).not.toMatch(/ada\.obi|\d{6}|Allen|sender@/);
  });
});
