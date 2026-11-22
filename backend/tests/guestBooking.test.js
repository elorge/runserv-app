'use strict';
// Stages 3-5: confirmation (server-signed quote, idempotency, single-use), scoped tracking, cancel, account conversion.
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

describe('creating a ride booking', () => {
  test('uses the SERVER-signed fare (a client-sent fare is ignored), CASH only, on the guest\'s own user', async () => {
    const g = await verified(); const dispatch = jest.fn();
    const r = await create(g, { ...rideBody(), fare: 1, estimatedFare: 1, paymentMethod: 'WALLET' }, { dispatch });
    const ride = mockDb._t('ride')[0];
    expect(Number(ride.estimatedFare)).toBe(2500); expect(ride.paymentMethod).toBe('CASH'); expect(ride.customerId).toBe(g.userId);
    expect(ride.pickupSource).toBe('PLACE_SEARCH'); expect(ride.distance).toBeCloseTo(8);
    expect(r.booking).toMatchObject({ service: 'RIDE', fare: 2500, currency: 'NGN' }); expect(r.booking.reference).toMatch(/^RS-[A-HJ-NP-Z2-9]{6}$/);
    expect(r.replayed).toBe(false); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockDb._t('user').find((u) => u.id === g.userId).firstName).toBe('Tunde');            // what the driver sees
  });
  test('returns a tracking token that is not stored anywhere', async () => {
    const g = await verified(); const r = await create(g, rideBody());
    expect(r.tracking.token).toMatch(booking.TRACK_RE); expect(r.tracking.url).toBe(`https://track.runserv.test/t/${r.tracking.token}`);
    expect(JSON.stringify(mockDb._t('guestBooking'))).not.toContain(r.tracking.token);
  });
  test('stores the signed quote and the fare calculation trace for support', async () => {
    const g = await verified(); await create(g, rideBody());
    const snap = mockDb._t('guestBooking')[0].quoteSnapshot;
    expect(snap.quote.id).toMatch(/^gq_/); expect(snap.trace).toMatchObject({ kind: 'RIDE', rateCardFare: 2500, quotedFare: 2500, bookingFee: 50 });
  });
  test('dispatch failure does not undo the booking', async () => {
    const g = await verified();
    const r = await create(g, rideBody(), { dispatch: jest.fn().mockRejectedValue(new Error('socket down')) });
    expect(r.booking.id).toBeTruthy(); expect(mockDb._t('ride')).toHaveLength(1);
  });
  test('the flag gates everything', async () => {
    const g = await verified();
    await expect(create(g, rideBody(), { env: { ...env, GUEST_BOOKING_ENABLED: 'false' } })).rejects.toMatchObject({ code: 'GUEST_BOOKING_DISABLED', statusCode: 404 });
    await expect(create(g, rideBody(), { env: { ...env, GUEST_PLANNING_ENABLED: 'false' } })).rejects.toMatchObject({ code: 'GUEST_BOOKING_DISABLED' });
    expect(mockDb._t('ride')).toHaveLength(0);
  });
});

describe('quote revalidation', () => {
  test('expired quote → 410', async () => {
    const g = await verified(); const q = rideQuote({}, { now: Date.now() - 11 * 60 * 1000 });
    await expect(create(g, rideBody(q))).rejects.toMatchObject({ code: 'QUOTE_EXPIRED', statusCode: 410 });
  });
  test('tampered fare / forged signature / missing quote are refused', async () => {
    const g = await verified(); const q = rideQuote();
    await expect(create(g, rideBody({ ...q, fare: 100 }))).rejects.toMatchObject({ code: 'QUOTE_INVALID' });
    await expect(create(g, rideBody({ ...q, signature: 'ab'.repeat(32) }))).rejects.toMatchObject({ code: 'QUOTE_INVALID' });
    await expect(create(g, { pickup: PICK, destination: DEST })).rejects.toMatchObject({ code: 'QUOTE_REQUIRED' });
    expect(mockDb._t('ride')).toHaveLength(0);
  });
  test('a cheap quote cannot be reused for a different trip (bound to pickup/destination)', async () => {
    const g = await verified(); const q = rideQuote();
    await expect(create(g, rideBody(q, { destination: { ...DEST, latitude: 9.0765, longitude: 7.3986 } }))).rejects.toMatchObject({ code: 'QUOTE_LOCATION_MISMATCH', statusCode: 409 });
    await expect(create(g, rideBody(q, { pickup: { ...PICK, latitude: 6.6 } }))).rejects.toMatchObject({ code: 'QUOTE_LOCATION_MISMATCH' });
  });
  test('quote for another country than the verified number is refused', async () => {
    const g = await verified(); const q = rideQuote({ countryCode: 'GH', currency: 'GHS' });
    await expect(create(g, rideBody(q))).rejects.toMatchObject({ code: 'COUNTRY_MISMATCH' });
  });
  test('a vehicle category switched off since the quote is refused', async () => {
    const g = await verified();
    await expect(create(g, rideBody(rideQuote({ vehicleType: 'VAN' })), { env: { ...env, ENABLED_VEHICLE_CATEGORIES: 'CAR' } })).rejects.toMatchObject({ code: 'VEHICLE_UNAVAILABLE' });
  });
  test('addresses are required', async () => {
    const g = await verified();
    await expect(create(g, rideBody(rideQuote(), { pickup: { ...PICK, address: ' ' } }))).rejects.toMatchObject({ code: 'ADDRESS_REQUIRED' });
  });
  test('a quote can only ever be used once', async () => {
    const g = await verified(); const q = rideQuote();
    await create(g, rideBody(q));
    mockDb._t('ride')[0].status = 'COMPLETED';
    await expect(create(g, rideBody(q), { idempotencyKey: 'idem-key-0002' })).rejects.toMatchObject({ code: 'QUOTE_ALREADY_USED', statusCode: 409 });
    expect(mockDb._t('ride')).toHaveLength(1);
  });
});

describe('idempotency: double-tap, retry, restart', () => {
  test('same key + same request → the same booking, no second ride', async () => {
    const g = await verified(); const body = rideBody();
    const a = await create(g, body); const b = await create(g, body);
    expect(b.replayed).toBe(true); expect(b.booking.id).toBe(a.booking.id); expect(b.tracking.token).toBe(a.tracking.token);
    expect(mockDb._t('ride')).toHaveLength(1); expect(mockDb._t('guestBooking')).toHaveLength(1);
  });
  test('a retry after the quote expired still returns the original booking', async () => {
    const g = await verified(); const body = rideBody(); const a = await create(g, body);
    const b = await create(g, body, { now: Date.now() + 30 * 60 * 1000 });
    expect(b.replayed).toBe(true); expect(b.booking.id).toBe(a.booking.id);
  });
  test('same key with a DIFFERENT request is refused, not silently replayed', async () => {
    const g = await verified(); await create(g, rideBody());
    await expect(create(g, rideBody(rideQuote()))).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', statusCode: 409 });
  });
  test('a missing or malformed key is refused', async () => {
    const g = await verified();
    await expect(create(g, rideBody(), { idempotencyKey: undefined })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(create(g, rideBody(), { idempotencyKey: 'short' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
  test('two guests can use the same key independently', async () => {
    const a = await verified('+2348012345678'); const b = await verified('+2348022222222');
    await create(a, rideBody()); await create(b, rideBody(rideQuote()));
    expect(mockDb._t('ride')).toHaveLength(2);
  });
});

describe('abuse limits', () => {
  test('one active booking at a time', async () => {
    const g = await verified(); await create(g, rideBody());
    await expect(create(g, rideBody(rideQuote()), { idempotencyKey: 'idem-key-0002' })).rejects.toMatchObject({ code: 'ACTIVE_BOOKING_EXISTS', statusCode: 409 });
  });
  test('daily cap per number', async () => {
    const g = await verified();
    for (let i = 0; i < booking.CFG.MAX_BOOKINGS_PER_DAY; i += 1) {
      await create(g, rideBody(rideQuote()), { idempotencyKey: `idem-key-10${i}` });
      mockDb._t('ride').forEach((r) => { r.status = 'COMPLETED'; });
    }
    await expect(create(g, rideBody(rideQuote()), { idempotencyKey: 'idem-key-9999' })).rejects.toMatchObject({ code: 'GUEST_DAILY_LIMIT', statusCode: 429 });
    expect(mockDb._calls.audit.map((e) => e.event)).toContain('BOOKING_DAILY_LIMIT');
  });
});

describe('parcel booking', () => {
  const pbody = (over = {}, q = parcelQuote()) => ({ quote: q, pickup: PICK, destination: DEST, contactName: 'Tunde', parcel: { ...parcelBody, ...over } });

  test('creates a delivery with a hand-over code the sender can see and the DB cannot reveal', async () => {
    const g = await verified(); const r = await create(g, pbody());
    const d = mockDb._t('delivery')[0];
    expect(r.podCode).toMatch(/^\d{6}$/); expect(d.podCodeHash).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(d)).not.toContain(r.podCode);
    expect(d).toMatchObject({ paymentMethod: 'CASH', customerId: g.userId, dropoffContact: '+2348098765432', pickupContact: g.phone });
    expect(Number(d.estimatedFee)).toBe(1800); expect(d.packageDescription).toContain('Phone charger box');
    const again = await booking.getOwnBooking({ guest: g, bookingId: r.booking.id, env });
    expect(again.podCode).toBe(r.podCode);                                                       // re-derivable, not stored
  });
  test('prohibited-items acknowledgement, recipient and description are mandatory', async () => {
    const g = await verified();
    await expect(create(g, pbody({ acknowledgedProhibited: false }))).rejects.toMatchObject({ code: 'PROHIBITED_ACK_REQUIRED' });
    await expect(create(g, pbody({ recipientName: '' }))).rejects.toMatchObject({ code: 'RECIPIENT_NAME_REQUIRED' });
    await expect(create(g, pbody({ recipientPhone: '123' }))).rejects.toMatchObject({ code: 'RECIPIENT_PHONE_INVALID' });
    await expect(create(g, pbody({ description: 'x' }))).rejects.toMatchObject({ code: 'PARCEL_DESCRIPTION_REQUIRED' });
    expect(mockDb._t('delivery')).toHaveLength(0);
  });
  test('parcel details changed since the quote → new quote needed (weight drives the price)', async () => {
    const g = await verified();
    await expect(create(g, pbody({ weightKg: 9 }))).rejects.toMatchObject({ code: 'QUOTE_PARCEL_MISMATCH', statusCode: 409 });
  });
  test('an unsupported parcel/vehicle combination is blocked with an explanation', async () => {
    const g = await verified(); const heavy = { ...parcelBody, weightKg: 25 };
    const q = guestQuote.signQuote({ service: 'PARCEL', vehicleType: 'MOTORCYCLE', fare: 1800, currency: 'NGN', countryCode: 'NG', distanceM: 8000, durationS: 1200, pickup: PICK, destination: DEST, parcel: heavy }, { env });
    await expect(create(g, { quote: q, pickup: PICK, destination: DEST, parcel: heavy })).rejects.toMatchObject({ code: 'PARCEL_TOO_HEAVY', statusCode: 422 });
  });
  test('dispatch is called WITHOUT contact numbers in what gets broadcast', async () => {
    const { _test } = require('../src/controllers/guestBooking.controller');
    const emit = jest.fn(); const io = { to: jest.fn(() => ({ emit })) };
    const q = parcelQuote();
    await _test.dispatch({ io, service: 'PARCEL', deliveryId: 'd1', contactName: 'Tunde', pickup: PICK, destination: DEST, q, parcel: { category: 'SMALL', description: 'box', weightKg: 2 }, trace: null });
    expect(io.to).toHaveBeenCalledWith('partners:online');
    const payload = emit.mock.calls[0][1];
    expect(JSON.stringify(payload)).not.toMatch(/\+234|pickupContact|dropoffContact|phone/i); expect(payload.proofOfDeliveryRequired).toBe(true);
  });
});

describe('tracking: scoped, expiring, revocable, personal-data-free', () => {
  const setup = async () => { const g = await verified(); const r = await create(g, rideBody()); return { g, r, token: r.tracking.token }; };

  test('the public view has the booking status and NO phone, email, ids of people, or fare internals', async () => {
    const { token } = await setup();
    const v = await booking.trackByToken({ token, ip: '3.3.3.3', env });
    expect(v).toMatchObject({ service: 'RIDE', status: 'FINDING_DRIVER', cancellable: false, earner: null });
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/\+234|@|guest-|userId|customerId|driverId|identity|phone|email|trackingNonce|quoteSnapshot/i);
  });
  test('after assignment: first name, vehicle and a rounded, fresh position only', async () => {
    const { token } = await setup();
    const ride = mockDb._t('ride')[0]; ride.status = 'ACCEPTED'; ride.driverId = 'drv1';
    mockDb._t('user').push({ id: 'drv1', firstName: 'Emeka', lastName: 'Private', phone: '+2348000000001', email: 'emeka@x.com' });
    mockDb._t('driverProfile').push({ userId: 'drv1', vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehicleColor: 'Silver', vehiclePlate: 'LSR-123AB', rating: 4.8, currentLat: 6.524412345, currentLng: 3.379298765, lastLocationAt: new Date() });
    const v = await booking.trackByToken({ token, env });
    expect(v.status).toBe('DRIVER_ASSIGNED'); expect(v.cancellable).toBe(false);
    expect(v.earner).toMatchObject({ firstName: 'Emeka', vehicle: { plate: 'LSR-123AB', color: 'Silver' }, location: { lat: 6.524, lng: 3.379 } });
    expect(JSON.stringify(v)).not.toMatch(/Private|\+2348000000001|emeka@x\.com/);
  });
  test('a stale driver position is not shown as live', async () => {
    const { token } = await setup();
    const ride = mockDb._t('ride')[0]; ride.status = 'ACCEPTED'; ride.driverId = 'drv1';
    mockDb._t('user').push({ id: 'drv1', firstName: 'Emeka' });
    mockDb._t('driverProfile').push({ userId: 'drv1', vehicleMake: 'T', vehicleModel: 'C', vehicleColor: 'S', vehiclePlate: 'P', currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date(Date.now() - 10 * 60 * 1000) });
    expect((await booking.trackByToken({ token, env })).earner.location).toBeNull();
  });
  test('malformed, unknown, expired and revoked tokens all get the SAME not-found', async () => {
    const { g, r, token } = await setup();
    const bad = async (t, now) => booking.trackByToken({ token: t, env, now }).catch((e) => e);
    const e1 = await bad('nope'); const e2 = await bad(`gt_${'A'.repeat(43)}`); const e3 = await bad(token, Date.now() + 25 * 60 * 60 * 1000);
    await booking.revokeTracking({ guest: g, bookingId: r.booking.id }); const e4 = await bad(token);
    for (const e of [e1, e2, e3, e4]) expect(e).toMatchObject({ code: 'TRACKING_NOT_FOUND', statusCode: 404, message: e1.message });
  });
  test('rotating the link kills the old one at once and issues a new one', async () => {
    const { g, r, token } = await setup();
    const n = await booking.rotateTracking({ guest: g, bookingId: r.booking.id, env });
    expect(n.tracking.token).not.toBe(token);
    await expect(booking.trackByToken({ token, env })).rejects.toMatchObject({ code: 'TRACKING_NOT_FOUND' });
    await expect(booking.trackByToken({ token: n.tracking.token, env })).resolves.toMatchObject({ service: 'RIDE' });
  });
  test('another guest cannot read, cancel, rotate or revoke this booking (changing an id gets a 404)', async () => {
    const { r } = await setup(); const other = await verified('+2348033333333');
    for (const fn of [
      () => booking.getOwnBooking({ guest: other, bookingId: r.booking.id, env }),
      () => booking.cancelBooking({ guest: other, bookingId: r.booking.id }),
      () => booking.rotateTracking({ guest: other, bookingId: r.booking.id, env }),
      () => booking.revokeTracking({ guest: other, bookingId: r.booking.id }),
    ]) await expect(fn()).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(await booking.listOwnBookings({ guest: other, env })).toEqual([]);
  });
  test('access is audited, but a poll does not write a row every time', async () => {
    const { token } = await setup();
    for (let i = 0; i < 5; i += 1) await booking.trackByToken({ token, env });
    expect(mockDb._calls.audit.filter((e) => e.event === 'TRACKING_VIEWED')).toHaveLength(1);
  });
});

describe('cancel', () => {
  test('before assignment: cancelled and audited', async () => {
    const g = await verified(); const r = await create(g, rideBody());
    const c = await booking.cancelBooking({ guest: g, bookingId: r.booking.id, reason: 'changed my mind' });
    expect(c.cancelled).toBe(true); expect(mockDb._t('ride')[0]).toMatchObject({ status: 'CANCELLED', cancellationReason: 'changed my mind' });
    expect(mockDb._calls.audit.map((e) => e.event)).toContain('BOOKING_CANCELLED');
  });
  test('after a driver accepted: refused, pointed to support with the reference', async () => {
    const g = await verified(); const r = await create(g, rideBody()); mockDb._t('ride')[0].status = 'ACCEPTED';
    await expect(booking.cancelBooking({ guest: g, bookingId: r.booking.id })).rejects.toMatchObject({ code: 'NOT_CANCELLABLE', statusCode: 409, reference: r.booking.reference });
    expect(mockDb._t('ride')[0].status).toBe('ACCEPTED');
  });
  test('a parcel can be cancelled while still PENDING', async () => {
    const g = await verified();
    const r = await create(g, { quote: parcelQuote(), pickup: PICK, destination: DEST, parcel: parcelBody });
    await expect(booking.cancelBooking({ guest: g, bookingId: r.booking.id })).resolves.toMatchObject({ cancelled: true });
  });
});

describe('account conversion', () => {
  const conv = (g, over = {}) => booking.convertToAccount({ guest: g, email: 'Tunde@Example.com', password: 'S3cure-pass!', firstName: 'Tunde', lastName: 'Ade', env, ...over });

  test('upgrades the SAME user (past bookings follow), revokes guest sessions, sets a real password', async () => {
    const g = await verified(); const r = await create(g, rideBody());
    const out = await conv(g);
    const u = mockDb._t('user').find((x) => x.id === g.userId);
    expect(u).toMatchObject({ authProvider: 'PASSWORD', email: 'tunde@example.com', firstName: 'Tunde' });
    expect(u.password).toMatch(/^\$2[aby]\$/); expect(u.password).not.toContain('S3cure');
    expect(mockDb._t('ride')[0].customerId).toBe(g.userId);
    expect(mockDb._t('guestIdentity')[0].convertedAt).toBeTruthy();
    expect(mockDb._t('guestSession').every((s) => s.revokedAt)).toBe(true);
    expect(out.user.id).toBe(g.userId); expect(r.booking.id).toBeTruthy();
  });
  test('weak password, bad email, and an email already taken are refused', async () => {
    const g = await verified();
    await expect(conv(g, { password: 'short' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(conv(g, { email: 'nope' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(conv(g, { email: 'x@guest.runserv.invalid' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    mockDb._t('user').push({ id: 'other', email: 'tunde@example.com', phone: '+2348055555555' });
    await expect(conv(g)).rejects.toMatchObject({ code: 'EMAIL_TAKEN', statusCode: 409 });
    expect(mockDb._t('user').find((x) => x.id === g.userId).authProvider).toBe('GUEST');
  });
  test('cannot be converted twice', async () => {
    const g = await verified(); await conv(g);
    await expect(conv(g, { email: 'again@example.com' })).rejects.toMatchObject({ code: 'ALREADY_CONVERTED' });
  });
  test('after conversion the number is a registered account: guests cannot verify it again', async () => {
    const g = await verified(); await conv(g);
    await expect(identity.requestOtp({ phone: g.phone, countryCode: 'NG', env, sms: { send: jest.fn() } })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });
});
