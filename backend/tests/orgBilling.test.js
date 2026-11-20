'use strict';
const mockDb = {};
const fn = () => jest.fn();
jest.mock('../src/lib/prisma', () => {
  mockDb.company = { findUnique: fn(), findMany: fn() };
  mockDb.companyEmployee = { findMany: fn() };
  mockDb.companyInvoice = { findUnique: fn(), create: fn(), update: fn(), count: fn(), updateMany: fn() };
  mockDb.invoicePayment = { create: fn() };
  mockDb.corporateTrip = { findMany: fn(), updateMany: fn(), update: fn(), count: fn() };
  mockDb.orgPayout = { upsert: fn(), update: fn(), count: fn(), findMany: fn() };
  mockDb.wallet = { update: fn(), findUnique: fn() };
  mockDb.walletTransaction = { create: fn() };
  mockDb.payment = { updateMany: fn() };
  mockDb.$transaction = jest.fn(async (ops) => (typeof ops === 'function' ? ops(mockDb) : Promise.all(ops)));
  return mockDb;
});
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/utils/walletHelpers', () => ({ ensureWallet: jest.fn() }));

const billing = require('../src/services/orgBilling.service');
const notifications = require('../src/services/notification.service');

const company = { id: 'c1', name: 'Acme Ltd', orgCode: 'RS-4K9Q2X', timezone: 'Africa/Lagos', currency: 'NGN', paymentTermsDays: 14, subscriptionFee: 0 };
const NOW = new Date('2026-12-01T01:00:00Z');

beforeEach(() => {
  jest.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (ops) => (typeof ops === 'function' ? ops(mockDb) : Promise.all(ops)));
  notifications.notify.mockResolvedValue({});
  require('../src/utils/walletHelpers').ensureWallet.mockImplementation(async (id) => ({ id: `w-${id}` }));
  mockDb.company.findUnique.mockResolvedValue(company);
  mockDb.companyEmployee.findMany.mockResolvedValue([{ userId: 'fin1' }]);
  mockDb.companyInvoice.findUnique.mockResolvedValue(null);
  mockDb.companyInvoice.create.mockImplementation(async ({ data }) => ({ id: 'inv1', ...data }));
  mockDb.companyInvoice.update.mockImplementation(async ({ data }) => ({ id: 'inv1', companyId: 'c1', subscriptionAmount: 0, issuedAt: NOW, dueDate: new Date('2026-12-15T01:00:00Z'), currency: 'NGN', ...data }));
});

describe('monthly invoice = credit part of the trips + subscription', () => {
  const trips = [
    { fare: 2000, creditAmount: 2000, commissionAmount: 360, driverEarnings: 1640, driverPaidAmount: 0, distanceKm: 10 },
    { fare: 2000, creditAmount: 1500, commissionAmount: 360, driverEarnings: 1640, driverPaidAmount: 410, distanceKm: 8 },   // hybrid: 500 came from the wallet
  ];
  test('bills only what went on credit, in the company timezone, and finds what drivers are still owed', async () => {
    mockDb.corporateTrip.findMany.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]).mockResolvedValueOnce(trips);
    const inv = await billing.generateInvoiceForCompany({ companyId: 'c1', now: NOW });
    const where = mockDb.corporateTrip.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', status: 'COMPLETED', invoiceId: null, creditAmount: { gt: 0 } });
    expect(where.tripAt.gte.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(where.tripAt.lt.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(inv).toMatchObject({ tripCount: 2, tripsAmount: 3500, subtotal: 3500, driverPayable: 1640 + 1230, totalDistanceKm: 18 });
    expect(inv.platformFee).toBeCloseTo(360 + 360 * 0.75, 2);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'fin1', type: 'org_invoice_issued' }));
  });
  test('the subscription fee is added; a month with only a subscription still gets an invoice', async () => {
    mockDb.company.findUnique.mockResolvedValue({ ...company, subscriptionFee: 25000 });
    let created; mockDb.companyInvoice.create.mockImplementation(async ({ data }) => (created = { id: 'inv1', ...data }));
    mockDb.companyInvoice.update.mockImplementation(async ({ data }) => ({ ...created, ...data }));
    mockDb.corporateTrip.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const inv = await billing.generateInvoiceForCompany({ companyId: 'c1', now: NOW });
    expect(inv).toMatchObject({ tripsAmount: 0, subscriptionAmount: 25000, subtotal: 25000 });
  });
  test('nothing on credit and no subscription → no invoice; paid invoices are never touched', async () => {
    mockDb.corporateTrip.findMany.mockResolvedValueOnce([]);
    expect(await billing.generateInvoiceForCompany({ companyId: 'c1', now: NOW })).toBeNull();
    mockDb.companyInvoice.findUnique.mockResolvedValue({ id: 'inv1', status: 'PAID' });
    expect((await billing.generateInvoiceForCompany({ companyId: 'c1', now: NOW })).status).toBe('PAID');
  });
  test('bad period', async () => {
    await expect(billing.generateInvoiceForCompany({ companyId: 'c1', period: '2026-13', now: NOW })).rejects.toThrow(/Invalid billing period/);
  });
});

describe('receipts (reconciliation) and paying drivers', () => {
  const inv = (o = {}) => ({ id: 'inv1', companyId: 'c1', period: '2026-11', status: 'ISSUED', currency: 'NGN', subtotal: 5000, amountPaid: 0, company, invoiceNumber: 'RS-INV-202611-4K9Q2X', ...o });
  const trips = [
    { id: 't1', earnerUserId: 'dA', fare: 2000, creditAmount: 2000, commissionAmount: 360, driverEarnings: 1640, driverPaidAmount: 0, distanceKm: 10 },
    { id: 't2', earnerUserId: 'dA', fare: 2000, creditAmount: 1500, commissionAmount: 360, driverEarnings: 1640, driverPaidAmount: 410, distanceKm: 4 },
    { id: 't3', earnerUserId: 'dB', fare: 1500, creditAmount: 1500, commissionAmount: 270, driverEarnings: 1230, driverPaidAmount: 0, distanceKm: 9 },
  ];
  beforeEach(() => {
    mockDb.orgPayout.upsert.mockImplementation(async ({ create }) => ({ id: `p-${create.userId}`, ...create }));
    mockDb.corporateTrip.count.mockResolvedValue(0);
  });

  test('a part payment keeps the invoice open and pays nobody yet', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValueOnce(inv()).mockResolvedValue(inv({ amountPaid: 2000 }));
    mockDb.companyInvoice.updateMany.mockResolvedValue({ count: 1 });
    mockDb.companyInvoice.update.mockImplementation(async ({ data }) => ({ id: 'inv1', ...data }));
    const r = await billing.recordPayment({ invoiceId: 'inv1', amount: 2000, reference: 'TRF-1', recordedById: 'admin' });
    expect(mockDb.invoicePayment.create.mock.calls[0][0].data).toMatchObject({ invoiceId: 'inv1', amount: 2000, reference: 'TRF-1' });
    // the money goes in as a database-side increment, never as "paid so far (read earlier) + amount"
    expect(mockDb.companyInvoice.updateMany.mock.calls[0][0].data).toEqual({ amountPaid: { increment: 2000 } });
    expect(mockDb.companyInvoice.update).toHaveBeenCalledWith({ where: { id: 'inv1' }, data: { status: 'PARTIALLY_PAID' } });
    expect(r).toMatchObject({ fullyPaid: false, settlement: null });
    expect(mockDb.wallet.update).not.toHaveBeenCalled();
  });
  test('two receipts landing together: the one that no longer fits is refused, not added', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv());
    mockDb.companyInvoice.updateMany.mockResolvedValue({ count: 0 });   // someone else got there first
    await expect(billing.recordPayment({ invoiceId: 'inv1', amount: 2000 })).rejects.toThrow(/changed by someone else/);
    expect(mockDb.invoicePayment.create).not.toHaveBeenCalled();
  });
  test('the receipt that completes the payment marks it PAID, collects the ride payments and pays every driver', async () => {
    mockDb.companyInvoice.updateMany.mockResolvedValue({ count: 1 });
    mockDb.companyInvoice.update.mockImplementation(async ({ data }) => ({ id: 'inv1', ...data }));
    mockDb.companyInvoice.findUnique.mockResolvedValueOnce(inv({ status: 'PARTIALLY_PAID', amountPaid: 2000 })).mockResolvedValueOnce(inv({ status: 'PARTIALLY_PAID', amountPaid: 5000 })).mockResolvedValue(inv({ status: 'PAID', amountPaid: 5000 }));
    mockDb.corporateTrip.findMany.mockResolvedValueOnce([{ rideId: 'r1' }]).mockResolvedValueOnce([]).mockResolvedValueOnce(trips);
    const r = await billing.recordPayment({ invoiceId: 'inv1', amount: 3000, recordedById: 'admin' });
    expect(r.fullyPaid).toBe(true);
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { rideId: { in: ['r1'] }, method: 'CORPORATE' }, data: { status: 'COMPLETED' } });
    // driver A is owed (1640 − 0) + (1640 − 410) = 2870 — NOT the full 3280 — because 410 was paid at completion
    const credits = Object.fromEntries(mockDb.walletTransaction.create.mock.calls.map((c) => [c[0].data.walletId, c[0].data.amount]));
    expect(credits).toEqual({ 'w-dA': 2870, 'w-dB': 1230 });
    expect(r.settlement).toMatchObject({ paid: 2, failed: 0, totalPaid: 4100 });
    expect(mockDb.corporateTrip.update).toHaveBeenCalledWith({ where: { id: 't2' }, data: { payoutStatus: 'PAID', driverPaidAmount: 1640, orgPayoutId: 'p-dA' } });
  });
  test('over-payment, zero and payments on paid/void invoices are refused', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv());
    await expect(billing.recordPayment({ invoiceId: 'inv1', amount: 9999 })).rejects.toThrow(/more than/);
    await expect(billing.recordPayment({ invoiceId: 'inv1', amount: 0 })).rejects.toThrow(/amount received/);
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ status: 'PAID', amountPaid: 5000 }));
    await expect(billing.recordPayment({ invoiceId: 'inv1', amount: 1 })).rejects.toThrow(/already fully paid/);
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ status: 'VOID' }));
    await expect(billing.recordPayment({ invoiceId: 'inv1', amount: 1 })).rejects.toThrow(/voided/);
  });
  test('drivers are not paid before the company has paid in full, unless Runserv pays in advance', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ status: 'PARTIALLY_PAID', amountPaid: 100 }));
    mockDb.corporateTrip.findMany.mockResolvedValue(trips);
    await expect(billing.settleDriversForInvoice({ invoiceId: 'inv1' })).rejects.toThrow(/paid its invoice in full/);
    await expect(billing.settleDriversForInvoice({ invoiceId: 'inv1', advance: true })).resolves.toMatchObject({ paid: 2 });
  });
  test('running settlement twice never double-credits', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ status: 'PAID', amountPaid: 5000 }));
    mockDb.corporateTrip.findMany.mockResolvedValue(trips);
    mockDb.orgPayout.upsert.mockImplementation(async ({ create }) => ({ id: `p-${create.userId}`, ...create, status: 'PAID' }));
    expect((await billing.settleDriversForInvoice({ invoiceId: 'inv1' })).paid).toBe(0);
    expect(mockDb.walletTransaction.create).not.toHaveBeenCalled();
  });
  test('one failing payout does not stop the rest and the invoice stays open for a retry', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ status: 'PAID', amountPaid: 5000 }));
    mockDb.corporateTrip.findMany.mockResolvedValue(trips);
    mockDb.wallet.update.mockImplementation(async ({ where }) => { if (where.id === 'w-dA') throw new Error('db down'); return {}; });
    expect(await billing.settleDriversForInvoice({ invoiceId: 'inv1' })).toMatchObject({ paid: 1, failed: 1 });
    expect(mockDb.companyInvoice.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { driversSettledAt: expect.any(Date) } }));
  });
  test('an invoice with receipts or driver payouts cannot be voided', async () => {
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv({ amountPaid: 100 }));
    await expect(billing.voidInvoice({ invoiceId: 'inv1' })).rejects.toThrow(/received payment/);
    mockDb.companyInvoice.findUnique.mockResolvedValue(inv()); mockDb.orgPayout.count.mockResolvedValue(1);
    await expect(billing.voidInvoice({ invoiceId: 'inv1' })).rejects.toThrow(/already paid/);
  });
});

describe('driver dashboard', () => {
  test('paid (incl. wallet-funded trips) / on an invoice the company has not paid / not yet invoiced — per organisation', async () => {
    const c = (name) => ({ name, logoUrl: null });
    mockDb.corporateTrip.findMany.mockResolvedValue([
      { companyId: 'c1', driverEarnings: 1640, driverPaidAmount: 1640, distanceKm: 10, invoiceId: null, company: c('Acme') },     // prepaid, paid instantly
      { companyId: 'c1', driverEarnings: 1640, driverPaidAmount: 410, distanceKm: 4, invoiceId: 'i2', company: c('Acme') },        // hybrid: 410 now, 1230 on invoice
      { companyId: 'c1', driverEarnings: 820, driverPaidAmount: 0, distanceKm: 5, invoiceId: null, company: c('Acme') },
      { companyId: 'c2', driverEarnings: 3280, driverPaidAmount: 0, distanceKm: 20, invoiceId: 'i3', company: c('Beta') },
    ]);
    mockDb.orgPayout.findMany.mockResolvedValue([]); mockDb.wallet.findUnique.mockResolvedValue({ currency: 'NGN' });
    const s = await billing.getEarnerSummary('d1');
    expect(s.totals).toMatchObject({ paid: 2050, awaitingCompanyPayment: 1230 + 3280, notYetBilled: 820, trips: 4, distanceKm: 39 });
    expect(s.byOrganisation.find((o) => o.name === 'Acme')).toMatchObject({ trips: 3, paid: 2050, awaitingCompanyPayment: 1230, notYetBilled: 820 });
    expect(s.byOrganisation[0].name).toBe('Beta');
  });
});
