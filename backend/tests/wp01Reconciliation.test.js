'use strict';
jest.mock('../src/lib/prisma', () => ({
  ledgerReconciliationRun: { create: jest.fn(async () => ({ id: 'run1' })), update: jest.fn(async ({ data }) => ({ id: 'run1', ...data })) },
  $queryRawUnsafe: jest.fn(),
  payout: { groupBy: jest.fn(async () => [{ currency: 'NGN', _sum: { amount: 500 } }]) },
}));
jest.mock('../src/services/opsAlert.service', () => ({ raiseAndDeliver: jest.fn(async () => ({})) }));
const prisma = require('../src/lib/prisma');
const recon = require('../src/services/ledgerReconciliation.service');

describe('compareBalances', () => {
  test('exact match is clean; any minor-unit difference is an exception; unledgered balances are flagged', () => {
    const r = recon.compareBalances([
      { id: 'a', currency: 'NGN', balance: '100.10', ledger: '100.10' },
      { id: 'b', currency: 'NGN', balance: '100.11', ledger: '100.10' },
      { id: 'c', currency: 'NGN', balance: '50.00', ledger: null },
      { id: 'd', currency: 'NGN', balance: '0.00', ledger: null },
    ], 'WALLET');
    expect(r.map((x) => [x.id, x.type, x.variance])).toEqual([['b', 'VARIANCE', 0.01], ['c', 'UNLEDGERED_BALANCE', 50]]);
  });
});
describe('run()', () => {
  beforeEach(() => jest.clearAllMocks());
  const feed = (unb, w, c) => prisma.$queryRawUnsafe.mockImplementation(async (sql) => sql.includes('CURRENCY_MISMATCH_ENTRY') ? [] : sql.includes('ledger_unbalanced') ? unb : sql.includes('"Wallet"') ? w : c);
  test('zero variance → OK, no alert, liabilities summarised', async () => {
    feed([], [{ id: 'w1', currency: 'NGN', balance: '10.00', ledger: '10.00' }], [{ id: 'c1', currency: 'NGN', balance: '5.00', ledger: '5.00' }]);
    const r = await recon.run();
    expect(r.status).toBe('OK'); expect(require('../src/services/opsAlert.service').raiseAndDeliver).not.toHaveBeenCalled();
    expect(r.summary.liabilitiesByCurrency.NGN).toEqual({ walletBalances: 10, pendingPayouts: 500 });
  });
  test('variance or unbalanced event → EXCEPTIONS, listed and alerted', async () => {
    feed([{ entryGroup: 'g1', currency: 'NGN' }], [{ id: 'w1', currency: 'NGN', balance: '10.00', ledger: '9.00' }], []);
    const r = await recon.run({ trigger: 'MANUAL', actorId: 'u1' });
    expect(r.status).toBe('EXCEPTIONS'); expect(r.exceptions.map((e) => e.type)).toEqual(['UNBALANCED_EVENT', 'VARIANCE']);
    expect(require('../src/services/opsAlert.service').raiseAndDeliver).toHaveBeenCalledTimes(1);
  });
  test('a failing query marks the run FAILED and rethrows', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    await expect(recon.run()).rejects.toThrow('db down');
    expect(prisma.ledgerReconciliationRun.update.mock.calls.pop()[0].data.status).toBe('FAILED');
  });
});
