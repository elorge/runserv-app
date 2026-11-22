// mobile/src/utils/guestAuth.js — pure rules for adopting / ending a GUEST session (no React, no storage).
// A guest session is a phone-verification credential. It is never a registered login: it is never written to the
// registered `authToken` / `user` keys and never connects the authenticated socket.
import { sessionUsable } from './guestBooking';

/** @returns {{ ok: boolean, message?: string, session?: object }} the cleaned session, or why it was refused. */
export function validateGuestSession(gs, now = Date.now()) {
  if (!gs || typeof gs !== 'object') return { ok: false, message: 'Missing verification session.' };
  if (typeof gs.session !== 'string' || gs.session.length < 16) return { ok: false, message: 'Invalid verification session.' };
  if (!gs.expiresAt || Number.isNaN(new Date(gs.expiresAt).getTime())) return { ok: false, message: 'Invalid verification session.' };
  if (gs.converted === true) return { ok: false, message: 'This number already has an account. Please sign in.' };
  const clean = { session: gs.session, expiresAt: gs.expiresAt, phone: String(gs.phone || ''), countryCode: String(gs.countryCode || '').toUpperCase().slice(0, 2) };
  if (!sessionUsable(clean, now)) return { ok: false, message: 'Your verification has expired. Please verify again.' };
  return { ok: true, session: clean };
}

/** Keys that belong to the REGISTERED session. Guest code must never touch them. */
export const REGISTERED_KEYS = Object.freeze(['authToken', 'user']);

/** Conversion response ({ user, token }) -> true only when it can start a registered session. */
export const isRegisteredPayload = (p) => !!(p && typeof p.token === 'string' && p.token.length > 10 && p.user && p.user.id && p.user.role);
