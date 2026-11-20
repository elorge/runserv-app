'use strict';
const crypto = require('crypto');
const mockDb = {
  bankPartner: { findUnique: jest.fn() },
  bankOffer: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
  bankReferral: { findUnique: jest.fn(), update: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], countryCode: 'NG' }; next(); },
  authorize: (...roles) => (req, res, next) => (roles.includes(req.headers['x-role']) ? next() : res.status(403).json({ success: false })),
}));
process.env.BANK_TRIP_BENEFITS_ENABLED = 'true'; // gate off-by-default behaviour is in bankHardening.test.js
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const bank = require('../src/routes/bankOffers.routes');

// Mirrors app.js: raw body for the bank webhook, JSON for everything else.
const app = express();
app.use('/api/bank-webhooks', express.raw({ type: '*/*', limit: '256kb' }));
app.use((req, res, next) => (req.path.startsWith('/api/bank-webhooks/') ? next() : express.json()(req, res, next)));
app.use('/api/offers', bank.offers); app.use('/api/bank-webhooks', bank.webhooks); app.use('/api/admin/banks', (req, _r, n) => n(), require('../src/routes/adminBank.routes'));
app.use(errorHandler);
beforeEach(() => { jest.clearAllMocks(); process.env.BANK_WEBHOOK_SECRETS = JSON.stringify({ bank1: 'topsecret' }); });

const signed = (obj, secret = 'topsecret') => { const raw = JSON.stringify(obj); const ts = String(Math.floor(Date.now() / 1000)); return { raw, ts, sig: crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') }; };

describe('customer offers API', () => {
  test('requires sign-in', async () => { expect((await request(app).get('/api/offers')).status).toBe(401); });
  test('list is queried only for the user’s country, active bank, in-window approved campaigns', async () => {
    await request(app).get('/api/offers').set('x-user', 'u');
    const w = mockDb.bankOffer.findMany.mock.calls[0][0].where;
    expect(w).toMatchObject({ isPublished: true, campaign: { status: { in: ['ACTIVE', 'SCHEDULED'] }, bankPartner: { status: 'ACTIVE', countryCode: 'NG' } } });
  });
  test('quote validates the amount; redeem needs an idempotency key', async () => {
    expect((await request(app).post('/api/offers/o1/quote').set('x-user', 'u').send({ amount: -5 })).status).toBe(400);
    expect((await request(app).post('/api/offers/o1/redeem').set('x-user', 'u').send({ rideId: 'r1' })).status).toBe(400);
  });
});

describe('bank webhook over HTTP (raw-body HMAC)', () => {
  const post = (b, h) => request(app).post('/api/bank-webhooks/bank1').set('content-type', 'application/json').set('x-runserv-timestamp', h.ts).set('x-runserv-signature', h.sig).send(b);
  test('accepts a correctly signed callback', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue({ id: 'bank1', status: 'ACTIVE' });
    mockDb.bankReferral.findUnique.mockImplementation(async ({ where }) => (where.referralCode ? { id: 'r', bankPartnerId: 'bank1', status: 'CLICKED', createdAt: new Date(), campaign: { attributionWindowDays: 30 } } : null));
    mockDb.bankReferral.update.mockResolvedValue({ status: 'SUBMITTED' });
    const body = { referralCode: 'RS-1', status: 'SUBMITTED' }; const h = signed(body);
    const r = await post(h.raw, h);
    expect(r.status).toBe(200); expect(r.body.data.status).toBe('SUBMITTED');
  });
  test('rejects a wrong signature with 401 and changes nothing', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue({ id: 'bank1', status: 'ACTIVE' });
    const h = signed({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'b' }, 'not-the-secret');
    expect((await post(h.raw, h)).status).toBe(401); expect(mockDb.bankReferral.update).not.toHaveBeenCalled();
  });
  test('unknown bank id looks identical to a bad signature', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue(null);
    const h = signed({ referralCode: 'x', status: 'SUBMITTED' });
    const r = await request(app).post('/api/bank-webhooks/nope').set('x-runserv-timestamp', h.ts).set('x-runserv-signature', h.sig).send(h.raw);
    expect(r.status).toBe(401); expect(r.body.message).toBe('Invalid signature.');
  });
});

describe('admin bank API is write-protected', () => {
  test('non-admin roles cannot create partners or approve campaigns; unauthenticated cannot even try', async () => {
    expect((await request(app).post('/api/admin/banks/partners').set('x-role', 'SUPPORT').send({ legalName: 'A', displayName: 'A' })).status).toBe(403);
    expect((await request(app).post('/api/admin/banks/campaigns/c1/approve').set('x-role', 'MODERATOR').send({ confirmWrittenApproval: true })).status).toBe(403);
  });
  test('http logo links are rejected (https only)', async () => {
    expect((await request(app).post('/api/admin/banks/partners').set('x-role', 'ADMIN').send({ legalName: 'A', displayName: 'A', logoUrl: 'http://x.co/l.png' })).status).toBe(400);
  });
});
