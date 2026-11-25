'use strict';
// Release-blocker regressions: wallet currency can never be chosen by the caller; the ledger fails closed; reconciliation is per currency; ledger-check fails on variance.
const fs = require('fs'); const path = require('path');
const ops = require('../src/services/walletOps');
const ledger = require('../src/services/ledger.service');

/** A tiny stateful wallet table that honours the id/currency/balance predicates the way Postgres would. */
const bank = (rows) => {
  const match = (w, where) => w.id === where.id && (where.currency === undefined || w.currency === where.currency) && (where.balance?.gte === undefined || w.balance >= where.balance.gte);
  const ledgerRows = [];
  return {
    rows, ledgerRows,
    wallet: {
      findUnique: jest.fn(async ({ where }) => rows.find((w) => (where.id ? w.id === where.id : w.userId === where.userId)) || null),
      updateMany: jest.fn(async ({ where, data }) => { const w = rows.find((x) => match(x, where)); if (!w) return { count: 0 }; w.balance += (data.balance.increment ?? -data.balance.decrement); return { count: 1 }; }),
      update: jest.fn(async ({ where, data }) => { const w = rows.find((x) => match(x, where)); if (!w) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' }); w.balance += data.balance.increment; return w; }),
    },
    ledgerEntry: { createMany: jest.fn(async ({ data }) => { ledgerRows.push(...data); return { count: data.length }; }) },
  };
};
const M = (currency) => ({ currency, refType: 'T', refId: 'r1' });

describe('P0: wallet currency is never caller-selectable', () => {
  test('debit with the wrong currency (id known) is refused, no money moves, nothing is journalled', async () => {
    const db = bank([{ id: 'w1', userId: 'u1', currency: 'NGN', balance: 100 }]);
    await expect(ops.debitWallet(db, { id: 'w1' }, 10, M('USD'))).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH', statusCode: 409 });
    expect(db.rows[0].balance).toBe(100); expect(db.ledgerRows).toHaveLength(0);
  });
  test('credit with the wrong currency is refused (id and userId forms)', async () => {
    const db = bank([{ id: 'w1', userId: 'u1', currency: 'NGN', balance: 0 }]);
    await expect(ops.creditWallet(db, { id: 'w1' }, 10, M('USD'))).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH' });
    await expect(ops.creditWallet(db, { userId: 'u1' }, 10, M('USD'))).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH' });
    expect(db.rows[0].balance).toBe(0); expect(db.ledgerRows).toHaveLength(0);
  });
  test('creditOp with the wrong currency throws at execution (so the array transaction rolls back)', async () => {
    const db = bank([{ id: 'w1', userId: 'u1', currency: 'NGN', balance: 0 }]);
    const { update } = ops.creditOp(db, { walletId: 'w1', currency: 'USD', amount: 5, refType: 'T', refId: 'r' });
    await expect(update).rejects.toMatchObject({ code: 'P2025' });
    expect(db.rows[0].balance).toBe(0);
  });
  test('correct currency works, and the ledger currency is the wallet\'s own; when no currency is supplied it is read from the row', async () => {
    const db = bank([{ id: 'w1', userId: 'u1', currency: 'NGN', balance: 100 }]);
    await ops.debitWallet(db, { id: 'w1' }, 10, M('NGN')); await ops.creditWallet(db, { userId: 'u1' }, 5, { refType: 'T', refId: 'r2' });
    expect(db.rows[0].balance).toBe(95); expect(db.ledgerRows.every((r) => r.currency === 'NGN')).toBe(true); expect(db.ledgerRows).toHaveLength(4);
  });
  test('insufficient funds and missing wallets are still told apart from a currency mismatch', async () => {
    const db = bank([{ id: 'w1', userId: 'u1', currency: 'NGN', balance: 5 }]);
    await expect(ops.debitWallet(db, { id: 'w1' }, 10, M('NGN'))).rejects.toMatchObject({ statusCode: 400 });
    await expect(ops.debitWallet(db, { id: 'nope' }, 10, M('NGN'))).rejects.toMatchObject({ statusCode: 404 });
    expect(await ops.tryDebitWallet(db, { id: 'w1' }, 10, M('NGN'))).toBe(false);
    await expect(ops.tryDebitWallet(db, { id: 'w1' }, 1, M('USD'))).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH' });
  });
});

describe('P0: the ledger fails closed', () => {
  const was = process.env.NODE_ENV; afterEach(() => { process.env.NODE_ENV = was; });
  test('outside the test runner, a client with no ledger table throws instead of skipping (post, move, moveOp)', async () => {
    process.env.NODE_ENV = 'production';
    const args = { account: 'WALLET:w', direction: 'CREDIT', amount: 1, currency: 'NGN', refType: 'T', refId: '1' };
    await expect(ledger.move({}, args)).rejects.toMatchObject({ statusCode: 500 });
    expect(() => ledger.moveOp({}, args)).toThrow(/Ledger unavailable/);
    expect(() => ops.creditOp({ wallet: { update: jest.fn() } }, { walletId: 'w', currency: 'NGN', amount: 1, refType: 'T', refId: '1' })).toThrow(/Ledger unavailable/);
  });
  test('under NODE_ENV=test the old fakes may still skip', async () => {
    process.env.NODE_ENV = 'test';
    await expect(ledger.move({}, { account: 'a', direction: 'CREDIT', amount: 1, currency: 'NGN', refType: 'T', refId: '1' })).resolves.toBeNull();
  });
});

describe('P0: reconciliation is per currency and reports stray entries', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/ledgerReconciliation.service.js'), 'utf8');
  test('ledger sums are restricted to the account\'s own currency, for wallets and companies', () => {
    expect(src).toMatch(/'WALLET:' \|\| w\.id AND l\.currency = w\.currency/);
    expect(src).toMatch(/'COMPANY_WALLET:' \|\| c\.id AND l\.currency = c\.currency/);
  });
  test('currency-mismatch and orphan-account entries become exceptions', async () => {
    jest.resetModules();
    const q = jest.fn(async (sql) => sql.includes('CURRENCY_MISMATCH_ENTRY') ? [{ type: 'CURRENCY_MISMATCH_ENTRY', kind: 'WALLET', id: 'w1', accountCurrency: 'NGN', entryCurrency: 'USD', entries: 2 }, { type: 'ORPHAN_ACCOUNT_ENTRY', kind: 'WALLET', id: 'gone', accountCurrency: null, entryCurrency: 'NGN', entries: 1 }] : sql.includes('ledger_unbalanced') ? [] : []);
    jest.doMock('../src/lib/prisma', () => ({ $queryRawUnsafe: q }));
    const { findExceptions } = require('../src/services/ledgerReconciliation.service');
    const r = await findExceptions();
    expect(r.exceptions.map((e) => e.type)).toEqual(['CURRENCY_MISMATCH_ENTRY', 'ORPHAN_ACCOUNT_ENTRY']);
  });
});

describe('P0: ledger-check fails on every variance', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/ledger-check.js'), 'utf8');
  test('uses the shared exception finder (covers unledgered balances via LEFT-style null ledger) and exits 1 on any exception', () => {
    expect(src).toMatch(/findExceptions/); expect(src).toMatch(/exceptions\.length[\s\S]*process\.exit\(1\)/);
    expect(src).not.toMatch(/console\.warn/);
  });
});
