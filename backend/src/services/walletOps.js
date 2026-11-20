// backend/src/services/walletOps.js
// Atomic wallet debits. Every place that spends a user's balance must use debitWallet inside a database
// transaction. It is ONE conditional UPDATE ("take the money only if the balance covers it"), so two requests
// racing each other can never both succeed on the same money (the old "read balance, check, decrement" pattern let
// a user withdraw or transfer the same naira twice by sending two requests at once).
'use strict';
const { AppError } = require('../middleware/errorHandler');
const ledger = require('./ledger.service');

/** @param {object} tx  Prisma transaction client  @param {{userId?:string,id?:string}} where  @param {number} amount */
const walletAccount = (where) => (where.id ? `WALLET:${where.id}` : `WALLET_OF_USER:${where.userId}`);
/** `meta` (optional): { currency, refType, refId, memo, actor } also writes the ledger entry, in the same transaction. */
const debitWallet = async (tx, where, amount, meta = null) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Invalid amount.', 400);
  const r = await tx.wallet.updateMany({ where: { ...where, balance: { gte: n } }, data: { balance: { decrement: n } } });
  if (r.count !== 1) throw new AppError('Insufficient wallet balance', 400);
  if (meta) await ledger.move(tx, { account: walletAccount(where), direction: 'DEBIT', amount: n, ...meta });
};

/** The rider's own choice, stored when the trip is requested. Only an explicit WALLET is acted on; anything else is
 *  treated as cash/card handled outside the wallet. The driver can no longer pick the method at completion. */
const riderPaymentChoice = (v) => (String(v || '').toUpperCase() === 'WALLET' ? 'WALLET' : 'CASH');

/**
 * Top-ups: a pending row is "claimed" atomically before the wallet is credited, so the customer's verify call and the
 * provider's webhook (or two taps) can never both credit the same payment. Returns null when someone else already has it.
 * If the credit fails, the claim is released so it can be retried.
 */
const withClaim = async (prisma, rowId, ops) => {
  if (rowId) {
    const c = await prisma.walletTransaction.updateMany({ where: { id: rowId, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'PROCESSING' } });
    if (c.count !== 1) return null;
  }
  try { return await prisma.$transaction(ops); }
  catch (e) {
    if (rowId) await prisma.walletTransaction.updateMany({ where: { id: rowId, status: 'PROCESSING' }, data: { status: 'PENDING' } }).catch(() => {});
    throw e;
  }
};

/** Add money with ONE database-side increment (never "read the balance, add in JavaScript, write it back": a second
 *  request in between would be overwritten). Refuses a missing wallet instead of silently crediting nothing. */
const creditWallet = async (tx, where, amount, meta = null) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Invalid amount.', 400);
  const r = await tx.wallet.updateMany({ where, data: { balance: { increment: n } } });
  if (r.count !== 1) throw new AppError('Wallet not found.', 404);
  if (meta) await ledger.move(tx, { account: walletAccount(where), direction: 'CREDIT', amount: n, ...meta });
};

/**
 * Compare-and-set. Moves a row out of the state we read it in, and tells us whether WE did it. Two staff clicking
 * "approve" and "reject" together, or one provider webhook arriving twice, both read the same old state; only one
 * of them can win this update, so only one of them moves money. Pass the state you read in `where`
 * (status, and updatedAt where the status alone could repeat).
 * @returns {Promise<boolean>}
 */
const claim = async (delegate, where, data) => (await delegate.updateMany({ where, data })).count === 1;

/** A reference nobody can guess or collide with (the old pattern was a millisecond timestamp). */
const newReference = (prefix) => `${prefix}-${require('crypto').randomBytes(9).toString('base64url')}`;

module.exports = { debitWallet, creditWallet, claim, newReference, riderPaymentChoice, withClaim };
