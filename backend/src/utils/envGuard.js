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
  if (env.ALLOW_PUBLIC_OSRM === 'true') w.push('ALLOW_PUBLIC_OSRM=true: production routing may use the public demo server.');
  return w;
};

const assertProductionEnv = (env = process.env) => {
  const problems = productionProblems(env);
  if (problems.length) throw new Error(`Refusing to start with unsafe configuration:\n - ${problems.join('\n - ')}`);
};

module.exports = { isDevLike, isProduction, productionProblems, productionWarnings, assertProductionEnv };
