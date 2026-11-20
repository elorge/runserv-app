// backend/src/controllers/adminBank.controller.js — Runserv staff side (/api/admin/banks)
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const svc = require('../services/bankAdmin.service');
const receipts = require('../services/bankReceipts.service');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const take = (req) => Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
const strip = (b, keys) => { const d = {}; for (const k of keys) if (b[k] !== undefined) d[k] = b[k]; return d; };
const BANK_FIELDS = ['legalName', 'displayName', 'countryCode', 'logoUrl', 'websiteUrl', 'contactEmail', 'contactPhone', 'agreementReference', 'agreementStartAt', 'agreementEndAt'];
const OFFER_FIELDS = ['title', 'shortDescription', 'termsAndConditions', 'offerType', 'eligibilityType', 'discountPercent', 'discountAmount', 'maxBenefitAmount', 'minTripAmount', 'redemptionLimit', 'perCustomerLimit', 'requiresBankApproval', 'accountOpeningUrl', 'displayPriority'];

// Partners
exports.listPartners = async (req, res) => ok(res, { partners: await prisma.bankPartner.findMany({ where: req.query.status ? { status: req.query.status } : {}, orderBy: { createdAt: 'desc' }, take: take(req), include: { _count: { select: { campaigns: true } } } }) });
exports.createPartner = async (req, res) => {
  const p = await prisma.bankPartner.create({ data: { ...strip(req.body, BANK_FIELDS), status: 'PROSPECT' } });
  await logActivity({ userId: req.user.id, action: 'bank_partner_created', entityType: 'BankPartner', entityId: p.id, req });
  return ok(res, { partner: p }, 201);
};
exports.updatePartner = async (req, res) => {
  const p = await prisma.bankPartner.update({ where: { id: req.params.id }, data: strip(req.body, BANK_FIELDS) });
  await logActivity({ userId: req.user.id, action: 'bank_partner_updated', entityType: 'BankPartner', entityId: p.id, details: { fields: Object.keys(strip(req.body, BANK_FIELDS)) }, req });
  return ok(res, { partner: p });
};
exports.setPartnerStatus = async (req, res) => {
  const p = await prisma.bankPartner.findUnique({ where: { id: req.params.id } });
  if (!p) throw new AppError('Bank partner not found.', 404);
  const to = req.body.status;
  if (to === 'ACTIVE' && (!p.agreementReference || !p.agreementStartAt)) throw new AppError('Record the signed agreement reference and start date before activating a bank.', 400);
  const row = await prisma.bankPartner.update({ where: { id: p.id }, data: { status: to } });
  // Pausing or terminating a bank hides all of its offers immediately (display rule reads bank status).
  await logActivity({ userId: req.user.id, action: `bank_partner_${to.toLowerCase()}`, entityType: 'BankPartner', entityId: p.id, details: { from: p.status, reason: req.body.reason }, req });
  return ok(res, { partner: row });
};

// Campaigns
exports.listCampaigns = async (req, res) => ok(res, { campaigns: await prisma.bankCampaign.findMany({ where: { ...(req.query.status && { status: req.query.status }), ...(req.query.bankPartnerId && { bankPartnerId: req.query.bankPartnerId }) }, orderBy: { createdAt: 'desc' }, take: take(req), include: { bankPartner: { select: { id: true, displayName: true } }, _count: { select: { offers: true } } } }) });
exports.getCampaign = async (req, res) => {
  const c = await prisma.bankCampaign.findUnique({ where: { id: req.params.id }, include: { bankPartner: true, offers: { orderBy: { displayPriority: 'desc' } } } });
  if (!c) throw new AppError('Campaign not found.', 404);
  return ok(res, { campaign: c, problems: svc.submissionProblems(c) });
};
exports.createCampaign = async (req, res) => {
  const bank = await prisma.bankPartner.findUnique({ where: { id: req.body.bankPartnerId }, select: { id: true } });
  if (!bank) throw new AppError('Bank partner not found.', 404);
  const b = req.body;
  const campaignCode = `RSC-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const c = await prisma.bankCampaign.create({
    data: { bankPartnerId: b.bankPartnerId, name: b.name, campaignCode, description: b.description, startsAt: b.startsAt, endsAt: b.endsAt, budgetAmount: b.budgetAmount, landingPageUrl: b.landingPageUrl, attributionWindowDays: b.attributionWindowDays ?? 30, createdById: req.user.id, status: 'DRAFT',
      ...(Array.isArray(b.offers) && b.offers.length && { offers: { create: b.offers.map((o) => ({ ...strip(o, OFFER_FIELDS), isPublished: false })) } }) },
    include: { offers: true },
  });
  await logActivity({ userId: req.user.id, action: 'bank_campaign_created', entityType: 'BankCampaign', entityId: c.id, details: { bankPartnerId: c.bankPartnerId }, req });
  return ok(res, { campaign: c }, 201);
};
exports.updateCampaign = async (req, res) => ok(res, await svc.updateCampaign({ id: req.params.id, data: req.body, actor: req.user.id, req }));
exports.campaignAction = async (req, res) => ok(res, { campaign: await svc.act({ id: req.params.id, action: req.params.action, actor: req.user.id, body: req.body, req }) });
exports.report = async (req, res) => ok(res, await svc.campaignReport(req.params.id));

// Offers
exports.addOffer = async (req, res) => {
  const c = await prisma.bankCampaign.findUnique({ where: { id: req.params.id } });
  if (!c) throw new AppError('Campaign not found.', 404);
  if (c.status !== 'DRAFT') throw new AppError('Offers can only be added to a draft campaign. Edit the campaign to return it to draft first.', 409);
  const o = await prisma.bankOffer.create({ data: { ...strip(req.body, OFFER_FIELDS), campaignId: c.id, isPublished: false } });
  await logActivity({ userId: req.user.id, action: 'bank_offer_created', entityType: 'BankOffer', entityId: o.id, details: { campaignId: c.id }, req });
  return ok(res, { offer: o }, 201);
};
exports.updateOffer = async (req, res) => ok(res, await svc.updateOffer({ offerId: req.params.id, data: req.body, actor: req.user.id, req }));
exports.deleteOffer = async (req, res) => {
  const o = await prisma.bankOffer.findUnique({ where: { id: req.params.id }, include: { campaign: true } });
  if (!o) throw new AppError('Offer not found.', 404);
  if (o.campaign.status !== 'DRAFT') throw new AppError('Only offers on draft campaigns can be deleted.', 409);
  const used = await prisma.bankOfferClick.count({ where: { offerId: o.id } });
  if (used) throw new AppError('This offer has recorded activity and cannot be deleted.', 409);
  await prisma.bankOffer.delete({ where: { id: o.id } });
  await logActivity({ userId: req.user.id, action: 'bank_offer_deleted', entityType: 'BankOffer', entityId: o.id, req });
  return ok(res, { deleted: true });
};

// Settlements
exports.listSettlements = async (req, res) => ok(res, { settlements: await prisma.bankSettlement.findMany({ where: { ...(req.query.status && { status: req.query.status }), ...(req.query.bankPartnerId && { bankPartnerId: req.query.bankPartnerId }) }, orderBy: { createdAt: 'desc' }, take: take(req), include: { bankPartner: { select: { id: true, displayName: true } } } }) });
exports.createSettlement = async (req, res) => ok(res, { settlement: await svc.createSettlement({ ...req.body, actor: req.user.id, req }) }, 201);
exports.transitionSettlement = async (req, res) => ok(res, { settlement: await svc.transitionSettlement({ id: req.params.id, to: req.body.status, bankTransactionRef: req.body.bankTransactionRef, actor: req.user.id, req }) });

// ── Runserv's accounts at each bank + money received from banks ─────────────
const publicAccount = (a) => ({ id: a.id, bankPartnerId: a.bankPartnerId, accountName: a.accountName, accountNumber: a.accountNumber, bankName: a.bankName, currency: a.currency, label: a.label, isActive: a.isActive, isPrimary: a.isPrimary, createdAt: a.createdAt });
exports.listAccounts = async (req, res) => ok(res, { accounts: (await prisma.bankReceivingAccount.findMany({ where: { ...(req.query.bankPartnerId && { bankPartnerId: String(req.query.bankPartnerId) }) }, orderBy: [{ bankPartnerId: 'asc' }, { createdAt: 'asc' }], include: { bankPartner: { select: { id: true, displayName: true } } } })).map((a) => ({ ...publicAccount(a), bank: a.bankPartner })) });
exports.createAccount = async (req, res) => ok(res, { account: publicAccount(await receipts.createAccount({ ...req.body, actor: req.user.id, req })) }, 201);
exports.updateAccount = async (req, res) => ok(res, { account: publicAccount(await receipts.updateAccount({ id: req.params.id, ...strip(req.body, ['isActive', 'isPrimary', 'label']), actor: req.user.id, req })) });
exports.rotateSecret = async (req, res) => { res.set('Cache-Control', 'no-store'); return ok(res, await receipts.rotateSecret({ bankPartnerId: req.params.id, actor: req.user.id, req })); };
exports.paymentInstructions = async (req, res) => ok(res, await receipts.paymentInstructions(req.params.id));
exports.listPayments = async (req, res) => ok(res, { payments: await prisma.bankPayment.findMany({ where: { ...(req.query.status && { status: String(req.query.status) }), ...(req.query.bankPartnerId && { bankPartnerId: String(req.query.bankPartnerId) }), ...(req.query.source && { source: String(req.query.source) }) }, orderBy: { receivedAt: 'desc' }, take: take(req), include: { bankPartner: { select: { id: true, displayName: true } }, settlement: { select: { id: true, paymentReference: true, netAmount: true, receivedAmount: true, status: true } } } }) });
exports.paymentsSummary = async (_req, res) => ok(res, await receipts.summary());
exports.matchPayment = async (req, res) => ok(res, { payment: await receipts.matchPayment({ paymentId: req.params.id, settlementId: req.body.settlementId, invoiceId: req.body.invoiceId, companyId: req.body.companyId, note: req.body.note, actor: req.user.id, req }) });
// Second-person decision on a credit someone typed in, imported, or proposed a match for. The service refuses the same person.
exports.approveReview = async (req, res) => ok(res, { payment: await receipts.approveReview({ paymentId: req.params.id, note: req.body.note, actor: req.user.id, req }) });
exports.rejectReview = async (req, res) => ok(res, { payment: await receipts.rejectReview({ paymentId: req.params.id, note: req.body.note, actor: req.user.id, req }) });
exports.importStatement = async (req, res) => ok(res, { import: await receipts.importStatement({ bankPartnerId: req.body.bankPartnerId, receivingAccountId: req.body.receivingAccountId, fileName: req.body.fileName, csvText: req.body.csvText, actor: req.user.id, req }) });
exports.listStatementImports = async (_req, res) => ok(res, { imports: await prisma.statementImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) });
exports.paymentsByAccount = async (_req, res) => ok(res, { accounts: await receipts.perAccountSummary() });
exports.runAlerts = async (_req, res) => ok(res, await receipts.alertStaleExceptions({ olderThanHours: 0 }));
exports.reversePayment = async (req, res) => ok(res, { payment: await receipts.reversePayment({ paymentId: req.params.id, note: req.body.note, actor: req.user.id, req }) });
// For a bank with no automatic notice: staff record a credit they SAW on the bank statement. Same matching rules, same duplicate guard.
exports.recordManualPayment = async (req, res) => {
  if (req.body.confirmSeenOnStatement !== true) throw new AppError('Confirm that you have seen this credit on the bank statement (confirmSeenOnStatement: true).', 400);
  const { bankPartnerId, ...payload } = req.body;
  const out = await receipts.recordInboundPayment({ bankPartnerId, payload, source: 'MANUAL', actor: req.user.id, req });
  return ok(res, { duplicate: out.duplicate, payment: out.payment, settlementStatus: out.settlementStatus ?? null }, out.duplicate ? 200 : 201);
};
