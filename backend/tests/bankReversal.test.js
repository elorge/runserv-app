'use strict';
const mockDb = {};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/ledger.service', () => ({ move: jest.fn().mockResolvedValue('g') }));
const ledger = require('../src/services/ledger.service');
const svc = require('../src/services/bankReversal.service');

const NOW = new Date('2026-11-18T10:00:00Z');
const pay = (o = {}) => ({ id: 'abcdef1234567', status: 'MATCHED', amount: 1000, currency: 'NGN', companyId: 'c1', invoiceId: null, settlementId: null, bankTransactionRef: 'TX1', receivingAccountId: 'ra1', ...o });
const setup = ({ payment = pay(), balance = 0, claim = 1, invoice = null } = {}) => {
  const tx = {
    bankPayment: { updateMany: jest.fn().mockResolvedValue({ count: claim }) },
    bankSettlement: { findUnique: jest.fn(), update: jest.fn() },
    company: { findUnique: jest.fn()
      .mockResolvedValueOnce({ id: 'c1', walletBalance: balance, currency: 'NGN', paymentTermsDays: 14, orgCode: 'RS-1' })
      .mockResolvedValue({ walletBalance: 0 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orgWalletTx: { create: jest.fn().mockResolvedValue({ id: 'w1' }) },
    companyInvoice: { create: jest.fn(async ({ data }) => ({ id: 'dn1', ...data })), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
    invoicePayment: { create: jest.fn() },
  };
  if (invoice) { tx.companyInvoice.findUnique.mockResolvedValueOnce(invoice.before).mockResolvedValueOnce(invoice.after); }
  mockDb.bankPayment = { findUnique: jest.fn().mockResolvedValue(payment) };
  mockDb.$transaction = jest.fn((fn) => fn(tx));
  return tx;
};

describe('reversing a bank credit applied to a company', () => {
  beforeEach(() => ledger.move.mockClear());
  test('wallet fully covers it: claw back all, no debit note', async () => {
    const tx = setup({ balance: 5000 });
    const r = await svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'bank recall', now: NOW });
    expect(r).toMatchObject({ clawedBack: 1000, debitNote: null });
    expect(tx.company.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', walletBalance: { gte: 1000 } }, data: { walletBalance: { decrement: 1000 } } });
    expect(ledger.move).toHaveBeenCalledTimes(1);
    expect(tx.companyInvoice.create).not.toHaveBeenCalled();
  });
  test('money already spent: take what is there (never negative) and invoice the rest', async () => {
    const tx = setup({ balance: 300 });
    const r = await svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'bank recall', now: NOW });
    expect(r.clawedBack).toBe(300);
    expect(r.debitNote).toMatchObject({ amount: 700, number: 'DN-ABCDEF12' });
    expect(tx.company.updateMany.mock.calls[0][0].data.walletBalance.decrement).toBe(300);
    const dn = tx.companyInvoice.create.mock.calls[0][0].data;
    expect(dn).toMatchObject({ subtotal: 700, status: 'ISSUED', period: 'DN-ABCDEF12', tripsAmount: 0 });
  });
  test('empty wallet: nothing clawed back, whole amount invoiced', async () => {
    const tx = setup({ balance: 0 });
    const r = await svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'x', now: NOW });
    expect(r).toMatchObject({ clawedBack: 0, debitNote: { amount: 1000 } });
    expect(tx.company.updateMany).not.toHaveBeenCalled();
    expect(ledger.move).not.toHaveBeenCalled();
  });
  test('a credit that paid an invoice reopens it and writes a negative receipt', async () => {
    const before = { id: 'i1', invoiceNumber: 'RS-INV-1', driversSettledAt: null };
    const after = { id: 'i1', subtotal: 1000, amountPaid: 0, dueDate: new Date('2027-01-01') };
    const tx = setup({ payment: pay({ companyId: null, invoiceId: 'i1' }), invoice: { before, after } });
    const r = await svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'recall', now: NOW });
    expect(r.invoiceReopened).toBe('RS-INV-1');
    expect(tx.companyInvoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'ISSUED', paidAt: null } });
    expect(tx.invoicePayment.create.mock.calls[0][0].data).toMatchObject({ amount: -1000, method: 'REVERSAL' });
  });
  test('warns when drivers were already paid from that invoice', async () => {
    const tx = setup({ payment: pay({ companyId: null, invoiceId: 'i1' }), invoice: { before: { id: 'i1', invoiceNumber: 'N', driversSettledAt: NOW }, after: { subtotal: 1000, amountPaid: 0, dueDate: new Date('2027-01-01') } } });
    expect((await svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'r', now: NOW })).driversAlreadyPaid).toBe(true);
    expect(tx).toBeTruthy();
  });
  test('only one reversal can win; already reversed or unapplied credits are refused', async () => {
    setup({ claim: 0 });
    await expect(svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    setup({ payment: pay({ status: 'REVERSED' }) });
    await expect(svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    setup({ payment: pay({ companyId: null }) });
    await expect(svc.apply({ paymentId: 'abcdef1234567', actor: 'u2', note: 'x' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('an open debit note is detected', async () => {
    mockDb.companyInvoice = { findFirst: jest.fn().mockResolvedValue({ id: 'dn1' }) };
    expect(await svc.hasOpenDebitNote('c1')).toBe(true);
    mockDb.companyInvoice.findFirst.mockResolvedValue(null);
    expect(await svc.hasOpenDebitNote('c1')).toBe(false);
  });
});

describe('the request goes through the two-person rule', () => {
  const approvals = require('../src/services/moneyApprovals.service');
  test('requesting is not limited by the admin size cap, refuses duplicates, and moves no money', async () => {
    mockDb.bankPayment = { findUnique: jest.fn().mockResolvedValue({ currency: 'NGN', status: 'MATCHED', companyId: 'c1', invoiceId: null }) };
    mockDb.pendingMoneyAction = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async ({ data }) => ({ id: 'm9', ...data })) };
    const r = await approvals.request({ kind: 'BANK_CREDIT_REVERSAL', targetId: 'p1', amount: 9e9, reason: 'Bank recalled the transfer', actor: 'u1', role: 'ADMIN' });
    expect(r.kind).toBe('BANK_CREDIT_REVERSAL');
    mockDb.pendingMoneyAction.findFirst.mockResolvedValue({ id: 'm9' });
    await expect(approvals.request({ kind: 'BANK_CREDIT_REVERSAL', targetId: 'p1', amount: 1, reason: 'Bank recalled again', actor: 'u1' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
