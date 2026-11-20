// backend/src/services/moneyApprovals.service.js
// Two-person rule for money that STAFF enter by hand about a company. A request changes nothing; a DIFFERENT admin approves it and
// only then does the credit / adjustment / invoice receipt happen. The decision is a compare-and-set, so two approvals at once
// cannot apply it twice, and the original reference makes the money step once-only as well.
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { claim } = require('./walletOps');

const LIMIT = () => { const n = Number(process.env.ADMIN_WALLET_ADJUST_MAX); return Number.isFinite(n) && n > 0 ? n : 500000; };

const request = async ({ kind, targetId, amount, reason, payload = {}, actor, role, req }) => {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) throw new AppError('Enter a valid amount.', 400);
  if (String(reason || '').trim().length < 5) throw new AppError('A reason of at least 5 characters is required.', 400);
  let currency;
  if (kind === 'BANK_CREDIT_REVERSAL') {
    const bp = await prisma.bankPayment.findUnique({ where: { id: targetId }, select: { currency: true, status: true, companyId: true, invoiceId: true } });
    if (!bp) throw new AppError('Payment not found.', 404);
    if (bp.status !== 'MATCHED' || !(bp.companyId || bp.invoiceId)) throw new AppError('Only a credit applied to a company can be reversed this way.', 409);
    if (await prisma.pendingMoneyAction.findFirst({ where: { kind, targetId, status: 'PENDING' }, select: { id: true } })) throw new AppError('A reversal for this credit is already waiting for approval.', 409);
    currency = bp.currency;
  } else if (kind === 'INVOICE_RECEIPT') {
    const inv = await prisma.companyInvoice.findUnique({ where: { id: targetId }, select: { currency: true, status: true } });
    if (!inv) throw new AppError('Invoice not found.', 404);
    if (['PAID', 'VOID'].includes(inv.status)) throw new AppError(`This invoice is ${inv.status}.`, 409);
    currency = inv.currency;
  } else {
    const co = await prisma.company.findUnique({ where: { id: targetId }, select: { currency: true } });
    if (!co) throw new AppError('Company not found.', 404);
    currency = co.currency;
  }
  if (kind !== 'BANK_CREDIT_REVERSAL' && Math.abs(amt) > LIMIT() && role !== 'SUPER_ADMIN') throw new AppError(`Amounts above ${LIMIT()} need a Super Admin to request them.`, 403);
  const row = await prisma.pendingMoneyAction.create({ data: { kind, targetId, amount: amt, currency, reason: String(reason).trim().slice(0, 300), payload, requestedById: actor } });
  await logActivity({ userId: actor, action: 'money_action_requested', entityType: 'PendingMoneyAction', entityId: row.id, details: { kind, targetId, amount: amt }, req });
  return row;
};

const execute = async (a, actor) => {
  const wallet = require('./orgWallet.service'); const billing = require('./orgBilling.service');
  if (a.kind === 'ORG_WALLET_CREDIT') return wallet.topUp({ companyId: a.targetId, amount: a.amount, reference: `MA-${a.id}`, description: a.reason, createdById: actor });
  if (a.kind === 'ORG_WALLET_ADJUST') return wallet.adjust({ companyId: a.targetId, amount: a.amount, description: a.reason, createdById: actor });
  if (a.kind === 'INVOICE_RECEIPT') return billing.recordPayment({ invoiceId: a.targetId, amount: a.amount, method: a.payload?.method || 'BANK_TRANSFER', reference: a.payload?.reference, receivedAt: a.payload?.receivedAt ? new Date(a.payload.receivedAt) : new Date(), recordedById: a.requestedById, note: a.reason });
  if (a.kind === 'BANK_CREDIT_REVERSAL') return require('./bankReversal.service').apply({ paymentId: a.targetId, actor, note: a.reason });
  throw new AppError('Unknown action.', 400);
};

const approve = async ({ id, actor, note, req, now = new Date() }) => {
  const a = await prisma.pendingMoneyAction.findUnique({ where: { id } });
  if (!a) throw new AppError('Request not found.', 404);
  if (a.status !== 'PENDING') throw new AppError('This request was already decided.', 409);
  if (a.requestedById === actor) throw new AppError('A different admin must approve a request you made.', 403);
  // Take the decision first; only the winner goes on to move money.
  if (!(await claim(prisma.pendingMoneyAction, { id, status: 'PENDING' }, { status: 'APPROVED', decidedById: actor, decidedAt: now, decisionNote: note ? String(note).slice(0, 300) : null })))
    throw new AppError('Someone else just decided this request.', 409);
  try {
    const result = await execute(a, actor);
    await logActivity({ userId: actor, action: 'money_action_approved', entityType: 'PendingMoneyAction', entityId: id, details: { kind: a.kind, amount: a.amount, requestedBy: a.requestedById }, req });
    return { action: { ...a, status: 'APPROVED' }, result };
  } catch (e) {
    // The money step failed (for example the invoice was paid meanwhile): put the request back so it is not lost.
    await prisma.pendingMoneyAction.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'PENDING', decidedById: null, decidedAt: null } });
    throw e;
  }
};

const reject = async ({ id, actor, note, req, now = new Date() }) => {
  if (String(note || '').trim().length < 3) throw new AppError('A reason is required to reject.', 400);
  const a = await prisma.pendingMoneyAction.findUnique({ where: { id } });
  if (!a) throw new AppError('Request not found.', 404);
  if (!(await claim(prisma.pendingMoneyAction, { id, status: 'PENDING' }, { status: 'REJECTED', decidedById: actor, decidedAt: now, decisionNote: String(note).slice(0, 300) })))
    throw new AppError('This request was already decided.', 409);
  await logActivity({ userId: actor, action: 'money_action_rejected', entityType: 'PendingMoneyAction', entityId: id, details: { kind: a.kind }, req });
  return { ...a, status: 'REJECTED' };
};

const list = ({ status = 'PENDING', take = 100 } = {}) => prisma.pendingMoneyAction.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take });

module.exports = { request, approve, reject, list };
