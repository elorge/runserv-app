// backend/src/services/ledger.service.js
// Append-only, double-entry money ledger. Every event is written as legs that balance (total DEBIT = total CREDIT, per currency).
// The wallet/balance columns stay the fast "current balance"; this is the permanent record that can be audited and reconciled
// against bank statements. The database refuses UPDATE/DELETE/TRUNCATE on LedgerEntry (prisma/sql/post_migrate.sql), so a mistake
// is corrected with a new, opposite entry — never by editing history.
//
// Account names:  WALLET:<walletId> · COMPANY_WALLET:<companyId> · BANK:<receivingAccountId> · SETTLEMENT:<id> · PLATFORM:CLEARING
'use strict';
const crypto = require('crypto');
const { AppError } = require('../middleware/errorHandler');
const { toMinor, fromMinor } = require('../utils/money');

/**
 * @param tx   a Prisma transaction client (post inside the same transaction as the balance change)
 * @param {{refType:string, refId:string, memo?:string, actor?:string, currency:string, legs:{account:string, direction:'DEBIT'|'CREDIT', amount:number}[]}} e
 */
const post = async (tx, e) => {
  if (!tx?.ledgerEntry) return null;                               // callers inside older fakes / scripts simply skip
  if (!e.legs?.length || e.legs.length < 2) throw new AppError('A ledger event needs at least two legs.', 500);
  let d = 0; let c = 0;
  for (const l of e.legs) {
    const m = toMinor(l.amount);
    if (!(m > 0)) throw new AppError('Ledger amounts must be positive.', 500);
    if (l.direction === 'DEBIT') d += m; else if (l.direction === 'CREDIT') c += m; else throw new AppError('Bad ledger direction.', 500);
  }
  if (d !== c) throw new AppError('Ledger event does not balance.', 500);
  const group = crypto.randomUUID();
  const rows = e.legs.map((l, i) => ({ entryGroup: group, account: l.account, currency: e.currency, direction: l.direction, amount: fromMinor(toMinor(l.amount)), refType: e.refType, refId: String(e.refId), memo: e.memo ? String(e.memo).slice(0, 300) : null, actorId: e.actor || null, idempotencyKey: `${group}:${i}` }));
  await tx.ledgerEntry.createMany({ data: rows });
  return group;
};

/** A single money movement between a named account and the clearing account (the "other side" outside the wallet). */
const move = (tx, { account, direction, amount, currency, refType, refId, memo, actor, counter = 'PLATFORM:CLEARING' }) =>
  post(tx, { refType, refId, memo, actor, currency, legs: [{ account, direction, amount }, { account: counter, direction: direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount }] });

/** Net position of an account from the ledger alone (credits − debits), for reconciliation against the balance column. */
const balanceOf = async (prisma, account, currency) => {
  const rows = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { account, currency }, _sum: { amount: true } });
  const sum = (dir) => toMinor(rows.find((r) => r.direction === dir)?._sum.amount ?? 0);
  return fromMinor(sum('CREDIT') - sum('DEBIT'));
};

module.exports = { post, move, balanceOf };
