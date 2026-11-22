// mobile/src/utils/roadToOnline.js
//
// "Road to online": the checklist a new driver or courier follows from sign-up to their first trip.
//
// Nothing is stored by the checklist itself. Every step is DERIVED from what the server already records on the profile
// (GET /drivers/profile or /partners/profile), so it always agrees with the admin app's approval flow:
//
//   profile exists ............ the vehicle (and, for drivers, licence) details were saved
//   <doc fields> .............. one URL per required document, saved as each is uploaded (so leaving mid-way loses nothing)
//   licenseVerificationStatus . UNVERIFIED | VERIFIED | REJECTED   (drivers only, set by a Runserv reviewer)
//   isApproved / isRejected ... Runserv's decision (+ rejectionReason)
//   isOnline / totalRides ..... has gone online at least once
//
// Pure functions: no React, no network. Text lives in the UI; this returns ids, states and the numbers/reasons to show.

export const STEP_IDS = ['account', 'details', 'documents', 'licence', 'review', 'online'];

export const STATE = {
  DONE: 'done',         // finished
  CURRENT: 'current',   // the person can act on this now
  WAITING: 'waiting',   // ball is in Runserv's court
  BLOCKED: 'blocked',   // something was rejected / expired: the person must fix it
  LOCKED: 'locked',     // not reachable yet
};

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const startOfUtcDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x.getTime(); };

/** A licence is valid through the whole of its expiry date (same rule as backend driverLicence.service). */
export const licenceExpired = (expiresAt, now = new Date()) =>
  !!expiresAt && !Number.isNaN(new Date(expiresAt).getTime()) && startOfUtcDay(expiresAt) < startOfUtcDay(now);

/**
 * @param {object} p
 * @param {'DRIVER'|'DELIVERY_PARTNER'} p.role
 * @param {object|null} p.profile        the server profile, or null when none exists yet (404)
 * @param {string[]} p.requiredKeys      profile fields for the documents this vehicle type must provide
 * @param {Date} [p.now]
 */
export function deriveRoad({ role, profile, requiredKeys = [], now = new Date() }) {
  const isDriver = role === 'DRIVER';
  const hasProfile = !!profile;
  const approved = !!profile?.isApproved;
  const rejected = !!profile?.isRejected && !approved;

  const filled = hasProfile ? requiredKeys.filter((k) => hasText(profile[k])).length : 0;
  const total = requiredKeys.length;
  const docsComplete = hasProfile && filled === total;

  const steps = [];
  const add = (id, state, info = {}) => steps.push({ id, state, info });

  add('account', STATE.DONE);

  // Approval is Runserv's final word: once approved, everything before it counts as done, even if a reviewer
  // approved without every document.
  if (approved) {
    add('details', STATE.DONE);
    add('documents', STATE.DONE, { filled: total, total });
    if (isDriver) add('licence', STATE.DONE);
    add('review', STATE.DONE);
    const everOnline = !!profile.isOnline || Number(profile.totalRides || 0) > 0 || Number(profile.totalDeliveries || 0) > 0;
    add('online', everOnline ? STATE.DONE : STATE.CURRENT);
  } else {
    add('details', hasProfile ? STATE.DONE : STATE.CURRENT);
    add('documents', !hasProfile ? STATE.LOCKED : docsComplete ? STATE.DONE : STATE.CURRENT, { filled, total });

    if (isDriver) {
      const status = profile?.licenseVerificationStatus || 'UNVERIFIED';
      const expired = hasProfile && licenceExpired(profile.licenseExpiresAt, now);
      if (!hasProfile) add('licence', STATE.LOCKED);
      else if (expired) add('licence', STATE.BLOCKED, { reason: 'expired' });
      else if (status === 'VERIFIED') add('licence', STATE.DONE);
      else if (status === 'REJECTED') add('licence', STATE.BLOCKED, { reason: 'rejected', note: profile.licenseRejectedReason || null });
      else add('licence', hasText(profile.licenseImageUrl) ? STATE.WAITING : STATE.LOCKED);
    }

    if (rejected) add('review', STATE.BLOCKED, { reason: 'rejected', note: profile.rejectionReason || null });
    else add('review', docsComplete ? STATE.WAITING : STATE.LOCKED);

    add('online', STATE.LOCKED);
  }

  const done = steps.filter((s) => s.state === STATE.DONE).length;
  const pick = (state) => steps.find((s) => s.state === state);
  const focus = pick(STATE.BLOCKED) || pick(STATE.CURRENT) || pick(STATE.WAITING) || null;

  return {
    steps,
    doneCount: done,
    total: steps.length,
    focusId: focus ? focus.id : null,
    // 'blocked' (fix something) > 'action' (your move) > 'waiting' (Runserv's move) > 'done'
    headline: !focus ? 'done' : focus.state === STATE.BLOCKED ? 'blocked' : focus.state === STATE.CURRENT ? 'action' : 'waiting',
    complete: steps.every((s) => s.state === STATE.DONE),
    approved,
    docs: { filled, total },
  };
}

/** Which screen a step sends the person to (both roles have a documents screen; going online happens on the dashboard). */
export const stepTarget = (role, id) => {
  const docs = role === 'DRIVER' ? 'DriverDocuments' : 'PartnerDocuments';
  switch (id) {
    case 'details': case 'documents': case 'licence': return docs;
    case 'review': return docs;
    case 'online': return role === 'DRIVER' ? 'DriverDashboard' : 'Dashboard';
    default: return null;
  }
};
