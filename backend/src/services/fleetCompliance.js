// backend/src/services/fleetCompliance.js
//
// Pure functions deciding whether a fleet vehicle may take new work (blueprint §4.5):
// "Expired mandatory documents should block the affected driver or vehicle from new eligible
// assignments until reviewed."  Which documents are mandatory is configuration, not code, because
// the requirement differs per vehicle category and must be confirmed with Lagos/federal authorities
// and Nigerian counsel (blueprint §11.3).
'use strict';

const FIELD_BY_DOC = {
  insurance:   'insuranceExpiresAt',
  roadworthy:  'roadworthyExpiresAt',
  permit:      'permitExpiresAt',
};

/** Env FLEET_REQUIRED_VEHICLE_DOCS="insurance,roadworthy" (default). Add "permit" once confirmed. */
const requiredDocs = (env = process.env) =>
  String(env.FLEET_REQUIRED_VEHICLE_DOCS ?? 'insurance,roadworthy')
    .split(',').map((s) => s.trim().toLowerCase()).filter((d) => FIELD_BY_DOC[d]);

const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

/**
 * A document is valid through the whole of its expiry date.
 * @returns {'MISSING'|'EXPIRED'|'EXPIRING'|'VALID'}
 */
const docState = (expiresAt, now = new Date(), warnDays = 30) => {
  if (!expiresAt) return 'MISSING';
  const exp = startOfDay(expiresAt).getTime();
  const today = startOfDay(now).getTime();
  if (exp < today) return 'EXPIRED';
  if (exp - today <= warnDays * 86400000) return 'EXPIRING';
  return 'VALID';
};

/**
 * Pick the best document RECORD proving `name` for this vehicle.
 * A record counts only if it is of the right type, belongs to THIS vehicle (a record attached to another
 * vehicle never counts), has been approved by a reviewer (isApproved + verifiedAt, not rejected) and has an
 * expiry date. Among qualifying records the one that expires last wins.
 * @returns {{ state:'MISSING'|'PENDING'|'REJECTED'|'EXPIRED'|'EXPIRING'|'VALID', expiresAt:Date|null, documentId?:string }}
 */
const proveDocument = (vehicle, name, now, warnDays) => {
  const all = (Array.isArray(vehicle.documents) ? vehicle.documents : [])
    .filter((d) => String(d.documentType || '').trim().toLowerCase() === name);
  if (!all.length) return { state: 'MISSING', expiresAt: null };
  // Wrong-vehicle records never count. (Fleet-level records have vehicleId null and are ignored for vehicle documents.)
  const mine = all.filter((d) => d.vehicleId && vehicle.id && d.vehicleId === vehicle.id);
  if (!mine.length) return { state: 'MISSING', expiresAt: null };
  const approved = mine.filter((d) => d.isApproved === true && d.verifiedAt && !d.rejectionNote);
  if (!approved.length) {
    return mine.some((d) => d.rejectionNote) && !mine.some((d) => !d.isApproved && !d.rejectionNote)
      ? { state: 'REJECTED', expiresAt: null }
      : { state: 'PENDING', expiresAt: null };
  }
  const withExpiry = approved.filter((d) => d.expiresAt);
  if (!withExpiry.length) return { state: 'PENDING', expiresAt: null }; // approved without an expiry cannot prove validity
  const best = withExpiry.sort((a, b) => new Date(b.expiresAt) - new Date(a.expiresAt))[0];
  return { state: docState(best.expiresAt, now, warnDays), expiresAt: best.expiresAt, documentId: best.id };
};

/**
 * Compliance picture for one vehicle: per-document state, blockers and warnings.
 *
 * STRICT mode (used by every dispatch/assignment gate): a mandatory document is satisfied only by an approved,
 * unexpired document RECORD for this vehicle. The manually entered insuranceExpiresAt / roadworthyExpiresAt /
 * permitExpiresAt columns are NOT proof and are ignored.
 * Strict is on when `strict: true` is passed or `vehicle.documents` was loaded. Without either, the legacy
 * column-based view is returned for display screens only; never use it to authorise work.
 */
const vehicleCompliance = (vehicle, { now = new Date(), required = requiredDocs(), warnDays = 30, strict } = {}) => {
  const useRecords = strict === true || (strict !== false && Array.isArray(vehicle.documents));
  const docs = {};
  for (const [name, field] of Object.entries(FIELD_BY_DOC)) {
    if (useRecords) {
      const p = proveDocument(vehicle, name, now, warnDays);
      docs[name] = { ...p, mandatory: required.includes(name) };
    } else {
      docs[name] = { state: docState(vehicle[field], now, warnDays), expiresAt: vehicle[field] ?? null, mandatory: required.includes(name) };
    }
  }
  const blockers = [];
  const warnings = [];
  const BLOCKING = { MISSING: 'is missing', PENDING: 'is awaiting approval', REJECTED: 'was rejected', EXPIRED: 'has expired' };
  for (const [name, d] of Object.entries(docs)) {
    if (d.mandatory && BLOCKING[d.state]) blockers.push(`${name} ${BLOCKING[d.state]}`);
    else if (d.state === 'EXPIRING') warnings.push(`${name} expires ${new Date(d.expiresAt).toISOString().slice(0, 10)}`);
    else if (!d.mandatory && d.state === 'EXPIRED') warnings.push(`${name} has expired`);
  }
  return { docs, blockers, warnings, strict: useRecords };
};

/**
 * May this vehicle take new jobs right now?
 * @returns {{ ok:boolean, reasons:string[] }}
 */
const dispatchEligibility = ({ fleetPartner, vehicle }, opts = {}) => {
  const reasons = [];
  if (fleetPartner.status !== 'ACTIVE') reasons.push(`fleet account is ${String(fleetPartner.status).toLowerCase()}`);
  if (vehicle.status !== 'ACTIVE' || vehicle.isActive === false) reasons.push(`vehicle is ${String(vehicle.status).toLowerCase()}`);
  reasons.push(...vehicleCompliance(vehicle, opts).blockers);
  return { ok: reasons.length === 0, reasons };
};

const DOC_LABEL = { insurance: 'insurance', roadworthy: 'roadworthiness certificate', permit: 'permit' };

/**
 * Same decision as dispatchEligibility, but structured for the driver / courier app: every reason has a
 * stable `code` (the app translates it), a plain-language `message` and who can fix it.
 * `warnings` are documents that are still valid but expire soon.
 * @returns {{ ok:boolean, reasons:{code:string,message:string,fixedBy:'FLEET'|'RUNSERV',doc?:string}[], warnings:{code:string,message:string,doc:string,expiresAt:Date}[] }}
 */
const dispatchReasons = ({ fleetPartner, vehicle }, opts = {}) => {
  const reasons = [];
  const fStatus = String(fleetPartner.status);
  if (fStatus !== 'ACTIVE') reasons.push({ code: 'FLEET_NOT_ACTIVE', fleetStatus: fStatus, fixedBy: 'RUNSERV', message: `Your fleet account is ${fStatus.toLowerCase().replace(/_/g, ' ')}. Contact your fleet manager.` });
  const vStatus = String(vehicle.status);
  if (vStatus !== 'ACTIVE' || vehicle.isActive === false) reasons.push({ code: 'VEHICLE_NOT_ACTIVE', vehicleStatus: vStatus, fixedBy: 'FLEET', message: `Your assigned vehicle is ${vStatus.toLowerCase().replace(/_/g, ' ')}. Contact your fleet manager.` });
  const c = vehicleCompliance(vehicle, opts);
  const warnings = [];
  for (const [doc, d] of Object.entries(c.docs)) {
    if (d.mandatory && d.state === 'MISSING') reasons.push({ code: 'DOC_MISSING', doc, fixedBy: 'FLEET', message: `The vehicle's ${DOC_LABEL[doc]} has not been provided. Ask your fleet manager to upload it.` });
    else if (d.mandatory && d.state === 'PENDING') reasons.push({ code: 'DOC_PENDING', doc, fixedBy: 'RUNSERV', message: `The vehicle's ${DOC_LABEL[doc]} is awaiting Runserv approval.` });
    else if (d.mandatory && d.state === 'REJECTED') reasons.push({ code: 'DOC_REJECTED', doc, fixedBy: 'FLEET', message: `The vehicle's ${DOC_LABEL[doc]} was rejected. Ask your fleet manager to upload a corrected one.` });
    else if (d.mandatory && d.state === 'EXPIRED') reasons.push({ code: 'DOC_EXPIRED', doc, expiresAt: d.expiresAt, fixedBy: 'FLEET', message: `The vehicle's ${DOC_LABEL[doc]} has expired. Ask your fleet manager to upload a renewed one.` });
    else if (d.state === 'EXPIRING') warnings.push({ code: 'DOC_EXPIRING', doc, expiresAt: d.expiresAt, message: `The vehicle's ${DOC_LABEL[doc]} expires on ${new Date(d.expiresAt).toISOString().slice(0, 10)}.` });
  }
  return { ok: reasons.length === 0, reasons, warnings };
};

module.exports = { FIELD_BY_DOC, requiredDocs, docState, proveDocument, vehicleCompliance, dispatchEligibility, dispatchReasons };
