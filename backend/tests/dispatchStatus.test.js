'use strict';
// M5: "why am I not receiving jobs?" — structured reasons for drivers and couriers.
const mockDb = {
  driverProfile: { findUnique: jest.fn() },
  deliveryPartnerProfile: { findUnique: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn() },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'] }; next(); },
  authorize: (...roles) => (req, res, next) => (roles.includes(req.headers['x-role']) ? next() : res.status(403).json({ success: false })),
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const { dispatchReasons } = require('../src/services/fleetCompliance');
const fleetService = require('../src/services/fleet.service');

const NOW = new Date('2026-11-17T12:00:00Z');
const fleet = (o = {}) => ({ status: 'ACTIVE', tradingName: 'Lagos Rides', legalName: 'Lagos Rides Ltd', ...o });
// Documents are proven by approved RECORDS for this vehicle (guide §3.2); the legacy *ExpiresAt columns are ignored.
const D = (type, expiresAt, o = {}) => ({ id: `d-${type}`, vehicleId: 'v1', documentType: type, isApproved: true, verifiedAt: new Date('2026-01-01'), rejectionNote: null, expiresAt, ...o });
const veh = (o = {}) => {
  const { insuranceExpiresAt = '2027-06-30', roadworthyExpiresAt = '2027-06-30', ...rest } = o;
  return { id: 'v1', vehicleType: 'CAR', status: 'ACTIVE', isActive: true, registrationNumber: 'LND-123AA',
    documents: [insuranceExpiresAt && D('insurance', insuranceExpiresAt), roadworthyExpiresAt && D('roadworthy', roadworthyExpiresAt)].filter(Boolean), ...rest };
};
const R = (f, v, opts = {}) => dispatchReasons({ fleetPartner: fleet(f), vehicle: veh(v) }, { now: NOW, ...opts });

describe('dispatchReasons', () => {
  test('a compliant vehicle on an active fleet has no reasons', () => expect(R()).toMatchObject({ ok: true, reasons: [], warnings: [] }));
  test('suspended fleet and vehicle give coded reasons with who can fix them', () => {
    const r = R({ status: 'SUSPENDED' }, { status: 'SUSPENDED' });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['FLEET_NOT_ACTIVE', 'VEHICLE_NOT_ACTIVE']);
    expect(r.reasons[0]).toMatchObject({ fleetStatus: 'SUSPENDED', fixedBy: 'RUNSERV' });
    expect(r.reasons[1]).toMatchObject({ vehicleStatus: 'SUSPENDED', fixedBy: 'FLEET' });
  });
  test('missing and expired mandatory documents are distinguished and name the document', () => {
    const r = R({}, { insuranceExpiresAt: null, roadworthyExpiresAt: '2026-11-16' });
    expect(r.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DOC_MISSING', doc: 'insurance' }), expect.objectContaining({ code: 'DOC_EXPIRED', doc: 'roadworthy' })]));
  });
  test('a document valid through today is still valid; one expiring soon is a warning, not a block', () => {
    const r = R({}, { insuranceExpiresAt: '2026-11-17', roadworthyExpiresAt: '2026-12-01' });
    expect(r.ok).toBe(true); expect(r.warnings.map((w) => w.doc).sort()).toEqual(['insurance', 'roadworthy']);
  });
  test('a non-mandatory document that is missing never blocks', () => expect(R({}, { permitExpiresAt: null }).ok).toBe(true));
  test('an inactive flag on an otherwise ACTIVE vehicle blocks', () => expect(R({}, { isActive: false }).reasons[0].code).toBe('VEHICLE_NOT_ACTIVE'));
  test('agrees with the gate used when going online (same decision, different shape)', () => {
    const { dispatchEligibility } = require('../src/services/fleetCompliance');
    for (const v of [veh(), veh({ status: 'PENDING' }), veh({ insuranceExpiresAt: null })]) {
      expect(dispatchReasons({ fleetPartner: fleet(), vehicle: v }, { now: NOW }).ok).toBe(dispatchEligibility({ fleetPartner: fleet(), vehicle: v }, { now: NOW }).ok);
    }
  });
});

describe('getDispatchStatus', () => {
  const ok = { isApproved: true, isRejected: false };
  beforeEach(() => mockDb.fleetDriverAssignment.findFirst.mockReset());
  test('a driver with no fleet is fine when approved', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    expect(await fleetService.getDispatchStatus('d1', { profile: ok })).toEqual({ canTakeJobs: true, isFleetDriver: false, fleet: null, vehicle: null, reasons: [], warnings: [] });
  });
  test('approval problems come first, whether or not there is a fleet', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    expect((await fleetService.getDispatchStatus('d1', { profile: { isApproved: false, isRejected: false } })).reasons[0].code).toBe('PROFILE_PENDING');
    expect((await fleetService.getDispatchStatus('d1', { profile: { isApproved: false, isRejected: true } })).reasons[0].code).toBe('PROFILE_REJECTED');
    expect((await fleetService.getDispatchStatus('d1', { profile: null })).reasons[0].code).toBe('NO_PROFILE');
  });
  test('a fleet driver sees fleet name, vehicle registration and the blocking documents, nothing financial', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartner: { ...fleet(), commissionRate: 10, payoutAccountNumber: '0123456789' }, vehicle: veh({ insuranceExpiresAt: '2020-01-01' }) });
    const r = await fleetService.getDispatchStatus('d1', { profile: ok });
    expect(r).toMatchObject({ canTakeJobs: false, isFleetDriver: true, fleet: { name: 'Lagos Rides', status: 'ACTIVE' }, vehicle: { registration: 'LND-123AA', status: 'ACTIVE' } });
    expect(r.reasons[0]).toMatchObject({ code: 'DOC_EXPIRED', doc: 'insurance' });
    expect(JSON.stringify(r)).not.toMatch(/commission|payout|0123456789/);
  });
  test('only the caller’s own ACTIVE assignment is looked up', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await fleetService.getDispatchStatus('d77', { profile: ok });
    expect(mockDb.fleetDriverAssignment.findFirst.mock.calls[0][0].where).toEqual({ driverUserId: 'd77', status: 'ACTIVE' });
  });
});

describe('HTTP', () => {
  const app = express(); app.use(express.json());
  app.use('/api/drivers', require('../src/routes/driver.routes'));
  app.use('/api/partners', require('../src/routes/partner.routes'));
  app.use(errorHandler);
  beforeEach(() => { jest.clearAllMocks(); mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null); });
  test('drivers: requires sign-in and the DRIVER role', async () => {
    expect((await request(app).get('/api/drivers/dispatch-status')).status).toBe(401);
    expect((await request(app).get('/api/drivers/dispatch-status').set('x-user', 'u').set('x-role', 'CUSTOMER')).status).toBe(403);
  });
  test('drivers: returns the structured status', async () => {
    mockDb.driverProfile.findUnique.mockResolvedValue({ isApproved: true, isRejected: false });
    const r = await request(app).get('/api/drivers/dispatch-status').set('x-user', 'd1').set('x-role', 'DRIVER');
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ canTakeJobs: true, isFleetDriver: false });
    expect(mockDb.driverProfile.findUnique.mock.calls[0][0].where).toEqual({ userId: 'd1' });
  });
  test('couriers: own endpoint, DELIVERY_PARTNER only', async () => {
    expect((await request(app).get('/api/partners/dispatch-status').set('x-user', 'u').set('x-role', 'DRIVER')).status).toBe(403);
    mockDb.deliveryPartnerProfile.findUnique.mockResolvedValue({ isApproved: false, isRejected: false });
    const r = await request(app).get('/api/partners/dispatch-status').set('x-user', 'p1').set('x-role', 'DELIVERY_PARTNER');
    expect(r.status).toBe(200); expect(r.body.data.reasons[0].code).toBe('PROFILE_PENDING');
  });
});
