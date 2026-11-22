'use strict';
// M16.2: recipient hand-over code + tracking link as delivery communications (email-only pilot, dual-channel readiness).
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
const { env: emailEnv, makeHttp } = require('./helpers/emailEnv');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../src/utils/fareEngine', () => ({
  estimateFare: jest.fn(async () => ({ estimatedFare: 2500, baseFare: 500, distanceCharge: 1800, timeCharge: 150, bookingFee: 50, surgeMultiplier: 1, commissionRate: 0.2 })),
  calculateDeliveryFee: jest.fn(async () => ({ estimatedFee: 1800, baseFee: 500, distanceCharge: 1300, currency: 'NGN' })),
  getSettings: jest.fn(async () => ({ delivery: { platformCommission: 0.2 } })),
}));
process.env.JWT_SECRET = 'test-secret';
const identity = require('../src/services/guestIdentity.service');
const booking = require('../src/services/guestBooking.service');
const guestQuote = require('../src/services/guestQuote.service');
const comms = require('../src/services/deliveryComms.service');
const emailOutbox = require('../src/services/emailOutbox.service');
const podSvc = require('../src/services/podCode.service');
const smsOutbox = require('../src/services/smsOutbox.service');

// Pilot: email delivery ON, SMS delivery OFF, SMS OTP OFF.
const base = { ...emailEnv, GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', ENABLED_VEHICLE_CATEGORIES: 'CAR,MOTORCYCLE,VAN', GUEST_TRACKING_BASE_URL: 'https://track.runserv.test/t', GUEST_HASH_SECRET: 'hash-secret-for-tests-0123456789abcdef', GUEST_QUOTE_SECRET: 'quote-secret-for-tests-0123456789abcdef' };
const pilot = { ...base, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true', SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'false' };
const both = { ...base, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true', SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'true' };
const PICK = { latitude: 6.5244, longitude: 3.3792, address: '12 Allen Avenue, Ikeja', source: 'PLACE_SEARCH' };
const DEST = { latitude: 6.4281, longitude: 3.4219, address: 'Victoria Island, Lagos' };
const parcel = { category: 'SMALL', weightKg: 2, longestSideCm: 30, description: 'Phone charger box', recipientName: 'Ada Obi', recipientPhone: '+2348098765432', recipientEmail: 'Ada.Obi@Example.com', acknowledgedProhibited: true };
let n = 0;
const guestFor = async (env, email = 'sender@example.com') => {
  const i = await mockDb.guestIdentity.create({ data: { email, phone: null, contactPhone: '+2348012345678', countryCode: 'NG', verifiedChannel: 'EMAIL', userId: `u${++n}`, verifiedAt: new Date() } });
  await mockDb.user.create({ data: { id: i.userId, phone: `+23480000${n}`, email: null, firstName: 'G', lastName: 'U', password: 'x' } });
  return { identityId: i.id, userId: i.userId, phone: '+2348012345678', email, countryCode: 'NG' };
};
const q = (env, p = parcel) => guestQuote.signQuote({ service: 'PARCEL', vehicleType: 'MOTORCYCLE', fare: 1800, currency: 'NGN', countryCode: 'NG', distanceM: 8000, durationS: 1200, pickup: PICK, destination: DEST, parcel: p }, { env });
const book = (g, env, over = {}, key = 'idem-key-0001') => booking.createBooking({ guest: g, idempotencyKey: key, body: { quote: q(env, { ...parcel, ...over }), pickup: PICK, destination: DEST, contactName: 'Tunde', parcel: { ...parcel, ...over } }, ip: '2.2.2.2', env, dispatch: jest.fn() });
const emailRows = (kind) => mockDb._t('emailOutbox').filter((r) => !kind || r.kind === kind);
const sentText = (http, i = 0) => http.calls[i].body.textContent || http.calls[i].body.text;

let afterEachRestore = null;
beforeEach(() => { mockDb = makeFakeGuestPrisma(); });
afterEach(() => { if (afterEachRestore) { afterEachRestore(); afterEachRestore = null; } });

describe('recipient contact rules (guide §4)', () => {
  test('pilot (email on, SMS off): the recipient email is REQUIRED, with a clear coded error', async () => {
    const g = await guestFor(pilot);
    await expect(book(g, pilot, { recipientEmail: '' })).rejects.toMatchObject({ code: 'RECIPIENT_EMAIL_REQUIRED' });
    expect(mockDb._t('delivery')).toHaveLength(0); expect(emailRows()).toHaveLength(0);     // nothing half-created
  });
  test('a typed-but-invalid email is rejected on every configuration', async () => {
    const g = await guestFor(pilot);
    for (const bad of ['not-an-email', 'a@b', 'x@y.invalid', 'a b@c.com']) await expect(book(g, pilot, { recipientEmail: bad }, `k-${bad.length}-${Math.random()}`.slice(0, 20).padEnd(10, 'x'))).rejects.toMatchObject({ code: 'RECIPIENT_EMAIL_INVALID' });
  });
  test('email delivery off: the email is optional (legacy flow keeps working)', async () => {
    const off = { ...base }; const g = await guestFor(off);
    const r = await book(g, off, { recipientEmail: '' });
    expect(r.booking.service).toBe('PARCEL'); expect(emailRows()).toHaveLength(0);
  });
  test('email is normalised and stored on the delivery only (never in the outbox beyond the send window)', async () => {
    const g = await guestFor(pilot); await book(g, pilot);
    expect(mockDb._t('delivery')[0].recipientEmail).toBe('ada.obi@example.com');
    expect(emailRows('RECIPIENT_CODE')[0]).toMatchObject({ toEmail: 'ada.obi@example.com', toMasked: 'a******@example.com', status: 'PENDING' });
  });
});

describe('email-only pilot: queued with the booking, sent to the RECIPIENT', () => {
  test('one recipient email is queued in the booking transaction; SMS queues nothing and reports DISABLED, not failed', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot);
    expect(r.queued).toEqual({ recipientEmail: true, senderEmail: false, recipientSms: false, senderSms: false });
    expect(emailRows().map((x) => x.kind)).toEqual(['RECIPIENT_CODE']); expect(mockDb._t('smsOutbox')).toHaveLength(0);
    const b = mockDb._t('guestBooking')[0]; const d = mockDb._t('delivery')[0];
    const st = await comms.recipientStatus({ booking: b, delivery: d, env: pilot });
    expect(st.sms.state).toBe('DISABLED'); expect(st.email.state).toBe('QUEUED'); expect(st.overall).toBe('PENDING');
  });
  test('a booking that rolls back leaves no email behind', async () => {
    const g = await guestFor(pilot); await book(g, pilot);
    await expect(book(g, pilot, {}, 'idem-key-0002')).rejects.toMatchObject({ code: 'ACTIVE_BOOKING_EXISTS' });
    expect(emailRows()).toHaveLength(1);
  });
  test('the email carries the code and a live tracking link; the link holds no code; the provider key is not in the body', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot); const http = makeHttp();
    expect(await emailOutbox.processForBooking(r.booking.id, { env: pilot, http })).toEqual([{ done: true, provider: 'brevo' }]);
    const code = podSvc.codeFor(mockDb._t('delivery')[0], pilot);
    const text = sentText(http);
    expect(http.calls[0].body.to).toEqual([{ email: 'ada.obi@example.com' }]);                // to the RECIPIENT, not the sender
    expect(JSON.stringify(http.calls[0].body)).not.toContain('sender@example.com');
    expect(text).toContain(code); expect(text).toContain(r.tracking.url); expect(text).toMatch(/ONLY when you have the parcel/);
    expect(r.tracking.url).not.toContain(code);
    expect(JSON.stringify(http.calls[0].body)).not.toContain('brevo-key');
  });
  test('accepted is not delivered; the row keeps no address and no code; a webhook later says DELIVERED', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot); const http = makeHttp();
    await emailOutbox.processForBooking(r.booking.id, { env: pilot, http });
    const row = emailRows('RECIPIENT_CODE')[0]; const code = podSvc.codeFor(mockDb._t('delivery')[0], pilot);
    expect(row).toMatchObject({ status: 'SENT', toEmail: null, deliveryStatus: 'ACCEPTED' });
    expect(JSON.stringify(row)).not.toContain(code); expect(JSON.stringify(row)).not.toContain(r.tracking.token);
    const b = mockDb._t('guestBooking')[0]; const d = mockDb._t('delivery')[0];
    expect((await comms.recipientStatus({ booking: b, delivery: d, env: pilot })).email.state).toBe('ACCEPTED');
    await emailOutbox.applyDeliveryEvent('brevo', { eventKey: 'e1', messageId: row.providerMessageId, status: 'DELIVERED', event: 'delivered' });
    expect((await comms.recipientStatus({ booking: b, delivery: d, env: pilot })).email.state).toBe('DELIVERED');
  });
  test('audit trail: POD_CODE_CREATED, DELIVERY_NOTIFICATION_QUEUED, EMAIL_ACCEPTED: with no code, token, address or text in any of them', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot); await emailOutbox.processForBooking(r.booking.id, { env: pilot, http: makeHttp() });
    const ev = mockDb._calls.audit; const names = ev.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(['POD_CODE_CREATED', 'DELIVERY_NOTIFICATION_QUEUED', 'EMAIL_ACCEPTED']));
    const dump = JSON.stringify(ev); const code = podSvc.codeFor(mockDb._t('delivery')[0], pilot);
    expect(dump).not.toContain(code); expect(dump).not.toContain(r.tracking.token); expect(dump).not.toContain('ada.obi@example.com');
  });
  test('delivery email flag is independent of the OTP flag: OTP on + delivery off sends nothing', async () => {
    const e = { ...pilot, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true' }; const g = await guestFor(e); const r = await book(g, e);
    const http = makeHttp(); const off = { ...e, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'false' };
    expect(await emailOutbox.processForBooking(r.booking.id, { env: off, http })).toEqual([{ skipped: true }]); expect(http.post).not.toHaveBeenCalled();
    expect(emailRows('RECIPIENT_CODE')[0]).toMatchObject({ status: 'SKIPPED', toEmail: null });
  });
});

describe('the code goes to the recipient, not automatically to the sender (guide §2)', () => {
  test('pilot: the sender\'s response and later reads carry NO code', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot);
    expect(r.podCode).toBeUndefined(); expect(r.podCodeVisible).toBe(false);
    const again = await booking.getOwnBooking({ guest: g, bookingId: r.booking.id, env: pilot });
    expect(again.podCode).toBeUndefined();
  });
  test('email delivery off (legacy): the sender still sees the code', async () => {
    const off = { ...base }; const g = await guestFor(off); const r = await book(g, off, { recipientEmail: '' });
    expect(r.podCode).toMatch(/^\d{6}$/); expect(r.podCodeVisible).toBe(true);
  });
  test('POD_CODE_SENDER_VISIBLE=true is a deliberate opt-in', async () => {
    const e = { ...pilot, POD_CODE_SENDER_VISIBLE: 'true' }; const g = await guestFor(e); const r = await book(g, e);
    expect(r.podCode).toMatch(/^\d{6}$/);
  });
  test('the sender only learns notification STATES, never contact details', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot);
    const notices = await comms.senderNotices({ booking: mockDb._t('guestBooking')[0], delivery: mockDb._t('delivery')[0], env: pilot });
    expect(notices).toEqual({ recipientEmail: 'QUEUED', recipientSms: 'DISABLED', recipientOverall: 'PENDING' });
    expect(JSON.stringify(notices)).not.toMatch(/@|\+234/); expect(r).toBeTruthy();
  });
});

describe('dual channel (SMS on): independent, partial results are kept', () => {
  const sms = (fail) => ({ send: jest.fn(async () => { if (fail) throw new Error('sms down'); }) });
  test('both queued; email success does not suppress SMS and SMS success does not suppress email', async () => {
    const g = await guestFor(both); const r = await book(g, both); const http = makeHttp(); const s = sms(false);
    expect(r.queued).toMatchObject({ recipientEmail: true, recipientSms: true });
    await Promise.all([emailOutbox.processForBooking(r.booking.id, { env: both, http }), smsOutbox.processForBooking(r.booking.id, { env: both, sms: s })]);
    const st = await comms.recipientStatus({ booking: mockDb._t('guestBooking')[0], delivery: mockDb._t('delivery')[0], env: both });
    expect(st.email.state).toBe('ACCEPTED'); expect(st.sms.state).toBe('ACCEPTED'); expect(st.overall).toBe('OK');
    expect(s.send.mock.calls.find((c) => c[0] === '+2348098765432')[1]).toMatch(/Give the courier the code \d{6}/);
  });
  test('email succeeds, SMS fails: email stays ACCEPTED, SMS is RETRYING, overall OK; the sender-visible state is truthful', async () => {
    const g = await guestFor(both); const r = await book(g, both);
    await emailOutbox.processForBooking(r.booking.id, { env: both, http: makeHttp() }); await smsOutbox.processForBooking(r.booking.id, { env: both, sms: sms(true) });
    const st = await comms.recipientStatus({ booking: mockDb._t('guestBooking')[0], delivery: mockDb._t('delivery')[0], env: both });
    expect(st.email.state).toBe('ACCEPTED'); expect(st.sms.state).toBe('RETRYING'); expect(st.overall).toBe('OK');
  });
  test('SMS succeeds, email fails permanently: SMS stays ACCEPTED, email FAILED, partial flagged', async () => {
    const g = await guestFor(both); const r = await book(g, both);
    const http = makeHttp((p) => ({ status: 400, data: { message: 'invalid email address' } }));
    await emailOutbox.processForBooking(r.booking.id, { env: both, http }); await smsOutbox.processForBooking(r.booking.id, { env: both, sms: sms(false) });
    const st = await comms.recipientStatus({ booking: mockDb._t('guestBooking')[0], delivery: mockDb._t('delivery')[0], env: both });
    expect(st.sms.state).toBe('ACCEPTED'); expect(st.email.state).toBe('FAILED'); expect(st.partial).toBe(true); expect(st.overall).toBe('OK');
  });
  test('both channels fail: overall UNRESOLVED so operations act; never reported as sent', async () => {
    const g = await guestFor(both); const r = await book(g, both);
    const http = makeHttp(() => ({ status: 400, data: { message: 'invalid email address' } }));
    await emailOutbox.processForBooking(r.booking.id, { env: both, http });
    mockDb._t('smsOutbox').forEach((x) => { x.status = 'DEAD'; });
    const st = await comms.recipientStatus({ booking: mockDb._t('guestBooking')[0], delivery: mockDb._t('delivery')[0], env: both });
    expect(st.overall).toBe('UNRESOLVED'); expect(st.email.state).toBe('FAILED'); expect(st.sms.state).toBe('FAILED');
  });
  test('an email-only sender (no phone) never gets a dead SMS tracking row queued', async () => {
    const g = await guestFor(both); g.phone = null; const r = await book(g, both);
    expect(mockDb._t('smsOutbox').map((x) => x.kind)).toEqual(['RECIPIENT_CODE']); expect(r.queued.senderSms).toBe(false);
  });
});

describe('sender tracking email (optional)', () => {
  test('off by default; on = the SENDER gets a link-only email (no code)', async () => {
    const g = await guestFor(pilot); await book(g, pilot);
    expect(emailRows('GUEST_TRACKING')).toHaveLength(0);
    mockDb = makeFakeGuestPrisma(); const on = { ...pilot, SENDER_TRACKING_EMAIL_ENABLED: 'true' }; const g2 = await guestFor(on); const r = await book(g2, on);
    expect(emailRows('GUEST_TRACKING')[0]).toMatchObject({ toEmail: 'sender@example.com' });
    const http = makeHttp(); await emailOutbox.processForBooking(r.booking.id, { env: on, http });
    const toSender = http.calls.find((c) => c.body.to[0].email === 'sender@example.com');
    expect(sentText(http, http.calls.indexOf(toSender))).toContain(r.tracking.url);
    expect(sentText(http, http.calls.indexOf(toSender))).not.toMatch(/\b\d{6}\b/);
  });
});

describe('tracking link and message rules', () => {
  test('a revoked link is left out of the recipient email (the code still goes); a cancelled delivery sends nothing', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot); const http = makeHttp();
    await booking.revokeTracking({ guest: g, bookingId: r.booking.id, ip: '1.1.1.1' });
    await emailOutbox.processForBooking(r.booking.id, { env: pilot, http });
    expect(sentText(http)).not.toContain('track.runserv.test'); expect(sentText(http)).toMatch(/hand-over code is \d{6}/);
    // cancelled before sending
    mockDb = makeFakeGuestPrisma(); const g2 = await guestFor(pilot); const r2 = await book(g2, pilot); const h2 = makeHttp();
    mockDb._t('delivery')[0].status = 'CANCELLED';
    expect(await emailOutbox.processForBooking(r2.booking.id, { env: pilot, http: h2 })).toEqual([{ skipped: true }]); expect(h2.post).not.toHaveBeenCalled();
  });
  test('a provider timeout keeps the same job and the same code: no rotation, no duplicate row', async () => {
    const g = await guestFor(pilot); const r = await book(g, pilot); const http = makeHttp(() => ({ throw: 'ETIMEDOUT' }));
    const code = podSvc.codeFor(mockDb._t('delivery')[0], pilot);
    await emailOutbox.processForBooking(r.booking.id, { env: pilot, http });
    expect(emailRows('RECIPIENT_CODE')).toHaveLength(1); expect(emailRows('RECIPIENT_CODE')[0]).toMatchObject({ status: 'PENDING', slotHeld: true });
    expect(podSvc.codeFor(mockDb._t('delivery')[0], pilot)).toBe(code); expect(mockDb._t('delivery')[0].podCodeHash).toBe(booking.podHash(mockDb._t('delivery')[0].id, code, pilot));
  });
  test('the request fingerprint includes the recipient email: same key + different email is refused', async () => {
    const g = await guestFor(pilot); await book(g, pilot);
    await expect(book(g, pilot, { recipientEmail: 'someone.else@example.com' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });
});

describe('Admin resend: same code, cooldown, audited, never reveals', () => {
  const setup = async (env = pilot) => { const g = await guestFor(env); const r = await book(g, env); await emailOutbox.processForBooking(r.booking.id, { env, http: makeHttp() }); return { g, r, b: mockDb._t('guestBooking')[0] }; };
  test('queues a NEW email for the SAME code; the code hash is untouched; the action is audited', async () => {
    const { b } = await setup(); const d = mockDb._t('delivery')[0]; const hash = d.podCodeHash;
    const later = Date.now() + 10 * 60 * 1000;
    const out = await comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'admin1', ip: '3.3.3.3', now: later, env: pilot });
    expect(out.queued).toEqual({ email: true, sms: false });
    expect(emailRows('RECIPIENT_CODE')).toHaveLength(2); expect(mockDb._t('delivery')[0].podCodeHash).toBe(hash);
    const http = makeHttp(); await emailOutbox.processForBooking(b.id, { env: pilot, http });
    expect(sentText(http)).toContain(podSvc.codeFor(d, pilot));
    expect(mockDb._calls.audit.map((e) => e.event)).toContain('POD_CODE_RESENT');
    expect(JSON.stringify(out)).not.toMatch(/\d{6}/);
  });
  test('cooldown: a second resend straight after is refused with retry-after', async () => {
    const { b } = await setup();
    await comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', env: { ...pilot, RECIPIENT_RESEND_COOLDOWN_SECONDS: '0' } });   // first resend (no cooldown configured)
    mockDb._t('emailOutbox').forEach((x) => { x.status = 'SENT'; });                                                                    // ... delivered to the provider
    await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', env: pilot })).rejects.toMatchObject({ code: 'RESEND_COOLDOWN', retryAfterS: expect.any(Number) });
  });
  test('refused when the previous email is still in the queue, and right after the first send (cooldown from creation)', async () => {
    const g = await guestFor(pilot); await book(g, pilot); const b = mockDb._t('guestBooking')[0];
    await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', env: pilot })).rejects.toMatchObject({ code: 'RESEND_COOLDOWN' });
  });
  test('refused once the parcel is handed over, failed or cancelled; refused for rides and when every channel is off', async () => {
    const { b } = await setup(); const d = mockDb._t('delivery')[0]; const now = Date.now() + 60 * 60 * 1000;
    d.podVerifiedAt = new Date(); await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now, env: pilot })).rejects.toMatchObject({ code: 'NOT_RESENDABLE' });
    d.podVerifiedAt = null; await expect(comms.resendRecipient({ booking: b, countryCode: 'NG', adminId: 'a', now, env: { ...pilot, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'false' } })).rejects.toMatchObject({ code: 'CHANNELS_DISABLED' });
    await expect(comms.resendRecipient({ booking: { ...b, service: 'RIDE', deliveryId: null }, countryCode: 'NG', adminId: 'a', now, env: pilot })).rejects.toMatchObject({ code: 'NOT_A_PARCEL' });
  });
  test('Admin detail shows masked contacts, channel states, provider and reference: and never the code or the full address', async () => {
    const { b } = await setup();
    const ctl = require('../src/controllers/adminGuest.controller');
    const saved = process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED; process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED = 'true';   // loadDetail reads the live environment
    afterEachRestore = () => { if (saved === undefined) delete process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED; else process.env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED = saved; };
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(x) { this.body = x; return this; } };
    mockDb.guestBooking.findUnique = (orig => async (a) => { const row = await orig(a); return row && a.include ? { ...row, identity: mockDb._t('guestIdentity')[0], delivery: mockDb._t('delivery')[0], ride: null } : row; })(mockDb.guestBooking.findUnique);
    await ctl.detail({ params: { id: b.id }, user: { id: 'a', role: 'ADMIN' } }, res);
    const c = res.body.data.communications; const dump = JSON.stringify(res.body);
    expect(c.email).toMatchObject({ enabled: true, contact: 'a******@example.com', state: 'ACCEPTED', provider: 'brevo' }); expect(c.sms).toMatchObject({ enabled: false, state: 'DISABLED' });
    expect(c.email.providerMessageId).toBeTruthy();
    expect(dump).not.toContain('ada.obi@example.com'); expect(dump).not.toContain(booking.podCodeFor(mockDb._t('delivery')[0].id, pilot));
  });
});

describe('configuration', () => {
  test('channel flags are independent; SMS delivery falls back to the legacy flag only while the new one is unset', () => {
    expect(comms.channels({ EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'true' })).toEqual({ email: true, sms: false });
    expect(comms.channels({ SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'true' })).toEqual({ email: false, sms: true });
    expect(comms.channels({ ENABLE_SMS_DELIVERY: 'true' }).sms).toBe(true);
    expect(comms.channels({ ENABLE_SMS_DELIVERY: 'true', SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'false' }).sms).toBe(false);
    expect(comms.channels({ GUEST_EMAIL_OTP_ENABLED: 'true', GUEST_SMS_OTP_ENABLED: 'true' })).toEqual({ email: false, sms: false });   // OTP flags never switch delivery on
  });
  test('env guard: delivery email needs a provider; SMS delivery needs Termii; a missing recipient channel is only a warning', () => {
    const { guestProblems, productionWarnings } = require('../src/utils/envGuard');
    const prod = { ...pilot, NODE_ENV: 'production', GUEST_TRACKING_BASE_URL: 'https://x.example.com/t' };
    expect(guestProblems({ ...prod, BREVO_ENABLED: 'false', RESEND_ENABLED: 'false' }).join()).toMatch(/EMAIL_DELIVERY_NOTIFICATIONS_ENABLED/);
    expect(guestProblems({ ...prod, SMS_DELIVERY_NOTIFICATIONS_ENABLED: 'true' }).join()).toMatch(/TERMII/);
    expect(productionWarnings({ ...prod, EMAIL_DELIVERY_NOTIFICATIONS_ENABLED: 'false' }).join()).toMatch(/no recipient delivery channel/);
  });
});
