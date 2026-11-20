// backend/src/services/orgWallet.service.js
//
// Company funding. Three billing modes:
//   PREPAID  the company tops up a wallet; every trip is paid from it at completion, and the
//            driver is paid straight away.
//   POSTPAID trips go on credit and are invoiced monthly. Only for VERIFIED companies with an
//            agreed credit limit and signed terms. Drivers are paid when the invoice is paid.
//   HYBRID   wallet first; whatever the wallet can't cover goes on credit (within the limit).
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const notificationService = require('./notification.service');
const { logger } = require('../utils/logger');
const { formatMoney } = require('../utils/currency');
const cal = require('../utils/orgCalendar');

class OrgError extends AppError {
  constructor(message, code, status = 400) { super(message, status); this.code = code; }
}

const notifySafe = (p) => Promise.resolve(notificationService.notify(p)).catch((e) => logger.warn(`[OrgWallet] notify: ${e.message}`));

/** Can this company be put on credit? Only after Runserv has verified it and agreed terms. */
const creditAllowed = (company) =>
  company.verificationStatus === 'VERIFIED' && Boolean(company.creditTermsSignedAt) && company.creditLimit > 0;

const usesWallet = (mode) => mode === 'PREPAID' || mode === 'HYBRID';
const usesCredit = (mode) => mode === 'POSTPAID' || mode === 'HYBRID';

/**
 * Where the company stands right now: what its wallet can still fund and how much credit is left.
 * Fares of trips still in progress are held against the wallet / credit so two people booking at
 * the same moment can't both spend the same money.
 */
const getFundingState = async (company) => {
  const mode = company.billingMode;
  const [open, unbilled, unpaid] = await Promise.all([
    prisma.corporateTrip.aggregate({ where: { companyId: company.id, status: 'REQUESTED' }, _sum: { fare: true } }),
    prisma.corporateTrip.aggregate({ where: { companyId: company.id, status: 'COMPLETED', invoiceId: null, creditAmount: { gt: 0 } }, _sum: { creditAmount: true } }),
    usesCredit(mode)
      ? prisma.companyInvoice.findMany({ where: { companyId: company.id, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, select: { subtotal: true, amountPaid: true } })
      : Promise.resolve([]),
  ]);
  const held = open._sum?.fare ?? 0;
  const balance = company.walletBalance ?? 0;
  const walletHeld = usesWallet(mode) ? Math.min(Math.max(balance, 0), held) : 0;
  const walletAvailable = usesWallet(mode) ? Math.max(0, balance - held) : 0;

  let creditExposure = 0; let creditAvailable = 0;
  if (usesCredit(mode)) {
    const owed = unpaid.reduce((s, i) => s + (i.subtotal - i.amountPaid), 0);
    creditExposure = cal.round2(owed + (unbilled._sum?.creditAmount ?? 0) + (held - walletHeld));
    creditAvailable = creditAllowed(company) ? Math.max(0, company.creditLimit - creditExposure) : 0;
  }
  return { mode, balance, held, walletAvailable, creditExposure, creditAvailable, creditLimit: company.creditLimit ?? 0 };
};

/** Throws if the company cannot fund a trip of `fare`. Returns the funding state. */
const assertCanFund = async (company, fare) => {
  const f = await getFundingState(company);
  const cur = company.currency;
  if (f.mode === 'PREPAID' && f.walletAvailable < fare) {
    throw new OrgError('Your organisation’s Runserv wallet does not have enough funds for this trip. Please pay yourself or ask your finance team to top up.', 'ORG_INSUFFICIENT_FUNDS', 403);
  }
  if (f.mode === 'POSTPAID' || f.mode === 'HYBRID') {
    if (f.mode === 'POSTPAID' && !creditAllowed(company)) {
      throw new OrgError('Your organisation’s credit facility is not active. Please pay yourself or contact your company admin.', 'ORG_CREDIT_NOT_APPROVED', 403);
    }
    const creditPart = f.mode === 'HYBRID' ? Math.max(0, fare - f.walletAvailable) : fare;
    if (creditPart > 0 && await require('./bankReversal.service').hasOpenDebitNote(company.id)) {
      throw new OrgError('Your organisation has an unpaid debit note from Runserv. Please settle it by bank transfer before putting more trips on credit.', 'ORG_DEBIT_NOTE_OPEN', 403);
    }
    if (creditPart > 0 && (!creditAllowed(company) || f.creditAvailable < creditPart)) {
      throw new OrgError(`Your organisation has reached its credit limit with Runserv (${formatMoney(f.creditLimit, cur)}). Please pay yourself or ask your finance team to settle the open invoice or top up.`, 'ORG_CREDIT_LIMIT', 403);
    }
  }
  return f;
};

/**
 * Move money in/out of the wallet and write the ledger line, atomically.
 * `amount` is signed. A repeated `reference` is a no-op (returns the existing line), so
 * top-up verification and retries are safe.
 */
const applyWalletChange = async ({ companyId, amount, type, description, reference = null, tripId = null, createdById = null }) => {
  try {
    return await prisma.$transaction(async (tx) => {
      const co = await tx.company.update({ where: { id: companyId }, data: { walletBalance: { increment: amount } }, select: { walletBalance: true, currency: true } });
      const row = await tx.orgWalletTx.create({
        data: { companyId, type, amount, balanceAfter: cal.round2(co.walletBalance), description, reference, tripId, createdById },
      });
      if (amount) await require('./ledger.service').move(tx, { account: `COMPANY_WALLET:${companyId}`, direction: amount > 0 ? 'CREDIT' : 'DEBIT', amount: Math.abs(amount), currency: co.currency || 'NGN', refType: `ORG_${type}`, refId: row?.id || reference || 'n/a', memo: description, actor: createdById });
      return row;
    });
  } catch (e) {
    if (e?.code === 'P2002' && reference) return prisma.orgWalletTx.findUnique({ where: { reference } });
    throw e;
  }
};

const topUp = ({ companyId, amount, reference, description = 'Wallet top-up', createdById }) => {
  if (!(amount > 0)) throw new AppError('Top-up amount must be greater than zero', 400);
  return applyWalletChange({ companyId, amount, type: 'TOPUP', description, reference, createdById });
};

const adjust = ({ companyId, amount, description, createdById }) => {
  if (!amount) throw new AppError('Amount cannot be zero', 400);
  return applyWalletChange({ companyId, amount, type: 'ADJUSTMENT', description, createdById });
};

/** Pay a trip from the wallet. May take the balance slightly negative if the final fare beat the estimate. */
const chargeTrip = ({ companyId, tripId, amount, description }) =>
  applyWalletChange({ companyId, amount: -amount, type: 'TRIP_CHARGE', description, reference: `TRIP-${tripId}`, tripId });

/** Split a final fare between wallet and credit according to the billing mode. */
const planFunding = (company, fare) => {
  const bal = Math.max(company.walletBalance ?? 0, 0);
  switch (company.billingMode) {
    case 'PREPAID':  return { walletPaid: fare, creditAmount: 0 };            // may overdraw slightly
    case 'POSTPAID': return { walletPaid: 0, creditAmount: fare };
    default: { const w = Math.min(bal, fare); return { walletPaid: cal.round2(w), creditAmount: cal.round2(fare - w) }; }
  }
};

/** Daily: tell the company's finance people when the wallet is low or credit is nearly used up. */
const runBalanceAlerts = async (now = new Date()) => {
  const companies = await prisma.company.findMany({ where: { status: 'ACTIVE' } });
  let sent = 0;
  for (const c of companies) {
    const f = await getFundingState(c);
    const alerts = [];
    if (usesWallet(c.billingMode) && f.walletAvailable <= (c.lowBalanceThreshold ?? 0)) {
      alerts.push({ type: 'org_low_balance', title: '⚠️ Wallet balance is low', message: `Your Runserv wallet has ${formatMoney(f.walletAvailable, c.currency)} available. Top up so staff can keep riding.` });
    }
    if (usesCredit(c.billingMode) && c.creditLimit > 0 && f.creditExposure / c.creditLimit >= 0.8) {
      alerts.push({ type: 'org_credit_high', title: '⚠️ Credit limit almost reached', message: `You have used ${Math.round((f.creditExposure / c.creditLimit) * 100)}% of your ${formatMoney(c.creditLimit, c.currency)} credit limit.` });
    }
    if (!alerts.length) continue;
    const people = await prisma.companyEmployee.findMany({ where: { companyId: c.id, isActive: true, inviteStatus: 'ACTIVE', role: { in: ['ORG_ADMIN', 'FINANCE'] } }, select: { userId: true } });
    for (const a of alerts) for (const p of people) {
      const recent = await prisma.notification.findFirst({ where: { userId: p.userId, type: a.type, createdAt: { gte: new Date(now.getTime() - 20 * 3600 * 1000) } }, select: { id: true } });
      if (recent) continue;
      await notifySafe({ userId: p.userId, title: a.title, message: a.message, type: a.type, data: { companyId: c.id } }); sent++;
    }
  }
  return { companies: companies.length, sent };
};

module.exports = { OrgError, creditAllowed, usesWallet, usesCredit, getFundingState, assertCanFund, applyWalletChange, topUp, adjust, chargeTrip, planFunding, runBalanceAlerts };
