'use strict';
const mockDb = {
  fleetDriverAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  ride: { findMany: jest.fn() },
  delivery: { findMany: jest.fn() },
  fleetTrip: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
const svc = require('../src/services/fleetTripReconcile.service');
const fleetSvc = require('../src/services/fleet.service');

const A = (o = {}) => ({ id: 'a1', fleetPartnerId: 'f1', vehicleId: 'v1', driverUserId: 'd1', startsAt: '2026-11-01T00:00:00Z', endsAt: null, ...o });
const ride = (id, o = {}) => ({ id, driverId: 'd1', actualFare: '1000.00', currency: 'NGN', completedAt: '2026-11-18T10:00:00Z', ...o });
const W = { since: '2026-11-18T00:00:00Z', until: '2026-11-19T00:00:00Z' };
beforeEach(() => { jest.clearAllMocks(); mockDb.activityLog.create.mockResolvedValue({}); mockDb.delivery.findMany.mockResolvedValue([]); });

describe('findMissingFleetTrips', () => {
  test('reports a completed fleet ride with no FleetTrip as missing, and a recorded one as fine', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([ride('r1'), ride('r2')]);
    mockDb.fleetTrip.findMany.mockResolvedValue([{ id: 't1', rideId: 'r1', deliveryId: null, fareAmount: '1000.00', fleetPartnerId: 'f1' }]);
    const r = await svc.findMissingFleetTrips(W);
    expect(r.missing.map((m) => m.rideId)).toEqual(['r2']);
    expect(r.missing[0]).toMatchObject({ fleetPartnerId: 'f1', vehicleId: 'v1', serviceType: 'RIDE' });
    expect(r.amountMismatch).toEqual([]); expect(r.checked).toBe(2);
  });
  test('flags an amount mismatch (minor-unit comparison, so 1000 === 1000.00)', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([ride('r1'), ride('r2', { actualFare: '2500.00' })]);
    mockDb.fleetTrip.findMany.mockResolvedValue([
      { id: 't1', rideId: 'r1', fareAmount: 1000, fleetPartnerId: 'f1' },
      { id: 't2', rideId: 'r2', fareAmount: '2400.00', fleetPartnerId: 'f1' }]);
    const r = await svc.findMissingFleetTrips(W);
    expect(r.missing).toEqual([]);
    expect(r.amountMismatch).toEqual([expect.objectContaining({ fleetTripId: 't2', recordedFare: '2400.00', actualFare: '2500.00' })]);
  });
  test('a trip completed BEFORE the assignment started, or after it ended, is not a fleet trip', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A({ startsAt: '2026-11-18T12:00:00Z', endsAt: '2026-11-18T18:00:00Z' })]);
    mockDb.ride.findMany.mockResolvedValue([ride('early', { completedAt: '2026-11-18T10:00:00Z' }), ride('in', { completedAt: '2026-11-18T13:00:00Z' }), ride('late', { completedAt: '2026-11-18T19:00:00Z' })]);
    mockDb.fleetTrip.findMany.mockResolvedValue([]);
    expect((await svc.findMissingFleetTrips(W)).missing.map((m) => m.rideId)).toEqual(['in']);
  });
  test('deliveries are reconciled too; no fleet drivers means no queries on rides', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([]);
    mockDb.delivery.findMany.mockResolvedValue([{ id: 'del1', partnerId: 'd1', actualFee: '500.00', currency: 'NGN', deliveredAt: '2026-11-18T11:00:00Z' }]);
    mockDb.fleetTrip.findMany.mockResolvedValue([]);
    expect((await svc.findMissingFleetTrips(W)).missing[0]).toMatchObject({ serviceType: 'DELIVERY', deliveryId: 'del1' });
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([]); mockDb.ride.findMany.mockClear();
    expect((await svc.findMissingFleetTrips(W)).missing).toEqual([]); expect(mockDb.ride.findMany).not.toHaveBeenCalled();
  });
  test('bad or oversized windows are refused', async () => {
    await expect(svc.findMissingFleetTrips({ since: '2026-11-19', until: '2026-11-18' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.findMissingFleetTrips({ since: '2026-01-01', until: '2026-11-18' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('repairMissingFleetTrips', () => {
  beforeEach(() => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([ride('r1'), ride('r2')]);
    mockDb.fleetTrip.findMany.mockResolvedValue([]);
  });
  test('re-records each missing trip as-of its completion time, audits the run, and survives one failure', async () => {
    const record = jest.fn().mockResolvedValueOnce({ id: 't' }).mockRejectedValueOnce(new Error('db down'));
    const r = await svc.repairMissingFleetTrips({ ...W, actor: 'admin1', record });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rideId: 'r1', driverUserId: 'd1', asOf: '2026-11-18T10:00:00Z' }));
    expect(r).toMatchObject({ repaired: 1, failed: [expect.objectContaining({ rideId: 'r2', error: 'db down' })] });
    expect(mockDb.activityLog.create).toHaveBeenCalled();
  });
  test('recordFleetTrip with asOf finds the assignment that covered that moment (even if since ended) and stays idempotent', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue(null);
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([{ fleetPartnerId: 'f1', vehicleId: 'v1', fleetPartner: { commissionRate: '0.15', currency: 'NGN' } }]);
    mockDb.fleetTrip.create.mockImplementation(async ({ data }) => data);
    const t = await fleetSvc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd1', fare: 10000, asOf: '2026-11-18T10:00:00Z' });
    expect(t).toMatchObject({ fleetPartnerId: 'f1', platformFeeAmount: 1500, fleetNetAmount: 8500 });
    const q = mockDb.fleetDriverAssignment.findMany.mock.calls[0][0];
    expect(q.where.status).toBeUndefined(); expect(q.where.startsAt).toEqual({ lte: new Date('2026-11-18T10:00:00Z') });
    mockDb.fleetTrip.findFirst.mockResolvedValue({ id: 'exists' });
    await expect(fleetSvc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd1', fare: 10000, asOf: '2026-11-18T10:00:00Z' })).resolves.toEqual({ id: 'exists' });
  });
  test('M13: repair refuses to guess when overlapping assignments conflict (different vehicle)', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue(null);
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([
      { id: 'a', fleetPartnerId: 'f1', vehicleId: 'v1', fleetPartner: { commissionRate: '0.15' } },
      { id: 'b', fleetPartnerId: 'f1', vehicleId: 'v2', fleetPartner: { commissionRate: '0.15' } }]);
    expect(await fleetSvc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r9', driverUserId: 'd1', fare: 1000, asOf: '2026-11-18T10:00:00Z' })).toBeNull();
    expect(mockDb.fleetTrip.create).not.toHaveBeenCalled();
  });
  test('assignmentAt picks only the covering assignment for that driver', () => {
    const list = [A({ id: 'x', driverUserId: 'other' }), A({ id: 'old', endsAt: '2026-11-10T00:00:00Z' }), A({ id: 'cur', startsAt: '2026-11-11T00:00:00Z' })];
    expect(svc.assignmentAt(list, 'd1', '2026-11-18T10:00:00Z').id).toBe('cur');
    expect(svc.assignmentAt(list, 'd1', '2026-10-01T00:00:00Z')).toBeNull();
  });
});

describe('M12 hardening', () => {
  test('an invalid date is a 400, not a 500 from Prisma', () => {
    expect(() => svc.parseWindow({ since: 'not-a-date', until: '2026-11-19T00:00:00Z' })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => svc.parseWindow({ since: '2026-11-18T00:00:00Z', until: 'nope' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  test('assignmentAt is deterministic (latest start wins) and flags overlapping assignments of different fleets', () => {
    const a1 = A({ id: 'a1', startsAt: '2026-11-01T00:00:00Z' });
    const a2 = A({ id: 'a2', fleetPartnerId: 'f2', startsAt: '2026-11-10T00:00:00Z' });
    const r = svc.assignmentAt([a1, a2], 'd1', '2026-11-18T10:00:00Z');
    expect(r).toMatchObject({ id: 'a2', fleetPartnerId: 'f2', ambiguous: true });
    expect(svc.assignmentAt([a2, a1], 'd1', '2026-11-18T10:00:00Z').id).toBe('a2');                 // input order irrelevant
    const sameFleet = svc.assignmentAt([a1, A({ id: 'a3', startsAt: '2026-11-05T00:00:00Z' })], 'd1', '2026-11-18T10:00:00Z');
    expect(sameFleet.ambiguous).toBe(false);                                                         // same fleet: no money risk
    expect(svc.assignmentAt([a1], 'dX', '2026-11-18T10:00:00Z')).toBeNull();
  });
  test('ambiguous trips are reported, never auto-repaired', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A({ id: 'a1' }), A({ id: 'a2', fleetPartnerId: 'f2', startsAt: '2026-11-10T00:00:00Z' })]);
    mockDb.ride.findMany.mockResolvedValue([ride('r1')]); mockDb.fleetTrip.findMany.mockResolvedValue([]);
    const r = await svc.findMissingFleetTrips(W);
    expect(r.missing).toEqual([]); expect(r.ambiguous).toHaveLength(1);
  });
  test('hitting the row limit is reported as truncated with a cursor, and rows past the cut are not half-scanned', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([
      ride('r1', { completedAt: '2026-11-18T01:00:00Z' }), ride('r2', { completedAt: '2026-11-18T02:00:00Z' }), ride('r3', { completedAt: '2026-11-18T03:00:00Z' })]);
    mockDb.fleetTrip.findMany.mockResolvedValue([]);
    const r = await svc.findMissingFleetTrips({ ...W, limit: 2 });
    expect(r.truncated).toBe(true);
    expect(r.scanned.rides).toBe(2);
    expect(new Date(r.nextSince).toISOString()).toBe('2026-11-18T02:00:00.000Z');
    expect(r.missing.map((m) => m.rideId)).toEqual(['r1', 'r2']);
  });
  test('a complete scan says so', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]); mockDb.ride.findMany.mockResolvedValue([ride('r1')]); mockDb.fleetTrip.findMany.mockResolvedValue([]);
    const r = await svc.findMissingFleetTrips(W);
    expect(r.truncated).toBe(false); expect(r.nextSince).toBeNull();
  });
  test('currency / fleet / vehicle / service-type drift is reported', async () => {
    mockDb.fleetDriverAssignment.findMany.mockResolvedValue([A()]);
    mockDb.ride.findMany.mockResolvedValue([ride('r1')]);
    mockDb.fleetTrip.findMany.mockResolvedValue([{ id: 't1', rideId: 'r1', deliveryId: null, fareAmount: '1000.00', fleetPartnerId: 'f9', vehicleId: 'v1', serviceType: 'RIDE', currency: 'GHS' }]);
    const r = await svc.findMissingFleetTrips(W);
    expect(r.fieldMismatch[0].diffs.map((d) => d.field).sort()).toEqual(['currency', 'fleetPartnerId']);
  });
});
