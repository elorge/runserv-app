// backend/src/services/payments/providerConfig.service.js
// Admin-controlled activation. Legacy providers (paystack/flutterwave/orange) keep working with NO config row (they follow
// country.paymentProviders); an explicit row with enabled=false is a kill switch. MTN MoMo is OFF unless a row enables it AND
// every gate passes (environment, onboarding, credentials, declared currency/service/limits).
'use strict';
const prisma = require('../../lib/prisma');
const { AppError } = require('../../middleware/errorHandler');
const { logActivity } = require('../../utils/auditLog');
const secretBox = require('./secretBox');
const mtn = require('./adapters/mtnMomo.adapter');

const LEGACY = ['paystack', 'flutterwave', 'orange'];
const PROVIDERS = {
  paystack:    { name: 'Paystack',    legacy: true,  secretNames: [] },
  flutterwave: { name: 'Flutterwave', legacy: true,  secretNames: [] },
  orange:      { name: 'Orange Money', legacy: true, secretNames: [] },
  mtn_momo:    { name: 'MTN MoMo',    legacy: false, secretNames: mtn.SECRET_NAMES, defaultMarkets: ['NG'] },
};

/** Which environment THIS backend runs payments in. LIVE must be explicit; anything else is SANDBOX. */
const activeEnvironment = () => (String(process.env.PAYMENT_PROVIDER_ENVIRONMENT || '').toUpperCase() === 'LIVE' ? 'LIVE' : 'SANDBOX');

const getRow = (providerKey, countryCode, environment = activeEnvironment()) =>
  prisma.paymentProviderConfig.findUnique({ where: { providerKey_countryCode_environment: { providerKey, countryCode: String(countryCode).toUpperCase(), environment } } });

/** Decrypted secrets: Admin-entered (encrypted) values win, else backend env. Never returned by any API. */
const resolveSecrets = (providerKey, row) => {
  const out = {};
  if (providerKey !== 'mtn_momo') return out;
  for (const n of mtn.SECRET_NAMES) {
    const fromDb = row?.secretsEnc?.[n] ? secretBox.decrypt(row.secretsEnc[n]) : null;
    out[n] = fromDb || process.env[mtn.ENV_FOR[n]] || undefined;
  }
  return out;
};

const adapterContext = async (providerKey, countryCode) => {
  const environment = activeEnvironment();
  const row = await getRow(providerKey, countryCode, environment);
  return { row, ctx: { environment, safeConfig: row?.safeConfig || {}, secrets: resolveSecrets(providerKey, row) } };
};

/** Presence only — masked. */
const credentialPresence = (providerKey, row) => {
  const s = resolveSecrets(providerKey, row);
  return Object.fromEntries((PROVIDERS[providerKey]?.secretNames || []).map((n) => [n, !!s[n]]));
};

/**
 * Can this provider take a payment for this customer right now?  { eligible, reason }
 * `reason` is for staff/logs; customers only ever see a generic message.
 */
const evaluate = async ({ providerKey, countryCode, currency, service, amount }) => {
  const info = PROVIDERS[providerKey];
  if (!info) return { eligible: false, reason: 'UNKNOWN_PROVIDER' };
  const environment = activeEnvironment();
  const row = await getRow(providerKey, countryCode, environment);
  if (info.legacy) return row && !row.enabled ? { eligible: false, reason: 'DISABLED_BY_ADMIN' } : { eligible: true, reason: 'LEGACY_DEFAULT' };
  if (!row || !row.enabled) return { eligible: false, reason: 'NOT_ENABLED' };
  if (environment === 'LIVE' && row.onboardingStatus !== 'PRODUCTION_APPROVED') return { eligible: false, reason: 'NOT_PRODUCTION_APPROVED' };
  const { ctx } = { ctx: { environment, safeConfig: row.safeConfig || {}, secrets: resolveSecrets(providerKey, row) } };
  if (!mtn.isConfigured(ctx)) return { eligible: false, reason: 'CREDENTIALS_MISSING' };
  if (!ctx.secrets.callbackSecret) return { eligible: false, reason: 'CALLBACK_SECRET_MISSING' };
  const cap = row.capabilities || {};
  if (currency && !(cap.currencies || []).map(String).includes(String(currency))) return { eligible: false, reason: 'CURRENCY_NOT_DECLARED' };
  if (service && cap.services && !cap.services.includes(service)) return { eligible: false, reason: 'SERVICE_NOT_ENABLED' };
  if (amount != null) {
    if (cap.minAmount != null && Number(amount) < Number(cap.minAmount)) return { eligible: false, reason: 'BELOW_MIN' };
    if (cap.maxAmount != null && Number(amount) > Number(cap.maxAmount)) return { eligible: false, reason: 'ABOVE_MAX' };
  }
  return { eligible: true, reason: 'OK' };
};

/** Kill-switch guard for the existing Paystack/Flutterwave/Orange initialise routes. */
const assertNotKilled = async (countryCode, providerKey) => {
  const r = await evaluate({ providerKey, countryCode });
  if (!r.eligible) throw new AppError('This payment method is temporarily unavailable. Please use another method.', 503);
};

/** Extra customer-facing methods for the payment-config response — only what the backend confirms is eligible. */
const extraMethodsFor = async (countryCode, currency) => {
  const out = [];
  try {
    const r = await evaluate({ providerKey: 'mtn_momo', countryCode, currency });
    if (r.eligible) out.push({ key: 'MTN_MOMO', provider: 'mtn_momo', label: 'MTN MoMo', style: 'MOBILE_MONEY_PROMPT' });
  } catch { /* never break the config call */ }
  return out;
};

// ── Admin operations (all audited; no secret ever enters an audit row) ───────────────────────────────────────────
const safe = (r) => r && { providerKey: r.providerKey, countryCode: r.countryCode, environment: r.environment, enabled: r.enabled, onboardingStatus: r.onboardingStatus, capabilities: r.capabilities, safeConfig: r.safeConfig };
const audit = (actor, action, row, extra, req) => logActivity({ userId: actor, action, entityType: 'PaymentProviderConfig', entityId: row?.id || null, details: extra, req });

const directory = async () => {
  const countries = await prisma.country.findMany({ where: { isActive: true }, select: { code: true, name: true, paymentProviders: true } });
  const rows = await prisma.paymentProviderConfig.findMany();
  const env = activeEnvironment();
  const out = [];
  for (const [key, info] of Object.entries(PROVIDERS)) {
    for (const c of countries) {
      const listed = info.legacy ? (Array.isArray(c.paymentProviders) ? c.paymentProviders : []).includes(key) : (info.defaultMarkets || []).includes(c.code) || rows.some((r) => r.providerKey === key && r.countryCode === c.code);
      if (!listed) continue;
      const row = rows.find((r) => r.providerKey === key && r.countryCode === c.code && r.environment === env) || null;
      const ev = await evaluate({ providerKey: key, countryCode: c.code });
      out.push({
        providerKey: key, name: info.name, countryCode: c.code, countryName: c.name, activeEnvironment: env,
        configured: !!row, enabled: !!row?.enabled || (info.legacy && !row), effective: ev.eligible, effectiveReason: ev.reason,
        onboardingStatus: row?.onboardingStatus || (info.legacy ? 'PRODUCTION_APPROVED' : 'PLANNED'),
        capabilities: row?.capabilities || null, safeConfig: row?.safeConfig || null,
        adapter: key === 'mtn_momo' ? mtn.getCapabilities() : null,
        credentials: credentialPresence(key, row), secretsRotatedAt: row?.secretsRotatedAt || null, lastVerifiedAt: row?.lastVerifiedAt || null,
        secretEntryAvailable: secretBox.isConfigured(),
        callbackUrl: key === 'mtn_momo' ? `${process.env.API_BASE_URL || ''}/api/payments/momo/webhook/<reference>/<token>` : null,
      });
    }
  }
  return out;
};

const upsertSettings = async ({ providerKey, countryCode, environment, onboardingStatus, capabilities, safeConfig, actor, req }) => {
  if (!PROVIDERS[providerKey]) throw new AppError('Unknown provider.', 404);
  countryCode = String(countryCode).toUpperCase();
  const before = await getRow(providerKey, countryCode, environment);
  const data = {
    ...(onboardingStatus && { onboardingStatus }), ...(capabilities && { capabilities }), ...(safeConfig && { safeConfig }), updatedById: actor,
  };
  const row = await prisma.paymentProviderConfig.upsert({
    where: { providerKey_countryCode_environment: { providerKey, countryCode, environment } },
    create: { providerKey, countryCode, environment, enabled: PROVIDERS[providerKey].legacy, ...data }, update: data,
  });
  await audit(actor, 'payment_provider_settings_changed', row, { before: safe(before), after: safe(row), environment }, req);
  return row;
};

const disable = async ({ providerKey, countryCode, environment, actor, reason, req }) => {
  countryCode = String(countryCode).toUpperCase();
  const row = await prisma.paymentProviderConfig.upsert({
    where: { providerKey_countryCode_environment: { providerKey, countryCode, environment } },
    create: { providerKey, countryCode, environment, enabled: false, updatedById: actor }, update: { enabled: false, updatedById: actor },
  });
  await audit(actor, 'payment_provider_disabled', row, { environment, reason: String(reason || '').slice(0, 300) }, req);
  return row;
};

/** Enable. LIVE + MTN MoMo needs a second Super Admin (maker-checker) and PRODUCTION_APPROVED; everything else is direct. */
const requestEnable = async ({ providerKey, countryCode, environment, actor, reason, req }) => {
  countryCode = String(countryCode).toUpperCase();
  if (String(reason || '').trim().length < 5) throw new AppError('A reason of at least 5 characters is required.', 400);
  const info = PROVIDERS[providerKey]; if (!info) throw new AppError('Unknown provider.', 404);
  const row = await getRow(providerKey, countryCode, environment);
  if (!info.legacy) {
    if (environment === 'LIVE' && row?.onboardingStatus !== 'PRODUCTION_APPROVED') throw new AppError('Record written MTN production approval (onboarding status) before enabling LIVE.', 409);
    if (!row || !mtn.isConfigured({ environment, safeConfig: row.safeConfig || {}, secrets: resolveSecrets(providerKey, row) })) throw new AppError('Credentials / settings are incomplete for this provider.', 409);
  }
  if (!info.legacy && environment === 'LIVE') {
    if (await prisma.providerChangeRequest.findFirst({ where: { providerKey, countryCode, environment, status: 'PENDING' } })) throw new AppError('An enable request is already waiting for approval.', 409);
    const cr = await prisma.providerChangeRequest.create({ data: { providerKey, countryCode, environment, action: 'ENABLE', reason: String(reason).slice(0, 300), requestedById: actor } });
    await logActivity({ userId: actor, action: 'payment_provider_enable_requested', entityType: 'ProviderChangeRequest', entityId: cr.id, details: { providerKey, countryCode, environment }, req });
    return { pendingApproval: true, request: cr };
  }
  const updated = await prisma.paymentProviderConfig.upsert({
    where: { providerKey_countryCode_environment: { providerKey, countryCode, environment } },
    create: { providerKey, countryCode, environment, enabled: true, updatedById: actor }, update: { enabled: true, updatedById: actor },
  });
  await audit(actor, 'payment_provider_enabled', updated, { environment, reason }, req);
  return { pendingApproval: false, config: updated };
};

const decide = async ({ id, approve, actor, note, req }) => {
  const cr = await prisma.providerChangeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Request not found.', 404);
  if (cr.status !== 'PENDING') throw new AppError('Already decided.', 409);
  if (cr.requestedById === actor) throw new AppError('A different Super Admin must decide a request you made.', 403);
  const won = (await prisma.providerChangeRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor, decidedAt: new Date(), decisionNote: note ? String(note).slice(0, 300) : null } })).count === 1;
  if (!won) throw new AppError('Someone else just decided this request.', 409);
  if (approve) {
    const row = await prisma.paymentProviderConfig.update({ where: { providerKey_countryCode_environment: { providerKey: cr.providerKey, countryCode: cr.countryCode, environment: cr.environment } }, data: { enabled: true, updatedById: actor } });
    await audit(actor, 'payment_provider_enabled', row, { environment: cr.environment, requestId: id, requestedBy: cr.requestedById }, req);
  } else await logActivity({ userId: actor, action: 'payment_provider_enable_rejected', entityType: 'ProviderChangeRequest', entityId: id, details: {}, req });
  return { id, status: approve ? 'APPROVED' : 'REJECTED' };
};

/** Rotate / enter secrets. Encrypted at rest, never returned; audit records names only. */
const setSecrets = async ({ providerKey, countryCode, environment, values, actor, req }) => {
  const info = PROVIDERS[providerKey]; if (!info || !info.secretNames.length) throw new AppError('This provider has no Admin-managed secrets.', 400);
  if (!secretBox.isConfigured()) throw new AppError('Secret entry is not available: PAYMENT_SECRETS_KEY is not configured on the backend. Set the provider secrets as backend environment variables instead.', 503);
  countryCode = String(countryCode).toUpperCase();
  const names = Object.keys(values || {}).filter((n) => info.secretNames.includes(n) && String(values[n] || '').length > 0);
  if (!names.length) throw new AppError('No valid secret values supplied.', 400);
  const existing = (await getRow(providerKey, countryCode, environment))?.secretsEnc || {};
  const next = { ...existing }; for (const n of names) next[n] = secretBox.encrypt(values[n]);
  const row = await prisma.paymentProviderConfig.upsert({
    where: { providerKey_countryCode_environment: { providerKey, countryCode, environment } },
    create: { providerKey, countryCode, environment, enabled: false, secretsEnc: next, secretsRotatedAt: new Date(), updatedById: actor },
    update: { secretsEnc: next, secretsRotatedAt: new Date(), updatedById: actor },
  });
  await audit(actor, 'payment_provider_secrets_rotated', row, { environment, names }, req);
  return { names, rotatedAt: row.secretsRotatedAt };
};

module.exports = { PROVIDERS, LEGACY, activeEnvironment, getRow, adapterContext, evaluate, assertNotKilled, extraMethodsFor, directory, upsertSettings, disable, requestEnable, decide, setSecrets, credentialPresence };
