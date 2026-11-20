// M4 — what the Fleet Partner Portal relies on: permissions map, finance hiding on trips,
// trip context (driver / vehicle names), exceptions filter, and the document file upload gate.
'use strict';
const mockDb = {
  fleetPartnerUser: { findFirst: jest.fn() },
  fleetTrip: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(2) },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], countryCode: 'NG' }; next(); },
}));
// The real middleware streams to Cloudinary; here it just pretends a file arrived (or not).
jest.mock('../src/services/upload.service', () => ({
  uploadPrivateSingle: () => [(req, res, next) => { if (req.headers['x-nofile']) return next(); req.privateFile = { ref: 'cldp:image:pdf:runserv/fleet/documents/doc', publicId: 'runserv/fleet/documents/doc' }; return next(); }],
  uploadSingle: () => (req, res, next) => { if (req.headers['x-nofile']) return next(); req.file = { path: 'https://res.example.com/fleet/doc.pdf', filename: 'runserv/fleet/documents/doc' }; return next(); },
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');

const app = express(); app.use(express.json()); app.use('/api/fleet', require('../src/routes/fleet.routes')); app.use(errorHandler);
const FLEET = { id: 'fleetA', status: 'ACTIVE', legalName: 'Acme Fleet', commissionRate: 0.1, payoutAccountNumber: '0123456789', payoutBankCode: '058', payoutAccountName: 'Acme' };
const member = (role, status = 'ACTIVE') => mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ role, fleetPartnerId: 'fleetA', fleetPartner: { ...FLEET, status } });
const TRIPS = [{ id: 't1', fareAmount: 1000, platformFeeAmount: 100, fleetNetAmount: 900, status: 'COMPLETED', driver: { firstName: 'A', lastName: 'B' }, vehicle: { registrationNumber: 'LND1AA' } }];
beforeEach(() => { jest.clearAllMocks(); mockDb.fleetTrip.findMany.mockResolvedValue(TRIPS); mockDb.fleetTrip.count.mockResolvedValue(1); });

describe('profile permissions map', () => {
  test.each([
    ['OWNER',         { seeFinance: true,  manageVehicles: true,  assignDrivers: true,  manageUsers: true  }],
    ['ADMIN',         { seeFinance: true,  manageVehicles: true,  assignDrivers: true,  manageUsers: true  }],
    ['FLEET_MANAGER', { seeFinance: false, manageVehicles: true,  assignDrivers: true,  manageUsers: false }],
    ['OPERATIONS',    { seeFinance: false, manageVehicles: false, assignDrivers: true,  manageUsers: false }],
    ['FINANCE',       { seeFinance: true,  manageVehicles: false, assignDrivers: false, manageUsers: false }],
    ['VIEWER',        { seeFinance: false, manageVehicles: false, assignDrivers: false, manageUsers: false }],
  ])('%s', async (role, expected) => {
    member(role);
    const r = await request(app).get('/api/fleet/profile').set('x-user', 'u');
    expect(r.status).toBe(200);
    expect(r.body.data.role).toBe(role);
    expect(r.body.data.permissions).toMatchObject(expected);
  });

  test('payout details and commission are not sent to roles without finance access', async () => {
    member('OPERATIONS');
    const f = (await request(app).get('/api/fleet/profile').set('x-user', 'u')).body.data.fleetPartner;
    expect(f.payoutAccountNumber).toBeUndefined(); expect(f.commissionRate).toBeUndefined();
    member('FINANCE');
    const g = (await request(app).get('/api/fleet/profile').set('x-user', 'u')).body.data.fleetPartner;
    expect(g.payoutAccountNumber).toBe('0123456789'); expect(g.commissionRate).toBe(0.1);
  });

  test('a suspended fleet still reads its profile (the portal shows a banner)', async () => {
    member('OWNER', 'SUSPENDED');
    const r = await request(app).get('/api/fleet/profile').set('x-user', 'u');
    expect(r.status).toBe(200); expect(r.body.data.fleetPartner.status).toBe('SUSPENDED');
  });
});

describe('trips', () => {
  test.each(['OPERATIONS', 'VIEWER', 'FLEET_MANAGER'])('%s sees the trip but not its money', async (role) => {
    member(role);
    const t = (await request(app).get('/api/fleet/trips').set('x-user', 'u')).body.data.trips[0];
    expect(t.id).toBe('t1');
    expect(t.fareAmount).toBeUndefined(); expect(t.platformFeeAmount).toBeUndefined(); expect(t.fleetNetAmount).toBeUndefined();
  });
  test.each(['OWNER', 'ADMIN', 'FINANCE'])('%s sees the money', async (role) => {
    member(role);
    const t = (await request(app).get('/api/fleet/trips').set('x-user', 'u')).body.data.trips[0];
    expect(t.fareAmount).toBe(1000); expect(t.fleetNetAmount).toBe(900);
  });
  test('trip rows carry driver and vehicle names but are still scoped to the caller’s fleet', async () => {
    member('OWNER');
    await request(app).get('/api/fleet/trips?fleetPartnerId=fleetB').set('x-user', 'u');
    const arg = mockDb.fleetTrip.findMany.mock.calls[0][0];
    expect(arg.where.fleetPartnerId).toBe('fleetA');
    expect(arg.include.driver.select).toEqual({ id: true, firstName: true, lastName: true }); // no phone / email / licence
    expect(arg.include.vehicle.select.registrationNumber).toBe(true);
  });
  test('exceptions=true narrows to cancelled and disputed trips', async () => {
    member('OWNER');
    await request(app).get('/api/fleet/trips?exceptions=true').set('x-user', 'u');
    expect(mockDb.fleetTrip.findMany.mock.calls[0][0].where.status).toEqual({ in: ['CANCELLED', 'DISPUTED'] });
  });
  test('an unknown status is rejected', async () => {
    member('OWNER');
    expect((await request(app).get('/api/fleet/trips?status=BOGUS').set('x-user', 'u')).status).toBe(400);
  });
});

describe('document file upload', () => {
  test.each(['VIEWER', 'OPERATIONS', 'FINANCE'])('%s cannot upload', async (role) => {
    member(role);
    expect((await request(app).post('/api/fleet/documents/upload').set('x-user', 'u')).status).toBe(403);
  });
  test.each(['OWNER', 'ADMIN', 'FLEET_MANAGER'])('%s can upload and gets a private reference back (never a public link)', async (role) => {
    member(role);
    const r = await request(app).post('/api/fleet/documents/upload').set('x-user', 'u');
    expect(r.status).toBe(201); expect(r.body.data.url).toMatch(/^cldp:/); expect(r.body.data.private).toBe(true);
    expect(mockDb.activityLog.create).toHaveBeenCalled();
  });
  test('no file → 400', async () => {
    member('OWNER');
    expect((await request(app).post('/api/fleet/documents/upload').set('x-user', 'u').set('x-nofile', '1')).status).toBe(400);
  });
  test('unauthenticated → 401', async () => {
    expect((await request(app).post('/api/fleet/documents/upload')).status).toBe(401);
  });
});
