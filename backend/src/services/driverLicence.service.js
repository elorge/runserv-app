// backend/src/services/driverLicence.service.js
//
// M13 (roadmap Phase 2 / §5B): driver-licence eligibility. A licence number and a photo are not enough: the licence must be
// VERIFIED by a Runserv reviewer, UNEXPIRED, and of a CLASS permitted for the vehicle category being driven.
//
// WHICH CLASS MAY DRIVE WHICH CATEGORY IS A LEGAL QUESTION, NOT A CODING ONE. This file therefore ships NO built-in class table:
// the rules come from configuration that you set after qualified Nigerian advice (roadmap Gate 2):
//   LICENCE_CLASS_RULES='{"CAR":["B"],"MOTORCYCLE":["A"]}'
// A category with no configured rule FAILS CLOSED (LICENCE_RULES_NOT_CONFIGURED) while enforcement is on.
//
// Enforcement: ENFORCE_LICENCE_ELIGIBILITY=true|false wins; otherwise ON everywhere except development/test (an unset NODE_ENV counts as production). The same check
// runs at approval, fleet assignment, go-online and accept (the server decides; the app only mirrors it).
'use strict';

const { normaliseCategory } = require('../utils/vehicleCategories');

const licenceEnforced = (env = process.env) => {
  const v = String(env.ENFORCE_LICENCE_ELIGIBILITY ?? '').toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return require('../utils/envGuard').isProduction(env); // same rule as the boot guard: only development|test are relaxed
};

/** @returns {Record<string, Set<string>>} category -> permitted licence classes (upper-case). Bad JSON => no rules (fails closed). */
const licenceRules = (env = process.env) => {
  let raw;
  try { raw = JSON.parse(env.LICENCE_CLASS_RULES || '{}'); } catch { return {}; }
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [cat, classes] of Object.entries(raw)) {
      if (Array.isArray(classes)) out[normaliseCategory(cat)] = new Set(classes.map((c) => String(c).trim().toUpperCase()).filter(Boolean));
    }
  }
  return out;
};

const normaliseClass = (c) => String(c ?? '').trim().toUpperCase();
const startOfUtcDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x.getTime(); };
const fail = (code, message) => ({ code, message });

/** A licence is valid through the WHOLE of its expiry date. */
const licenceExpired = (expiresAt, now = new Date()) => startOfUtcDay(expiresAt) < startOfUtcDay(now);

/**
 * Pure. `profile` is a DriverProfile; `category` the vehicle category being driven (defaults to the profile's own).
 * @returns {{ ok:boolean, failures:{code:string,message:string}[] }}
 */
const checkLicence = ({ profile, category, now = new Date(), env = process.env }) => {
  const failures = [];
  if (!profile) return { ok: false, failures: [fail('LICENCE_NOT_VERIFIED', 'No driver profile.')] };
  const cat = normaliseCategory(category || profile.vehicleType);

  if (profile.licenseVerificationStatus !== 'VERIFIED' || !profile.licenseVerifiedAt) {
    failures.push(fail('LICENCE_NOT_VERIFIED', profile.licenseVerificationStatus === 'REJECTED'
      ? 'Your driving licence was rejected. Upload a corrected one.' : 'Your driving licence has not been verified by Runserv yet.'));
  }
  const cls = normaliseClass(profile.licenseClass);
  if (!cls) failures.push(fail('LICENCE_CLASS_MISSING', 'Your driving licence class has not been recorded.'));
  if (!profile.licenseExpiresAt) failures.push(fail('LICENCE_EXPIRY_MISSING', 'Your driving licence expiry date has not been recorded.'));
  else if (licenceExpired(profile.licenseExpiresAt, now)) failures.push(fail('LICENCE_EXPIRED', 'Your driving licence has expired.'));

  if (cls) {
    const rule = licenceRules(env)[cat];
    if (!rule || rule.size === 0) failures.push(fail('LICENCE_RULES_NOT_CONFIGURED', `Licence rules for ${cat.toLowerCase()} work have not been configured by Runserv.`));
    else if (!rule.has(cls)) failures.push(fail('LICENCE_CLASS_NOT_PERMITTED', `A class ${cls} licence cannot be used for ${cat.toLowerCase()} work.`));
  }
  return { ok: failures.length === 0, failures };
};

module.exports = { licenceEnforced, licenceRules, licenceExpired, checkLicence, normaliseClass };
