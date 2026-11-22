'use strict';
jest.mock('../src/lib/prisma', () => ({}));
const express = require('express');
const request = require('supertest');

const build = (enabled) => {
  jest.resetModules();
  process.env.JWT_SECRET = 'test-secret';
  if (enabled) process.env.GUEST_PLANNING_ENABLED = 'true'; else delete process.env.GUEST_PLANNING_ENABLED;
  const autocomplete = jest.fn((req, res) => res.json({ success: true, seenCountry: req.guestCountry, seenUser: req.user ?? null }));
  const placeDetails = jest.fn((req, res) => res.json({ success: true }));
  jest.doMock('../src/controllers/places.controller', () => ({ autocomplete, placeDetails, reverse: (req, res) => res.json({ success: true, seenCountry: req.guestCountry }) }));
  const h = (req, res) => res.json({ success: true });
  jest.doMock('../src/controllers/guestBooking.controller', () => ({ requestOtp: h, verifyOtp: h, create: h, list: h, get: h, cancel: h, rotateTracking: h, revokeTracking: h, convert: h, track: h }));
  jest.doMock('../src/controllers/guest.controller', () => ({ quote: (req, res) => res.json({ success: true }) }));
  const app = express(); app.use(express.json());
  app.use('/api/guest', require('../src/routes/guest.routes'));
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, code: err.code, message: err.message })); // eslint-disable-line no-unused-vars
  return { app, autocomplete, placeDetails };
};
const ok = { input: 'Ikeja city mall', sessionToken: 'abcdefgh12345678', countryCode: 'NG' };

describe('guest places + config', () => {
  test('config reports the flag', async () => {
    expect((await request(build(false).app).get('/api/guest/config')).body.data.planningEnabled).toBe(false);
    expect((await request(build(true).app).get('/api/guest/config')).body.data.planningEnabled).toBe(true);
  });
  test('places are dark when the flag is off', async () => {
    const { app, autocomplete } = build(false);
    const r = await request(app).post('/api/guest/places/autocomplete').send(ok);
    expect(r.status).toBe(404); expect(autocomplete).not.toHaveBeenCalled();
  });
  test('autocomplete passes the validated country and never fabricates a user', async () => {
    const { app } = build(true);
    const r = await request(app).post('/api/guest/places/autocomplete').send(ok);
    expect(r.status).toBe(200); expect(r.body.seenCountry).toBe('NG'); expect(r.body.seenUser).toBeNull();
  });
  test('rejects short/long input, missing token, unsupported country', async () => {
    const { app, autocomplete } = build(true);
    expect((await request(app).post('/api/guest/places/autocomplete').send({ ...ok, input: 'a' })).status).toBe(400);
    expect((await request(app).post('/api/guest/places/autocomplete').send({ ...ok, input: 'x'.repeat(101) })).status).toBe(400);
    expect((await request(app).post('/api/guest/places/autocomplete').send({ ...ok, sessionToken: undefined })).status).toBe(400);
    expect((await request(app).post('/api/guest/places/autocomplete').send({ ...ok, countryCode: 'ZZ' })).status).toBe(400);
    expect(autocomplete).not.toHaveBeenCalled();
  });
  test('details needs a placeId and token', async () => {
    const { app, placeDetails } = build(true);
    expect((await request(app).post('/api/guest/places/details').send({ sessionToken: 'abcdefgh12345678' })).status).toBe(400);
    expect((await request(app).post('/api/guest/places/details').send({ placeId: 'ChIJxyz', sessionToken: 'abcdefgh12345678' })).status).toBe(200);
    expect(placeDetails).toHaveBeenCalledTimes(1);
  });
});

describe('guest booking routes are dark / protected by default', () => {
  test('flag off: otp, bookings and tracking are all 404', async () => {
    const { app } = build(true); // planning on, booking flag off
    expect((await request(app).post('/api/guest/otp/request').send({ phone: '+2348012345678' })).status).toBe(404);
    expect((await request(app).get('/api/guest/bookings')).status).toBe(404);
    expect((await request(app).get(`/api/guest/track/gt_${'A'.repeat(43)}`)).status).toBe(404);
  });
  test('flag on: bookings need a Guest session (a Bearer token is not one)', async () => {
    process.env.GUEST_BOOKING_ENABLED = 'true';
    const { app } = build(true); process.env.GUEST_BOOKING_ENABLED = 'true';
    const r = await request(app).get('/api/guest/bookings').set('Authorization', 'Bearer abc');
    expect(r.status).toBe(401); expect(r.body.code).toBe('GUEST_SESSION_REQUIRED');
    delete process.env.GUEST_BOOKING_ENABLED;
  });
  test('reverse geocode validates coordinates and country', async () => {
    const { app } = build(true);
    expect((await request(app).post('/api/guest/places/reverse').send({ lat: 6.5, lng: 3.3 })).body.seenCountry).toBe('NG');
    expect((await request(app).post('/api/guest/places/reverse').send({ lat: 999, lng: 3.3 })).status).toBe(400);
  });
});
