'use strict';
const mockDb = {
  user: { findUnique: jest.fn() },
  fleetVehicle: { findFirst: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  fleetTrip: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  fleetPartner: { findUnique: jest.fn() },
  fleetSettlement: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
};
mockDb.$transaction = jest.fn(async (fn) => fn(mockDb));
mockDb.$executeRaw = jest.fn().mockResolvedValue(1);
jest.mock('../src/lib/prisma', () => mockDb);
const svc = require('../src/services/fleet.service');

const FLEET = { id: 'fleet-aaaaaa', status: 'ACTIVE', verificationStatus: 'VERIFIED', commissionRate: '0.150000', currency: 'NGN' };
// Dispatch is decided from approved document RECORDS (guide §3.2), not from typed expiry columns.
const doc = (type, o = {}) => ({ id: `doc-${type}`, vehicleId: 'veh1', documentType: type, isApproved: true, verifiedAt: new Date('2026-01-01'), rejectionNote: null, expiresAt: '2099-01-01', ...o });
const GOOD_VEHICLE = { id: 'veh1', fleetPartnerId: 'fleet-aaaaaa', vehicleType: 'CAR', status: 'ACTIVE', isActive: true, documents: [doc('insurance'), doc('roadworthy')] };
const GOOD_PROFILE = { isApproved: true, isRejected: false, vehicleType: 'CAR', licenseNumber: 'LIC-1', licenseImageUrl: 'https://x/lic.jpg' };
const APPROVED_DRIVER = { id: 'drv1', isActive: true, driverProfile: GOOD_PROFILE };
beforeEach(() => { jest.clearAllMocks(); mockDb.activityLog.create.mockResolvedValue({}); });

describe('assignDriver', () => {
  const go = (over = {}) => svc.assignDriver({ fleetPartner: FLEET, vehicleId: 'veh1', driverUserId: 'drv1', actor: 'u1', ...over });
  test('happy path creates an ACTIVE assignment and audits it', async () => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue(GOOD_VEHICLE); mockDb.user.findUnique.mockResolvedValue(APPROVED_DRIVER);
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null); mockDb.fleetDriverAssignment.create.mockResolvedValue({ id: 'a1' });
    await expect(go()).resolves.toEqual({ id: 'a1' });
    expect(mockDb.fleetVehicle.findFirst).toHaveBeenCalledWith({ where: { id: 'veh1', fleetPartnerId: 'fleet-aaaaaa' }, include: { documents: true } }); // isolation: scoped by fleet
    expect(mockDb.activityLog.create).toHaveBeenCalled();
  });
  test('a vehicle of another fleet is a 404', async () => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue(null);
    await expect(go()).rejects.toMatchObject({ statusCode: 404 });
  });
  test('inactive fleet cannot assign', async () => { await expect(go({ fleetPartner: { ...FLEET, status: 'PENDING' } })).rejects.toMatchObject({ statusCode: 403 }); });
  test('vehicle with expired insurance cannot be assigned', async () => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue({ ...GOOD_VEHICLE, documents: [doc('insurance', { expiresAt: '2020-01-01' }), doc('roadworthy')] });
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/insurance has expired/) });
  });
  test.each([[null, 400], [{ isApproved: false, isRejected: false }, 403], [{ isApproved: true, isRejected: true }, 403]])('driver profile %j → %i (fleet cannot bypass Runserv approval)', async (profile, code) => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue(GOOD_VEHICLE); mockDb.user.findUnique.mockResolvedValue({ ...APPROVED_DRIVER, driverProfile: profile && { ...GOOD_PROFILE, ...profile } });
    await expect(go()).rejects.toMatchObject({ statusCode: code });
  });
  test('conflicting active assignment → 409 for vehicle and for driver', async () => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue(GOOD_VEHICLE); mockDb.user.findUnique.mockResolvedValue(APPROVED_DRIVER);
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ vehicleId: 'veh1', driverUserId: 'other' });
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: /vehicle already/ });
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ vehicleId: 'veh2', driverUserId: 'drv1' });
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: /driver already/ });
  });
  test('race: unique-index violation maps to 409', async () => {
    mockDb.fleetVehicle.findFirst.mockResolvedValue(GOOD_VEHICLE); mockDb.user.findUnique.mockResolvedValue(APPROVED_DRIVER);
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null); mockDb.fleetDriverAssignment.create.mockRejectedValue(Object.assign(new Error('x'), { code: 'P2002' }));
    await expect(go()).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('endAssignment', () => {
  const A = { id: 'a1', status: 'ACTIVE', driverUserId: 'd', vehicleId: 'v' };
  beforeEach(() => {
    mockDb.ride = { findFirst: jest.fn().mockResolvedValue(null) }; mockDb.delivery = { findFirst: jest.fn().mockResolvedValue(null) };
    mockDb.fleetTrip.findFirst.mockReset().mockResolvedValue(null);
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(A);
    mockDb.fleetDriverAssignment.updateMany = jest.fn().mockResolvedValue({ count: 1 }); mockDb.fleetDriverAssignment.findUnique = jest.fn().mockResolvedValue({ ...A, status: 'ENDED' });
  });
  const end = () => svc.endAssignment({ fleetPartnerId: 'f', assignmentId: 'a1', actor: 'u' });
  test('blocked while a FleetTrip is in progress', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue({ id: 't' }); await expect(end()).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.fleetDriverAssignment.updateMany).not.toHaveBeenCalled();
  });
  test('blocked while the driver has an ACTIVE RIDE even though no FleetTrip exists yet', async () => {
    mockDb.ride.findFirst.mockResolvedValue({ id: 'r1' }); await expect(end()).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.ride.findFirst.mock.calls[0][0].where).toMatchObject({ driverId: 'd', status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } });
    expect(mockDb.fleetDriverAssignment.updateMany).not.toHaveBeenCalled();
  });
  test('blocked while the driver has an ACTIVE DELIVERY', async () => {
    mockDb.delivery.findFirst.mockResolvedValue({ id: 'dl1' }); await expect(end()).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.delivery.findFirst.mock.calls[0][0].where).toMatchObject({ partnerId: 'd', status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } });
  });
  test('ends the assignment inside one transaction under a per-driver lock when the driver is idle', async () => {
    await expect(end()).resolves.toMatchObject({ status: 'ENDED' });
    expect(mockDb.$executeRaw).toHaveBeenCalled(); expect(mockDb.fleetDriverAssignment.updateMany.mock.calls[0][0].where).toEqual({ id: 'a1', status: 'ACTIVE' });
  });
  test('a concurrent close (count 0) is reported, not double-applied', async () => {
    mockDb.fleetDriverAssignment.updateMany.mockResolvedValue({ count: 0 }); await expect(end()).rejects.toMatchObject({ statusCode: 400 });
  });
  test('other fleet’s assignment is a 404', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await expect(svc.endAssignment({ fleetPartnerId: 'f', assignmentId: 'a1', actor: 'u' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('assertDriverDispatchable (go-online / accept gate)', () => {
  test('independent drivers are untouched', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await expect(svc.assertDriverDispatchable('d')).resolves.toEqual({ fleet: false });
  });
  test('fleet driver with a compliant vehicle passes', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f', vehicleId: 'v', vehicle: GOOD_VEHICLE, fleetPartner: FLEET, driver: APPROVED_DRIVER });
    await expect(svc.assertDriverDispatchable('d')).resolves.toMatchObject({ fleet: true });
  });
  test('expired document, suspended vehicle or suspended fleet are all refused with 403', async () => {
    for (const a of [
      { vehicle: { ...GOOD_VEHICLE, documents: [doc('insurance'), doc('roadworthy', { expiresAt: '2020-01-01' })] }, fleetPartner: FLEET },
      { vehicle: { ...GOOD_VEHICLE, status: 'SUSPENDED' }, fleetPartner: FLEET },
      { vehicle: GOOD_VEHICLE, fleetPartner: { ...FLEET, status: 'SUSPENDED' } },
    ]) {
      mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f', vehicleId: 'v', driver: APPROVED_DRIVER, ...a });
      await expect(svc.assertDriverDispatchable('d')).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

describe('recordFleetTrip', () => {
  test('uses the fleet commission rate in integer minor units', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue(null);
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f', vehicleId: 'v', fleetPartner: FLEET });
    mockDb.fleetTrip.create.mockImplementation(async ({ data }) => data);
    const t = await svc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd', fare: 10000 });
    expect(t).toMatchObject({ fareAmount: 10000, platformFeeAmount: 1500, fleetNetAmount: 8500, status: 'COMPLETED', rideId: 'r1' });
  });
  test('non-fleet driver records nothing', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue(null); mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await expect(svc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd', fare: 100 })).resolves.toBeNull();
    expect(mockDb.fleetTrip.create).not.toHaveBeenCalled();
  });
  test('idempotent: a second call for the same ride does not create again', async () => {
    mockDb.fleetTrip.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(svc.recordFleetTrip({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd', fare: 100 })).resolves.toEqual({ id: 'existing' });
    expect(mockDb.fleetTrip.create).not.toHaveBeenCalled();
  });
});

const EV = { paymentReference: 'NIBSS-20261124-0001', paymentMethod: 'BANK_TRANSFER', paidAmount: '100.00' };
const PAYABLE = { ...FLEET, payoutBankCode: '058', payoutAccountNumber: '0123456789' };
describe('settlements', () => {
  const trips = [{ fareAmount: '10000.00', platformFeeAmount: '1500.00' }, { fareAmount: '2500.50', platformFeeAmount: '375.08' }];
  test('summariseTrips reconciles to trip-level records', () => {
    const t = svc.summariseTrips(trips, -50000);
    expect(t).toMatchObject({ grossMinor: 1250050, feeMinor: 187508, adjustmentsMinor: -50000, netMinor: 1250050 - 187508 - 50000, tripCount: 2 });
  });
  const mk = () => { mockDb.fleetPartner.findUnique.mockResolvedValue(FLEET); mockDb.fleetSettlement.findFirst.mockResolvedValue(null); mockDb.fleetTrip.findMany.mockResolvedValue(trips); mockDb.fleetSettlement.create.mockImplementation(async ({ data }) => ({ id: 's1', ...data })); };
  test('creates a statement with gross, fee, adjustments and net', async () => {
    mk();
    const r = await svc.createSettlement({ fleetPartnerId: FLEET.id, periodStart: '2026-11-01', periodEnd: '2026-11-08', adjustments: -500, actor: 'u' });
    expect(r.settlement).toMatchObject({ grossAmount: 12500.5, platformFeeAmount: 1875.08, adjustmentsAmount: -500, netAmount: 10125.42 });
    expect(r.tripCount).toBe(2);
  });
  test('overlapping period is refused so trips are never paid twice', async () => {
    mk(); mockDb.fleetSettlement.findFirst.mockReset(); mockDb.fleetSettlement.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'old' });
    await expect(svc.createSettlement({ fleetPartnerId: FLEET.id, periodStart: '2026-11-01', periodEnd: '2026-11-08', actor: 'u' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('empty period and reversed dates are refused', async () => {
    mk(); mockDb.fleetTrip.findMany.mockResolvedValue([]);
    await expect(svc.createSettlement({ fleetPartnerId: FLEET.id, periodStart: '2026-11-01', periodEnd: '2026-11-08', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createSettlement({ fleetPartnerId: FLEET.id, periodStart: '2026-11-08', periodEnd: '2026-11-01', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('negative net is refused', async () => {
    mk();
    await expect(svc.createSettlement({ fleetPartnerId: FLEET.id, periodStart: '2026-11-01', periodEnd: '2026-11-08', adjustments: -99999999, actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('state machine: cannot jump PENDING → PAID', async () => {
    mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'PENDING' });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('maker–checker: approver cannot also mark paid', async () => {
    mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', fleetPartnerId: 'f', netAmount: '100.00' }); mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'admin1' });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'admin1' })).rejects.toMatchObject({ statusCode: 403 });
    mockDb.fleetSettlement.updateMany.mockResolvedValue({ count: 1 });
    mockDb.fleetSettlement.findUnique.mockReset(); mockDb.fleetSettlement.findUnique.mockResolvedValueOnce({ id: 's', status: 'APPROVED', fleetPartnerId: 'f', netAmount: '100.00' }).mockResolvedValueOnce({ id: 's', status: 'PAID' }); mockDb.fleetPartner.findUnique.mockResolvedValue(PAYABLE);
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'admin2', evidence: EV })).resolves.toMatchObject({ status: 'PAID' });
    expect(mockDb.fleetSettlement.updateMany.mock.calls[0][0].data.paidAt).toBeInstanceOf(Date);
    // conditional update: carries the status we validated against
    expect(mockDb.fleetSettlement.updateMany.mock.calls[0][0].where).toEqual({ id: 's', status: 'APPROVED' });
  });
  test('maker–checker can be switched off for single-admin deployments', async () => {
    process.env.FLEET_MAKER_CHECKER = 'off';
    mockDb.fleetSettlement.findUnique.mockReset(); mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', fleetPartnerId: 'f', netAmount: '100.00' }); mockDb.fleetSettlement.updateMany.mockResolvedValue({ count: 1 }); mockDb.fleetPartner.findUnique.mockResolvedValue(PAYABLE);
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'admin1', evidence: EV })).resolves.toBeTruthy();
    delete process.env.FLEET_MAKER_CHECKER;
  });
  describe('PAID needs payment evidence', () => {
    const approved = () => { mockDb.fleetSettlement.findUnique.mockReset(); mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', fleetPartnerId: 'f', netAmount: '100.00' }); mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'maker' }); mockDb.fleetSettlement.updateMany.mockReset(); mockDb.fleetSettlement.updateMany.mockResolvedValue({ count: 1 }); mockDb.fleetPartner.findUnique.mockResolvedValue(PAYABLE); };
    const pay = (evidence) => svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'checker', evidence });
    test('no evidence, short reference, bad method, missing or wrong amount are all refused and nothing is written', async () => {
      approved();
      await expect(pay(null)).rejects.toMatchObject({ statusCode: 400 });
      await expect(pay({ ...EV, paymentReference: 'abc' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(pay({ ...EV, paymentMethod: 'CASH' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(pay({ ...EV, paidAmount: undefined })).rejects.toMatchObject({ statusCode: 400 });
      await expect(pay({ ...EV, paidAmount: '99.99' })).rejects.toMatchObject({ code: 'PAID_AMOUNT_MISMATCH' });
      expect(mockDb.fleetSettlement.updateMany).not.toHaveBeenCalled();
    });
    test('an unverified fleet or one without a payout account cannot be paid', async () => {
      approved(); mockDb.fleetPartner.findUnique.mockResolvedValue({ ...PAYABLE, verificationStatus: 'PENDING' });
      await expect(pay(EV)).rejects.toMatchObject({ code: 'FLEET_NOT_VERIFIED' });
      mockDb.fleetPartner.findUnique.mockResolvedValue({ ...PAYABLE, payoutAccountNumber: null });
      await expect(pay(EV)).rejects.toMatchObject({ code: 'PAYOUT_ACCOUNT_MISSING' });
    });
    test('valid evidence is stored with the masked account snapshot, the payer and the amount', async () => {
      approved(); await pay({ ...EV, paidAmount: 100 });
      const d = mockDb.fleetSettlement.updateMany.mock.calls[0][0].data;
      expect(d).toMatchObject({ status: 'PAID', paymentReference: EV.paymentReference, paymentMethod: 'BANK_TRANSFER', paidAmount: 100, paidById: 'checker', payoutAccountMasked: '058 ••••6789' });
      expect(d.paidAt).toBeInstanceOf(Date);
    });
    test('the same bank reference cannot settle two statements (unique violation -> 409)', async () => {
      approved(); mockDb.fleetSettlement.updateMany.mockRejectedValue(Object.assign(new Error('u'), { code: 'P2002' }));
      await expect(pay(EV)).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_PAYMENT_REFERENCE' });
    });
  });
});
