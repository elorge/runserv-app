'use strict';
// WP-01 acceptance: "No production path can mutate a wallet without passing through the canonical financial service."
const fs = require('fs'); const path = require('path');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const SRC = path.join(__dirname, '..', 'src');
const files = walk(SRC).filter((f) => f.endsWith('.js'));

describe('wallet balance is only written by walletOps', () => {
  test('no other file increments/decrements/sets Wallet.balance', () => {
    const offenders = [];
    for (const f of files) {
      if (f.endsWith(path.join('services', 'walletOps.js'))) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/balance:\s*\{\s*(increment|decrement|set)\b/.test(src)) offenders.push(path.relative(SRC, f));
      if (/wallet\.(update|updateMany|upsert)\([^)]*balance\s*:\s*[^{]/s.test(src) && /data:\s*\{[^}]*balance\s*:\s*[\w.]+\s*[,}]/.test(src)) offenders.push(path.relative(SRC, f) + ' (absolute set)');
    }
    expect(offenders).toEqual([]);
  });
  test('ledger posting needs refType and refId (no silent unledgered mutation)', async () => {
    const { debitWallet, creditWallet } = require('../src/services/walletOps');
    const tx = { wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    await expect(debitWallet(tx, { id: 'w' }, 5, { currency: 'NGN' })).rejects.toMatchObject({ statusCode: 500 });
    await expect(creditWallet(tx, { id: 'w' }, 5, null)).rejects.toMatchObject({ statusCode: 500 });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });
  test('debit + credit write balanced legs keyed WALLET:<id> with the idempotency key', async () => {
    const { debitWallet, creditWallet } = require('../src/services/walletOps');
    const tx = { wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } };
    await debitWallet(tx, { id: 'w1' }, 10, { currency: 'NGN', refType: 'T', refId: 'r', idempotencyKey: 'K1' });
    await creditWallet(tx, { id: 'w1' }, 10, { currency: 'NGN', refType: 'T', refId: 'r2', idempotencyKey: 'K2' });
    const [a, b] = tx.ledgerEntry.createMany.mock.calls.map((c) => c[0].data);
    expect(a.map((r) => r.account).sort()).toEqual(['PLATFORM:CLEARING', 'WALLET:w1']);
    expect(a[0].idempotencyKey).toBe('K1:0'); expect(b[1].idempotencyKey).toBe('K2:1');
    expect(a.reduce((s, r) => s + (r.direction === 'DEBIT' ? r.amount : -r.amount), 0)).toBe(0);
  });
  test('array-form creditOp returns the balance update and ledger op; refuses missing context', () => {
    const { creditOp } = require('../src/services/walletOps');
    const db = { wallet: { update: jest.fn(() => 'U') }, ledgerEntry: { createMany: jest.fn(() => 'L') } };
    expect(creditOp(db, { walletId: 'w', currency: 'NGN', amount: 5, refType: 'X', refId: '1' })).toEqual({ update: 'U', ledger: 'L' });
    expect(() => creditOp(db, { walletId: 'w', currency: 'NGN', amount: 5, refType: 'X' })).toThrow(/mandatory/);
  });
});
