// backend/src/services/openingBalances.service.js — one-off, approved, idempotent opening-balance backfill for balances that exist with NO ledger history.
// Covers customer/driver/partner wallets (WALLET:<id>) AND company wallets (COMPANY_WALLET:<id>). Posting is idempotent per account
// (idempotencyKey OPENING:<account>), needs a named approver and an approval reference, and is audited. On a brand-new database there is nothing to do.
'use strict';
const prisma = require('../lib/prisma');
const ledger = require('./ledger.service');
const { toMinor, fromMinor } = require('../utils/money');

const findCandidates = async (db = prisma) => {
  const wallets = await db.$queryRawUnsafe(`SELECT 'WALLET' AS kind, w.id, w.currency, w.balance::text AS balance FROM "Wallet" w WHERE w.balance <> 0 AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" l WHERE l.account = 'WALLET:' || w.id)`);
  const companies = await db.$queryRawUnsafe(`SELECT 'COMPANY_WALLET' AS kind, c.id, c.currency, c."walletBalance"::text AS balance FROM "Company" c WHERE c."walletBalance" <> 0 AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" l WHERE l.account = 'COMPANY_WALLET:' || c.id)`);
  return [...wallets, ...companies];
};

const totalsByCurrency = (rows) => {
  const t = {}; for (const r of rows) t[r.currency] = (t[r.currency] || 0) + toMinor(r.balance);
  return Object.fromEntries(Object.entries(t).map(([c, v]) => [c, fromMinor(v)]));
};

/** Posts one balanced OPENING_BALANCE event per candidate. A negative balance is refused (it needs a human decision, not a silent debit). */
const post = async (rows, { approvedBy, approvalRef, db = prisma } = {}) => {
  if (!approvedBy || !approvalRef) throw new Error('Posting opening balances needs an approver (--approved-by) and an approval reference (--approval-ref).');
  let posted = 0;
  for (const r of rows) {
    const amount = Number(r.balance);
    if (!(amount > 0)) throw new Error(`Refusing ${r.kind}:${r.id}: balance ${r.balance} is not positive — resolve with Finance first.`);
    const account = `${r.kind}:${r.id}`;
    await db.$transaction((tx) => ledger.move(tx, { account, direction: 'CREDIT', amount, currency: r.currency, refType: 'OPENING_BALANCE', refId: r.id, memo: `Opening balance; approved by ${approvedBy} (${approvalRef})`.slice(0, 300), counter: 'PLATFORM:OPENING', idempotencyKey: `OPENING:${account}` }));
    posted += 1;
  }
  try { await db.activityLog?.create({ data: { action: 'ledger_opening_balances_posted', entityType: 'Ledger', entityId: approvalRef, details: { approvedBy, count: posted, totals: totalsByCurrency(rows) } } }); } catch { /* audit is best-effort here; the ledger rows carry the approval text */ }
  return { posted, totals: totalsByCurrency(rows) };
};

module.exports = { findCandidates, totalsByCurrency, post };
