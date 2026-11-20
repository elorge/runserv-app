'use strict';
const mockDb = {
  bankOffer: { findUnique: jest.fn(), findMany: jest.fn() },
  bankOfferDailyStat: { upsert: jest.fn().mockResolvedValue({}) },
  bankOfferClick: { create: jest.fn() },
  bankReferral: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  bankRedemption: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  bankCampaign: { updateMany: jest.fn(), update: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
  $transaction: jest.fn(),
};
jest.mock('../src/lib/prisma', () => mockDb);
process.env.BANK_TRIP_BENEFITS_ENABLED = 'true'; // the default-off behaviour is covered in bankHardening.test.js
const svc = require('../src/services/bankOffers.service');

const NOW = new Date('2026-11-17T12:00:00Z');
const bank = (o = {}) => ({ id: 'bank1', displayName: 'Test Bank', status: 'ACTIVE', agreementReference: 'AGR-1', agreementStartAt: '2026-01-01', agreementEndAt: '2027-12-31', logoUrl: 'https://x.co/l.png', ...o });
const camp = (o = {}) => ({ id: 'c1', campaignCode: 'RSC-1', status: 'ACTIVE', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z', budgetAmount: '100000', spentAmount: '0', currency: 'NGN', attributionWindowDays: 30, ...o });
const offer = (o = {}) => ({ id: 'o1', campaignId: 'c1', title: '10% off', offerType: 'DISCOUNT', eligibilityType: 'PUBLIC', isPublished: true, termsAndConditions: 'T&C', discountPercent: '10', accountOpeningUrl: 'https://bank.example/open', ...o });
const D = (o = {}, c = {}, b = {}) => svc.isDisplayable({ offer: offer(o), campaign: camp(c), bank: bank(b) }, NOW, {});

describe('display rules — only approved, in-window, funded offers of an active bank', () => {
  test('a clean offer is displayable', () => expect(D().ok).toBe(true));
  test.each([
    ['draft campaign', {}, { status: 'DRAFT' }, {}, 'CAMPAIGN_NOT_APPROVED'],
    ['pending approval', {}, { status: 'PENDING_APPROVAL' }, {}, 'CAMPAIGN_NOT_APPROVED'],
    ['paused', {}, { status: 'PAUSED' }, {}, 'CAMPAIGN_NOT_APPROVED'],
    ['cancelled', {}, { status: 'CANCELLED' }, {}, 'CAMPAIGN_NOT_APPROVED'],
    ['not started', {}, { startsAt: '2026-12-01T00:00:00Z' }, {}, 'NOT_STARTED'],
    ['ended', {}, { endsAt: '2026-11-17T11:59:59Z' }, {}, 'ENDED'],
    ['no dates', {}, { startsAt: null }, {}, 'NO_DATES'],
    ['budget exhausted', {}, { spentAmount: '100000' }, {}, 'BUDGET_EXHAUSTED'],
    ['unpublished offer', { isPublished: false }, {}, {}, 'NOT_PUBLISHED'],
    ['offer without terms', { termsAndConditions: '' }, {}, {}, 'NO_TERMS'],
    ['bank paused', {}, {}, { status: 'PAUSED' }, 'BANK_NOT_ACTIVE'],
    ['bank terminated', {}, {}, { status: 'TERMINATED' }, 'BANK_NOT_ACTIVE'],
    ['no agreement reference', {}, {}, { agreementReference: null }, 'NO_AGREEMENT'],
    ['agreement ended', {}, {}, { agreementEndAt: '2026-10-31' }, 'AGREEMENT_ENDED'],
    ['agreement not started', {}, {}, { agreementStartAt: '2026-12-01' }, 'AGREEMENT_NOT_STARTED'],
  ])('%s → hidden (%s)', (_n, o, c, b, reason) => { const r = D(o, c, b); expect(r.ok).toBe(false); expect(r.reason).toBe(reason); });
  test('scheduled campaigns display once their start time has passed', () => expect(D({}, { status: 'SCHEDULED' }).ok).toBe(true));
  test('credit and deferred-payment offers are hidden unless explicitly enabled', () => {
    for (const t of ['CREDIT', 'DEFERRED_PAYMENT']) {
      expect(D({ offerType: t }).reason).toBe('CREDIT_NOT_ENABLED');
      expect(svc.isDisplayable({ offer: offer({ offerType: t }), campaign: camp(), bank: bank() }, NOW, { BANK_CREDIT_OFFERS_ENABLED: 'true' }).ok).toBe(true);
    }
  });
  test('customer view hides internal fields and always carries a no-guarantee disclaimer', () => {
    const v = svc.toCustomerOffer({ offer: offer({ offerType: 'CREDIT' }), campaign: camp(), bank: bank() });
    expect(JSON.stringify(v)).not.toMatch(/budget|spent|createdBy|approvedBy/i);
    expect(v.disclaimer).toMatch(/not guaranteed/i);
    expect(svc.toCustomerOffer({ offer: offer({ offerType: 'ACCOUNT_OPENING' }), campaign: camp(), bank: bank() }).disclaimer).toMatch(/subject to the bank/i);
    expect(svc.toCustomerOffer({ offer: offer(), campaign: camp(), bank: bank() }).disclaimer).toBeTruthy();
  });
});

describe('benefit calculation', () => {
  test('percentage, cap, minimum trip, fixed amount, sponsored', () => {
    expect(svc.computeBenefit(offer({ discountPercent: '10' }), 5000)).toEqual({ eligible: true, benefitMinor: 50000 });
    expect(svc.computeBenefit(offer({ discountPercent: '10', maxBenefitAmount: '300' }), 5000).benefitMinor).toBe(30000);
    expect(svc.computeBenefit(offer({ discountPercent: '10', minTripAmount: '2000' }), 1500)).toMatchObject({ eligible: false, reason: 'BELOW_MINIMUM_TRIP' });
    expect(svc.computeBenefit(offer({ discountPercent: null, discountAmount: '500' }), 5000).benefitMinor).toBe(50000);
    expect(svc.computeBenefit(offer({ discountPercent: null, discountAmount: '9000' }), 5000).benefitMinor).toBe(500000); // never more than the trip
    expect(svc.computeBenefit(offer({ offerType: 'SPONSORED_RIDE', discountPercent: null, maxBenefitAmount: '2000' }), 5000).benefitMinor).toBe(200000);
  });
  test('non-trip offers and bad amounts give nothing', () => {
    expect(svc.computeBenefit(offer({ offerType: 'ACCOUNT_OPENING' }), 5000).eligible).toBe(false);
    expect(svc.computeBenefit(offer(), 0).eligible).toBe(false);
    expect(svc.computeBenefit(offer(), -5).eligible).toBe(false);
  });
  test('integer arithmetic: 12.5% of 1234.57 rounds half-up in kobo', () => {
    expect(svc.computeBenefit(offer({ discountPercent: '12.5' }), 1234.57).benefitMinor).toBe(15432); // 123457*0.125 = 15432.125
  });
});

describe('outbound click → referral (no personal data to the bank)', () => {
  beforeEach(() => { jest.clearAllMocks(); mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer(), campaign: { ...camp(), bankPartner: bank() } }); mockDb.bankOfferClick.create.mockResolvedValue({ id: 'ck1' }); mockDb.bankReferral.create.mockResolvedValue({}); });
  test('creates a CLICKED referral and returns a URL containing only opaque params', async () => {
    const r = await svc.trackClick({ userId: 'user-secret-id', offerId: 'o1' });
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe('https://bank.example/open');
    expect([...u.searchParams.keys()].sort()).toEqual(['ref', 'utm_campaign', 'utm_source']);
    expect(r.url).not.toContain('user-secret-id');
    expect(mockDb.bankReferral.create.mock.calls[0][0].data).toMatchObject({ status: 'CLICKED', bankPartnerId: 'bank1', campaignId: 'c1' });
  });
  test('a click on a hidden offer is a 404', async () => {
    mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer(), campaign: { ...camp({ status: 'PAUSED' }), bankPartner: bank() } });
    await expect(svc.trackClick({ userId: 'u', offerId: 'o1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb.bankReferral.create).not.toHaveBeenCalled();
  });
  test('non-https destination is refused', () => { expect(() => svc.buildOutboundUrl('http://bank.example', { referralCode: 'x', campaignCode: 'y' })).toThrow(); });
  test('impressions only count displayable offers, once per call, max 20', async () => {
    mockDb.bankOffer.findUnique.mockImplementation(async ({ where }) => where.id === 'hidden' ? { ...offer({ id: 'hidden' }), campaign: { ...camp({ status: 'DRAFT' }), bankPartner: bank() } } : { ...offer({ id: where.id }), campaign: { ...camp(), bankPartner: bank() } });
    expect(await svc.recordImpressions(['o1', 'o1', 'hidden', 'o2'])).toBe(2);
    expect(mockDb.bankOfferDailyStat.upsert).toHaveBeenCalledTimes(2);
  });
});

describe('redemption', () => {
  let tx;
  beforeEach(() => {
    jest.clearAllMocks();
    tx = { bankCampaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() }, bankRedemption: { create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data })), count: jest.fn().mockResolvedValue(1) } };
    mockDb.$transaction.mockImplementation(async (fn) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn)));
    mockDb.bankRedemption.findUnique.mockResolvedValue(null);
    mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer({ redemptionLimit: 100, perCustomerLimit: 2 }), campaign: { ...camp(), bankPartner: bank() } });
  });
  const go = (o = {}) => svc.redeem({ userId: 'u1', offerId: 'o1', amount: 5000, idempotencyKey: 'key-12345678', ...o });
  test('reserves the benefit and charges the campaign budget atomically', async () => {
    const r = await go();
    expect(r.replay).toBe(false); expect(r.redemption).toMatchObject({ benefitAmount: 500, status: 'RESERVED' });
    expect(tx.bankCampaign.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', spentAmount: { lte: 99500 } }, data: { spentAmount: { increment: 500 } } });
  });
  test('budget exhausted by a concurrent redemption → 409, nothing reserved', async () => {
    tx.bankCampaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: /budget/ });
    expect(tx.bankRedemption.create).not.toHaveBeenCalled();
  });
  test('global and per-customer limits are enforced (transaction rolls back by throwing)', async () => {
    tx.bankRedemption.count.mockResolvedValueOnce(101);
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: /redemption limit/ });
    tx.bankRedemption.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    await expect(go()).rejects.toMatchObject({ statusCode: 409, message: /maximum number/ });
  });
  test('idempotent: same key + same user returns the original; another user is refused', async () => {
    mockDb.bankRedemption.findUnique.mockResolvedValue({ id: 'r0', userId: 'u1', offerId: 'o1', status: 'RESERVED', benefitAmount: '500', currency: 'NGN' });
    expect(await go()).toMatchObject({ replay: true }); expect(mockDb.$transaction).not.toHaveBeenCalled();
    await expect(go({ userId: 'u2' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('missing idempotency key, hidden offer and ineligible trip are all refused', async () => {
    await expect(go({ idempotencyKey: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer({ minTripAmount: '2000' }), campaign: { ...camp(), bankPartner: bank() } });
    await expect(go({ amount: 1000 })).rejects.toMatchObject({ statusCode: 422 });
    mockDb.bankOffer.findUnique.mockResolvedValue({ ...offer(), campaign: { ...camp({ status: 'PAUSED' }), bankPartner: bank() } });
    await expect(go()).rejects.toMatchObject({ statusCode: 404 });
  });
  test('release returns budget; only the owner may release; only RESERVED can be released', async () => {
    mockDb.bankRedemption.findUnique.mockResolvedValue({ id: 'r1', userId: 'u1', campaignId: 'c1', status: 'RESERVED', benefitAmount: '500' });
    mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb)); mockDb.bankRedemption.updateMany.mockResolvedValue({ count: 1 }); mockDb.bankCampaign.update.mockResolvedValue({});
    await expect(svc.releaseRedemption({ redemptionId: 'r1', userId: 'u2' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.releaseRedemption({ redemptionId: 'r1', userId: 'u1' })).resolves.toEqual({ released: true });
    expect(mockDb.bankCampaign.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { spentAmount: { decrement: 500 } } });
    mockDb.bankRedemption.findUnique.mockResolvedValue({ id: 'r1', userId: 'u1', status: 'CONFIRMED' });
    await expect(svc.releaseRedemption({ redemptionId: 'r1', userId: 'u1' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('bank callbacks — signed, idempotent, forward-only, bank-scoped', () => {
  const SECRET = 's3cret'; const env = { BANK_WEBHOOK_SECRETS: JSON.stringify({ bank1: SECRET, bank2: 'other' }) };
  const send = (payload, { bank = 'bank1', secret = SECRET, ts = Math.floor(NOW.getTime() / 1000) } = {}) => {
    const raw = JSON.stringify(payload);
    return svc.processBankCallback({ bankPartnerId: bank, rawBody: Buffer.from(raw), env, now: NOW, headers: { 'x-runserv-timestamp': String(ts), 'x-runserv-signature': svc.sign(secret, ts, raw) } });
  };
  const ref = (o = {}) => ({ id: 'ref1', bankPartnerId: 'bank1', status: 'CLICKED', createdAt: new Date('2026-11-10T00:00:00Z'), applicationAt: null, campaign: { attributionWindowDays: 30 }, campaignId: 'c1', ...o });
  beforeEach(() => { jest.clearAllMocks(); mockDb.bankReferral.findUnique.mockImplementation(async ({ where }) => (where.referralCode ? ref() : null)); mockDb.bankReferral.update.mockImplementation(async ({ data }) => ({ status: data.status })); });

  test('valid signed VERIFIED callback verifies the referral', async () => {
    expect(await send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'BNK-9', conversionValue: 0 })).toEqual({ duplicate: false, status: 'VERIFIED' });
    const d = mockDb.bankReferral.update.mock.calls[0][0].data;
    expect(d).toMatchObject({ status: 'VERIFIED', bankExternalRef: 'BNK-9' }); expect(d.verifiedAt).toBeInstanceOf(Date);
  });
  test('bad signature, wrong secret, missing headers, stale or future timestamp → 401', async () => {
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'x' }, { secret: 'wrong' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'x' }, { ts: Math.floor(NOW.getTime() / 1000) - 3600 })).rejects.toMatchObject({ statusCode: 401 });
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'x' }, { ts: Math.floor(NOW.getTime() / 1000) + 3600 })).rejects.toMatchObject({ statusCode: 401 });
    await expect(svc.processBankCallback({ bankPartnerId: 'bank1', rawBody: '{}', headers: {}, env, now: NOW })).rejects.toMatchObject({ statusCode: 401 });
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'x' }, { bank: 'bank3' })).rejects.toMatchObject({ statusCode: 401 }); // no secret configured
    expect(mockDb.bankReferral.update).not.toHaveBeenCalled();
  });
  test('tampered body fails the signature', async () => {
    const raw = JSON.stringify({ referralCode: 'RS-1', status: 'DECLINED' }); const ts = Math.floor(NOW.getTime() / 1000);
    await expect(svc.processBankCallback({ bankPartnerId: 'bank1', rawBody: raw.replace('DECLINED', 'VERIFIED'), env, now: NOW, headers: { 'x-runserv-timestamp': String(ts), 'x-runserv-signature': svc.sign(SECRET, ts, raw) } })).rejects.toMatchObject({ statusCode: 401 });
  });
  test('a bank cannot touch another bank’s referral', async () => {
    mockDb.bankReferral.findUnique.mockResolvedValue(ref({ bankPartnerId: 'bank2' }));
    await expect(send({ referralCode: 'RS-1', status: 'SUBMITTED' })).rejects.toMatchObject({ statusCode: 404 });
  });
  test('replay of the same status is an idempotent 200', async () => {
    mockDb.bankReferral.findUnique.mockResolvedValue(ref({ status: 'VERIFIED' }));
    expect(await send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'BNK-9' })).toEqual({ duplicate: true, status: 'VERIFIED' });
    expect(mockDb.bankReferral.update).not.toHaveBeenCalled();
  });
  test('cannot go backwards, nor change a terminal referral', async () => {
    mockDb.bankReferral.findUnique.mockResolvedValue(ref({ status: 'SUBMITTED' }));
    await expect(send({ referralCode: 'RS-1', status: 'APPLICATION_STARTED' })).rejects.toMatchObject({ statusCode: 409 });
    mockDb.bankReferral.findUnique.mockResolvedValue(ref({ status: 'DECLINED' }));
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'z' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('VERIFIED needs a bank reference; CLICKED cannot be sent by a bank; bad status', async () => {
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send({ referralCode: 'RS-1', status: 'CLICKED' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send({ referralCode: 'RS-1', status: 'NOPE' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('outside the attribution window → 422 and a click-only referral is expired', async () => {
    mockDb.bankReferral.findUnique.mockResolvedValue(ref({ createdAt: new Date('2026-09-01T00:00:00Z') }));
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'late' })).rejects.toMatchObject({ statusCode: 422 });
    expect(mockDb.bankReferral.update.mock.calls[0][0].data).toEqual({ status: 'EXPIRED' });
  });
  test('the same bank reference cannot verify two referrals', async () => {
    mockDb.bankReferral.findUnique.mockImplementation(async ({ where }) => (where.referralCode ? ref() : { id: 'other-ref' }));
    await expect(send({ referralCode: 'RS-1', status: 'VERIFIED', bankReference: 'BNK-9' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('application stages are recorded but are not verification', async () => {
    await send({ referralCode: 'RS-1', status: 'APPLICATION_STARTED' });
    const d = mockDb.bankReferral.update.mock.calls[0][0].data;
    expect(d.status).toBe('APPLICATION_STARTED'); expect(d.verifiedAt).toBeUndefined();
  });
});
