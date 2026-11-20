// backend/src/services/bankAdmin.service.js — campaign approval workflow, reporting, settlements.
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { toMinor, fromMinor } = require('../utils/money');

const TERMINAL = ['COMPLETED', 'EXPIRED', 'CANCELLED'];

const loadCampaign = async (id) => {
  const c = await prisma.bankCampaign.findUnique({ where: { id }, include: { bankPartner: true, offers: true } });
  if (!c) throw new AppError('Campaign not found.', 404);
  return c;
};

/** Checks a campaign is complete enough to be reviewed. Returns a list of problems. */
const submissionProblems = (c) => {
  const p = [];
  if (!c.startsAt || !c.endsAt) p.push('start and end dates are required');
  else if (new Date(c.endsAt) <= new Date(c.startsAt)) p.push('end date must be after start date');
  if (!c.offers.length) p.push('add at least one offer');
  for (const o of c.offers) {
    if (!o.termsAndConditions?.trim()) p.push(`offer "${o.title}" needs terms and conditions`);
    if (o.offerType === 'ACCOUNT_OPENING' && !o.accountOpeningUrl) p.push(`offer "${o.title}" needs the bank-approved account-opening link`);
    if (o.accountOpeningUrl && !/^https:\/\//i.test(o.accountOpeningUrl)) p.push(`offer "${o.title}" link must be https`);
    if (['DISCOUNT', 'CASHBACK'].includes(o.offerType) && !o.discountPercent && !o.discountAmount) p.push(`offer "${o.title}" needs a discount value`);
  }
  return p;
};

/**
 * Lifecycle: DRAFT → PENDING_APPROVAL → SCHEDULED/ACTIVE ⇄ PAUSED → (COMPLETED|EXPIRED|CANCELLED)
 * Actions: submit | approve | reject | pause | resume | cancel.
 * Approval is a controlled action: it needs written bank approval confirmed by the approver, an ACTIVE bank
 * with an agreement reference, and a different person from the campaign's creator (maker–checker).
 */
const act = async ({ id, action, actor, body = {}, req, now = new Date(), env = process.env }) => {
  const c = await loadCampaign(id);
  const log = (name, extra = {}) => logActivity({ userId: actor, action: `bank_campaign_${name}`, entityType: 'BankCampaign', entityId: id, details: { bankPartnerId: c.bankPartnerId, from: c.status, ...extra }, req });
  const set = (data) => prisma.bankCampaign.update({ where: { id }, data });
  const bad = (m, code = 400) => { throw new AppError(m, code); };

  switch (action) {
    case 'submit': {
      if (c.status !== 'DRAFT') bad(`Only a draft can be submitted (this one is ${c.status}).`);
      const problems = submissionProblems(c);
      if (problems.length) bad(`Cannot submit: ${problems.join('; ')}.`);
      const row = await set({ status: 'PENDING_APPROVAL' }); await log('submitted'); return row;
    }
    case 'approve': {
      if (c.status !== 'PENDING_APPROVAL') bad(`Only a campaign pending approval can be approved (this one is ${c.status}).`);
      if (body.confirmWrittenApproval !== true) bad('Confirm that the bank has approved the creative, copy, links and terms in writing (confirmWrittenApproval: true).');
      if (c.bankPartner.status !== 'ACTIVE') bad('The bank partner is not ACTIVE.');
      if (!c.bankPartner.agreementReference) bad('Record the signed agreement reference on the bank partner first.');
      if (env.BANK_MAKER_CHECKER !== 'off' && c.createdById === actor) bad('A different admin must approve this campaign (maker–checker).', 403);
      const problems = submissionProblems(c); if (problems.length) bad(`Cannot approve: ${problems.join('; ')}.`);
      if (new Date(c.endsAt) <= now) bad('The campaign has already ended.');
      const status = new Date(c.startsAt) <= now ? 'ACTIVE' : 'SCHEDULED';
      const [row] = await prisma.$transaction([set({ status, approvedById: actor, approvedAt: now }), prisma.bankOffer.updateMany({ where: { campaignId: id }, data: { isPublished: true } })]);
      await log('approved', { to: status, creativeApprovedInWriting: true, agreementReference: c.bankPartner.agreementReference }); return row;
    }
    case 'reject': {
      if (c.status !== 'PENDING_APPROVAL') bad('Only a campaign pending approval can be rejected.');
      if (!body.note) bad('A rejection note is required.');
      const row = await set({ status: 'DRAFT' }); await log('rejected', { note: String(body.note).slice(0, 500) }); return row;
    }
    case 'pause': {
      if (!['ACTIVE', 'SCHEDULED'].includes(c.status)) bad(`Cannot pause a ${c.status} campaign.`);
      const row = await set({ status: 'PAUSED' }); await log('paused', { reason: body.reason }); return row;
    }
    case 'resume': {
      if (c.status !== 'PAUSED') bad('Only a paused campaign can be resumed.');
      if (!c.approvedAt) bad('This campaign was never approved.');
      if (c.endsAt && new Date(c.endsAt) <= now) bad('The campaign has already ended.');
      const status = new Date(c.startsAt) <= now ? 'ACTIVE' : 'SCHEDULED';
      const row = await set({ status }); await log('resumed', { to: status }); return row;
    }
    case 'cancel': {
      if (TERMINAL.includes(c.status)) bad(`Cannot cancel a ${c.status} campaign.`);
      const [row] = await prisma.$transaction([set({ status: 'CANCELLED' }), prisma.bankOffer.updateMany({ where: { campaignId: id }, data: { isPublished: false } })]);
      await log('cancelled', { reason: body.reason }); return row;
    }
    default: return bad('Unknown action.');
  }
};

/**
 * Edits are free in DRAFT. Editing anything customer-facing on an approved/paused campaign takes it back to DRAFT
 * (offers unpublished) so the new wording is approved again — approved creative cannot be silently changed.
 */
const FRONT_FIELDS = ['name', 'description', 'startsAt', 'endsAt', 'landingPageUrl', 'budgetAmount', 'attributionWindowDays'];
const updateCampaign = async ({ id, data, actor, req }) => {
  const c = await loadCampaign(id);
  if (TERMINAL.includes(c.status)) throw new AppError(`A ${c.status} campaign cannot be edited.`, 400);
  const patch = {}; for (const k of FRONT_FIELDS) if (data[k] !== undefined) patch[k] = data[k];
  const reapprove = c.status !== 'DRAFT' && Object.keys(patch).length > 0;
  const ops = [prisma.bankCampaign.update({ where: { id }, data: { ...patch, ...(reapprove && { status: 'DRAFT', approvedAt: null, approvedById: null }) } })];
  if (reapprove) ops.push(prisma.bankOffer.updateMany({ where: { campaignId: id }, data: { isPublished: false } }));
  const [row] = await prisma.$transaction(ops);
  await logActivity({ userId: actor, action: 'bank_campaign_edited', entityType: 'BankCampaign', entityId: id, details: { fields: Object.keys(patch), returnedToDraft: reapprove }, req });
  return { campaign: row, returnedToDraft: reapprove };
};

/** Same rule for offers: changing a live offer's terms/value sends its campaign back for approval. */
const updateOffer = async ({ offerId, data, actor, req }) => {
  const o = await prisma.bankOffer.findUnique({ where: { id: offerId }, include: { campaign: true } });
  if (!o) throw new AppError('Offer not found.', 404);
  if (TERMINAL.includes(o.campaign.status)) throw new AppError('This campaign is closed.', 400);
  const ALLOWED = ['title', 'shortDescription', 'termsAndConditions', 'offerType', 'eligibilityType', 'discountPercent', 'discountAmount', 'maxBenefitAmount', 'minTripAmount', 'redemptionLimit', 'perCustomerLimit', 'requiresBankApproval', 'accountOpeningUrl', 'displayPriority'];
  const patch = {}; for (const k of ALLOWED) if (data[k] !== undefined) patch[k] = data[k];
  const reapprove = o.campaign.status !== 'DRAFT' && ['title', 'shortDescription', 'termsAndConditions', 'offerType', 'discountPercent', 'discountAmount', 'maxBenefitAmount', 'accountOpeningUrl'].some((k) => patch[k] !== undefined);
  const ops = [prisma.bankOffer.update({ where: { id: offerId }, data: patch })];
  if (reapprove) { ops.push(prisma.bankCampaign.update({ where: { id: o.campaignId }, data: { status: 'DRAFT', approvedAt: null, approvedById: null } })); ops.push(prisma.bankOffer.updateMany({ where: { campaignId: o.campaignId }, data: { isPublished: false } })); }
  const [row] = await prisma.$transaction(ops);
  await logActivity({ userId: actor, action: 'bank_offer_edited', entityType: 'BankOffer', entityId: offerId, details: { fields: Object.keys(patch), campaignReturnedToDraft: reapprove }, req });
  return { offer: row, campaignReturnedToDraft: reapprove };
};

/** Aggregated, non-identifying performance. Each stage is a separate number; nothing is inferred from a click. */
const campaignReport = async (campaignId) => {
  const c = await loadCampaign(campaignId);
  const [stats, clicks, referrals, redemptions] = await Promise.all([
    prisma.bankOfferDailyStat.groupBy({ by: ['offerId'], where: { campaignId }, _sum: { impressions: true, views: true } }),
    prisma.bankOfferClick.groupBy({ by: ['offerId'], where: { offer: { campaignId } }, _count: { _all: true } }),
    prisma.bankReferral.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
    prisma.bankRedemption.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true }, _sum: { benefitAmount: true } }),
  ]);
  const ref = Object.fromEntries(referrals.map((r) => [r.status, r._count._all]));
  const red = Object.fromEntries(redemptions.map((r) => [r.status, { count: r._count._all, benefit: Number(r._sum.benefitAmount ?? 0) }]));
  const sum = (arr, f) => arr.reduce((s, x) => s + (x._sum?.[f] ?? 0), 0);
  const total = {
    impressions: sum(stats, 'impressions'), views: sum(stats, 'views'), clicks: clicks.reduce((s, x) => s + x._count._all, 0),
    applicationsStarted: (ref.APPLICATION_STARTED ?? 0) + (ref.SUBMITTED ?? 0) + (ref.VERIFIED ?? 0) + (ref.DECLINED ?? 0),
    submitted: (ref.SUBMITTED ?? 0) + (ref.VERIFIED ?? 0) + (ref.DECLINED ?? 0), verifiedConversions: ref.VERIFIED ?? 0, declined: ref.DECLINED ?? 0,
    redemptions: (red.CONFIRMED?.count ?? 0) + (red.RESERVED?.count ?? 0),
  };
  const budget = c.budgetAmount === null ? null : Number(c.budgetAmount);
  return {
    campaign: { id: c.id, name: c.name, status: c.status, startsAt: c.startsAt, endsAt: c.endsAt, currency: c.currency },
    totals: total,
    funnelNote: 'Clicks and applications are NOT bank accounts. Only verifiedConversions were confirmed by the bank.',
    budget: { amount: budget, spent: Number(c.spentAmount), remaining: budget === null ? null : fromMinor(Math.max(toMinor(budget) - toMinor(c.spentAmount), 0)) },
    redemptionsByStatus: red,
  };
};

// ── Bank settlements (amounts the bank owes Runserv under the agreement) ────
const FLOW = { PENDING: ['RECONCILING', 'CANCELLED'], RECONCILING: ['APPROVED', 'DISPUTED', 'CANCELLED'], APPROVED: ['PAID', 'DISPUTED'], DISPUTED: ['RECONCILING', 'CANCELLED'], PAID: [], CANCELLED: [] };

const createSettlement = async ({ bankPartnerId, campaignId = null, periodStart, periodEnd, agreedAmount, adjustmentsAmount = 0, invoiceReference = null, actor, req }) => {
  const start = new Date(periodStart); const end = new Date(periodEnd);
  if (!(end > start)) throw new AppError('periodEnd must be after periodStart.', 400);
  const bank = await prisma.bankPartner.findUnique({ where: { id: bankPartnerId } });
  if (!bank) throw new AppError('Bank partner not found.', 404);
  if (campaignId) { const c = await prisma.bankCampaign.findFirst({ where: { id: campaignId, bankPartnerId }, select: { id: true } }); if (!c) throw new AppError('Campaign does not belong to this bank.', 404); }
  const net = toMinor(agreedAmount) + toMinor(adjustmentsAmount);
  if (net < 0) throw new AppError('Net amount cannot be negative.', 400);
  // Concurrency (guide §4.2, applied to bank settlements in M12): the overlap check and the insert run in ONE transaction
  // behind a per-bank advisory lock, so two simultaneous requests cannot both pass the check.
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bank-settlement:' + bankPartnerId}))`;
      const overlap = await tx.bankSettlement.findFirst({ where: { bankPartnerId, campaignId, status: { not: 'CANCELLED' }, periodStart: { lt: end }, periodEnd: { gt: start } }, select: { id: true } });
      if (overlap) throw new AppError('A settlement already covers part of this period.', 409);
      return tx.bankSettlement.create({ data: { bankPartnerId, campaignId, periodStart: start, periodEnd: end, agreedAmount, adjustmentsAmount, netAmount: fromMinor(net), invoiceReference, currency: 'NGN', paymentReference: `RSV-${require('crypto').randomBytes(4).toString('hex').toUpperCase()}` } });
    });
  } catch (e) {
    if (e.code === 'P2002') throw new AppError('A settlement already covers part of this period.', 409); // unique reference raced
    throw e;
  }
  await logActivity({ userId: actor, action: 'bank_settlement_created', entityType: 'BankSettlement', entityId: row.id, details: { bankPartnerId, net: row.netAmount }, req });
  return row;
};

const transitionSettlement = async ({ id, to, actor, req, env = process.env, bankTransactionRef = null }) => {
  const s = await prisma.bankSettlement.findUnique({ where: { id } });
  if (!s) throw new AppError('Settlement not found.', 404);
  if (!FLOW[s.status]?.includes(to)) throw new AppError(`Cannot move a ${s.status} settlement to ${to}.`, 400);
  if (to === 'PAID' && env.BANK_MAKER_CHECKER !== 'off') {
    const a = await prisma.activityLog.findFirst({ where: { entityType: 'BankSettlement', entityId: id, action: 'bank_settlement_approved' }, orderBy: { createdAt: 'desc' }, select: { userId: true } });
    if (a && a.userId === actor) throw new AppError('A different admin must mark this settlement as paid (maker–checker).', 403);
  }
  // Concurrency (M12): every write is conditional on the status we validated against. If another request moved the record
  // first, zero rows change and we answer 409 — so a double-click on "Mark paid" can never create two receipts.
  const changed = () => new AppError('This settlement was changed by someone else. Reload and try again.', 409);
  let row;
  if (to === 'PAID') {
    // Marking paid by hand must point at the bank's own transaction id, and it is recorded as a manual receipt, so every
    // naira shown as received is traceable to a bank reference (no unexplained "paid" settlements).
    const ref = String(bankTransactionRef || '').trim();
    if (ref.length < 6) throw new AppError('Enter the bank\'s transaction reference for this payment (from the bank statement).', 400);
    const remaining = Math.max(toMinor(s.netAmount) - toMinor(s.receivedAmount ?? 0), 0);
    row = await prisma.$transaction(async (tx) => {
      const { count } = await tx.bankSettlement.updateMany({ where: { id, status: s.status }, data: { status: 'PAID', paidAt: new Date(), receivedAmount: s.netAmount } });
      if (count !== 1) throw changed();
      if (remaining > 0) await tx.bankPayment.create({ data: { bankPartnerId: s.bankPartnerId, settlementId: id, source: 'MANUAL', bankTransactionRef: ref, paymentReference: s.paymentReference ?? null, amount: fromMinor(remaining), currency: s.currency, paidAt: new Date(), status: 'MATCHED', resolvedById: actor, resolvedAt: new Date(), resolutionNote: 'Marked paid by staff against a bank statement' } });
      return tx.bankSettlement.findUnique({ where: { id } });
    });
  } else {
    const { count } = await prisma.bankSettlement.updateMany({ where: { id, status: s.status }, data: { status: to } });
    if (count !== 1) throw changed();
    row = await prisma.bankSettlement.findUnique({ where: { id } });
  }
  await logActivity({ userId: actor, action: `bank_settlement_${to.toLowerCase()}`, entityType: 'BankSettlement', entityId: id, details: { from: s.status, to }, req });
  return row;
};

module.exports = { submissionProblems, act, updateCampaign, updateOffer, campaignReport, createSettlement, transitionSettlement, FLOW };
