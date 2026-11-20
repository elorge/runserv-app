'use strict';
const mockDb = {};
const fn = () => jest.fn();
jest.mock('../src/lib/prisma', () => {
  mockDb.corporateTrip = { aggregate: fn() };
  mockDb.companyInvoice = { findMany: fn() };
  mockDb.company = { update: fn(), findMany: fn() };
  mockDb.orgWalletTx = { create: fn(), findUnique: fn() };
  mockDb.companyEmployee = { findMany: fn() };
  mockDb.notification = { findFirst: fn() };
  mockDb.$transaction = jest.fn(async (cb) => cb(mockDb));
  return mockDb;
});
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn().mockResolvedValue({}) }));
const w = require('../src/services/orgWallet.service');
const notifications = require('../src/services/notification.service');

const base = { id: 'c1', currency: 'NGN', billingMode: 'PREPAID', walletBalance: 10000, creditLimit: 0, verificationStatus: 'UNVERIFIED', creditTermsSignedAt: null, lowBalanceThreshold: 0 };
const verified = { verificationStatus: 'VERIFIED', creditTermsSignedAt: new Date(), creditLimit: 100000 };
const state = ({ held = 0, unbilled = 0, owed = [] } = {}) => {
  mockDb.corporateTrip.aggregate.mockReset()
    .mockResolvedValueOnce({ _sum: { fare: held } }).mockResolvedValueOnce({ _sum: { creditAmount: unbilled } });
  mockDb.companyInvoice.findMany.mockResolvedValue(owed);
};
beforeEach(() => { jest.clearAllMocks(); mockDb.$transaction.mockImplementation(async (cb) => cb(mockDb)); });

describe('credit is a privilege', () => {
  test('only verified + signed terms + a limit', () => {
    expect(w.creditAllowed({ ...base, ...verified })).toBe(true);
    expect(w.creditAllowed({ ...base, ...verified, verificationStatus: 'UNDER_REVIEW' })).toBe(false);
    expect(w.creditAllowed({ ...base, ...verified, creditTermsSignedAt: null })).toBe(false);
    expect(w.creditAllowed({ ...base, ...verified, creditLimit: 0 })).toBe(false);
  });
});

describe('funding state', () => {
  test('prepaid: open trips hold part of the wallet', async () => {
    state({ held: 3000 });
    expect(await w.getFundingState(base)).toMatchObject({ walletAvailable: 7000, held: 3000, creditAvailable: 0 });
  });
  test('postpaid: exposure = unpaid invoices (net of receipts) + unbilled credit + open trips', async () => {
    state({ held: 2000, unbilled: 5000, owed: [{ subtotal: 20000, amountPaid: 8000 }] });
    const f = await w.getFundingState({ ...base, ...verified, billingMode: 'POSTPAID', walletBalance: 0 });
    expect(f).toMatchObject({ creditExposure: 12000 + 5000 + 2000, creditAvailable: 100000 - 19000, walletAvailable: 0 });
  });
  test('hybrid: open trips are held against the wallet first', async () => {
    state({ held: 4000 });
    const f = await w.getFundingState({ ...base, ...verified, billingMode: 'HYBRID', walletBalance: 3000 });
    expect(f).toMatchObject({ walletAvailable: 0, creditExposure: 1000 });
  });
  test('an unapproved company has no credit available even if a limit is stored', async () => {
    state();
    expect((await w.getFundingState({ ...base, billingMode: 'POSTPAID', creditLimit: 50000 })).creditAvailable).toBe(0);
  });
});

describe('plan at completion', () => {
  test('prepaid pays all from the wallet (may overdraw); postpaid all on credit; hybrid splits', () => {
    expect(w.planFunding({ ...base, billingMode: 'PREPAID', walletBalance: 100 }, 2000)).toEqual({ walletPaid: 2000, creditAmount: 0 });
    expect(w.planFunding({ ...base, billingMode: 'POSTPAID' }, 2000)).toEqual({ walletPaid: 0, creditAmount: 2000 });
    expect(w.planFunding({ ...base, billingMode: 'HYBRID', walletBalance: 750 }, 2000)).toEqual({ walletPaid: 750, creditAmount: 1250 });
    expect(w.planFunding({ ...base, billingMode: 'HYBRID', walletBalance: -300 }, 2000)).toEqual({ walletPaid: 0, creditAmount: 2000 });
  });
});

describe('wallet ledger', () => {
  test('top-up credits the balance and writes a ledger line with the balance after', async () => {
    mockDb.company.update.mockResolvedValue({ walletBalance: 60000 });
    mockDb.orgWalletTx.create.mockImplementation(async ({ data }) => data);
    const tx = await w.topUp({ companyId: 'c1', amount: 50000, reference: 'PS-1', createdById: 'fin' });
    expect(mockDb.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { walletBalance: { increment: 50000 } }, select: { walletBalance: true, currency: true } });
    expect(tx).toMatchObject({ type: 'TOPUP', amount: 50000, balanceAfter: 60000, reference: 'PS-1' });
  });
  test('verifying the same payment twice credits once', async () => {
    mockDb.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    mockDb.orgWalletTx.findUnique.mockResolvedValue({ id: 'existing', reference: 'PS-1' });
    expect((await w.topUp({ companyId: 'c1', amount: 50000, reference: 'PS-1' })).id).toBe('existing');
  });
  test('zero / negative top-ups are refused', () => {
    expect(() => w.topUp({ companyId: 'c1', amount: 0 })).toThrow(); expect(() => w.adjust({ companyId: 'c1', amount: 0 })).toThrow();
  });
});

describe('daily alerts', () => {
  test('a low prepaid wallet alerts admins/finance once a day', async () => {
    mockDb.company.findMany.mockResolvedValue([{ ...base, walletBalance: 500, lowBalanceThreshold: 5000 }]);
    state(); mockDb.companyEmployee.findMany.mockResolvedValue([{ userId: 'fin1' }]); mockDb.notification.findFirst.mockResolvedValue(null);
    expect((await w.runBalanceAlerts()).sent).toBe(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'fin1', type: 'org_low_balance' }));
    mockDb.notification.findFirst.mockResolvedValue({ id: 'recent' }); state();
    notifications.notify.mockClear();
    expect((await w.runBalanceAlerts()).sent).toBe(0);
  });
});
