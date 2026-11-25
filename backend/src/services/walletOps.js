// backend/src/services/walletOps.js
// Atomic wallet debits. Every place that spends a user's balance must use debitWallet inside a database
// transaction. It is ONE conditional UPDATE ("take the money only if the balance covers it"), so two requests
// racing each other can never both succeed on the same money (the old "read balance, check, decrement" pattern let
// a user withdraw or transfer the same naira twice by sending two requests at once).
'use strict';
const { AppError } = require('../middleware/errorHandler');
const ledger = require('./ledger.service');

/** Canonical ledger account for a wallet. ALWAYS keyed by wallet id, so reconciliation has one account per wallet. */
const walletAccount = (walletId) => `WALLET:${walletId}`;

/** Every balance mutation must say WHY (refType + refId); currency is taken from the wallet row when not given. */
const needContext = (meta) => {
  if (!meta || !meta.refType || meta.refId === undefined || meta.refId === null || meta.refId === '') {
    throw new AppError('Wallet mutation refused: ledger context (refType, refId) is mandatory.', 500);
  }
};

/** Resolve {id,currency} of the wallet a mutation targets (one indexed read, inside the caller's transaction). */
const walletRef = async (db, where) => {
  const w = await db.wallet.findUnique({ where: where.id ? { id: where.id } : { userId: where.userId }, select: { id: true, currency: true } });
  if (!w) throw new AppError('Wallet not found.', 404);
  return w;
};

const currencyMismatch = () => { const e = new AppError('Wallet currency does not match the amount currency.', 409); e.code = 'WALLET_CURRENCY_MISMATCH'; return e; };

/**
 * The currency a mutation will be posted in. It is ALWAYS the wallet's stored currency: a caller-supplied meta.currency is only a
 * claim that is checked (by the currency predicate on the UPDATE itself when the id is known, or against the row read here), never trusted.
 */
const targetOf = async (tx, where, meta) => {
  if (where.id && meta.currency) return { id: where.id, currency: meta.currency };       // verified atomically by the UPDATE's currency predicate
  const w = await walletRef(tx, where);
  if (meta.currency && meta.currency !== w.currency) throw currencyMismatch();
  return w;
};

/** After a conditional UPDATE matched nothing: say why (missing wallet, wrong currency, or not enough money). */
const explainMiss = async (tx, w, { needsFunds }) => {
  const row = typeof tx.wallet.findUnique === 'function' ? await tx.wallet.findUnique({ where: { id: w.id }, select: { currency: true } }) : undefined;
  if (row === null) return new AppError('Wallet not found.', 404);
  if (row && row.currency !== w.currency) return currencyMismatch();
  return needsFunds ? new AppError('Insufficient wallet balance', 400) : new AppError('Wallet not found.', 404);
};

/**
 * Take money from a wallet. ONE conditional UPDATE (balance must cover it) + the balanced ledger entry, in the caller's transaction.
 * @param tx    Prisma transaction client
 * @param where {id}|{userId}
 * @param meta  { refType, refId, memo?, actor?, currency?, idempotencyKey? }  — MANDATORY (refType, refId)
 */
const debitWallet = async (tx, where, amount, meta) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Invalid amount.', 400);
  needContext(meta);
  const w = await targetOf(tx, where, meta);
  const r = await tx.wallet.updateMany({ where: { id: w.id, currency: w.currency, balance: { gte: n } }, data: { balance: { decrement: n } } });
  if (r.count !== 1) throw await explainMiss(tx, w, { needsFunds: true });
  await ledger.move(tx, { ...meta, currency: w.currency, account: walletAccount(w.id), direction: 'DEBIT', amount: n });
};

/** debitWallet that answers false (instead of throwing) when the balance does not cover it; every other error still throws. */
const tryDebitWallet = async (tx, where, amount, meta) => {
  try { await debitWallet(tx, where, amount, meta); return true; }
  catch (e) { if (e instanceof AppError && e.statusCode === 400 && /Insufficient/.test(e.message)) return false; throw e; }
};

/**
 * Array-form building blocks for `prisma.$transaction([...])` call sites. Returns { update, ledger }: put `update` where the
 * balance change used to be and `ledger` at the END of the same array (so existing result indexes do not move).
 * The ONLY other place a Wallet balance may be written is debitWallet/creditWallet above (enforced by tests/wp01WalletGuard.test.js).
 */
const creditOp = (db, { walletId, currency, amount, refType, refId, memo, actor, idempotencyKey }) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Invalid amount.', 400);
  needContext({ refType, refId });
  if (!walletId || !currency) throw new AppError('Wallet mutation refused: walletId and currency are mandatory.', 500);
  return {
    // currency is part of the unique filter (Prisma 5): a wrong currency matches no row, the update throws and the whole array-transaction rolls back
    update: db.wallet.update({ where: { id: walletId, currency }, data: { balance: { increment: n } } }),
    ledger: ledger.moveOp(db, { account: walletAccount(walletId), direction: 'CREDIT', amount: n, currency, refType, refId, memo, actor, idempotencyKey }),
  };
};

/** Spread form of creditOp for arrays whose result positions do not matter: `...creditOps(prisma, {...})`. */
const creditOps = (db, a) => { const o = creditOp(db, a); return [o.update, o.ledger]; };

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

/** Add money with ONE database-side increment + the balanced ledger entry. Refuses a missing wallet. meta as for debitWallet. */
const creditWallet = async (tx, where, amount, meta) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Invalid amount.', 400);
  needContext(meta);
  const w = await targetOf(tx, where, meta);
  const r = await tx.wallet.updateMany({ where: { id: w.id, currency: w.currency }, data: { balance: { increment: n } } });
  if (r.count !== 1) throw await explainMiss(tx, w, { needsFunds: false });
  await ledger.move(tx, { ...meta, currency: w.currency, account: walletAccount(w.id), direction: 'CREDIT', amount: n });
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

module.exports = { debitWallet, tryDebitWallet, creditWallet, creditOp, creditOps, walletRef, walletAccount, claim, newReference, riderPaymentChoice, withClaim };
