'use strict';
// M10: consent endpoints, going online needs consent, and the privacy of ride / nearby responses.
const mockDb = {
  driverProfile: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  deliveryPartnerProfile: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  ride: { findFirst: jest.fn(), findUnique: jest.fn() },
  delivery: { findFirst: jest.fn(), findUnique: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn() },
  activityLog: { create: jest.fn() },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { req.user = { id: 'u1' }; next(); },
  authorize: (...roles) => (req, res, next) => (roles.includes(req.headers['x-role']) ? next() : res.status(403).json({ success: false })),
  requirePhone: (req, res, next) => next(),
}));
jest.mock('../src/services/country.service', () => ({ getPricingContextForUserId: jest.fn().mockResolvedValue({ currencyCode: 'NGN', countryCode: 'NG' }), getCurrencyForUserId: jest.fn() }));
jest.mock('../src/utils/fareEngine', () => ({
  estimateFare: jest.fn().mockResolvedValue({ estimatedFare: 1500, commissionRate: 0.2, roundingStep: 50, bookingFee: 100, surgeMultiplier: 1, surgeLabel: '' }),
  calculateFinalFare: jest.fn(), applyDriverFloor: jest.fn(), roundToStep: (n) => n,
  getSurgeMultiplier: jest.fn(() => ({ multiplier: 1, label: 'Normal' })), getSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/fleet.service', () => ({ assertDriverDispatchable: jest.fn().mockResolvedValue() }));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const T = require('../src/services/tracking.service');

const io = { in: jest.fn(() => ({ socketsLeave: jest.fn() })), to: jest.fn(() => ({ emit: jest.fn() })) };
const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/drivers', require('../src/routes/driver.routes'));
app.use('/api/partners', require('../src/routes/partner.routes'));
app.use(errorHandler);

const base = { id: 'p1', isApproved: true, isRejected: false, isOnline: false, locationConsentAt: null, locationConsentVersion: null, locationConsentRevokedAt: null };
const consented = { ...base, locationConsentAt: new Date(), locationConsentVersion: T.CONSENT_VERSION };
beforeEach(() => { jest.clearAllMocks(); mockDb.ride.findFirst.mockResolvedValue(null); mockDb.delivery.findFirst.mockResolvedValue(null); });

describe.each([
  ['drivers', 'DRIVER', 'driverProfile', 'ride'],
  ['partners', 'DELIVERY_PARTNER', 'deliveryPartnerProfile', 'delivery'],
])('%s location consent', (path, role, model, tripModel) => {
  const get = () => request(app).get(`/api/${path}/location-consent`).set('x-role', role);
  const put = (body) => request(app).put(`/api/${path}/location-consent`).set('x-role', role).send(body);

  test('GET shows the required version and not granted', async () => {
    mockDb[model].findUnique.mockResolvedValue(base);
    const r = await get();
    expect(r.status).toBe(200); expect(r.body.data.consent).toMatchObject({ granted: false, required: T.CONSENT_VERSION });
  });
  test('only the right role may call it', async () => {
    expect((await request(app).get(`/api/${path}/location-consent`).set('x-role', 'CUSTOMER')).status).toBe(403);
  });
  test('PUT granted on the current wording records consent and an audit row', async () => {
    mockDb[model].findUnique.mockResolvedValue(base);
    mockDb[model].update.mockResolvedValue({ ...consented, locationConsentRevokedAt: null });
    const r = await put({ granted: true, version: T.CONSENT_VERSION });
    expect(r.status).toBe(200); expect(r.body.data.consent.granted).toBe(true);
    expect(mockDb[model].update.mock.calls[0][0].data).toMatchObject({ locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'location_consent_granted' }) }));
  });
  test('PUT granted on old wording is refused with a code', async () => {
    mockDb[model].findUnique.mockResolvedValue(base);
    const r = await put({ granted: true, version: 'old' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('LOCATION_CONSENT_VERSION');
    expect(mockDb[model].update).not.toHaveBeenCalled();
  });
  test('PUT needs a boolean', async () => {
    mockDb[model].findUnique.mockResolvedValue(base);
    expect((await put({ granted: 'yes' })).status).toBeGreaterThanOrEqual(400);
  });
  test('withdrawing takes them offline and erases the stored position', async () => {
    mockDb[model].findUnique.mockResolvedValue({ ...consented, isOnline: true });
    mockDb[model].update.mockResolvedValue({ ...consented, isOnline: false, locationConsentRevokedAt: new Date(Date.now() + 5) });
    const r = await put({ granted: false });
    expect(r.status).toBe(200); expect(r.body.data.isOnline).toBe(false);
    expect(mockDb[model].update.mock.calls[0][0].data).toMatchObject({ isOnline: false, currentLat: null, currentLng: null, lastLocationAt: null });
    expect(io.in).toHaveBeenCalledWith('user:u1');
    expect(mockDb.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'location_consent_withdrawn' }) }));
  });
  test('withdrawing is blocked during a trip', async () => {
    mockDb[model].findUnique.mockResolvedValue({ ...consented, isOnline: true });
    mockDb[tripModel].findFirst.mockResolvedValue({ id: 't1' });
    const r = await put({ granted: false });
    expect(r.status).toBe(400); expect(r.body.code).toBe('LOCATION_CONSENT_ACTIVE_TRIP');
    expect(mockDb[model].update).not.toHaveBeenCalled();
  });
  test('going online without consent returns LOCATION_CONSENT_REQUIRED', async () => {
    mockDb[model].findUnique.mockResolvedValue(base);
    const r = await request(app).put(`/api/${path}/status`).set('x-role', role).send({ isOnline: true, currentLat: 6.5, currentLng: 3.3 });
    expect(r.status).toBe(403); expect(r.body.code).toBe('LOCATION_CONSENT_REQUIRED');
    expect(mockDb[model].update).not.toHaveBeenCalled();
  });
  test('going online with old-wording consent is also refused', async () => {
    mockDb[model].findUnique.mockResolvedValue({ ...consented, locationConsentVersion: 'old' });
    const r = await request(app).put(`/api/${path}/status`).set('x-role', role).send({ isOnline: true });
    expect(r.body.code).toBe('LOCATION_CONSENT_REQUIRED');
  });
  test('going online with consent stores the position; offline erases it', async () => {
    mockDb[model].findUnique.mockResolvedValue(consented);
    mockDb[model].update.mockResolvedValue({ ...consented, isOnline: true });
    await request(app).put(`/api/${path}/status`).set('x-role', role).send({ isOnline: true, currentLat: 6.5, currentLng: 3.3 }).expect(200);
    expect(mockDb[model].update.mock.calls[0][0].data).toMatchObject({ isOnline: true, currentLat: 6.5, currentLng: 3.3 });
    expect(mockDb[model].update.mock.calls[0][0].data.lastLocationAt).toBeInstanceOf(Date);
    await request(app).put(`/api/${path}/status`).set('x-role', role).send({ isOnline: false }).expect(200);
    expect(mockDb[model].update.mock.calls[1][0].data).toMatchObject({ isOnline: false, currentLat: null, currentLng: null, lastLocationAt: null });
  });
});

describe('ride and nearby privacy', () => {
  const rideCtrl = require('../src/controllers/ride.controller');
  const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
  const deepKeys = (o, acc = new Set()) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.add(k); deepKeys(v, acc); } return acc; };

  test('getRideById asks the database for the safe subset only', async () => {
    mockDb.ride.findUnique = jest.fn().mockResolvedValue({ id: 'r1', customerId: 'u1', driverId: 'd1' });
    await rideCtrl.getRideById({ params: { id: 'r1' }, user: { id: 'u1' } }, res());
    const sel = mockDb.ride.findUnique.mock.calls[0][0].include.driver.select;
    const keys = deepKeys(sel);
    for (const k of ['licenseNumber', 'licenseImageUrl', 'govtIdUrl', 'guarantorIdUrl', 'guarantorLetterUrl', 'insuranceUrl', 'currentLat', 'currentLng']) expect(keys.has(k)).toBe(false);
    expect(sel.driverProfile).toEqual({ select: T.DRIVER_PUBLIC_SELECT });
  });

  test('getActiveRide: exact driver position only to the assigned customer, flagged stale after 90 s', async () => {
    mockDb.ride.findFirst.mockResolvedValue({ id: 'r1', customerId: 'u1', driverId: 'd1', status: 'ACCEPTED' });
    mockDb.driverProfile.findUnique.mockResolvedValue({ ...consented, isOnline: true, currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date(Date.now() - 200000), locationHeading: 80 });
    const r = res();
    await rideCtrl.getActiveRide({ user: { id: 'u1', role: 'CUSTOMER' } }, r);
    expect(deepKeys(mockDb.ride.findFirst.mock.calls[0][0].include.driver.select).has('currentLat')).toBe(false);
    const out = r.json.mock.calls[0][0].data;
    expect(out.driverLocation).toMatchObject({ lat: 6.5, lng: 3.3, heading: 80, stale: true });

    // the driver asking about their own ride gets no location block
    mockDb.driverProfile.findUnique.mockClear();
    const r2 = res();
    await rideCtrl.getActiveRide({ user: { id: 'd1', role: 'DRIVER' } }, r2);
    expect(r2.json.mock.calls[0][0].data.driverLocation).toBeNull();
    expect(mockDb.driverProfile.findUnique).not.toHaveBeenCalled();
  });

  test('getActiveRide: no location when the driver has withdrawn consent', async () => {
    mockDb.ride.findFirst.mockResolvedValue({ id: 'r1', customerId: 'u1', driverId: 'd1', status: 'ACCEPTED' });
    mockDb.driverProfile.findUnique.mockResolvedValue({ ...consented, locationConsentRevokedAt: new Date(Date.now() + 10), isOnline: true, currentLat: 6.5, currentLng: 3.3, lastLocationAt: new Date() });
    const r = res();
    await rideCtrl.getActiveRide({ user: { id: 'u1', role: 'CUSTOMER' } }, r);
    expect(r.json.mock.calls[0][0].data.driverLocation).toBeNull();
  });

  test('nearby drivers: consent + recent-fix filter, rounded positions, no exact coordinates in the response', async () => {
    mockDb.driverProfile.findMany.mockResolvedValue([{ id: 'p', vehicleType: 'CAR', vehicleMake: 'T', vehicleModel: 'C', vehicleColor: 'blue', vehiclePlate: 'X', vehicleYear: 2020, rating: 4.5, floorMultiplier: 1, totalRides: 3,
      currentLat: 6.601812, currentLng: 3.351499, lastLocationAt: new Date(), locationHeading: 12, user: { id: 'd1', firstName: 'A', lastName: 'B', profileImage: null, phone: '1' } }]);
    const r = res();
    await rideCtrl.getNearbyDrivers({ query: { pickupLat: '6.60', pickupLng: '3.35' }, user: { id: 'u1' } }, r);
    const where = mockDb.driverProfile.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ isOnline: true, locationConsentVersion: T.CONSENT_VERSION, locationConsentRevokedAt: null });
    expect(where.lastLocationAt.gte).toBeInstanceOf(Date);
    const d = r.json.mock.calls[0][0].data.drivers[0];
    expect(d).toMatchObject({ approxLat: 6.602, approxLng: 3.351, heading: 12 });
    expect(d).not.toHaveProperty('currentLat'); expect(d).not.toHaveProperty('currentLng'); expect(d).not.toHaveProperty('phone');
    expect(JSON.stringify(d)).not.toContain('6.601812');
  });
});
