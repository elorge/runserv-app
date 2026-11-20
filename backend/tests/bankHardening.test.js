'use strict';
// M5 audit fixes on the Bank Offers customer API.
const mockDb = {
  bankOffer: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  bankOfferDailyStat: { upsert: jest.fn().mockResolvedValue({}) },
  bankOfferClick: { create: jest.fn() },
  bankReferral: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  bankRedemption: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
  bankCampaign: { updateMany: jest.fn(), update: jest.fn() },
  ride: { findUnique: jest.fn() },
  delivery: { findUnique: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
  $transaction: jest.fn(),
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], countryCode: 'NG' }; next(); },
  authorize: () => (req, res, next) => next(),
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const svc = require('../src/services/bankOffers.service');
const { offers } = require('../src/routes/bankOffers.routes');

const app = express(); app.use(express.json()); app.use('/api/offers', offers); app.use(errorHandler);

const bank = () => ({ id: 'bank1', displayName: 'Test Bank', status: 'ACTIVE', agreementReference: 'AGR-1', agreementStartAt: '2026-01-01', agreementEndAt: '2030-12-31' });
const camp = (o = {}) => ({ id: 'c1', campaignCode: 'RSC-1', status: 'ACTIVE', startsAt: '2026-01-01T00:00:00Z', endsAt: '2030-12-31T00:00:00Z', budgetAmount: '100000', spentAmount: '0', currency: 'NGN', attributionWindowDays: 30, ...o });
const offer = (o = {}) => ({ id: 'o1', campaignId: 'c1', title: '10% off', offerType: 'DISCOUNT', eligibilityType: 'PUBLIC', isPublished: true, termsAndConditions: 'T&C', discountPercent: '10', accountOpeningUrl: 'https://bank.example/open', ...o });
const load = (o) => mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer(o), campaign: { ...camp(), bankPartner: bank() } });

beforeEach(() => { jest.resetAllMocks(); mockDb.bankOfferDailyStat.upsert.mockResolvedValue({}); mockDb.bankOffer.findMany.mockResolvedValue([]); delete process.env.BANK_TRIP_BENEFITS_ENABLED; });

describe('trip-benefit offers stay closed until Decision 4 is made (BANK_TRIP_BENEFITS_ENABLED)', () => {
  test('default is off', () => expect(svc.tripBenefitsEnabled({})).toBe(false));
  test('a discount offer is not viewable, clickable or countable while off; an account-opening offer is', async () => {
    load({ offerType: 'DISCOUNT' });
    await expect(svc.viewOffer('o1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.trackClick({ userId: 'u1', offerId: 'o1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.recordImpressions(['o1'], { userId: 'u9' })).toBe(0);
    load({ offerType: 'ACCOUNT_OPENING' });
    expect((await svc.viewOffer('o1')).id).toBe('o1');
  });
  test('the feed omits discount offers while off and includes them when on', async () => {
    const row = (o) => ({ ...offer(o), campaign: { ...camp(), bankPartner: bank() } });
    mockDb.bankOffer.findMany.mockResolvedValue([row({ id: 'a', offerType: 'DISCOUNT' }), row({ id: 'b', offerType: 'ACCOUNT_OPENING' })]);
    expect((await svc.listOffers()).map((o) => o.id)).toEqual(['b']);
    process.env.BANK_TRIP_BENEFITS_ENABLED = 'true';
    expect((await svc.listOffers()).map((o) => o.id)).toEqual(['a', 'b']);
  });
  test('quote and redeem answer 404 over HTTP while off; the feed reports the flag', async () => {
    expect((await request(app).post('/api/offers/o1/quote').set('x-user', 'u').send({ amount: 100 })).status).toBe(404);
    expect((await request(app).post('/api/offers/o1/redeem').set('x-user', 'u').send({ rideId: 'r', idempotencyKey: 'abcdefgh' })).status).toBe(404);
    const r = await request(app).get('/api/offers').set('x-user', 'u');
    expect(r.body.data.tripBenefitsEnabled).toBe(false);
  });
});

describe('redeem uses the server’s own trip, never the client’s numbers', () => {
  const key = 'idem-key-12345';
  const post = (b) => request(app).post('/api/offers/o1/redeem').set('x-user', 'u1').send({ idempotencyKey: key, ...b });
  beforeEach(() => {
    process.env.BANK_TRIP_BENEFITS_ENABLED = 'true'; load();
    mockDb.bankRedemption.findUnique.mockResolvedValue(null); mockDb.bankRedemption.findFirst.mockResolvedValue(null); mockDb.bankRedemption.count.mockResolvedValue(1);
    mockDb.bankCampaign.updateMany.mockResolvedValue({ count: 1 });
    mockDb.bankRedemption.create.mockImplementation(async ({ data }) => ({ id: 'red1', ...data }));
    mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb));
  });
  test('needs exactly one of rideId / deliveryId', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ rideId: 'r1', deliveryId: 'd1' })).status).toBe(400);
  });
  test('someone else’s trip looks like it does not exist', async () => {
    mockDb.ride.findUnique.mockResolvedValue({ customerId: 'other', status: 'REQUESTED', estimatedFare: 5000 });
    expect((await post({ rideId: 'r1' })).status).toBe(404);
    mockDb.ride.findUnique.mockResolvedValue(null);
    expect((await post({ rideId: 'r1' })).status).toBe(404);
    expect(mockDb.bankRedemption.create).not.toHaveBeenCalled();
  });
  test('only before a driver is assigned', async () => {
    mockDb.ride.findUnique.mockResolvedValue({ customerId: 'u1', status: 'IN_PROGRESS', estimatedFare: 5000 });
    expect((await post({ rideId: 'r1' })).status).toBe(409);
    mockDb.delivery.findUnique.mockResolvedValue({ customerId: 'u1', status: 'ASSIGNED', estimatedFee: 2000 });
    expect((await post({ deliveryId: 'd1' })).status).toBe(409);
  });
  test('the benefit is computed from the stored fare; a client-sent amount is ignored', async () => {
    mockDb.ride.findUnique.mockResolvedValue({ customerId: 'u1', status: 'REQUESTED', estimatedFare: 5000 });
    const r = await post({ rideId: 'r1', amount: 99999999 });
    expect(r.status).toBe(201);
    expect(mockDb.bankRedemption.create.mock.calls[0][0].data).toMatchObject({ tripAmount: 5000, benefitAmount: 500, rideId: 'r1', userId: 'u1' });
  });
  test('a trip holds one live benefit; the same key replays instead of failing', async () => {
    mockDb.ride.findUnique.mockResolvedValue({ customerId: 'u1', status: 'REQUESTED', estimatedFare: 5000 });
    mockDb.bankRedemption.findFirst.mockResolvedValue({ idempotencyKey: 'a-different-key' });
    expect((await post({ rideId: 'r1' })).status).toBe(409);
    mockDb.bankRedemption.findFirst.mockResolvedValue({ idempotencyKey: key });
    mockDb.bankRedemption.findUnique.mockResolvedValue({ id: 'red0', userId: 'u1', offerId: 'o1', status: 'RESERVED', benefitAmount: '500', currency: 'NGN' });
    const r = await post({ rideId: 'r1' });
    expect(r.status).toBe(200); expect(r.body.data.replay).toBe(true);
  });
});

describe('click and impression abuse', () => {
  beforeEach(() => { process.env.BANK_TRIP_BENEFITS_ENABLED = 'true'; load({ offerType: 'ACCOUNT_OPENING' }); });
  test('tapping again reuses the open referral instead of creating another click', async () => {
    mockDb.bankReferral.findFirst.mockResolvedValue({ referralCode: 'RS-ABC' });
    const r = await svc.trackClick({ userId: 'u1', offerId: 'o1' });
    expect(r.reused).toBe(true); expect(r.url).toContain('ref=RS-ABC');
    expect(mockDb.bankOfferClick.create).not.toHaveBeenCalled(); expect(mockDb.bankReferral.create).not.toHaveBeenCalled();
  });
  test('the reuse lookup is scoped to this customer and offer, inside the attribution window, and ignores finished referrals', async () => {
    mockDb.bankReferral.findFirst.mockResolvedValue(null); mockDb.bankOfferClick.create.mockResolvedValue({ id: 'ck' }); mockDb.bankReferral.create.mockResolvedValue({});
    await svc.trackClick({ userId: 'u1', offerId: 'o1' });
    const w = mockDb.bankReferral.findFirst.mock.calls[0][0].where;
    expect(w).toMatchObject({ userId: 'u1', offerId: 'o1', status: { in: ['CLICKED', 'APPLICATION_STARTED', 'SUBMITTED'] } });
    expect(w.createdAt.gte).toBeInstanceOf(Date);
    expect(mockDb.bankReferral.create).toHaveBeenCalledTimes(1);
  });
  test('one impression per customer per offer per hour', async () => {
    expect(await svc.recordImpressions(['o1'], { userId: 'imp-user-1' })).toBe(1);
    expect(await svc.recordImpressions(['o1'], { userId: 'imp-user-1' })).toBe(0);
    expect(await svc.recordImpressions(['o1'], { userId: 'imp-user-2' })).toBe(1);
  });
});

describe('release is safe against races and abandoned reservations', () => {
  beforeEach(() => { mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb)); mockDb.bankCampaign.update.mockResolvedValue({}); });
  test('when another call already released it, the budget is not returned a second time', async () => {
    mockDb.bankRedemption.findUnique.mockResolvedValue({ id: 'r1', userId: 'u1', campaignId: 'c1', status: 'RESERVED', benefitAmount: '500' });
    mockDb.bankRedemption.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.releaseRedemption({ redemptionId: 'r1', userId: 'u1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.bankCampaign.update).not.toHaveBeenCalled();
  });
  test('stale reservations are released; failures on one do not stop the sweep', async () => {
    mockDb.bankRedemption.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mockDb.bankRedemption.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, userId: 'u', campaignId: 'c1', status: 'RESERVED', benefitAmount: '100' }));
    mockDb.bankRedemption.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const now = new Date('2026-11-17T12:00:00Z');
    expect(await svc.releaseStaleReservations({ olderThanMinutes: 60, now })).toEqual({ checked: 2, released: 1 });
    expect(mockDb.bankRedemption.findMany.mock.calls[0][0].where).toMatchObject({ status: 'RESERVED', createdAt: { lt: new Date('2026-11-17T11:00:00Z') } });
  });
});
