'use strict';
const q = jest.fn(); const created = [];
const db = { $queryRawUnsafe: q, $transaction: jest.fn(async (fn) => fn({ ledgerEntry: { createMany: jest.fn(async ({ data }) => { created.push(...data); return { count: data.length }; }) } })), activityLog: { create: jest.fn(async () => ({})) } };
jest.mock('../src/lib/prisma', () => ({}));
const svc = require('../src/services/openingBalances.service');
beforeEach(() => { created.length = 0; q.mockReset(); });
test('finds wallets AND company wallets with no ledger history', async () => {
  q.mockResolvedValueOnce([{ kind: 'WALLET', id: 'w1', currency: 'NGN', balance: '10.50' }]).mockResolvedValueOnce([{ kind: 'COMPANY_WALLET', id: 'c1', currency: 'NGN', balance: '100.00' }]);
  const rows = await svc.findCandidates(db); expect(rows.map((r) => r.kind)).toEqual(['WALLET', 'COMPANY_WALLET']); expect(svc.totalsByCurrency(rows)).toEqual({ NGN: 110.5 });
});
test('posting needs an approver and a reference; nothing is written otherwise', async () => {
  await expect(svc.post([{ kind: 'WALLET', id: 'w', currency: 'NGN', balance: '5' }], { db })).rejects.toThrow(/approver/); expect(created).toHaveLength(0);
});
test('posts one balanced, idempotent event per account against PLATFORM:OPENING, with the approval in the memo', async () => {
  const r = await svc.post([{ kind: 'COMPANY_WALLET', id: 'c1', currency: 'NGN', balance: '100.00' }], { approvedBy: 'Finance Lead', approvalRef: 'FIN-1', db });
  expect(r.posted).toBe(1); expect(created).toHaveLength(2);
  expect(created.find((x) => x.account === 'COMPANY_WALLET:c1')).toMatchObject({ direction: 'CREDIT', amount: 100, refType: 'OPENING_BALANCE', idempotencyKey: 'OPENING:COMPANY_WALLET:c1:0' });
  expect(created.find((x) => x.account === 'PLATFORM:OPENING').direction).toBe('DEBIT'); expect(created[0].memo).toMatch(/Finance Lead \(FIN-1\)/);
});
test('a negative balance is refused, not silently debited', async () => {
  await expect(svc.post([{ kind: 'WALLET', id: 'w', currency: 'NGN', balance: '-5' }], { approvedBy: 'a', approvalRef: 'b', db })).rejects.toThrow(/not positive/);
});
