// backend/src/services/orgBilling.service.js
//
// Invoices, receipts and driver settlement.
//
//   • Trips paid from the company's wallet are already settled (driver paid at completion).
//   • The CREDIT part of the month's trips (+ the subscription fee) goes on one monthly invoice.
//   • Receipts are recorded against the invoice (it can be paid in parts). When it is fully paid,
//     every driver/partner who still has money owed on its trips is credited their share to their
//     Runserv wallet — one credit per driver per invoice.
// Everything here is idempotent, so the scheduler / an admin can safely run it again.
'use strict';

const prisma = require('../lib/prisma');
const notificationService = require('./notification.service');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { formatMoney } = require('../utils/currency');
const cal = require('../utils/orgCalendar');

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];
const notifySafe = (p) => Promise.resolve(notificationService.notify(p)).catch((e) => logger.warn(`[OrgBilling] notify failed: ${e.message}`));
const sumBy = (rows, f) => rows.reduce((s, r) => s + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
const invoiceNumberFor = (company, period) => `RS-INV-${period.replace('-', '')}-${String(company.orgCode).replace(/^RS-/, '')}`;

/** People who should hear about invoices: org admins and finance. */
const billingContacts = (companyId) =>
  prisma.companyEmployee.findMany({ where: { companyId, isActive: true, inviteStatus: 'ACTIVE', role: { in: ['ORG_ADMIN', 'FINANCE'] } }, select: { userId: true } });

// ── 1. Invoices ──────────────────────────────────────────────────────────────

/**
 * Bill the credit part of every completed, unbilled trip in `period` ('YYYY-MM', company timezone)
 * plus the subscription fee. Returns the invoice, or null if there is nothing to bill.
 */
const generateInvoiceForCompany = async ({ companyId, period, now = new Date() }) => {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new AppError('Company not found', 404);
  const tz = cal.safeTz(company.timezone);
  const per = period || cal.lastClosedPeriod(now, tz);
  if (!cal.isValidPeriod(per)) throw new AppError('Invalid billing period (expected YYYY-MM)', 400);
  const { start, end } = cal.periodBounds(per, tz);

  const existing = await prisma.companyInvoice.findUnique({ where: { companyId_period: { companyId, period: per } } });
  if (existing && ['PAID', 'VOID'].includes(existing.status)) return existing;

  const unbilled = await prisma.corporateTrip.findMany({
    where: { companyId, status: 'COMPLETED', invoiceId: null, creditAmount: { gt: 0 }, tripAt: { gte: start, lt: end } }, select: { id: true },
  });
  const subscription = existing ? existing.subscriptionAmount : (company.subscriptionFee ?? 0);
  if (!existing && unbilled.length === 0 && subscription <= 0) return null;

  const invoice = existing ?? await prisma.companyInvoice.create({
    data: {
      companyId, period: per, periodStart: start, periodEnd: end, invoiceNumber: invoiceNumberFor(company, per),
      currency: company.currency, status: 'ISSUED', issuedAt: now, subscriptionAmount: subscription,
      dueDate: new Date(now.getTime() + (company.paymentTermsDays ?? 14) * DAY_MS),
    },
  });
  if (unbilled.length) await prisma.corporateTrip.updateMany({ where: { id: { in: unbilled.map((t) => t.id) } }, data: { invoiceId: invoice.id, billedAt: now } });

  const trips = await prisma.corporateTrip.findMany({
    where: { invoiceId: invoice.id, status: 'COMPLETED' },
    select: { fare: true, creditAmount: true, commissionAmount: true, driverEarnings: true, driverPaidAmount: true, distanceKm: true },
  });
  const tripsAmount = cal.round2(sumBy(trips, 'creditAmount'));
  const subtotal = cal.round2(tripsAmount + invoice.subscriptionAmount);
  const updated = await prisma.companyInvoice.update({
    where: { id: invoice.id },
    data: {
      tripCount: trips.length, totalDistanceKm: cal.round2(sumBy(trips, 'distanceKm')), tripsAmount, subtotal,
      // Runserv's share of the CREDIT part only (the wallet part was settled when the trip ended).
      platformFee: cal.round2(sumBy(trips, (t) => (t.fare > 0 ? t.commissionAmount * (t.creditAmount / t.fare) : 0))),
      driverPayable: cal.round2(sumBy(trips, (t) => t.driverEarnings - t.driverPaidAmount)),
    },
  });

  if (!existing) {
    for (const c of await billingContacts(companyId)) {
      await notifySafe({ userId: c.userId, title: '🧾 Your Runserv invoice is ready', message: `${per}: ${formatMoney(updated.subtotal, updated.currency)} due ${updated.dueDate.toISOString().slice(0, 10)}.`, type: 'org_invoice_issued', data: { invoiceId: updated.id, period: per } });
    }
  }
  return updated;
};

/** Bill the last closed month for every active company. Safe to run daily. */
const generateMonthlyInvoices = async ({ now = new Date() } = {}) => {
  const companies = await prisma.company.findMany({ where: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, select: { id: true } });
  const out = { checked: companies.length, issued: 0, skipped: 0, failed: 0 };
  for (const c of companies) {
    try {
      const before = await prisma.companyInvoice.count({ where: { companyId: c.id } });
      const inv = await generateInvoiceForCompany({ companyId: c.id, now });
      const after = await prisma.companyInvoice.count({ where: { companyId: c.id } });
      if (inv && after > before) out.issued++; else out.skipped++;
    } catch (e) {
      if (e?.code === 'P2002') out.skipped++; else { out.failed++; logger.error(`[OrgBilling] invoice failed for ${c.id}: ${e.message}`); }
    }
  }
  return out;
};

const markOverdueInvoices = async (now = new Date()) =>
  (await prisma.companyInvoice.updateMany({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: now } }, data: { status: 'OVERDUE' } })).count;

// ── 2. Receipts → invoice paid → drivers paid ────────────────────────────────

/**
 * Record a receipt against an invoice (full or partial). Pays the drivers once it is fully paid.
 * The money is added with ONE conditional database increment (it refuses to go past the invoice total), together with the
 * receipt line, in one transaction. The old version read the paid-so-far, added in JavaScript and wrote the total back, so
 * two receipts arriving together (a bank credit and a staff entry, say) lost one of them or overpaid the invoice.
 * Pass `tx` to run inside the caller's transaction (the bank matcher does); the notifications and driver payments then
 * come back as `after()` to run once that transaction has committed.
 */
const recordPayment = async ({ invoiceId, amount, method = 'BANK_TRANSFER', reference, receivedAt = new Date(), recordedById, note, settleDrivers = true, tx = null }) => {
  const amt = cal.round2(Number(amount));
  if (!(amt > 0)) throw new AppError('Enter the amount received', 400);

  const work = async (t) => {
    const invoice = await t.companyInvoice.findUnique({ where: { id: invoiceId }, include: { company: true } });
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'VOID') throw new AppError('This invoice was voided', 400);
    const outstanding = cal.round2(invoice.subtotal - invoice.amountPaid);
    if (invoice.status === 'PAID' || outstanding <= 0) throw new AppError('This invoice is already fully paid', 400);
    if (amt > outstanding + 0.005) throw new AppError(`That is more than the ${formatMoney(outstanding, invoice.currency)} outstanding on this invoice`, 400);

    const took = await t.companyInvoice.updateMany({
      where: { id: invoiceId, status: { notIn: ['VOID', 'PAID'] }, amountPaid: { lte: cal.round2(invoice.subtotal - amt + 0.005) } },
      data:  { amountPaid: { increment: amt } },
    });
    if (took.count !== 1) throw new AppError('This invoice was just paid or changed by someone else. Refresh and check the amount outstanding.', 409);
    await t.invoicePayment.create({ data: { invoiceId, amount: amt, method, reference: reference || null, receivedAt, recordedById: recordedById || null, note: note || null } });

    const now = await t.companyInvoice.findUnique({ where: { id: invoiceId } });
    const full = now.amountPaid >= now.subtotal - 0.005;
    const updated = await t.companyInvoice.update({
      where: { id: invoiceId },
      data: full ? { status: 'PAID', paidAt: receivedAt } : { status: now.status === 'OVERDUE' ? 'OVERDUE' : 'PARTIALLY_PAID' },
    });
    return { invoice, updated, full };
  };

  const afterCommit = async ({ invoice, updated, full }) => {
    if (full) {
      // The ride payments were billed to the company; they are now collected.
      const rides = await prisma.corporateTrip.findMany({ where: { invoiceId, rideId: { not: null } }, select: { rideId: true } });
      const dels = await prisma.corporateTrip.findMany({ where: { invoiceId, deliveryId: { not: null } }, select: { deliveryId: true } });
      if (rides.length) await prisma.payment.updateMany({ where: { rideId: { in: rides.map((r) => r.rideId) }, method: 'CORPORATE' }, data: { status: 'COMPLETED' } });
      if (dels.length) await prisma.payment.updateMany({ where: { deliveryId: { in: dels.map((d) => d.deliveryId) }, method: 'CORPORATE' }, data: { status: 'COMPLETED' } });
    }
    for (const c of await billingContacts(invoice.companyId)) {
      await notifySafe({ userId: c.userId, title: full ? '✅ Invoice paid' : '💳 Payment received', message: full ? `Thank you — invoice ${invoice.invoiceNumber} is fully paid.` : `We received ${formatMoney(amt, invoice.currency)} on invoice ${invoice.invoiceNumber}. ${formatMoney(cal.round2(invoice.subtotal - invoice.amountPaid - amt), invoice.currency)} remains.`, type: 'org_invoice_paid', data: { invoiceId } });
    }
    const settlement = full && settleDrivers ? await settleDriversForInvoice({ invoiceId }) : null;
    return { invoice: updated, settlement, fullyPaid: full };
  };

  if (tx) {
    const r = await work(tx);
    return { invoice: r.updated, fullyPaid: r.full, after: () => afterCommit(r) };
  }
  const r = await prisma.$transaction(work);
  return afterCommit(r);
};

/** Convenience: receive whatever is still outstanding. */
const markInvoicePaid = async ({ invoiceId, reference, method, paidAt, recordedById, settleDrivers = true }) => {
  const inv = await prisma.companyInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new AppError('Invoice not found', 404);
  if (inv.status === 'PAID') return { invoice: inv, settlement: await settleDriversForInvoice({ invoiceId }), fullyPaid: true };
  return recordPayment({ invoiceId, amount: inv.subtotal - inv.amountPaid, method, reference, receivedAt: paidAt, recordedById, settleDrivers });
};

/**
 * Pay every driver/partner what they are still owed on this invoice's trips. Idempotent.
 * `advance: true` lets Runserv pay drivers before the company has paid (admin decision).
 */
const settleDriversForInvoice = async ({ invoiceId, advance = false }) => {
  const invoice = await prisma.companyInvoice.findUnique({ where: { id: invoiceId }, include: { company: true } });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'VOID') throw new AppError('This invoice was voided', 400);
  if (invoice.status !== 'PAID' && !advance) throw new AppError('Drivers are paid once the company has paid its invoice in full. Record the payment first (or pay in advance).', 400);

  const trips = await prisma.corporateTrip.findMany({
    where: { invoiceId, status: 'COMPLETED', payoutStatus: 'ACCRUED', earnerUserId: { not: null } },
    select: { id: true, earnerUserId: true, fare: true, commissionAmount: true, driverEarnings: true, driverPaidAmount: true, creditAmount: true, distanceKm: true },
  });
  const byEarner = new Map();
  for (const t of trips) { if (!byEarner.has(t.earnerUserId)) byEarner.set(t.earnerUserId, []); byEarner.get(t.earnerUserId).push(t); }

  const { ensureWallet } = require('../utils/walletHelpers');
  const result = { paid: 0, failed: 0, totalPaid: 0, payouts: [] };
  for (const [userId, list] of byEarner) {
    try {
      const net = cal.round2(sumBy(list, (t) => t.driverEarnings - t.driverPaidAmount));
      const gross = cal.round2(sumBy(list, 'creditAmount'));
      const fee = cal.round2(sumBy(list, (t) => (t.fare > 0 ? t.commissionAmount * (t.creditAmount / t.fare) : 0)));
      const km = cal.round2(sumBy(list, 'distanceKm'));
      const w = await ensureWallet(userId);
      const payout = await prisma.orgPayout.upsert({
        where: { invoiceId_userId: { invoiceId, userId } },
        create: { userId, companyId: invoice.companyId, invoiceId, period: invoice.period, tripCount: list.length, distanceKm: km, grossAmount: gross, platformFee: fee, netAmount: net, currency: invoice.currency, status: 'PENDING' },
        update: { tripCount: list.length, distanceKm: km, grossAmount: gross, platformFee: fee, netAmount: net },
      });
      if (payout.status === 'PAID') continue;

      const reference = `ORGPAY-${payout.id}`;
      const ops = [
        ...require('./walletOps').creditOps(prisma, { walletId: w.id, currency: w.currency || invoice.currency, amount: net, refType: 'ORG_INVOICE_PAYOUT', refId: reference, memo: `Organisation rides ${invoice.period}`, idempotencyKey: `ORG_INVOICE_PAYOUT:${reference}` }),
        prisma.walletTransaction.create({ data: { walletId: w.id, type: 'CREDIT', amount: net, status: 'COMPLETED', reference, description: `Organisation rides ${invoice.period} — ${invoice.company.name} (${list.length} trip${list.length === 1 ? '' : 's'})` } }),
        prisma.orgPayout.update({ where: { id: payout.id }, data: { status: 'PAID', paidAt: new Date(), walletReference: reference } }),
        ...list.map((t) => prisma.corporateTrip.update({ where: { id: t.id }, data: { payoutStatus: 'PAID', driverPaidAmount: t.driverEarnings, orgPayoutId: payout.id } })),
      ];
      await prisma.$transaction(ops);
      result.paid++; result.totalPaid = cal.round2(result.totalPaid + net); result.payouts.push({ userId, amount: net, trips: list.length });
      await notifySafe({ userId, title: '💰 Organisation earnings paid', message: `${formatMoney(net, invoice.currency)} for ${list.length} ${invoice.company.name} trip${list.length === 1 ? '' : 's'} (${invoice.period}) was added to your wallet.`, type: 'org_payout_paid', data: { payoutId: payout.id, invoiceId } });
    } catch (e) { result.failed++; logger.error(`[OrgBilling] payout failed for ${userId} invoice ${invoiceId}: ${e.message}`); }
  }
  if (result.failed === 0) {
    const left = await prisma.corporateTrip.count({ where: { invoiceId, status: 'COMPLETED', payoutStatus: 'ACCRUED', earnerUserId: { not: null } } });
    if (left === 0) await prisma.companyInvoice.update({ where: { id: invoiceId }, data: { driversSettledAt: new Date() } });
  }
  return result;
};

const voidInvoice = async ({ invoiceId }) => {
  const invoice = await prisma.companyInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'PAID' || invoice.amountPaid > 0) throw new AppError('An invoice that has received payment cannot be voided', 400);
  if ((await prisma.orgPayout.count({ where: { invoiceId, status: 'PAID' } })) > 0) throw new AppError('Drivers were already paid from this invoice, so it cannot be voided', 400);
  await prisma.corporateTrip.updateMany({ where: { invoiceId }, data: { invoiceId: null, billedAt: null } });
  return prisma.companyInvoice.update({ where: { id: invoiceId }, data: { status: 'VOID', tripCount: 0, tripsAmount: 0, subtotal: 0, platformFee: 0, driverPayable: 0, totalDistanceKm: 0 } });
};

// ── 3. What a driver / delivery partner sees ─────────────────────────────────

/**
 * Per organisation: what has been paid already (wallet-funded trips and settled invoices), what is
 * on an invoice the company hasn't paid yet (the "intended credit"), and what isn't invoiced yet.
 */
const getEarnerSummary = async (userId) => {
  const trips = await prisma.corporateTrip.findMany({
    where: { earnerUserId: userId, status: 'COMPLETED' },
    select: { companyId: true, driverEarnings: true, driverPaidAmount: true, distanceKm: true, invoiceId: true, company: { select: { name: true, logoUrl: true } } },
  });
  const totals = { notYetBilled: 0, awaitingCompanyPayment: 0, paid: 0, trips: trips.length, distanceKm: 0 };
  const groups = new Map();
  for (const t of trips) {
    const earn = Number(t.driverEarnings) || 0; const paid = Number(t.driverPaidAmount) || 0; const owed = Math.max(0, earn - paid);
    const km = Number(t.distanceKm) || 0;
    totals.distanceKm += km; totals.paid += paid;
    const bucket = t.invoiceId ? 'awaitingCompanyPayment' : 'notYetBilled';
    totals[bucket] += owed;
    if (!groups.has(t.companyId)) groups.set(t.companyId, { companyId: t.companyId, name: t.company?.name, logoUrl: t.company?.logoUrl, trips: 0, distanceKm: 0, notYetBilled: 0, awaitingCompanyPayment: 0, paid: 0 });
    const g = groups.get(t.companyId); g.trips++; g.distanceKm += km; g.paid += paid; g[bucket] += owed;
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? cal.round2(v) : v]));
  const [payouts, w] = await Promise.all([
    prisma.orgPayout.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 24, include: { company: { select: { name: true } } } }),
    prisma.wallet.findUnique({ where: { userId }, select: { currency: true } }),
  ]);
  return {
    currency: w?.currency ?? 'NGN', totals: round(totals),
    byOrganisation: [...groups.values()].map(round).sort((a, b) => (b.awaitingCompanyPayment + b.notYetBilled) - (a.awaitingCompanyPayment + a.notYetBilled)),
    payouts: payouts.map((p) => ({ id: p.id, organisation: p.company?.name, period: p.period, trips: p.tripCount, distanceKm: p.distanceKm, amount: p.netAmount, status: p.status, paidAt: p.paidAt, currency: p.currency })),
  };
};

const getEarnerTrips = async ({ userId, companyId, period, page = 1, limit = 20 }) => {
  const where = { earnerUserId: userId, status: 'COMPLETED' };
  if (companyId) where.companyId = companyId;
  if (period && cal.isValidPeriod(period)) { const { start, end } = cal.periodBounds(period); where.tripAt = { gte: start, lt: end }; }
  const take = Math.min(Math.max(parseInt(limit) || 20, 1), 100); const pg = Math.max(parseInt(page) || 1, 1);
  const [rows, total] = await Promise.all([
    prisma.corporateTrip.findMany({
      where, orderBy: { tripAt: 'desc' }, skip: (pg - 1) * take, take,
      select: { id: true, serviceType: true, tripAt: true, driverEarnings: true, driverPaidAmount: true, distanceKm: true, currency: true, payoutStatus: true, invoiceId: true,
        company: { select: { name: true } }, invoice: { select: { period: true, status: true } },
        ride: { select: { pickupAddress: true, dropoffAddress: true } }, delivery: { select: { pickupAddress: true, dropoffAddress: true } } },
    }),
    prisma.corporateTrip.count({ where }),
  ]);
  return {
    trips: rows.map((t) => ({
      id: t.id, type: t.serviceType, date: t.tripAt, organisation: t.company?.name,
      from: t.ride?.pickupAddress ?? t.delivery?.pickupAddress, to: t.ride?.dropoffAddress ?? t.delivery?.dropoffAddress,
      distanceKm: t.distanceKm, earnings: t.driverEarnings, currency: t.currency,
      status: t.payoutStatus === 'PAID' ? 'PAID' : (t.driverPaidAmount > 0 ? 'PART_PAID' : (t.invoice ? (t.invoice.status === 'PAID' ? 'PAYING' : 'AWAITING_COMPANY') : 'NOT_BILLED')),
      period: t.invoice?.period ?? null,
    })),
    pagination: { total, page: pg, pages: Math.ceil(total / take) },
  };
};

module.exports = {
  invoiceNumberFor, generateInvoiceForCompany, generateMonthlyInvoices, markOverdueInvoices,
  recordPayment, markInvoicePaid, settleDriversForInvoice, voidInvoice, getEarnerSummary, getEarnerTrips,
};
