'use strict';
const mockDb = {
  bankCampaign: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  bankOffer: { updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  bankPartner: { findUnique: jest.fn() },
  bankSettlement: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  bankPayment: { create: jest.fn().mockResolvedValue({}) },
  bankOfferDailyStat: { groupBy: jest.fn() }, bankOfferClick: { groupBy: jest.fn() }, bankReferral: { groupBy: jest.fn() }, bankRedemption: { groupBy: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
  $transaction: jest.fn(async (ops) => (typeof ops === 'function' ? ops(mockDb) : Promise.all(ops))),
};
jest.mock('../src/lib/prisma', () => mockDb);
const svc = require('../src/services/bankAdmin.service');

const NOW = new Date('2026-11-17T12:00:00Z');
const full = (o = {}) => ({ id: 'c1', bankPartnerId: 'b1', status: 'DRAFT', createdById: 'maker', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z', approvedAt: null,
  bankPartner: { id: 'b1', status: 'ACTIVE', agreementReference: 'AGR-1' }, offers: [{ id: 'o1', title: '10% off', offerType: 'DISCOUNT', termsAndConditions: 'T&C', discountPercent: '10' }], ...o });
const set = (c) => { mockDb.bankCampaign.findUnique.mockResolvedValue(c); mockDb.bankCampaign.update.mockImplementation(({ data }) => ({ ...c, ...data })); mockDb.bankOffer.updateMany.mockReturnValue('pub'); };
const act = (action, body = {}, actor = 'checker') => svc.act({ id: 'c1', action, actor, body, now: NOW, env: {} });
beforeEach(() => { jest.clearAllMocks(); mockDb.activityLog.create.mockResolvedValue({}); mockDb.$transaction.mockImplementation(async (ops) => (typeof ops === 'function' ? ops(mockDb) : Promise.all(ops))); mockDb.bankSettlement.updateMany.mockResolvedValue({ count: 1 }); });

describe('campaign approval workflow', () => {
  test('submit requires dates, offers with terms, discount value, https link', async () => {
    for (const [o, re] of [[{ startsAt: null }, /dates/], [{ offers: [] }, /at least one offer/], [{ offers: [{ title: 'x', offerType: 'DISCOUNT', termsAndConditions: ' ', discountPercent: 5 }] }, /terms/], [{ offers: [{ title: 'x', offerType: 'DISCOUNT', termsAndConditions: 't' }] }, /discount value/], [{ offers: [{ title: 'x', offerType: 'ACCOUNT_OPENING', termsAndConditions: 't' }] }, /account-opening link/], [{ endsAt: '2026-10-01' }, /after start/]]) {
      set(full(o)); await expect(act('submit')).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(re) });
    }
  });
  test('draft → pending approval', async () => { set(full()); expect(await act('submit')).toMatchObject({ status: 'PENDING_APPROVAL' }); });
  test('approve needs the written-approval confirmation', async () => {
    set(full({ status: 'PENDING_APPROVAL' })); await expect(act('approve', {})).rejects.toMatchObject({ message: /in writing/ });
  });
  test('maker–checker: creator cannot approve their own campaign', async () => {
    set(full({ status: 'PENDING_APPROVAL' })); await expect(act('approve', { confirmWrittenApproval: true }, 'maker')).rejects.toMatchObject({ statusCode: 403 });
  });
  test('bank must be ACTIVE with an agreement reference', async () => {
    set(full({ status: 'PENDING_APPROVAL', bankPartner: { id: 'b1', status: 'PAUSED', agreementReference: 'A' } })); await expect(act('approve', { confirmWrittenApproval: true })).rejects.toMatchObject({ message: /not ACTIVE/ });
    set(full({ status: 'PENDING_APPROVAL', bankPartner: { id: 'b1', status: 'ACTIVE', agreementReference: null } })); await expect(act('approve', { confirmWrittenApproval: true })).rejects.toMatchObject({ message: /agreement reference/ });
  });
  test('approval goes ACTIVE if already started, SCHEDULED if in the future, and publishes the offers', async () => {
    set(full({ status: 'PENDING_APPROVAL' })); expect(await act('approve', { confirmWrittenApproval: true })).toMatchObject({ status: 'ACTIVE', approvedById: 'checker' });
    expect(mockDb.bankOffer.updateMany).toHaveBeenCalledWith({ where: { campaignId: 'c1' }, data: { isPublished: true } });
    set(full({ status: 'PENDING_APPROVAL', startsAt: '2026-12-01T00:00:00Z' })); expect(await act('approve', { confirmWrittenApproval: true })).toMatchObject({ status: 'SCHEDULED' });
  });
  test('cannot approve a campaign that has already ended', async () => {
    set(full({ status: 'PENDING_APPROVAL', startsAt: '2026-01-01', endsAt: '2026-02-01' })); await expect(act('approve', { confirmWrittenApproval: true })).rejects.toMatchObject({ message: /already ended/ });
  });
  test('only approved states can be approved; drafts cannot skip review', async () => {
    set(full()); await expect(act('approve', { confirmWrittenApproval: true })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('reject returns to draft and needs a note', async () => {
    set(full({ status: 'PENDING_APPROVAL' })); await expect(act('reject', {})).rejects.toMatchObject({ statusCode: 400 });
    expect(await act('reject', { note: 'logo wrong' })).toMatchObject({ status: 'DRAFT' });
  });
  test('pause / resume / cancel rules', async () => {
    set(full({ status: 'ACTIVE', approvedAt: NOW })); expect(await act('pause')).toMatchObject({ status: 'PAUSED' });
    set(full({ status: 'PAUSED', approvedAt: NOW })); expect(await act('resume')).toMatchObject({ status: 'ACTIVE' });
    set(full({ status: 'PAUSED', approvedAt: null })); await expect(act('resume')).rejects.toMatchObject({ message: /never approved/ });
    set(full({ status: 'DRAFT' })); await expect(act('pause')).rejects.toMatchObject({ statusCode: 400 });
    set(full({ status: 'ACTIVE' })); expect(await act('cancel')).toMatchObject({ status: 'CANCELLED' });
    expect(mockDb.bankOffer.updateMany).toHaveBeenLastCalledWith({ where: { campaignId: 'c1' }, data: { isPublished: false } });
    set(full({ status: 'EXPIRED' })); await expect(act('cancel')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('every state change is audited', async () => { set(full()); await act('submit'); expect(mockDb.activityLog.create.mock.calls[0][0].data.action).toBe('bank_campaign_submitted'); });
});

describe('approved creative cannot be silently changed', () => {
  test('editing a live campaign returns it to draft and unpublishes offers', async () => {
    set(full({ status: 'ACTIVE', approvedAt: NOW }));
    const r = await svc.updateCampaign({ id: 'c1', data: { name: 'New headline' }, actor: 'a' });
    expect(r.returnedToDraft).toBe(true); expect(mockDb.bankCampaign.update.mock.calls[0][0].data).toMatchObject({ status: 'DRAFT', approvedAt: null });
    expect(mockDb.bankOffer.updateMany).toHaveBeenCalledWith({ where: { campaignId: 'c1' }, data: { isPublished: false } });
  });
  test('editing a draft stays a draft; closed campaigns are not editable; unknown fields are dropped', async () => {
    set(full()); const r = await svc.updateCampaign({ id: 'c1', data: { name: 'x', status: 'ACTIVE', spentAmount: 0 }, actor: 'a' });
    expect(r.returnedToDraft).toBe(false); expect(mockDb.bankCampaign.update.mock.calls[0][0].data).toEqual({ name: 'x' });
    set(full({ status: 'CANCELLED' })); await expect(svc.updateCampaign({ id: 'c1', data: { name: 'x' }, actor: 'a' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('editing a live offer’s terms sends the campaign back for approval; changing display priority does not', async () => {
    mockDb.bankOffer.findUnique.mockResolvedValue({ id: 'o1', campaignId: 'c1', campaign: { id: 'c1', status: 'ACTIVE' } }); mockDb.bankOffer.update.mockReturnValue('o'); mockDb.bankCampaign.update.mockReturnValue('c');
    expect((await svc.updateOffer({ offerId: 'o1', data: { termsAndConditions: 'new terms' }, actor: 'a' })).campaignReturnedToDraft).toBe(true);
    expect((await svc.updateOffer({ offerId: 'o1', data: { displayPriority: 5 }, actor: 'a' })).campaignReturnedToDraft).toBe(false);
  });
});

describe('reporting keeps funnel stages separate', () => {
  test('a click is not a conversion', async () => {
    mockDb.bankCampaign.findUnique.mockResolvedValue(full({ budgetAmount: '1000', spentAmount: '250.5', currency: 'NGN' }));
    mockDb.bankOfferDailyStat.groupBy.mockResolvedValue([{ _sum: { impressions: 1000, views: 120 } }]);
    mockDb.bankOfferClick.groupBy.mockResolvedValue([{ _count: { _all: 40 } }]);
    mockDb.bankReferral.groupBy.mockResolvedValue([{ status: 'CLICKED', _count: { _all: 20 } }, { status: 'APPLICATION_STARTED', _count: { _all: 8 } }, { status: 'SUBMITTED', _count: { _all: 5 } }, { status: 'VERIFIED', _count: { _all: 3 } }, { status: 'DECLINED', _count: { _all: 1 } }]);
    mockDb.bankRedemption.groupBy.mockResolvedValue([{ status: 'CONFIRMED', _count: { _all: 7 }, _sum: { benefitAmount: '700' } }]);
    const r = await svc.campaignReport('c1');
    expect(r.totals).toMatchObject({ impressions: 1000, views: 120, clicks: 40, applicationsStarted: 17, submitted: 9, verifiedConversions: 3, declined: 1, redemptions: 7 });
    expect(r.budget).toEqual({ amount: 1000, spent: 250.5, remaining: 749.5 });
    expect(r.funnelNote).toMatch(/NOT bank accounts/);
  });
});

describe('bank settlements', () => {
  test('overlap refused; negative net refused; campaign must belong to the bank', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue({ id: 'b1' }); mockDb.bankSettlement.findFirst.mockResolvedValue({ id: 'old' });
    await expect(svc.createSettlement({ bankPartnerId: 'b1', periodStart: '2026-11-01', periodEnd: '2026-12-01', agreedAmount: 100, actor: 'a' })).rejects.toMatchObject({ statusCode: 409 });
    mockDb.bankSettlement.findFirst.mockResolvedValue(null);
    await expect(svc.createSettlement({ bankPartnerId: 'b1', periodStart: '2026-11-01', periodEnd: '2026-12-01', agreedAmount: 100, adjustmentsAmount: -500, actor: 'a' })).rejects.toMatchObject({ statusCode: 400 });
    mockDb.bankCampaign.findFirst.mockResolvedValue(null);
    await expect(svc.createSettlement({ bankPartnerId: 'b1', campaignId: 'cX', periodStart: '2026-11-01', periodEnd: '2026-12-01', agreedAmount: 100, actor: 'a' })).rejects.toMatchObject({ statusCode: 404 });
  });
  test('net = agreed + adjustments in minor units', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue({ id: 'b1' }); mockDb.bankSettlement.findFirst.mockResolvedValue(null); mockDb.bankSettlement.create.mockImplementation(async ({ data }) => data);
    expect((await svc.createSettlement({ bankPartnerId: 'b1', periodStart: '2026-11-01', periodEnd: '2026-12-01', agreedAmount: 1000.10, adjustmentsAmount: -0.2, actor: 'a' })).netAmount).toBe(999.9);
  });
  test('maker–checker on PAID', async () => {
    mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'x' }); mockDb.bankSettlement.updateMany.mockResolvedValue({ count: 1 }); mockDb.bankSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', bankPartnerId: 'b1', netAmount: 1000, receivedAmount: 0, currency: 'NGN' });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'x', env: {}, bankTransactionRef: 'STMT-123456' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'y', env: {}, bankTransactionRef: 'STMT-123456' })).resolves.toMatchObject({ id: 's' });
  });
  test('marking paid by hand needs the bank\'s transaction reference and records a manual receipt', async () => {
    mockDb.bankSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', bankPartnerId: 'b1', netAmount: 1000, receivedAmount: 250, currency: 'NGN' }); mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'x' }); mockDb.bankSettlement.updateMany.mockResolvedValue({ count: 1 });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'y', env: {} })).rejects.toMatchObject({ statusCode: 400 });
    await svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'y', env: {}, bankTransactionRef: 'STMT-123456' });
    expect(mockDb.bankPayment.create.mock.calls[0][0].data).toMatchObject({ source: 'MANUAL', amount: 750, status: 'MATCHED', bankTransactionRef: 'STMT-123456' });
  });
  test('M12: a lost race on PAID returns 409 and records NO receipt (double-click safe)', async () => {
    mockDb.bankSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', bankPartnerId: 'b1', netAmount: 1000, receivedAmount: 0, currency: 'NGN' });
    mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'x' });
    mockDb.bankSettlement.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'y', env: {}, bankTransactionRef: 'STMT-123456' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.bankPayment.create).not.toHaveBeenCalled();
    expect(mockDb.bankSettlement.updateMany.mock.calls[0][0].where).toEqual({ id: 's', status: 'APPROVED' });
  });
  test('M12: non-PAID transitions are conditional on the validated status (409 if changed)', async () => {
    mockDb.bankSettlement.findUnique.mockResolvedValue({ id: 's', status: 'PENDING' });
    mockDb.bankSettlement.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.transitionSettlement({ id: 's', to: 'RECONCILING', actor: 'y', env: {} })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.bankSettlement.updateMany.mock.calls[0][0].where).toEqual({ id: 's', status: 'PENDING' });
  });
  test('M12: settlement creation takes a per-bank advisory lock inside a transaction', async () => {
    mockDb.bankPartner.findUnique.mockResolvedValue({ id: 'b1' }); mockDb.bankSettlement.findFirst.mockResolvedValue(null); mockDb.bankSettlement.create.mockImplementation(async ({ data }) => data);
    await svc.createSettlement({ bankPartnerId: 'b1', periodStart: '2026-11-01', periodEnd: '2026-12-01', agreedAmount: 10, actor: 'a' });
    expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });
});
