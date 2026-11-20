'use strict';
const mockDb = {
  fleetPartnerUser: { findFirst: jest.fn() },
  fleetVehicle: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn(), findFirst: jest.fn() },
  fleetDriverAssignment: { findMany: jest.fn().mockResolvedValue([]) },
  fleetSettlement: { findMany: jest.fn().mockResolvedValue([]) },
  fleetTrip: { findMany: jest.fn().mockResolvedValue([{ id: 't', fareAmount: 100, platformFeeAmount: 10, fleetNetAmount: 90 }]), count: jest.fn().mockResolvedValue(1) },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], countryCode: 'NG' }; next(); },
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');

const app = express(); app.use(express.json()); app.use('/api/fleet', require('../src/routes/fleet.routes')); app.use(errorHandler);
const member = (role, fleetPartnerId = 'fleetA', status = 'ACTIVE') => mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ role, fleetPartnerId, fleetPartner: { id: fleetPartnerId, status } });
const VEH = { vehicleType: 'CAR', make: 'Toyota', model: 'Corolla', registrationNumber: 'LND123AA' };
beforeEach(() => jest.clearAllMocks());

test('unauthenticated → 401', async () => { expect((await request(app).get('/api/fleet/overview')).status).toBe(401); });
test('a signed-in user with no fleet → 403', async () => {
  mockDb.fleetPartnerUser.findFirst.mockResolvedValue(null);
  expect((await request(app).get('/api/fleet/vehicles').set('x-user', 'u')).status).toBe(403);
});
test('every list is scoped to the caller’s own fleet (object-level isolation)', async () => {
  member('OWNER', 'fleetA');
  await request(app).get('/api/fleet/vehicles?fleetPartnerId=fleetB').set('x-user', 'u');
  expect(mockDb.fleetVehicle.findMany.mock.calls[0][0].where.fleetPartnerId).toBe('fleetA');
  await request(app).get('/api/fleet/drivers').set('x-user', 'u');
  expect(mockDb.fleetDriverAssignment.findMany.mock.calls[0][0].where.fleetPartnerId).toBe('fleetA');
});
test('another fleet’s vehicle id is a 404, not a leak', async () => {
  member('OWNER', 'fleetA'); mockDb.fleetVehicle.findFirst.mockResolvedValue(null);
  const r = await request(app).get('/api/fleet/vehicles/vehOfFleetB').set('x-user', 'u');
  expect(r.status).toBe(404); expect(mockDb.fleetVehicle.findFirst.mock.calls[0][0].where).toEqual({ id: 'vehOfFleetB', fleetPartnerId: 'fleetA' });
});
test('VIEWER cannot create vehicles; FLEET_MANAGER can', async () => {
  member('VIEWER'); expect((await request(app).post('/api/fleet/vehicles').set('x-user', 'u').send(VEH)).status).toBe(403);
  member('FLEET_MANAGER'); mockDb.fleetVehicle.create.mockResolvedValue({ id: 'v', ...VEH, vehicleType: 'CAR' });
  const r = await request(app).post('/api/fleet/vehicles').set('x-user', 'u').send(VEH);
  expect(r.status).toBe(201);
  const data = mockDb.fleetVehicle.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ fleetPartnerId: 'fleetA', status: 'PENDING' }); // a fleet cannot self-approve a vehicle
});
test('client cannot smuggle status/fleetPartnerId into a vehicle', async () => {
  member('OWNER'); mockDb.fleetVehicle.create.mockResolvedValue({ id: 'v' });
  await request(app).post('/api/fleet/vehicles').set('x-user', 'u').send({ ...VEH, status: 'ACTIVE', fleetPartnerId: 'fleetB' });
  expect(mockDb.fleetVehicle.create.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', fleetPartnerId: 'fleetA' });
});
test('only the three launch categories are accepted', async () => {
  member('OWNER'); expect((await request(app).post('/api/fleet/vehicles').set('x-user', 'u').send({ ...VEH, vehicleType: 'TRICYCLE' })).status).toBe(400);
});
test('finance data is hidden from OPERATIONS and VIEWER; open to FINANCE', async () => {
  member('OPERATIONS'); expect((await request(app).get('/api/fleet/settlements').set('x-user', 'u')).status).toBe(403);
  member('VIEWER'); expect((await request(app).get('/api/fleet/settlements').set('x-user', 'u')).status).toBe(403);
  member('FINANCE'); expect((await request(app).get('/api/fleet/settlements').set('x-user', 'u')).status).toBe(200);
});
test('trip fares are stripped for VIEWER but visible to FINANCE', async () => {
  member('VIEWER'); let r = await request(app).get('/api/fleet/trips').set('x-user', 'u');
  expect(r.body.data.trips[0].fareAmount).toBeUndefined();
  member('FINANCE'); r = await request(app).get('/api/fleet/trips').set('x-user', 'u');
  expect(r.body.data.trips[0].fareAmount).toBe(100);
});
test('only OWNER/ADMIN manage the team; OWNER role cannot be granted', async () => {
  member('FLEET_MANAGER'); expect((await request(app).get('/api/fleet/users').set('x-user', 'u')).status).toBe(403);
  member('OWNER'); expect((await request(app).post('/api/fleet/users').set('x-user', 'u').send({ email: 'a@b.co', role: 'OWNER' })).status).toBe(400);
});
test('documents must be https links', async () => {
  member('OWNER'); expect((await request(app).post('/api/fleet/documents').set('x-user', 'u').send({ documentType: 'insurance', fileUrl: 'http://x.co/a.pdf' })).status).toBe(400);
});
