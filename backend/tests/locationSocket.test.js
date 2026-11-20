'use strict';
// M10: the shared driver/courier live-location socket handler.
const mockDb = {
  user: { findUnique: jest.fn() },
  driverProfile: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  deliveryPartnerProfile: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ride: { findFirst: jest.fn(), findUnique: jest.fn() },
  delivery: { findFirst: jest.fn(), findUnique: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/services/notification.service', () => ({ setIO: jest.fn() }));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn() }));

const { initializeSocketHandlers } = require('../src/services/socket.service');
const T = require('../src/services/tracking.service');

const flush = () => new Promise((r) => setImmediate(r));
const consented = (o = {}) => ({ isApproved: true, isOnline: true, currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date(Date.now() - 10000),
  locationConsentAt: new Date(), locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null, ...o });

// A tiny fake of socket.io: records rooms joined and events emitted.
const connect = (role, userId = 'u-driver-0001') => {
  const handlers = {}; const rooms = new Set(); const emitted = []; const toEmits = [];
  const socket = {
    id: 's1', userId, userRole: role, userName: 'T T', handshake: {},
    use: jest.fn(), join: (r) => rooms.add(r), leave: (r) => rooms.delete(r),
    on: (e, h) => { handlers[e] = h; }, emit: (e, d) => emitted.push([e, d]), disconnect: jest.fn(),
  };
  const io = { use: jest.fn(), sockets: { sockets: new Map() }, to: (room) => ({ emit: (e, d) => toEmits.push([room, e, d]) }), on: (ev, cb) => { if (ev === 'connection') io._conn = cb; } };
  initializeSocketHandlers(io);
  io._conn(socket);
  return { handlers, rooms, emitted, toEmits };
};

beforeEach(() => { jest.clearAllMocks(); mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null); mockDb.ride.findFirst.mockResolvedValue(null); mockDb.delivery.findFirst.mockResolvedValue(null); });

describe('going online and reconnecting', () => {
  test('a courier going online joins the partner pool only with consent', async () => {
    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValue(consented({ isOnline: false, locationConsentAt: null, locationConsentVersion: null }));
    const c = connect('DELIVERY_PARTNER', 'u-courier-0001'); await flush();
    await c.handlers['partner:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(c.rooms.has('partners:online')).toBe(false);
    expect(c.emitted).toContainEqual(['location:rejected', expect.objectContaining({ reason: 'LOCATION_CONSENT_REQUIRED' })]);
    expect(mockDb.deliveryPartnerProfile.update).not.toHaveBeenCalled();

    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValueOnce(consented({ isOnline: false })).mockResolvedValue(consented());   // 2nd read = after the update
    await c.handlers['partner:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(c.rooms.has('partners:online')).toBe(true);
    expect(mockDb.deliveryPartnerProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isOnline: true, currentLat: 6.5 }) }));
  });
  test('a courier built with the driver:* names still works (either prefix, either role)', async () => {
    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValue(consented());
    const c = connect('DELIVERY_PARTNER', 'u-courier-0002'); await flush();
    c.rooms.clear();
    await c.handlers['driver:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(c.rooms.has('partners:online')).toBe(true);
  });
  test('reconnect does NOT rejoin the pool when consent is missing or on old wording', async () => {
    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValue(consented({ locationConsentVersion: 'old' }));
    const c = connect('DELIVERY_PARTNER', 'u-courier-0003'); await flush();
    expect(c.rooms.has('partners:online')).toBe(false);
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ locationConsentAt: null }));
    const d = connect('DRIVER', 'u-driver-0003'); await flush();
    expect(d.rooms.has('drivers:online')).toBe(false);
  });
  test('reconnect rejoins when online and consented', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    const d = connect('DRIVER', 'u-driver-0004'); await flush();
    expect(d.rooms.has('drivers:online')).toBe(true);
  });
  test('an unapproved driver cannot go online', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isApproved: false, isOnline: false }));
    const d = connect('DRIVER', 'u-driver-0005'); await flush();
    await d.handlers['driver:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
  });
  test('going offline leaves the pool and erases the stored position', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    const d = connect('DRIVER', 'u-driver-0006'); await flush();
    await d.handlers['driver:offline']();
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(mockDb.driverProfile.update).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: 'u-driver-0006', user: { driverRides: { none: { status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } } } } }), data: expect.objectContaining({ isOnline: false, currentLat: null, currentLng: null, lastLocationAt: null }) });
  });
  test('a customer socket has no live-location handlers doing anything', async () => {
    const c = connect('CUSTOMER', 'u-cust-0001'); await flush();
    await c.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
  });
});

describe('location pings', () => {
  test('a courier ping is stored and sent ONLY to the assigned customer, with heading and speed', async () => {
    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValue(consented());
    mockDb.delivery.findFirst.mockResolvedValue({ id: 'del-1', customerId: 'cust-9' });
    const c = connect('DELIVERY_PARTNER', 'u-courier-0010'); await flush();
    await c.handlers['driver:location']({ lat: 6.5, lng: 3.3, heading: 45, speed: 6, accuracy: 9 });   // old build name
    expect(mockDb.deliveryPartnerProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentLat: 6.5, locationHeading: 45, locationAccuracy: 9 }) }));
    expect(c.toEmits).toHaveLength(1);
    expect(c.toEmits[0][0]).toBe('user:cust-9');
    expect(c.toEmits[0][1]).toBe('partner:location:update');
    expect(c.toEmits[0][2]).toMatchObject({ deliveryId: 'del-1', lat: 6.5, lng: 3.3, heading: 45, speed: 6 });
  });
  test('a driver ping goes to the ride customer as driver:location:update', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    mockDb.ride.findFirst.mockResolvedValue({ id: 'ride-1', customerId: 'cust-1' });
    const d = connect('DRIVER', 'u-driver-0011'); await flush();
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3, heading: 10 });
    expect(d.toEmits[0].slice(0, 2)).toEqual(['user:cust-1', 'driver:location:update']);
  });
  test('without an active trip the ping is stored but broadcast to nobody', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    const d = connect('DRIVER', 'u-driver-0012'); await flush();
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(mockDb.driverProfile.update).toHaveBeenCalled(); expect(d.toEmits).toHaveLength(0);
  });
  test('no consent: nothing stored, nothing sent, left the pool', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ locationConsentAt: null }));
    mockDb.ride.findFirst.mockResolvedValue({ id: 'ride-1', customerId: 'cust-1' });
    const d = connect('DRIVER', 'u-driver-0013'); await flush();
    d.rooms.add('drivers:online');
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled(); expect(d.toEmits).toHaveLength(0);
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(d.emitted).toContainEqual(['location:rejected', expect.objectContaining({ reason: 'LOCATION_CONSENT_REQUIRED' })]);
  });
  test('offline profile: ping rejected', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isOnline: false }));
    const d = connect('DRIVER', 'u-driver-0014'); await flush();
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(d.emitted).toContainEqual(['location:rejected', { reason: 'NOT_ONLINE' }]);
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
  });
  test.each([[{ lat: 200, lng: 3 }, 'BAD_COORDS'], [{ lat: 6.5, lng: 3.3, accuracy: 500 }, 'LOW_ACCURACY'], [{ lat: 6.5, lng: 3.3, timestamp: Date.now() - 120000 }, 'STALE_PING']])('bad ping %j is rejected with %s', async (ping, reason) => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    mockDb.ride.findFirst.mockResolvedValue({ id: 'ride-1', customerId: 'cust-1' });
    const d = connect('DRIVER', 'u-driver-0015'); await flush();
    await d.handlers['driver:location'](ping);
    expect(d.emitted).toContainEqual(['location:rejected', { reason }]);
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled(); expect(d.toEmits).toHaveLength(0);
  });
  test('an impossible jump from the last stored fix is rejected', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date(Date.now() - 3000) }));
    const d = connect('DRIVER', 'u-driver-0016'); await flush();
    await d.handlers['driver:location']({ lat: 7.5, lng: 3.3 });
    expect(d.emitted).toContainEqual(['location:rejected', { reason: 'TOO_FAST' }]);
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
  });
});

// ── Guide §6 / §5.4: race-condition and eligibility regressions ─────────────────────────────────────────────────────
describe('M10 review fixes: approval, fix and atomic guards', () => {
  const P2025 = Object.assign(new Error('not found'), { code: 'P2025' });
  test('reconnect does NOT rejoin the dispatch pool when the profile is not approved', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isApproved: false }));
    const d = connect('DRIVER', 'u-driver-0101'); await flush();
    expect(d.rooms.has('drivers:online')).toBe(false);
  });
  test('reconnect does NOT rejoin without a fresh GPS fix (waiting for location)', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ currentLat: null, currentLng: null, lastLocationAt: null }));
    const d = connect('DRIVER', 'u-driver-0102'); await flush();
    expect(d.rooms.has('drivers:online')).toBe(false);
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ lastLocationAt: new Date(Date.now() - 5 * 60 * 1000) }));
    const e = connect('DRIVER', 'u-driver-0103'); await flush();
    expect(e.rooms.has('drivers:online')).toBe(false);
  });
  test('reconnect join-then-verify: consent withdrawn while joining leaves the room again', async () => {
    mockDb.driverProfile.findUnique
      .mockResolvedValueOnce(consented())                              // initial load: qualifies
      .mockResolvedValue(consented({ locationConsentRevokedAt: new Date(Date.now() + 1000) })); // re-check after join: withdrawn
    const d = connect('DRIVER', 'u-driver-0104'); await flush(); await flush();
    expect(d.rooms.has('drivers:online')).toBe(false);
  });
  test('going online with an invalid first fix keeps the driver OUT of the pool and stores nothing', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isOnline: false }));
    const d = connect('DRIVER', 'u-driver-0105'); await flush();
    for (const bad of [{}, { lat: 0, lng: 0 }, { lat: 6.5, lng: 3.3, accuracy: 900 }]) {
      d.emitted.length = 0;
      await d.handlers['driver:online'](bad);
      expect(d.rooms.has('drivers:online')).toBe(false);
      expect(d.emitted).toContainEqual(['location:rejected', expect.objectContaining({ reason: 'LOCATION_FIX_REQUIRED', detail: expect.any(String) })]);
    }
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
  });
  test('going online writes atomically: the WHERE carries approval and current-version consent', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isOnline: false }));
    const d = connect('DRIVER', 'u-driver-0106'); await flush();
    await d.handlers['driver:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    const where = mockDb.driverProfile.update.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: 'u-driver-0106', isApproved: true, locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null });
  });
  test('consent withdrawn between the check and the write: online is refused (P2025) and nobody joins', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isOnline: false }));
    mockDb.driverProfile.update.mockRejectedValueOnce(P2025);
    const d = connect('DRIVER', 'u-driver-0107'); await flush();
    await d.handlers['driver:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(d.emitted).toContainEqual(['location:rejected', expect.objectContaining({ reason: 'LOCATION_CONSENT_REQUIRED' })]);
  });
  test('a fleet driver whose vehicle is not dispatchable cannot go online by socket either', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ isOnline: false }));
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f', vehicleId: 'v', driver: { isActive: true, driverProfile: { isApproved: true, vehicleType: 'CAR', licenseNumber: 'x', licenseImageUrl: 'y' } },
      fleetPartner: { id: 'f', status: 'ACTIVE' }, vehicle: { id: 'v', fleetPartnerId: 'f', vehicleType: 'CAR', status: 'ACTIVE', isActive: true, documents: [] } });
    const d = connect('DRIVER', 'u-driver-0108'); await flush();
    await d.handlers['driver:online']({ lat: 6.5, lng: 3.3, accuracy: 12 });
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(mockDb.driverProfile.update).not.toHaveBeenCalled();
    expect(d.emitted).toContainEqual(['location:rejected', expect.objectContaining({ reason: 'FLEET_NOT_DISPATCHABLE' })]);
  });
  test('offline: when a trip was accepted a moment ago the atomic write matches nothing → ACTIVE_TRIP, still in the pool', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    mockDb.driverProfile.update.mockRejectedValueOnce(P2025);
    const d = connect('DRIVER', 'u-driver-0109'); await flush();
    d.rooms.add('drivers:online');
    await d.handlers['driver:offline']();
    expect(d.emitted).toContainEqual(['location:rejected', { reason: 'ACTIVE_TRIP' }]);
    expect(d.rooms.has('drivers:online')).toBe(true);
  });
  test('a ping that lands after consent withdrawal (P2025) is not stored and the socket leaves the pool', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    mockDb.driverProfile.update.mockRejectedValueOnce(P2025);
    const d = connect('DRIVER', 'u-driver-0110'); await flush();
    d.rooms.add('drivers:online');
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(d.rooms.has('drivers:online')).toBe(false);
    expect(d.toEmits).toHaveLength(0);
  });
  test('first valid ping after reconnect-without-fix joins the pool (WAITING_FOR_LOCATION → online)', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue(consented({ currentLat: null, currentLng: null, lastLocationAt: null }));
    const d = connect('DRIVER', 'u-driver-0111'); await flush();
    expect(d.rooms.has('drivers:online')).toBe(false);
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());       // after the ping is stored, the profile has a fresh fix
    await d.handlers['driver:location']({ lat: 6.5, lng: 3.3 });
    expect(d.rooms.has('drivers:online')).toBe(true);
  });
  test('disconnect clears stored coordinates only when no trip is in progress', async () => {
    jest.useFakeTimers();
    mockDb.driverProfile.findUnique.mockResolvedValue(consented());
    const handlers = {};
    const socket = { id: 's9', userId: 'u-driver-0112', userRole: 'DRIVER', userName: 'T', handshake: {}, use: jest.fn(), join: jest.fn(), leave: jest.fn(), on: (e, h) => { handlers[e] = h; }, emit: jest.fn(), disconnect: jest.fn() };
    const io = { use: jest.fn(), sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }), on: (ev, cb) => { if (ev === 'connection') io._conn = cb; } };
    initializeSocketHandlers(io); io._conn(socket);
    await handlers.disconnect('client namespace disconnect');
    const calls = mockDb.driverProfile.updateMany.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual({ where: { userId: 'u-driver-0112' }, data: { isOnline: false } });
    expect(calls[1].where).toMatchObject({ userId: 'u-driver-0112', user: { driverRides: { none: expect.anything() } } });
    expect(calls[1].data).toMatchObject({ currentLat: null, currentLng: null, lastLocationAt: null });
    jest.useRealTimers();
  });
});

describe('M12: accuracy policy for dispatch eligibility', () => {
  const tracking = require('../src/services/tracking.service');
  test('a fix without accuracy is fine for an in-trip ping but not for the initial go-online fix', () => {
    expect(tracking.validatePing({ lat: 6.5, lng: 3.3 }).ok).toBe(true);
    expect(tracking.validatePing({ lat: 6.5, lng: 3.3 }, null, Date.now(), { requireAccuracy: true })).toEqual({ ok: false, reason: 'ACCURACY_REQUIRED' });
    expect(tracking.validatePing({ lat: 6.5, lng: 3.3, accuracy: 12 }, null, Date.now(), { requireAccuracy: true }).ok).toBe(true);
    expect(tracking.validatePing({ lat: 6.5, lng: 3.3, accuracy: 400 }, null, Date.now(), { requireAccuracy: true }).reason).toBe('LOW_ACCURACY');
  });
});
