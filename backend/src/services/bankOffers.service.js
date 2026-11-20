// backend/src/services/bankOffers.service.js
//
// Bank Offers engine (blueprint §6). Principles enforced here, server-side:
//  * Only approved, in-window, budget-available campaigns of an ACTIVE bank with a valid agreement are shown.
//  * Impressions, views, clicks, applications, redemptions and VERIFIED conversions are separate counts;
//    only a signed bank callback can make a referral VERIFIED. A click is never an account opening.
//  * No personal data goes to the bank: outbound links carry an opaque referral code only.
//  * Credit / deferred-payment offers are hidden unless BANK_CREDIT_OFFERS_ENABLED=true, and when shown they
//    always carry "subject to the bank's approval" wording — never a guaranteed-approval claim.
'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { toMinor, fromMinor, rateToPpm } = require('../utils/money');

const CREDIT_TYPES = ['CREDIT', 'DEFERRED_PAYMENT'];
const TRIP_BENEFIT_TYPES = ['DISCOUNT', 'CASHBACK', 'SPONSORED_RIDE', 'SPONSORED_DELIVERY'];
const creditEnabled = (env = process.env) => String(env.BANK_CREDIT_OFFERS_ENABLED) === 'true';
// Discount / cashback / sponsored-trip offers can only be honoured once the fare-application rule exists
// (blueprint §10.3, pending Decision 4). Until BANK_TRIP_BENEFITS_ENABLED=true they are not shown, viewed, clicked,
// quoted or redeemed, so a customer is never promised a discount the app cannot apply.
const tripBenefitsEnabled = (env = process.env) => String(env.BANK_TRIP_BENEFITS_ENABLED) === 'true';
const isTripBenefit = (offer) => TRIP_BENEFIT_TYPES.includes(offer.offerType);

const DISCLAIMER = {
  CREDIT: "Credit is provided by the bank and is subject to the bank's own eligibility checks and approval. Approval is not guaranteed. Runserv does not make credit decisions.",
  DEFERRED_PAYMENT: "Deferred payment is provided by the bank and is subject to the bank's own eligibility checks and approval. Approval is not guaranteed. Runserv does not make credit decisions.",
  ACCOUNT_OPENING: "Opening an account is subject to the bank's own requirements and approval. Runserv does not open accounts or guarantee approval.",
  DEFAULT: "This offer is provided by the bank and is subject to its terms and eligibility. Runserv does not guarantee that you will qualify.",
};
const disclaimerFor = (offer) => DISCLAIMER[offer.offerType] ?? DISCLAIMER.DEFAULT;

const ELIGIBILITY_TEXT = {
  PUBLIC: 'Open to all Runserv customers.',
  EXISTING_BANK_CUSTOMERS: 'For existing customers of this bank.',
  NEW_BANK_CUSTOMERS: 'For people who are not yet customers of this bank.',
  INVITATION_ONLY: 'By invitation from the bank.',
  BANK_APPROVAL_REQUIRED: 'Subject to the bank’s eligibility check.',
};

// ── Display rules (pure) ──────────────────────────────────────────────────────
const dateOnlyMs = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x.getTime(); };

/** Is this offer allowed on a customer's screen right now? Returns { ok, reason }. */
const isDisplayable = ({ offer, campaign, bank }, now = new Date(), env = process.env) => {
  if (!bank || bank.status !== 'ACTIVE') return { ok: false, reason: 'BANK_NOT_ACTIVE' };
  if (!bank.agreementReference) return { ok: false, reason: 'NO_AGREEMENT' };
  if (bank.agreementStartAt && dateOnlyMs(bank.agreementStartAt) > now.getTime()) return { ok: false, reason: 'AGREEMENT_NOT_STARTED' };
  if (bank.agreementEndAt && dateOnlyMs(bank.agreementEndAt) + 86400000 <= now.getTime()) return { ok: false, reason: 'AGREEMENT_ENDED' };
  if (!campaign || !['ACTIVE', 'SCHEDULED'].includes(campaign.status)) return { ok: false, reason: 'CAMPAIGN_NOT_APPROVED' };
  if (!campaign.startsAt || !campaign.endsAt) return { ok: false, reason: 'NO_DATES' };
  if (new Date(campaign.startsAt) > now) return { ok: false, reason: 'NOT_STARTED' };
  if (new Date(campaign.endsAt) <= now) return { ok: false, reason: 'ENDED' };
  if (campaign.budgetAmount !== null && campaign.budgetAmount !== undefined && toMinor(campaign.spentAmount) >= toMinor(campaign.budgetAmount)) return { ok: false, reason: 'BUDGET_EXHAUSTED' };
  if (!offer.isPublished) return { ok: false, reason: 'NOT_PUBLISHED' };
  if (!offer.termsAndConditions) return { ok: false, reason: 'NO_TERMS' };
  if (CREDIT_TYPES.includes(offer.offerType) && !creditEnabled(env)) return { ok: false, reason: 'CREDIT_NOT_ENABLED' };
  return { ok: true };
};

/** What a customer sees. Internal fields (budget, creator, spend) are deliberately absent. */
const toCustomerOffer = ({ offer, campaign, bank }) => ({
  id: offer.id, title: offer.title, description: offer.shortDescription, terms: offer.termsAndConditions,
  offerType: offer.offerType, eligibility: ELIGIBILITY_TEXT[offer.eligibilityType] ?? ELIGIBILITY_TEXT.BANK_APPROVAL_REQUIRED,
  eligibilityType: offer.eligibilityType, requiresBankApproval: offer.requiresBankApproval,
  expiresAt: campaign.endsAt, hasTripBenefit: TRIP_BENEFIT_TYPES.includes(offer.offerType), hasAccountLink: Boolean(offer.accountOpeningUrl),
  limits: { perCustomer: offer.perCustomerLimit ?? null, minTripAmount: offer.minTripAmount === null || offer.minTripAmount === undefined ? null : Number(offer.minTripAmount), maxBenefitAmount: offer.maxBenefitAmount === null || offer.maxBenefitAmount === undefined ? null : Number(offer.maxBenefitAmount) },
  currency: campaign.currency, bank: { name: bank.displayName, logoUrl: bank.logoUrl ?? null },
  disclaimer: disclaimerFor(offer),
});

// ── Benefit calculation (pure, integer minor units) ──────────────────────────
/** @returns {{ eligible:boolean, reason?:string, benefitMinor:number }} */
const computeBenefit = (offer, tripAmount) => {
  if (!TRIP_BENEFIT_TYPES.includes(offer.offerType)) return { eligible: false, reason: 'NOT_A_TRIP_BENEFIT', benefitMinor: 0 };
  const trip = toMinor(tripAmount);
  if (!(trip > 0)) return { eligible: false, reason: 'INVALID_AMOUNT', benefitMinor: 0 };
  if (offer.minTripAmount && trip < toMinor(offer.minTripAmount)) return { eligible: false, reason: 'BELOW_MINIMUM_TRIP', benefitMinor: 0 };
  let benefit;
  if (offer.discountPercent) benefit = Number((BigInt(trip) * BigInt(Math.round(Number(offer.discountPercent) * 10000)) + 500000n) / 1000000n); // percent → ppm
  else if (offer.discountAmount) benefit = toMinor(offer.discountAmount);
  else if (['SPONSORED_RIDE', 'SPONSORED_DELIVERY'].includes(offer.offerType)) benefit = trip; // fully sponsored, bounded by the cap below
  else return { eligible: false, reason: 'NO_VALUE_CONFIGURED', benefitMinor: 0 };
  if (offer.maxBenefitAmount) benefit = Math.min(benefit, toMinor(offer.maxBenefitAmount));
  benefit = Math.min(benefit, trip);
  return benefit > 0 ? { eligible: true, benefitMinor: benefit } : { eligible: false, reason: 'ZERO_BENEFIT', benefitMinor: 0 };
};

// ── Loading ───────────────────────────────────────────────────────────────────
const loadDisplayable = async (offerId, now = new Date()) => {
  const offer = await prisma.bankOffer.findUnique({ where: { id: offerId }, include: { campaign: { include: { bankPartner: true } } } });
  if (!offer) return null;
  const { campaign, ...o } = offer; const { bankPartner: bank, ...c } = campaign;
  return { offer: o, campaign: c, bank, display: isDisplayable({ offer: o, campaign: c, bank }, now) };
};

const mustBeDisplayable = async (offerId, env = process.env) => {
  const row = await loadDisplayable(offerId);
  if (!row || !row.display.ok || (isTripBenefit(row.offer) && !tripBenefitsEnabled(env))) throw new AppError('This offer is not available.', 404); // same answer for unknown and unavailable
  return row;
};

/** Offers a customer may see, highest priority first. */
const listOffers = async ({ countryCode = 'NG', now = new Date() } = {}) => {
  const rows = await prisma.bankOffer.findMany({
    where: { isPublished: true, campaign: { status: { in: ['ACTIVE', 'SCHEDULED'] }, startsAt: { lte: now }, endsAt: { gt: now }, bankPartner: { status: 'ACTIVE', countryCode } } },
    include: { campaign: { include: { bankPartner: true } } }, orderBy: [{ displayPriority: 'desc' }, { createdAt: 'desc' }], take: 100,
  });
  const out = [];
  for (const r of rows) {
    const { campaign, ...offer } = r; const { bankPartner: bank, ...c } = campaign;
    if (isTripBenefit(offer) && !tripBenefitsEnabled()) continue;
    if (isDisplayable({ offer, campaign: c, bank }, now).ok) out.push(toCustomerOffer({ offer, campaign: c, bank }));
  }
  return out;
};

// ── Event counters ────────────────────────────────────────────────────────────
const today = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const bump = (offer, field) => prisma.bankOfferDailyStat.upsert({
  where: { offerId_day: { offerId: offer.id, day: today() } },
  update: { [field]: { increment: 1 } }, create: { offerId: offer.id, campaignId: offer.campaignId, day: today(), [field]: 1 },
});

// One impression per customer per offer per hour, so a script (or a refresh loop) cannot inflate the numbers a bank is shown.
// In-process only: with several server instances the guard is per instance, which still bounds the inflation to N per hour.
const seenImpressions = new Map();
const impressionSeen = (userId, offerId, nowMs = Date.now()) => {
  if (!userId) return false;
  if (seenImpressions.size > 50000) seenImpressions.clear();
  const key = `${userId}:${offerId}`; const hour = Math.floor(nowMs / 3600000);
  if (seenImpressions.get(key) === hour) return true;
  seenImpressions.set(key, hour); return false;
};

/** The app reports which offers it actually rendered. Only displayable offers count. */
const recordImpressions = async (offerIds, { userId = null, env = process.env } = {}) => {
  const ids = [...new Set(offerIds)].slice(0, 20); let counted = 0;
  for (const id of ids) {
    const r = await loadDisplayable(id);
    if (!r?.display.ok || (isTripBenefit(r.offer) && !tripBenefitsEnabled(env))) continue;
    if (impressionSeen(userId, id)) continue;
    await bump(r.offer, 'impressions'); counted += 1;
  }
  return counted;
};

const viewOffer = async (offerId) => { const r = await mustBeDisplayable(offerId); await bump(r.offer, 'views'); return toCustomerOffer(r); };

// ── Outbound click → referral ────────────────────────────────────────────────
const code = (prefix, bytes = 6) => `${prefix}${crypto.randomBytes(bytes).toString('hex').toUpperCase()}`;

/** Adds only opaque, non-personal parameters (referral code, campaign code, source). */
const buildOutboundUrl = (baseUrl, { referralCode, campaignCode }) => {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:') throw new AppError('This offer has no valid destination link.', 409);
  u.searchParams.set('utm_source', 'runserv'); u.searchParams.set('utm_campaign', campaignCode); u.searchParams.set('ref', referralCode);
  return u.toString();
};

const trackClick = async ({ userId, offerId, source = 'RUNSERV_APP' }) => {
  const r = await mustBeDisplayable(offerId);
  if (!r.offer.accountOpeningUrl) throw new AppError('This offer has no account-opening link.', 400);
  // Tapping again reuses the customer's open referral instead of creating a new click each time: clicks stay a count of
  // people who engaged, and the bank's callback still lands on the one code it was given.
  const windowMs = (r.campaign.attributionWindowDays ?? 30) * 86400000;
  const open = await prisma.bankReferral.findFirst({
    where: { userId, offerId, status: { in: ['CLICKED', 'APPLICATION_STARTED', 'SUBMITTED'] }, createdAt: { gte: new Date(Date.now() - windowMs) } },
    orderBy: { createdAt: 'desc' }, select: { referralCode: true },
  });
  if (open) return { url: buildOutboundUrl(r.offer.accountOpeningUrl, { referralCode: open.referralCode, campaignCode: r.campaign.campaignCode }), referralCode: open.referralCode, bankName: r.bank.displayName, reused: true };
  const referralCode = code('RS-', 5);
  const click = await prisma.bankOfferClick.create({ data: { offerId, userId, source, attributionCode: code('CK-', 8) } });
  await prisma.bankReferral.create({
    data: { bankPartnerId: r.bank.id, campaignId: r.campaign.id, offerId, userId, clickId: click.id, referralCode, status: 'CLICKED', currency: r.campaign.currency },
  });
  return { url: buildOutboundUrl(r.offer.accountOpeningUrl, { referralCode, campaignCode: r.campaign.campaignCode }), referralCode, bankName: r.bank.displayName };
};

// ── Sponsored benefit: quote & redeem ────────────────────────────────────────
const quote = async ({ offerId, amount }) => {
  const r = await mustBeDisplayable(offerId);
  const b = computeBenefit(r.offer, amount);
  return { eligible: b.eligible, reason: b.reason ?? null, benefitAmount: fromMinor(b.benefitMinor), payable: fromMinor(Math.max(toMinor(amount) - b.benefitMinor, 0)), currency: r.campaign.currency, disclaimer: disclaimerFor(r.offer) };
};

/**
 * Reserve a sponsored benefit. All limits are enforced in one DB transaction: the budget with a conditional
 * atomic update, the redemption limits by counting after the insert and rolling back if exceeded.
 * Idempotent per (idempotencyKey).
 */
const redeem = async ({ userId, offerId, amount, idempotencyKey, rideId = null, deliveryId = null }) => {
  if (!idempotencyKey || String(idempotencyKey).length < 8) throw new AppError('idempotencyKey (min 8 chars) is required.', 400);
  const prior = await prisma.bankRedemption.findUnique({ where: { idempotencyKey } });
  if (prior) {
    if (prior.userId !== userId || prior.offerId !== offerId) throw new AppError('This idempotency key was already used.', 409);
    return { redemption: prior, replay: true };
  }
  const r = await mustBeDisplayable(offerId);
  const b = computeBenefit(r.offer, amount);
  if (!b.eligible) throw new AppError(`This offer cannot be applied: ${String(b.reason).replace(/_/g, ' ').toLowerCase()}.`, 422);
  const benefit = fromMinor(b.benefitMinor);

  const redemption = await prisma.$transaction(async (tx) => {
    if (r.campaign.budgetAmount !== null && r.campaign.budgetAmount !== undefined) {
      const room = fromMinor(toMinor(r.campaign.budgetAmount) - b.benefitMinor);
      const upd = await tx.bankCampaign.updateMany({ where: { id: r.campaign.id, spentAmount: { lte: room } }, data: { spentAmount: { increment: benefit } } });
      if (upd.count !== 1) throw new AppError('This campaign’s budget has been used up.', 409);
    } else {
      await tx.bankCampaign.update({ where: { id: r.campaign.id }, data: { spentAmount: { increment: benefit } } });
    }
    const row = await tx.bankRedemption.create({ data: { offerId, campaignId: r.campaign.id, userId, idempotencyKey, rideId, deliveryId, tripAmount: amount, benefitAmount: benefit, currency: r.campaign.currency, status: 'RESERVED' } });
    const live = { status: { in: ['RESERVED', 'CONFIRMED'] } };
    if (r.offer.redemptionLimit && (await tx.bankRedemption.count({ where: { offerId, ...live } })) > r.offer.redemptionLimit) throw new AppError('This offer has reached its redemption limit.', 409);
    if (r.offer.perCustomerLimit && (await tx.bankRedemption.count({ where: { offerId, userId, ...live } })) > r.offer.perCustomerLimit) throw new AppError('You have already used this offer the maximum number of times.', 409);
    return row;
  });
  return { redemption, replay: false };
};

/** Give the budget back when a reserved benefit is not used (trip cancelled, payment failed). Safe against double release. */
const releaseRedemption = async ({ redemptionId, userId = null }) => {
  const red = await prisma.bankRedemption.findUnique({ where: { id: redemptionId } });
  if (!red || (userId && red.userId !== userId)) throw new AppError('Redemption not found.', 404);
  if (red.status !== 'RESERVED') throw new AppError(`A ${red.status.toLowerCase()} redemption cannot be released.`, 400);
  await prisma.$transaction(async (tx) => {
    // Conditional flip: only the call that actually moves RESERVED → RELEASED gives the budget back, so two
    // simultaneous releases cannot return it twice.
    const flipped = await tx.bankRedemption.updateMany({ where: { id: red.id, status: 'RESERVED' }, data: { status: 'RELEASED' } });
    if (flipped.count !== 1) throw new AppError('This redemption was already released or used.', 409);
    await tx.bankCampaign.update({ where: { id: red.campaignId }, data: { spentAmount: { decrement: Number(red.benefitAmount) } } });
  });
  return { released: true };
};

/** Housekeeping: reservations never confirmed (app closed, payment abandoned) hold budget for nothing. Run on a schedule. */
const releaseStaleReservations = async ({ olderThanMinutes = 60, now = new Date(), limit = 200 } = {}) => {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60000);
  const rows = await prisma.bankRedemption.findMany({ where: { status: 'RESERVED', createdAt: { lt: cutoff } }, select: { id: true }, take: limit });
  let released = 0;
  for (const { id } of rows) { try { await releaseRedemption({ redemptionId: id }); released += 1; } catch { /* already handled elsewhere */ } }
  return { checked: rows.length, released };
};

const confirmRedemption = async ({ redemptionId }) => {
  const red = await prisma.bankRedemption.findUnique({ where: { id: redemptionId } });
  if (!red) throw new AppError('Redemption not found.', 404);
  if (red.status !== 'RESERVED') throw new AppError(`A ${red.status.toLowerCase()} redemption cannot be confirmed.`, 400);
  return prisma.bankRedemption.update({ where: { id: red.id }, data: { status: 'CONFIRMED' } });
};

// ── Bank callbacks (verified conversions) ────────────────────────────────────
const RANK = { CLICKED: 0, APPLICATION_STARTED: 1, SUBMITTED: 2, VERIFIED: 3, DECLINED: 3 };
const TERMINAL = ['VERIFIED', 'DECLINED', 'EXPIRED', 'DUPLICATE'];
const CALLBACK_TOLERANCE_SEC = 300;

/** Per-bank secrets live in env (BANK_WEBHOOK_SECRETS='{"<bankPartnerId>":"secret"}'), never in the database or repo. */
const getBankSecret = (bankPartnerId, env = process.env) => {
  try { return JSON.parse(env.BANK_WEBHOOK_SECRETS || '{}')[bankPartnerId] || null; } catch { return null; }
};

const sign = (secret, timestamp, rawBody) => crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

const verifyCallbackSignature = ({ secret, timestamp, signature, rawBody, nowSec = Math.floor(Date.now() / 1000) }) => {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > CALLBACK_TOLERANCE_SEC) return false; // replay protection
  const a = Buffer.from(sign(secret, timestamp, rawBody)); const b = Buffer.from(String(signature).replace(/^sha256=/, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const processBankCallback = async ({ bankPartnerId, rawBody, headers, env = process.env, now = new Date(), secret: secretOverride = null }) => {
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const secret = secretOverride || getBankSecret(bankPartnerId, env);
  if (!verifyCallbackSignature({ secret, timestamp: headers['x-runserv-timestamp'], signature: headers['x-runserv-signature'], rawBody: raw, nowSec: Math.floor(now.getTime() / 1000) }))
    throw new AppError('Invalid signature.', 401);
  let p; try { p = JSON.parse(raw); } catch { throw new AppError('Invalid JSON.', 400); }
  const status = String(p.status || '').toUpperCase();
  if (!RANK.hasOwnProperty(status) || status === 'CLICKED') throw new AppError('status must be APPLICATION_STARTED, SUBMITTED, VERIFIED or DECLINED.', 400);
  if (!p.referralCode) throw new AppError('referralCode is required.', 400);
  if (status === 'VERIFIED' && !p.bankReference) throw new AppError('bankReference is required for VERIFIED.', 400);
  if (p.conversionValue !== undefined && p.conversionValue !== null && (!Number.isFinite(Number(p.conversionValue)) || Number(p.conversionValue) < 0)) throw new AppError('conversionValue must be a non-negative number.', 400);

  const ref = await prisma.bankReferral.findUnique({ where: { referralCode: p.referralCode }, include: { campaign: true } });
  if (!ref || ref.bankPartnerId !== bankPartnerId) throw new AppError('Unknown referral.', 404); // a bank can only touch its own referrals
  if (ref.status === status) return { duplicate: true, status: ref.status };            // idempotent replay
  if (TERMINAL.includes(ref.status) || RANK[status] <= RANK[ref.status]) throw new AppError(`Cannot move a ${ref.status} referral to ${status}.`, 409);

  const windowMs = (ref.campaign.attributionWindowDays ?? 30) * 86400000;
  if (now.getTime() - new Date(ref.createdAt).getTime() > windowMs) {
    if (ref.status === 'CLICKED') await prisma.bankReferral.update({ where: { id: ref.id }, data: { status: 'EXPIRED' } });
    throw new AppError('The attribution window for this referral has elapsed.', 422);
  }
  if (p.bankReference) {
    const clash = await prisma.bankReferral.findUnique({ where: { bankExternalRef: String(p.bankReference) } });
    if (clash && clash.id !== ref.id) throw new AppError('This bank reference is already linked to another referral.', 409);
  }
  const data = { status, ...(p.bankReference && { bankExternalRef: String(p.bankReference) }) };
  if (status === 'APPLICATION_STARTED' || status === 'SUBMITTED') data.applicationAt = ref.applicationAt ?? now;
  if (status === 'VERIFIED') { data.verifiedAt = now; if (p.conversionValue !== undefined && p.conversionValue !== null) data.conversionValue = Number(p.conversionValue); }
  // Conditional on the status we just read: two simultaneous callbacks cannot both apply (the loser gets a 409 and may retry).
  let row;
  try { row = await prisma.bankReferral.update({ where: { id: ref.id, status: ref.status }, data }); }
  catch (e) { if (e.code === 'P2025') throw new AppError('This referral was updated at the same moment. Retry.', 409); throw e; }
  await logActivity({ userId: null, action: `bank_referral_${status.toLowerCase()}`, entityType: 'BankReferral', entityId: ref.id, details: { bankPartnerId, campaignId: ref.campaignId } });
  return { duplicate: false, status: row.status };
};

module.exports = {
  CREDIT_TYPES, TRIP_BENEFIT_TYPES, creditEnabled, tripBenefitsEnabled, releaseStaleReservations, disclaimerFor, isDisplayable, toCustomerOffer, computeBenefit,
  listOffers, recordImpressions, viewOffer, trackClick, buildOutboundUrl, quote, redeem, releaseRedemption, confirmRedemption,
  getBankSecret, sign, verifyCallbackSignature, processBankCallback, RANK,
};
