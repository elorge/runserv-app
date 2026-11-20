'use strict';
const mockDb = {
  fleetVehicle: { findMany: jest.fn(), count: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'admin1' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');

const app = express(); app.use(express.json()); app.use('/api/admin/fleet', require('../src/routes/adminFleet.routes')); app.use(errorHandler);
const future = new Date(Date.now() + 200 * 864e5); const past = new Date(Date.now() - 5 * 864e5);
const veh = (id, over = {}) => ({ id, fleetPartnerId: 'f1', vehicleType: 'CAR', registrationNumber: id, status: 'PENDING', insuranceExpiresAt: future, roadworthyExpiresAt: future, permitExpiresAt: null, fleetPartner: { id: 'f1', legalName: 'Acme' }, ...over });
beforeEach(() => { jest.clearAllMocks(); delete process.env.FLEET_REQUIRED_VEHICLE_DOCS; mockDb.fleetVehicle.count.mockResolvedValue(2); });

test('lists vehicles across fleets with a compliance verdict on each row', async () => {
  mockDb.fleetVehicle.findMany.mockResolvedValue([veh('OK1'), veh('BAD1', { insuranceExpiresAt: past })]);
  const r = await request(app).get('/api/admin/fleet/vehicles');
  expect(r.status).toBe(200);
  expect(r.body.data.vehicles[0].compliance.blockers).toEqual([]);
  expect(r.body.data.vehicles[1].compliance.blockers.join()).toMatch(/insurance has expired/);
  expect(r.body.data.total).toBe(2);
});

test('passes status / type / fleet / search filters to the query', async () => {
  mockDb.fleetVehicle.findMany.mockResolvedValue([]);
  await request(app).get('/api/admin/fleet/vehicles?status=PENDING&vehicleType=VAN&fleetPartnerId=f9&q=lnd');
  const w = mockDb.fleetVehicle.findMany.mock.calls[0][0].where;
  expect(w).toMatchObject({ status: 'PENDING', vehicleType: 'VAN', fleetPartnerId: 'f9' });
  expect(w.OR[0].registrationNumber.contains).toBe('lnd');
});

test('compliance=blocked keeps only vehicles that cannot take jobs', async () => {
  mockDb.fleetVehicle.findMany.mockResolvedValue([veh('OK1'), veh('BAD1', { roadworthyExpiresAt: null })]);
  const r = await request(app).get('/api/admin/fleet/vehicles?compliance=blocked');
  expect(r.body.data.vehicles.map((v) => v.id)).toEqual(['BAD1']);
});

test('page size is capped at 100', async () => {
  mockDb.fleetVehicle.findMany.mockResolvedValue([]);
  await request(app).get('/api/admin/fleet/vehicles?limit=9999&page=3');
  const a = mockDb.fleetVehicle.findMany.mock.calls[0][0];
  expect(a.take).toBe(100); expect(a.skip).toBe(200);
});

describe('country-limited staff are kept out of global fleet / bank administration', () => {
  const guard = require('../src/middleware/globalStaff');
  const run = (user) => { const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }; const next = jest.fn(); guard({ user }, res, next); return { res, next }; };
  test('blocks an ADMIN assigned to specific countries', () => { const { res, next } = run({ role: 'ADMIN', supportCountries: ['ML'] }); expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled(); });
  test('allows an unrestricted ADMIN and a SUPER_ADMIN', () => {
    expect(run({ role: 'ADMIN', supportCountries: [] }).next).toHaveBeenCalled();
    expect(run({ role: 'SUPER_ADMIN', supportCountries: ['ML'] }).next).toHaveBeenCalled();
  });
});
