'use strict';
// M16: durable SMS outbox for guest bookings (tracking link, recipient hand-over code).
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

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
const outbox = require('../src/services/smsOutbox.service');

const env = { JWT_SECRET: 'test-secret', GUEST_PLANNING_ENABLED: 'true', GUEST_BOOKING_ENABLED: 'true', ENABLE_SMS_DELIVERY: 'true', NODE_ENV: 'test', ENABLED_VEHICLE_CATEGORIES: 'CAR,MOTORCYCLE,VAN', GUEST_TRACKING_BASE_URL: 'https://track.runserv.test/t' };
const PICK = { latitude: 6.5244, longitude: 3.3792, address: '12 Allen Avenue, Ikeja', source: 'PLACE_SEARCH' };
const DEST = { latitude: 6.4281, longitude: 3.4219, address: 'Victoria Island, Lagos' };
const KEY = 'idem-key-0001';

const verified = async (phone = '+2348012345678') => {
  const sms = { send: jest.fn() };
  await identity.requestOtp({ phone, countryCode: 'NG', ip: '1.1.1.1', env, sms });
  const code = /(\d{6})/.exec(sms.send.mock.calls[0][1])[1];
  await identity.verifyOtp({ phone, countryCode: 'NG', code, env });
  const i = mockDb._t('guestIdentity').find((x) => x.phone === phone);
  return { identityId: i.id, userId: i.userId, phone: i.phone, countryCode: 'NG' };
};
const rideQuote = (over = {}, opts = {}) => guestQuote.signQuote({ service: 'RIDE', vehicleType: 'CAR', fare: 2500, currency: 'NGN', countryCode: 'NG', distanceM: 8000, durationS: 1200, pickup: PICK, destination: DEST, ...over }, { env, ...opts });
const parcelBody = { category: 'SMALL', weightKg: 2, longestSideCm: 30, description: 'Phone charger box', recipientName: 'Ada Obi', recipientPhone: '+2348098765432', acknowledgedProhibited: true };
const parcelQuote = (over = {}) => guestQuote.signQuote({ service: 'PARCEL', vehicleType: 'MOTORCYCLE', fare: 1800, currency: 'NGN', countryCode: 'NG', distanceM: 8000, durationS: 1200, pickup: PICK, destination: DEST, parcel: parcelBody, ...over }, { env });
const rideBody = (q = rideQuote(), over = {}) => ({ quote: q, pickup: PICK, destination: DEST, contactName: 'Tunde', ...over });
const create = (guest, body, over = {}) => booking.createBooking({ guest, idempotencyKey: KEY, body, ip: '2.2.2.2', env, dispatch: jest.fn(), ...over });


beforeEach(() => { mockDb = makeFakeGuestPrisma(); });
const rows = () => mockDb._t('smsOutbox');
const parcelBooking = async (guest) => create(guest, { quote: parcelQuote(), pickup: PICK, destination: DEST, contactName: 'Tunde', parcel: parcelBody });
const sender = () => ({ send: jest.fn(async () => ({})) });

describe('queueing (transactional)', () => {
  test('a ride queues one tracking SMS; a parcel also queues the recipient code', async () => {
    const g = await verified(); await create(g, rideBody());
    expect(rows().map((r) => r.kind)).toEqual(['GUEST_TRACKING']);
    mockDb = makeFakeGuestPrisma(); const g2 = await verified(); await parcelBooking(g2);
    expect(rows().map((r) => r.kind).sort()).toEqual(['GUEST_TRACKING', 'RECIPIENT_CODE']);
  });
  test('rows hold no message text, hand-over code or tracking token', async () => {
    const g = await verified(); const r = await parcelBooking(g);
    const dump = JSON.stringify(rows());
    expect(dump).not.toContain(r.tracking.token); expect(dump).not.toContain(r.podCode); expect(dump).not.toMatch(/Track it here|Give the courier/);
    rows().forEach((x) => expect(x.toMasked).toMatch(/\*\*\*\*/));
  });
  test('a booking that fails leaves NO queued SMS behind', async () => {
    const g = await verified(); await create(g, rideBody());
    const before = rows().length;
    await expect(create(g, rideBody(rideQuote({ }, { now: Date.now() })), { idempotencyKey: 'idem-key-0002' })).rejects.toMatchObject({ statusCode: 409 });   // second active booking is refused
    expect(rows()).toHaveLength(before);
  });
  test('nothing is queued when SMS delivery is off', async () => {
    const g = await verified(); await create(g, rideBody(), { env: { ...env, ENABLE_SMS_DELIVERY: 'false' } });
    expect(rows()).toHaveLength(0);
  });
  test('an undeliverable recipient number is recorded as DEAD at once, so support can see it', async () => {
    await outbox.enqueueTx(mockDb, { kind: 'RECIPIENT_CODE', bookingId: 'b1', phone: '12345', countryCode: 'NG', env });
    expect(rows()[0]).toMatchObject({ status: 'DEAD', toPhone: null }); expect(rows()[0].lastError).toMatch(/not valid/i);
  });
});

describe('delivery', () => {
  test('sends the tracking link to the guest and the code to the recipient, then drops the numbers', async () => {
    const g = await verified(); const r = await parcelBooking(g); const sms = sender();
    await outbox.processForBooking(r.booking.id, { env, sms });
    const sent = sms.send.mock.calls;
    expect(sent).toHaveLength(2);
    expect(sent.find(([to]) => to === g.phone)[1]).toContain(r.tracking.url);
    expect(sent.find(([to]) => to === '+2348098765432')[1]).toContain(r.podCode);
    expect(rows().every((x) => x.status === 'SENT' && x.toPhone === null && x.sentAt)).toBe(true);
  });
  test('the same row is never sent twice, even when workers race', async () => {
    const g = await verified(); await create(g, rideBody()); const sms = sender(); const id = rows()[0].id;
    await Promise.all([outbox.processEvent(id, { env, sms }), outbox.processEvent(id, { env, sms }), outbox.processEvent(id, { env, sms })]);
    expect(sms.send).toHaveBeenCalledTimes(1);
  });
  test('a provider failure is retried with back-off, then dead-lettered with the number kept for re-queue', async () => {
    const g = await verified(); await create(g, rideBody()); const sms = { send: jest.fn().mockRejectedValue(new Error('provider down')) };
    const id = rows()[0].id; let now = Date.now();
    let o = await outbox.processEvent(id, { env, sms, now: new Date(now) });
    expect(o).toEqual({ retry: true }); expect(rows()[0]).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'provider down' });
    expect(await outbox.processDue({ env, sms, now: new Date(now + 1000) })).toMatchObject({ processed: 0 });   // not due yet
    for (let i = 1; i < outbox.MAX_ATTEMPTS; i += 1) { now += 31 * 60 * 1000; o = await outbox.processEvent(id, { env, sms, now: new Date(now) }); }
    expect(o).toEqual({ dead: true }); expect(rows()[0]).toMatchObject({ status: 'DEAD', attempts: outbox.MAX_ATTEMPTS }); expect(rows()[0].toPhone).toBe(g.phone);
    expect((await outbox.stats()).alerts.join()).toMatch(/failed permanently/);
  });
  test('a retry that finally works completes normally', async () => {
    const g = await verified(); await create(g, rideBody());
    const sms = { send: jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue({}) }; const id = rows()[0].id; const now = Date.now();
    await outbox.processEvent(id, { env, sms, now: new Date(now) });
    await outbox.processEvent(id, { env, sms, now: new Date(now + 31 * 60 * 1000) });
    expect(rows()[0].status).toBe('SENT');
  });
  test('back-off grows and is capped', () => { expect(outbox.backoffMs(1)).toBe(30000); expect(outbox.backoffMs(2)).toBe(60000); expect(outbox.backoffMs(30)).toBe(30 * 60 * 1000); });
  test('a turned-off tracking link is never texted', async () => {
    const g = await verified(); await create(g, rideBody()); mockDb._t('guestBooking')[0].trackingRevokedAt = new Date(); const sms = sender();
    await outbox.processEvent(rows()[0].id, { env, sms });
    expect(sms.send).not.toHaveBeenCalled(); expect(rows()[0]).toMatchObject({ status: 'SKIPPED', toPhone: null });
  });
  test('the recipient code is not texted for a cancelled delivery', async () => {
    const g = await verified(); const r = await parcelBooking(g); mockDb._t('delivery')[0].status = 'CANCELLED'; const sms = sender();
    await outbox.processForBooking(r.booking.id, { env, sms });
    expect(sms.send.mock.calls.some(([to]) => to === '+2348098765432')).toBe(false);          // the recipient is not sent a code for a cancelled parcel
    expect(rows().find((x) => x.kind === 'RECIPIENT_CODE').status).toBe('SKIPPED');
  });
  test('switching SMS off later skips instead of failing', async () => {
    const g = await verified(); await create(g, rideBody()); const sms = sender();
    await outbox.processEvent(rows()[0].id, { env: { ...env, ENABLE_SMS_DELIVERY: 'false' }, sms });
    expect(sms.send).not.toHaveBeenCalled(); expect(rows()[0].status).toBe('SKIPPED');
  });
});

describe('support tooling and privacy', () => {
  const deadRow = async () => { const g = await verified(); await create(g, rideBody()); const sms = { send: jest.fn().mockRejectedValue(new Error('x')) }; let now = Date.now();
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i += 1) { await outbox.processEvent(rows()[0].id, { env, sms, now: new Date(now) }); now += 31 * 60 * 1000; } return rows()[0]; };
  test('Admin can re-queue a dead message, and it then sends', async () => {
    const r = await deadRow(); expect(r.status).toBe('DEAD');
    expect(await outbox.requeue(r.id)).toEqual({ requeued: true });
    const sms = sender(); await outbox.processEvent(r.id, { env, sms }); expect(sms.send).toHaveBeenCalledTimes(1); expect(rows()[0].status).toBe('SENT');
  });
  test('only dead messages can be re-queued', async () => {
    const g = await verified(); await create(g, rideBody());
    await expect(outbox.requeue(rows()[0].id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(outbox.requeue('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('dead rows lose the stored number after the retention window, and can no longer be re-queued', async () => {
    const r = await deadRow();
    expect(await outbox.scrubDead({ now: new Date(Date.now() + 5 * 86400000) })).toBe(0);
    expect(await outbox.scrubDead({ now: new Date(Date.now() + (outbox.SCRUB_DEAD_DAYS + 1) * 86400000) })).toBe(1);
    expect(rows()[0].toPhone).toBeNull();
    await expect(outbox.requeue(r.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  test('the guest sees delivery state only', async () => {
    const g = await verified(); const r = await parcelBooking(g); await outbox.processForBooking(r.booking.id, { env, sms: sender() });
    expect(await outbox.noticesFor(r.booking.id)).toEqual({ trackingSms: 'SENT', recipientSms: 'SENT' });
    expect(await outbox.noticesFor('other')).toEqual({ trackingSms: null, recipientSms: null });
  });
});
