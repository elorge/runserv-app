// backend/src/utils/envGuard.js
// Fail-closed environment rules. A missing NODE_ENV used to mean "development", which switched CORS to allow-all
// (with credentials) and turned off other protections. Now only an explicit NODE_ENV=development|test is relaxed.
'use strict';

const isDevLike = (env = process.env) => ['development', 'test'].includes(String(env.NODE_ENV || '').toLowerCase());
const isProduction = (env = process.env) => !isDevLike(env);

/** Returns a list of problems that must stop a production start. */
const productionProblems = (env = process.env) => {
  if (!isProduction(env)) return [];
  const p = [];
  const secret = env.JWT_SECRET || '';
  if (secret.length < 32) p.push('JWT_SECRET must be at least 32 random characters.');
  if (/^(secret|changeme|password|jwt|test)/i.test(secret)) p.push('JWT_SECRET looks like a placeholder.');
  if (!env.DATABASE_URL) p.push('DATABASE_URL is not set.');
  if (!env.CLIENT_URL && !env.ADMIN_URL) p.push('CLIENT_URL / ADMIN_URL are not set, so no browser origin would be allowed.');
  // M13/M14: refuse to start production on development-grade map or document-storage settings.
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) p.push('CLOUDINARY_* is not set: private identity documents cannot be stored.');
  const osrm = !!(env.OSRM_URL || env.ROUTING_URL);
  const googleRouting = !!(env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_PLACES_API_KEY);
  if (!osrm && !googleRouting && env.ALLOW_PUBLIC_OSRM !== 'true') p.push('No production routing provider: set OSRM_URL to your own routing server (or GOOGLE_ROUTES_API_KEY). The public OSRM demo server is development-only.');
  if (env.OSRM_URL && !/^https:\/\//.test(env.OSRM_URL)) p.push('OSRM_URL must be https in production.');
  if (env.BANK_RECEIPTS_ENABLED === 'true' && String(env.BANK_SECRETS_KEY || '').length < 32) p.push('BANK_SECRETS_KEY (32+ characters) is required to store bank callback secrets.');
  // WP-03: staff MFA is mandatory in production. Without it a stolen staff password is a full admin session.
  if (!require('./flags').isCanonicalBool(env.REQUIRE_STAFF_MFA)) p.push('REQUIRE_STAFF_MFA must be exactly "true" or "false" (got a non-canonical value).');
  if (!require('./flags').isTrue(env.REQUIRE_STAFF_MFA) || env.REQUIRE_STAFF_MFA !== 'true') p.push('REQUIRE_STAFF_MFA=true is required in production (staff sign-in must pass the authenticator step).');
  if (String(env.MFA_ENCRYPTION_KEY || '').length < 32) p.push('MFA_ENCRYPTION_KEY (32+ characters) is required in production to protect staff authenticator secrets.');
  p.push(...guestProblems(env));
  return p;
};

const truthy = (v) => String(v || '').toLowerCase() === 'true';
const weakSecret = (v) => String(v || '').length < 32 || /^(secret|changeme|password|jwt|test)/i.test(String(v || ''));

/**
 * M16: guest planning / booking prerequisites. Only enforced in production AND only for the features that are switched on,
 * so a deployment that keeps guest booking dark is not affected.
 */
const guestProblems = (env = process.env) => {
  const p = [];
  // WP-07: the recipient hand-over code is keyed-hashed with GUEST_HASH_SECRET, so the registered email handover flow needs it even when guest booking is OFF.
  // (When guest booking is on, the same secret is checked below; this block only reports the flow-only case, so there is no duplicate message.)
  if ((truthy(env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED) || String(env.PARCEL_PILOT_SCOPE || '').trim().toLowerCase() === 'guest_and_registered') && !truthy(env.GUEST_BOOKING_ENABLED)) {
    if (weakSecret(env.GUEST_HASH_SECRET)) p.push('GUEST_HASH_SECRET (32+ random characters) is required when EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true or PARCEL_PILOT_SCOPE=guest_and_registered, even with guest booking off.');
    else if ([env.JWT_SECRET, env.GUEST_QUOTE_SECRET, env.GUEST_OTP_HASH_SECRET].includes(env.GUEST_HASH_SECRET)) p.push('GUEST_HASH_SECRET must differ from JWT_SECRET, GUEST_QUOTE_SECRET and GUEST_OTP_HASH_SECRET.');
  }
  // M16.2.2: Option B stands on the recipient EMAIL flow, with an expiring code. It must not start without both, whether or not guest booking is on.
  if (String(env.PARCEL_PILOT_SCOPE || '').trim().toLowerCase() === 'guest_and_registered') {
    if (!truthy(env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED)) p.push('PARCEL_PILOT_SCOPE=guest_and_registered needs EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true: registered parcels use the recipient email flow, and without it they would silently fall back to the old SMS-only path.');
    const ttl = env.POD_CODE_TTL_HOURS;
    if (ttl === undefined || String(ttl).trim() === '' || !(Number(ttl) > 0 && Number(ttl) <= 24 * 30)) p.push('POD_CODE_TTL_HOURS (0 < hours <= 720) is required for PARCEL_PILOT_SCOPE=guest_and_registered.');
  }
  const planning = truthy(env.GUEST_PLANNING_ENABLED);
  const booking = truthy(env.GUEST_BOOKING_ENABLED);
  if (booking && !planning) p.push('GUEST_BOOKING_ENABLED=true requires GUEST_PLANNING_ENABLED=true (booking never turns on without its planning prerequisites).');
  if (planning || booking) {
    if (weakSecret(env.GUEST_QUOTE_SECRET)) p.push('GUEST_QUOTE_SECRET (32+ random characters) is required when guest planning is enabled.');
  }
  if (booking) {
    if (weakSecret(env.GUEST_HASH_SECRET)) p.push('GUEST_HASH_SECRET (32+ random characters) is required when guest booking is enabled.');
    else if (env.GUEST_HASH_SECRET === env.JWT_SECRET || env.GUEST_HASH_SECRET === env.GUEST_QUOTE_SECRET) p.push('GUEST_HASH_SECRET must differ from JWT_SECRET and GUEST_QUOTE_SECRET.');
    let u = null; try { u = new URL(String(env.GUEST_TRACKING_BASE_URL || '')); } catch { /* invalid */ }
    if (!u || u.protocol !== 'https:') p.push('GUEST_TRACKING_BASE_URL must be an absolute https:// URL of the deployed tracking page (e.g. https://api.example.com/t).');
    // M16.1: email is the primary verification channel; SMS is optional and only checked when it is deliberately switched on.
    const list = String(env.GUEST_OTP_CHANNEL || 'email').toLowerCase().split(',').map((x) => x.trim());
    const emailOn = truthy(env.GUEST_EMAIL_OTP_ENABLED) && list.includes('email');
    const smsOn = truthy(env.GUEST_SMS_OTP_ENABLED) && list.includes('sms');
    if (!emailOn && !smsOn) p.push('GUEST_BOOKING_ENABLED=true needs a verification channel: set GUEST_EMAIL_OTP_ENABLED=true (and GUEST_OTP_CHANNEL=email) or enable SMS deliberately.');
    if (list.includes('sms') && !truthy(env.GUEST_SMS_OTP_ENABLED)) p.push('GUEST_OTP_CHANNEL lists sms but GUEST_SMS_OTP_ENABLED is not true: enable both deliberately or remove sms.');
    if (list.includes('email') && !truthy(env.GUEST_EMAIL_OTP_ENABLED) && !smsOn) p.push('GUEST_OTP_CHANNEL lists email but GUEST_EMAIL_OTP_ENABLED is not true.');
    if (smsOn) {
      if (!truthy(env.ENABLE_SMS_DELIVERY)) p.push('ENABLE_SMS_DELIVERY=true is required when SMS OTP is enabled.');
      else if (!env.TERMII_API_KEY || !env.TERMII_SENDER_ID) p.push('TERMII_API_KEY and TERMII_SENDER_ID are required when SMS OTP is enabled.');
    }
    // M16.2: delivery notifications (recipient code + tracking link) have their own flags, independent of the OTP flags above.
    const deliveryEmailOn = truthy(env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED);
    const smsRaw = env.SMS_DELIVERY_NOTIFICATIONS_ENABLED; const deliverySmsOn = truthy(smsRaw !== undefined && smsRaw !== '' ? smsRaw : env.ENABLE_SMS_DELIVERY);
    if (deliveryEmailOn) {
      const brevo = truthy(env.BREVO_ENABLED); const resend = truthy(env.RESEND_ENABLED);
      if (!brevo && !resend) p.push('EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true needs at least one provider: BREVO_ENABLED=true and/or RESEND_ENABLED=true.');
      if (brevo && (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL)) p.push('BREVO_API_KEY and BREVO_SENDER_EMAIL are required when BREVO_ENABLED=true.');
    }
    if (deliveryEmailOn) {
      // M16.2.1: two product decisions must be RECORDED in configuration, not guessed in code (action plan P1.1 / P1.3).
      const ttl = env.POD_CODE_TTL_HOURS;
      if (ttl === undefined || String(ttl).trim() === '' || !(Number(ttl) > 0 && Number(ttl) <= 24 * 30)) p.push('POD_CODE_TTL_HOURS (hand-over code expiry, 0 < hours <= 720) is required when EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true. Product/operations choose the value; there is no default.');
      const scope = String(env.PARCEL_PILOT_SCOPE || '').trim().toLowerCase();
      // M16.2.2: Option B (guest_and_registered) is built: registered parcels ride the same recipient email flow. Either value is a RECORDED decision; unset is not.
      if (scope !== 'guest_only' && scope !== 'guest_and_registered') p.push('PARCEL_PILOT_SCOPE must be set to guest_only (Option A) or guest_and_registered (Option B) when EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true (record the pilot-scope decision explicitly).');
    }
    if (deliverySmsOn && (!env.TERMII_API_KEY || !env.TERMII_SENDER_ID)) p.push('TERMII_API_KEY and TERMII_SENDER_ID are required when SMS delivery notifications are enabled.');
    if (emailOn) {
      if (weakSecret(env.GUEST_OTP_HASH_SECRET)) p.push('GUEST_OTP_HASH_SECRET (32+ random characters) is required when email OTP is enabled. It has no fallback.');
      else if ([env.JWT_SECRET, env.GUEST_HASH_SECRET, env.GUEST_QUOTE_SECRET].includes(env.GUEST_OTP_HASH_SECRET)) p.push('GUEST_OTP_HASH_SECRET must differ from JWT_SECRET, GUEST_HASH_SECRET and GUEST_QUOTE_SECRET.');
      const brevo = truthy(env.BREVO_ENABLED); const resend = truthy(env.RESEND_ENABLED);
      if (!brevo && !resend) p.push('Email OTP needs at least one provider: BREVO_ENABLED=true and/or RESEND_ENABLED=true.');
      if (brevo && (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL)) p.push('BREVO_API_KEY and BREVO_SENDER_EMAIL are required when BREVO_ENABLED=true.');
      if (resend && (!env.RESEND_API_KEY || !(env.RESEND_SENDER_EMAIL || env.BREVO_SENDER_EMAIL))) p.push('RESEND_API_KEY and RESEND_SENDER_EMAIL are required when RESEND_ENABLED=true.');
      const alloc = (name, def) => { const n = env[name] === undefined || env[name] === '' ? def : Number(env[name]); if (!Number.isFinite(n) || n < 0) p.push(`${name} must be a non-negative number.`); };
      alloc('BREVO_DAILY_ALLOCATION', 300); alloc('RESEND_DAILY_ALLOCATION', 100);   // never above the provider's real account limit: that is checked against the dashboard, not here
      for (const [u, n] of [[env.BREVO_API_BASE_URL, 'BREVO_API_BASE_URL'], [env.RESEND_API_BASE_URL, 'RESEND_API_BASE_URL']]) { if (u && !/^https:\/\/api\.(brevo|resend)\.(com)(\/|$)/.test(u)) p.push(`${n} must be the provider's own https API URL.`); }
    }
  }
  return p;
};

/** Non-fatal, but loud: configurations that are legal to start with yet will surprise you in production. */
const productionWarnings = (env = process.env) => {
  if (!isProduction(env)) return [];
  const w = [];
  let rules = {}; try { rules = JSON.parse(env.LICENCE_CLASS_RULES || '{}'); } catch { w.push('LICENCE_CLASS_RULES is not valid JSON: no driver can be cleared to work.'); }
  if (!Object.keys(rules).length) w.push('LICENCE_CLASS_RULES is empty: with licence enforcement on, no driver can go online until rules are configured.');
  if (String(env.ENFORCE_LICENCE_ELIGIBILITY).toLowerCase() === 'false') w.push('ENFORCE_LICENCE_ELIGIBILITY=false: licence checks are OFF in production.');
  if (!env.ENABLED_VEHICLE_CATEGORIES) w.push('ENABLED_VEHICLE_CATEGORIES is unset: defaults to CAR,MOTORCYCLE,VAN. Set it to CAR for the pilot.');
  if (env.OUTBOX_WORKER === 'off') w.push('OUTBOX_WORKER=off on this instance: make sure another instance runs it.');
  if (truthy(env.GUEST_BOOKING_ENABLED) && !truthy(env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED) && !truthy(env.SMS_DELIVERY_NOTIFICATIONS_ENABLED !== undefined && env.SMS_DELIVERY_NOTIFICATIONS_ENABLED !== '' ? env.SMS_DELIVERY_NOTIFICATIONS_ENABLED : env.ENABLE_SMS_DELIVERY)) w.push('Guest booking is on but no recipient delivery channel is: set EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true (pilot). Otherwise the parcel recipient never receives the hand-over code.');
  if (env.ALLOW_PUBLIC_OSRM === 'true') w.push('ALLOW_PUBLIC_OSRM=true: production routing may use the public demo server.');
  return w;
};

const assertProductionEnv = (env = process.env) => {
  const problems = productionProblems(env);
  if (problems.length) throw new Error(`Refusing to start with unsafe configuration:\n - ${problems.join('\n - ')}`);
};

module.exports = { isDevLike, isProduction, guestProblems, productionProblems, productionWarnings, assertProductionEnv };
