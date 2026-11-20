// backend/src/services/bankReversal.service.js
// Reversing a bank credit that was already applied to a company (decision M8-3).
//   1. It is a REQUEST (PendingMoneyAction, kind BANK_CREDIT_REVERSAL); a DIFFERENT admin approves it.
//   2. On approval, in ONE transaction:
//        - the credit is marked REVERSED (compare-and-set, so it can only happen once);
//        - a wallet top-up is clawed back from the company wallet up to what is there (never below zero), with ledger entries;
//        - whatever the wallet could not cover becomes a debit-note invoice (DN-...) payable by bank transfer;
//        - a credit that paid an invoice reopens that invoice (a negative receipt line is added).
//   3. While a debit note is unpaid, the company cannot put new trips on credit (see orgWallet.assertCanFund).
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { toMinor, fromMinor } = require('../utils/money');

const DN_PREFIX = 'DN-';

const apply = async ({ paymentId, actor, note, req, now = new Date() }) => {
  const p = await prisma.bankPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new AppError('Payment not found.', 404);
  if (p.status === 'REVERSED') throw new AppError('Already reversed.', 409);
  if (p.status !== 'MATCHED' || !(p.companyId || p.invoiceId)) throw new AppError('Only a credit applied to a company can be reversed this way.', 409);
  const amt = toMinor(p.amount);

  const out = await prisma.$transaction(async (tx) => {
    const won = await tx.bankPayment.updateMany({ where: { id: p.id, status: 'MATCHED' }, data: { status: 'REVERSED', resolvedById: actor, resolvedAt: now, resolutionNote: String(note || 'Reversed').slice(0, 500) } });
    if (won.count !== 1) throw new AppError('Someone else just changed this credit. Refresh.', 409);
    const result = { clawedBack: 0, debitNote: null, invoiceReopened: null, driversAlreadyPaid: false };

    // Bank side: a settlement this credit counted towards reopens.
    if (p.settlementId) {
      const s = await tx.bankSettlement.findUnique({ where: { id: p.settlementId } });
      if (s) { const left = Math.max(toMinor(s.receivedAmount) - amt, 0); await tx.bankSettlement.update({ where: { id: s.id }, data: { receivedAmount: fromMinor(left), ...(s.status === 'PAID' && left < toMinor(s.netAmount) && { status: 'RECONCILING', paidAt: null }) } }); }
    }

    if (p.invoiceId) {
      const inv = await tx.companyInvoice.findUnique({ where: { id: p.invoiceId } });
      if (!inv) throw new AppError('Invoice not found.', 404);
      const dec = await tx.companyInvoice.updateMany({ where: { id: inv.id, amountPaid: { gte: fromMinor(amt) } }, data: { amountPaid: { decrement: fromMinor(amt) } } });
      if (dec.count !== 1) throw new AppError('The invoice has less paid on it than this credit. Check its receipts before reversing.', 409);
      const after = await tx.companyInvoice.findUnique({ where: { id: inv.id } });
      const paid = toMinor(after.amountPaid); const owed = toMinor(after.subtotal);
      const status = paid >= owed ? 'PAID' : new Date(after.dueDate) < now ? 'OVERDUE' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
      await tx.companyInvoice.update({ where: { id: inv.id }, data: { status, ...(status !== 'PAID' && { paidAt: null }) } });
      await tx.invoicePayment.create({ data: { invoiceId: inv.id, amount: -fromMinor(amt), method: 'REVERSAL', reference: p.bankTransactionRef, receivedAt: now, recordedById: actor, note: `Bank credit reversed: ${String(note || '').slice(0, 150)}` } });
      result.invoiceReopened = inv.invoiceNumber; result.driversAlreadyPaid = !!inv.driversSettledAt;
    } else {
      // Wallet top-up: take back only what is there, never below zero.
      const co = await tx.company.findUnique({ where: { id: p.companyId }, select: { id: true, walletBalance: true, currency: true, paymentTermsDays: true, orgCode: true } });
      if (!co) throw new AppError('Company not found.', 404);
      const claw = Math.min(Math.max(toMinor(co.walletBalance), 0), amt);
      if (claw > 0) {
        const moved = await tx.company.updateMany({ where: { id: co.id, walletBalance: { gte: fromMinor(claw) } }, data: { walletBalance: { decrement: fromMinor(claw) } } });
        if (moved.count !== 1) throw new AppError('The company wallet changed while reversing. Try again.', 409);
        const bal = await tx.company.findUnique({ where: { id: co.id }, select: { walletBalance: true } });
        const row = await tx.orgWalletTx.create({ data: { companyId: co.id, type: 'ADJUSTMENT', amount: -fromMinor(claw), balanceAfter: bal.walletBalance, description: `Bank credit reversed (${p.bankTransactionRef})`, reference: `REV-${p.id}`, createdById: actor } });
        await require('./ledger.service').move(tx, { account: `COMPANY_WALLET:${co.id}`, counter: `BANK:${p.receivingAccountId || 'unknown'}`, direction: 'DEBIT', amount: fromMinor(claw), currency: p.currency, refType: 'BANK_PAYMENT_REVERSAL', refId: row.id, memo: 'Bank credit reversed', actor });
      }
      result.clawedBack = fromMinor(claw);
      const short = amt - claw;
      if (short > 0) {
        const num = `${DN_PREFIX}${p.id.slice(0, 8).toUpperCase()}`;
        const dn = await tx.companyInvoice.create({ data: {
          companyId: co.id, invoiceNumber: num, period: num, periodStart: now, periodEnd: now, tripCount: 0, tripsAmount: 0, subscriptionAmount: 0,
          subtotal: fromMinor(short), amountPaid: 0, platformFee: 0, driverPayable: 0, currency: p.currency, status: 'ISSUED', issuedAt: now,
          dueDate: new Date(now.getTime() + (co.paymentTermsDays || 14) * 86400000), notes: `Debit note: bank credit ${p.bankTransactionRef} was reversed after the money had been spent.` } });
        result.debitNote = { id: dn.id, number: num, amount: fromMinor(short) };
      }
    }
    return result;
  });

  await logActivity({ userId: actor, action: 'bank_credit_reversed_company', entityType: 'BankPayment', entityId: p.id, details: { amount: String(p.amount), ...out }, req });
  return out;
};

/** Open debit note? (used to stop new credit trips) */
const hasOpenDebitNote = async (companyId) => {
  if (!prisma.companyInvoice?.findFirst) return false;
  const r = await prisma.companyInvoice.findFirst({ where: { companyId, period: { startsWith: DN_PREFIX }, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, select: { id: true } });
  return !!r;
};

module.exports = { apply, hasOpenDebitNote, DN_PREFIX };
