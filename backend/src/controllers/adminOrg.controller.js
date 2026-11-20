// backend/src/controllers/adminOrg.controller.js
// Runserv staff: create & approve organisations, verify them, set billing mode/credit/commission,
// credit wallets, issue invoices, record receipts and pay drivers. Mounted at /api/admin/corporate.
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { ensureWallet } = require('../utils/walletHelpers');
const notificationService = require('../services/notification.service');
const corp = require('../services/corporate.service');
const wallet = require('../services/orgWallet.service');
const billing = require('../services/orgBilling.service');
const cal = require('../utils/orgCalendar');

const bad = (req, res) => {
  const e = validationResult(req);
  if (e.isEmpty()) return false;
  res.status(400).json({ success: false, message: e.array()[0].msg || 'Invalid input', errors: e.array() });
  return true;
};
const pageArgs = (q, def = 20) => {
  const limit = Math.min(Math.max(parseInt(q.limit) || def, 1), 100); const page = Math.max(parseInt(q.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};
const tempPassword = () => `Rs${crypto.randomBytes(5).toString('hex')}!9`;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(['www', 'api', 'admin', 'app', 'business', 'mail', 'support', 'help', 'status', 'static', 'cdn']);

/**
 * Switching to credit (postpaid / hybrid) is only allowed for a verified company with an agreed
 * credit limit and signed payment terms. Pure function — unit tested.
 */
const validateBillingMode = (company, next) => {
  const mode = next.billingMode ?? company.billingMode;
  if (mode === 'PREPAID') return null;
  const verified = (next.verificationStatus ?? company.verificationStatus) === 'VERIFIED';
  const limit = next.creditLimit ?? company.creditLimit;
  const signed = next.creditTermsSignedAt !== undefined ? next.creditTermsSignedAt : company.creditTermsSignedAt;
  if (!verified) return 'Verify the company first (documents and business checks) before offering monthly billing.';
  if (!(limit > 0)) return 'Set an agreed credit limit before offering monthly billing.';
  if (!signed) return 'Record that the company has signed the payment terms before offering monthly billing.';
  return null;
};

const companyListDto = (c, extra = {}) => ({
  id: c.id, name: c.name, email: c.email, phone: c.phone, orgCode: c.orgCode, status: c.status, verificationStatus: c.verificationStatus,
  billingMode: c.billingMode, creditLimit: c.creditLimit, walletBalance: c.walletBalance, commissionRate: c.commissionRate, subscriptionFee: c.subscriptionFee,
  slug: c.slug, customDomain: c.customDomain, createdAt: c.createdAt, ...extra,
});

// ── Companies ────────────────────────────────────────────────────────────────
exports.listCompanies = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query);
  const { status, verificationStatus, search } = req.query;
  const where = { ...(status && { status }), ...(verificationStatus && { verificationStatus }),
    ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }, { orgCode: { contains: search, mode: 'insensitive' } }] }) };
  const [rows, total] = await Promise.all([
    prisma.company.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, include: { owner: { select: { firstName: true, lastName: true, email: true } }, _count: { select: { members: true } } } }),
    prisma.company.count({ where }),
  ]);
  res.json({ success: true, data: { companies: rows.map((c) => companyListDto(c, { owner: c.owner, staffCount: c._count.members })), pagination: { total, page, pages: Math.ceil(total / limit) } } });
};

exports.getCompany = async (req, res) => {
  const c = await prisma.company.findUnique({ where: { id: req.params.id }, include: { owner: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } } });
  if (!c) throw new AppError('Company not found', 404);
  const [staff, pending, departments, trips, invoices, txs, funding] = await Promise.all([
    prisma.companyEmployee.count({ where: { companyId: c.id, inviteStatus: 'ACTIVE', isActive: true } }),
    prisma.companyEmployee.count({ where: { companyId: c.id, inviteStatus: 'PENDING', isActive: true } }),
    prisma.department.count({ where: { companyId: c.id } }),
    prisma.corporateTrip.aggregate({ where: { companyId: c.id, status: 'COMPLETED' }, _sum: { fare: true, commissionAmount: true }, _count: { _all: true } }),
    prisma.companyInvoice.findMany({ where: { companyId: c.id }, orderBy: { periodStart: 'desc' }, take: 12 }),
    prisma.orgWalletTx.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'desc' }, take: 15 }),
    wallet.getFundingState(c),
  ]);
  res.json({ success: true, data: { company: c, stats: { staff, pending, departments, trips: trips._count._all, billed: trips._sum.fare ?? 0, runservRevenue: trips._sum.commissionAmount ?? 0 }, funding, invoices, walletTransactions: txs } });
};

/** Create an organisation and its first ORG_ADMIN (new account, or an existing customer). */
exports.createCompany = async (req, res) => {
  if (bad(req, res)) return;
  const { name, email, phone, address, rcNumber, billingEmail, commissionRate, subscriptionFee, slug, admin } = req.body;
  if (await prisma.company.findFirst({ where: { OR: [{ email }, ...(rcNumber ? [{ rcNumber }] : [])] }, select: { id: true } })) throw new AppError('A company with this email or RC number already exists', 400);
  if (slug && (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug) || await prisma.company.findUnique({ where: { slug }, select: { id: true } }))) throw new AppError('That portal address is invalid or taken', 400);

  let user = await prisma.user.findUnique({ where: { email: admin.email.toLowerCase() } });
  let createdPassword = null;
  if (user) {
    if (user.role !== 'CUSTOMER') throw new AppError('That email belongs to a non-customer account and cannot administer an organisation', 400);
    await corp.assertNoOtherMembership(user.id, '__none__');
  } else {
    if (admin.phone && await prisma.user.findUnique({ where: { phone: admin.phone }, select: { id: true } })) throw new AppError('That phone number is already used by another account', 400);
    createdPassword = admin.password || tempPassword();
    user = await prisma.user.create({ data: { email: admin.email.toLowerCase(), phone: admin.phone || null, password: await bcrypt.hash(createdPassword, 10), firstName: admin.firstName, lastName: admin.lastName, role: 'CUSTOMER', isVerified: true } });
    await ensureWallet(user.id, user);
  }
  const company = await prisma.company.create({
    data: { name, email, phone, address, rcNumber: rcNumber || null, billingEmail: billingEmail || null, ownerUserId: user.id, orgCode: await corp.generateOrgCode(), status: 'ACTIVE',
      verificationStatus: 'UNVERIFIED', billingMode: 'PREPAID', slug: slug || null,
      ...(commissionRate !== undefined && { commissionRate }), ...(subscriptionFee !== undefined && { subscriptionFee }) },
  });
  await corp.ensureOwnerMembership(company);
  await logActivity({ userId: req.user.id, action: 'company_created', entityType: 'Company', entityId: company.id, details: { name, orgCode: company.orgCode }, req });
  res.status(201).json({ success: true, message: 'Organisation created (prepaid). Verify it before offering monthly billing.', data: { company, admin: { id: user.id, email: user.email, created: Boolean(createdPassword) }, temporaryPassword: createdPassword } });
};

/** Approve / suspend / reject an organisation (the "approve registration" step). */
exports.setStatus = async (req, res) => {
  if (bad(req, res)) return;
  const c = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!c) throw new AppError('Company not found', 404);
  const { status } = req.body;
  const updated = await prisma.company.update({ where: { id: c.id }, data: { status } });
  if (status === 'ACTIVE') await corp.ensureOwnerMembership(updated);
  await logActivity({ userId: req.user.id, action: `company_${status.toLowerCase()}`, entityType: 'Company', entityId: c.id, req });
  notificationService.notify({ userId: c.ownerUserId, title: status === 'ACTIVE' ? '🎉 Organisation approved' : status === 'SUSPENDED' ? 'Organisation suspended' : 'Organisation update',
    message: status === 'ACTIVE' ? `${c.name} is now active. Your organisation code is ${c.orgCode}. Sign in to your dashboard to set up departments and import your staff directory.` : `${c.name} is now ${status.toLowerCase()}.`,
    type: 'corporate_status', data: { companyId: c.id } }).catch(() => {});
  res.json({ success: true, message: `Organisation ${status.toLowerCase()}`, data: { company: updated } });
};

exports.setVerification = async (req, res) => {
  if (bad(req, res)) return;
  const c = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!c) throw new AppError('Company not found', 404);
  const { status, notes } = req.body;
  const data = { verificationStatus: status, verificationNotes: notes || null, verifiedAt: status === 'VERIFIED' ? new Date() : null, verifiedById: status === 'VERIFIED' ? req.user.id : null };
  // Losing verification takes away credit.
  if (status !== 'VERIFIED' && c.billingMode !== 'PREPAID') data.billingMode = 'PREPAID';
  const updated = await prisma.company.update({ where: { id: c.id }, data });
  await logActivity({ userId: req.user.id, action: 'company_verification', entityType: 'Company', entityId: c.id, details: { status, notes }, req });
  res.json({ success: true, message: `Verification: ${status}`, data: { company: updated } });
};

/** Commercial terms. Credit (postpaid/hybrid) is gated by verification, a credit limit and signed terms. */
exports.setTerms = async (req, res) => {
  if (bad(req, res)) return;
  const c = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!c) throw new AppError('Company not found', 404);
  const b = req.body;
  const next = {
    ...(b.billingMode && { billingMode: b.billingMode }), ...(b.creditLimit !== undefined && { creditLimit: Number(b.creditLimit) }),
    ...(b.creditTermsSigned !== undefined && { creditTermsSignedAt: b.creditTermsSigned ? (c.creditTermsSignedAt ?? new Date()) : null }),
  };
  const problem = validateBillingMode(c, next);
  if (problem) throw new AppError(problem, 400);
  const updated = await prisma.company.update({ where: { id: c.id }, data: {
    ...next,
    ...(b.commissionRate !== undefined && { commissionRate: b.commissionRate }), ...(b.subscriptionFee !== undefined && { subscriptionFee: b.subscriptionFee }),
    ...(b.paymentTermsDays !== undefined && { paymentTermsDays: b.paymentTermsDays }), ...(b.lowBalanceThreshold !== undefined && { lowBalanceThreshold: b.lowBalanceThreshold }),
    ...(b.timezone && cal.safeTz(b.timezone) === b.timezone && { timezone: b.timezone }),
  } });
  await logActivity({ userId: req.user.id, action: 'company_terms_updated', entityType: 'Company', entityId: c.id, details: b, req });
  res.json({ success: true, message: 'Terms saved', data: { company: updated } });
};

/** White-label address: <slug>.business.runserv.org and/or the company's own domain. */
exports.setDomain = async (req, res) => {
  if (bad(req, res)) return;
  const { slug, customDomain } = req.body;
  if (slug && (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug))) throw new AppError('Portal address must be 3–40 letters, numbers or hyphens', 400);
  const data = {};
  if (slug !== undefined) data.slug = slug || null;
  if (customDomain !== undefined) data.customDomain = customDomain ? customDomain.toLowerCase() : null;
  try { const c = await prisma.company.update({ where: { id: req.params.id }, data }); res.json({ success: true, message: 'Portal address saved', data: { company: c } }); }
  catch (e) { if (e?.code === 'P2002') throw new AppError('That address is already used by another organisation', 400); throw e; }
};

// ── Wallet (Runserv staff reconcile bank transfers) ──────────────────────────
// Staff-entered money about a company is a REQUEST until a different admin approves it (services/moneyApprovals.service.js).
const approvals = require('../services/moneyApprovals.service');
const queued = (res, row) => res.status(202).json({ success: true, message: 'Request recorded. A different admin must approve it before anything changes.', data: { request: row } });
exports.creditWallet = async (req, res) => {
  if (bad(req, res)) return;
  const reason = [req.body.note || 'Bank transfer received', req.body.reference ? `ref ${req.body.reference}` : ''].filter(Boolean).join(' — ');
  queued(res, await approvals.request({ kind: 'ORG_WALLET_CREDIT', targetId: req.params.id, amount: Number(req.body.amount), reason, payload: { reference: req.body.reference }, actor: req.user.id, role: req.user.role, req }));
};
exports.adjustWallet = async (req, res) => {
  if (bad(req, res)) return;
  queued(res, await approvals.request({ kind: 'ORG_WALLET_ADJUST', targetId: req.params.id, amount: Number(req.body.amount), reason: req.body.note, actor: req.user.id, role: req.user.role, req }));
};
exports.listApprovals = async (req, res) => res.json({ success: true, data: { requests: await approvals.list({ status: ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING' }) } });
exports.approveApproval = async (req, res) => { const out = await approvals.approve({ id: req.params.id, actor: req.user.id, note: req.body?.note, req }); res.json({ success: true, message: 'Approved and applied.', data: out }); };
exports.rejectApproval = async (req, res) => res.json({ success: true, data: { request: await approvals.reject({ id: req.params.id, actor: req.user.id, note: req.body?.note, req }) } });

// ── Stats ────────────────────────────────────────────────────────────────────
exports.getStats = async (req, res) => {
  const period = cal.periodOf(new Date()); const { start, end } = cal.periodBounds(period);
  const [active, pending, mtd, open, overdue, owed, wallets] = await Promise.all([
    prisma.company.count({ where: { status: 'ACTIVE' } }), prisma.company.count({ where: { status: 'PENDING' } }),
    prisma.corporateTrip.aggregate({ where: { status: 'COMPLETED', tripAt: { gte: start, lt: end } }, _sum: { fare: true, commissionAmount: true, distanceKm: true }, _count: { _all: true } }),
    prisma.companyInvoice.aggregate({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, _sum: { subtotal: true, amountPaid: true }, _count: { _all: true } }),
    prisma.companyInvoice.count({ where: { status: 'OVERDUE' } }),
    prisma.corporateTrip.findMany({ where: { status: 'COMPLETED', payoutStatus: 'ACCRUED', earnerUserId: { not: null } }, select: { driverEarnings: true, driverPaidAmount: true } }),
    prisma.company.aggregate({ where: { status: 'ACTIVE' }, _sum: { walletBalance: true } }),
  ]);
  res.json({ success: true, data: {
    period, activeCompanies: active, pendingCompanies: pending,
    monthToDate: { trips: mtd._count._all, billed: mtd._sum.fare ?? 0, runservRevenue: mtd._sum.commissionAmount ?? 0, distanceKm: cal.round2(mtd._sum.distanceKm ?? 0) },
    outstandingInvoices: { count: open._count._all, amount: cal.round2((open._sum.subtotal ?? 0) - (open._sum.amountPaid ?? 0)) },
    overdueInvoices: overdue, owedToDrivers: cal.round2(owed.reduce((s, t) => s + t.driverEarnings - t.driverPaidAmount, 0)), companyWalletsHeld: wallets._sum.walletBalance ?? 0,
  } });
};

// ── Invoices & receipts ──────────────────────────────────────────────────────
exports.listInvoices = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query);
  const where = { ...(req.query.status && { status: req.query.status }), ...(req.query.period && { period: req.query.period }), ...(req.query.companyId && { companyId: req.query.companyId }) };
  const [invoices, total] = await Promise.all([
    prisma.companyInvoice.findMany({ where, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }], skip, take: limit, include: { company: { select: { id: true, name: true, orgCode: true } } } }),
    prisma.companyInvoice.count({ where }),
  ]);
  res.json({ success: true, data: { invoices, pagination: { total, page, pages: Math.ceil(total / limit) } } });
};
exports.getInvoice = async (req, res) => {
  const invoice = await prisma.companyInvoice.findUnique({ where: { id: req.params.id }, include: {
    company: { select: { id: true, name: true, orgCode: true, email: true, billingEmail: true, commissionRate: true } },
    payments: { orderBy: { receivedAt: 'asc' } },
    payouts: { include: { user: { select: { firstName: true, lastName: true, phone: true, role: true } } }, orderBy: { netAmount: 'desc' } } } });
  if (!invoice) throw new AppError('Invoice not found', 404);
  const trips = await prisma.corporateTrip.findMany({ where: { invoiceId: invoice.id }, orderBy: { tripAt: 'asc' }, include: {
    employee: { select: { staffNumber: true, department: { select: { name: true } }, user: { select: { firstName: true, lastName: true } } } },
    ride: { select: { pickupAddress: true, dropoffAddress: true } }, delivery: { select: { pickupAddress: true, dropoffAddress: true } } } });
  res.json({ success: true, data: { invoice, trips } });
};
exports.generateInvoices = async (req, res) => {
  if (bad(req, res)) return;
  const { companyId, period } = req.body;
  if (companyId) { const invoice = await billing.generateInvoiceForCompany({ companyId, period }); return res.json({ success: true, message: invoice ? 'Invoice generated' : 'Nothing to bill for that period', data: { invoice } }); }
  const result = await billing.generateMonthlyInvoices(); const overdue = await billing.markOverdueInvoices();
  res.json({ success: true, message: `${result.issued} invoice(s) issued`, data: { ...result, markedOverdue: overdue } });
};
/** Reconciliation: record a receipt (full or part payment). */
exports.recordPayment = async (req, res) => {
  if (bad(req, res)) return;
  const { amount, method, reference, receivedAt, note } = req.body;
  // A receipt typed in by staff does not mark anything paid (and pays no drivers) until a different admin approves it.
  queued(res, await approvals.request({ kind: 'INVOICE_RECEIPT', targetId: req.params.id, amount: Number(amount), reason: note || `Receipt ${reference || ''}`.trim() || 'Receipt recorded by staff', payload: { method, reference, receivedAt }, actor: req.user.id, role: req.user.role, req }));
};
exports.settleDrivers = async (req, res) => {
  const advance = req.body?.advance === true;
  // Paying drivers before the company has paid puts Runserv's own money at risk: Super Admin only.
  if (advance && req.user.role !== 'SUPER_ADMIN') throw new AppError('Only a Super Admin can pay drivers before the company has paid.', 403);
  const result = await billing.settleDriversForInvoice({ invoiceId: req.params.id, advance });
  await logActivity({ userId: req.user.id, action: 'org_drivers_settled', entityType: 'CompanyInvoice', entityId: req.params.id, details: { ...result, advance }, req });
  res.json({ success: true, message: `${result.paid} driver payout(s) credited`, data: result });
};
exports.voidInvoice = async (req, res) => {
  const invoice = await billing.voidInvoice({ invoiceId: req.params.id });
  await logActivity({ userId: req.user.id, action: 'org_invoice_voided', entityType: 'CompanyInvoice', entityId: req.params.id, req });
  res.json({ success: true, message: 'Invoice voided', data: { invoice } });
};
exports.listPayouts = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query, 25);
  const where = { ...(req.query.status && { status: req.query.status }), ...(req.query.period && { period: req.query.period }), ...(req.query.companyId && { companyId: req.query.companyId }) };
  const [payouts, total] = await Promise.all([
    prisma.orgPayout.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, include: { user: { select: { firstName: true, lastName: true, phone: true, role: true } }, company: { select: { name: true } }, invoice: { select: { invoiceNumber: true, status: true } } } }),
    prisma.orgPayout.count({ where }),
  ]);
  res.json({ success: true, data: { payouts, pagination: { total, page, pages: Math.ceil(total / limit) } } });
};

exports.validateBillingMode = validateBillingMode;
