// mobile/src/utils/guestBooking.js — pure helpers for the guest booking screens (no React, no network).
import { parseApiError, safeServerMessage } from './apiError';

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Idempotency key for ONE booking attempt (server: 8-64 chars of A-Za-z0-9._:-). Reuse it on every retry of the same attempt. */
export const newIdempotencyKey = (rand = Math.random, now = Date.now) =>
  `gb-${now().toString(36)}-${Array.from({ length: 16 }, () => ALNUM[Math.floor(rand() * ALNUM.length)]).join('')}`;

/** Keep digits and a leading +. The server normalises to international format; this only strips punctuation people type. */
export const cleanPhoneInput = (raw) => {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  return (s.startsWith('+') ? '+' : '') + s.replace(/\+/g, '');
};
/** Cheap client check so an obvious typo never costs an SMS. The server is the authority. */
/** M16.1: trim + lowercase, like the server. */
export const cleanEmailInput = (raw) => String(raw || '').trim().toLowerCase();
export const looksLikeEmail = (raw) => { const e = cleanEmailInput(raw); return e.length >= 6 && e.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(e) && !e.includes('..'); };
export const looksLikePhone = (raw) => { const d = cleanPhoneInput(raw).replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; };

export const isOtpCode = (v) => /^\d{6}$/.test(String(v || ''));

/** "123456" -> "123 456" (easier to read out loud). */
export const groupCode = (code) => String(code || '').replace(/\D/g, '').replace(/^(\d{3})(\d{1,3})$/, '$1 $2');

export const formatCountdown = (sec) => { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Parcel form -> { ok, errors:{field:message} }. Mirrors the server's required fields so people fix them before submitting. */
export function validateParcelForm({ description, recipientName, recipientPhone, recipientEmail, acknowledged }) {
  const errors = {};
  if (String(description || '').trim().length < 3) errors.description = 'Say what is in the parcel.';
  if (String(recipientName || '').trim().length < 2) errors.recipientName = 'Enter the recipient’s name.';
  if (!looksLikePhone(recipientPhone)) errors.recipientPhone = 'Enter the recipient’s phone number.';
  // The server decides whether the recipient's email is mandatory (it is while email is the only delivery channel); here we only reject one that is typed but wrong.
  if (String(recipientEmail || '').trim() && !looksLikeEmail(recipientEmail)) errors.recipientEmail = 'Enter a valid email address for the recipient.';
  if (acknowledged !== true) errors.acknowledged = 'Please confirm the parcel has no prohibited items.';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Send OTP / verify OTP failures -> a message plus what the screen should do next. */
export function otpErrorMessage(err) {
  const p = parseApiError(err);
  const by = {
    OTP_COOLDOWN: 'Please wait a moment before asking for another code.',
    OTP_DAILY_CAP: 'We cannot send codes right now. Please try again later.',
    OTP_CHANNEL_DISABLED: 'Verification is not available right now. Please try again later.',
    INVALID_EMAIL: 'Enter a valid email address.',
    INVALID_CODE_FORMAT: 'Enter the 6-digit code from your email.',
    GUEST_SECRET_MISSING: 'Verification is not available right now. Please try again later.',
    OTP_PHONE_LIMIT: 'Too many codes were requested. Try again later.',
    OTP_IP_LIMIT: 'Too many attempts from this device. Try again later.',
    OTP_WRONG: 'That code is not right. Check it and try again.',
    OTP_EXPIRED: 'That code has expired. Request a new one.',
    OTP_EXPIRED_OR_MISSING: 'That code has expired. Request a new one.',
    OTP_LOCKED: 'Too many wrong codes. Request a new code.',
    OTP_USED: 'That code was already used. Request a new one.',
    OTP_DELIVERY_UNAVAILABLE: 'We cannot send codes right now. Please try again later.',
    OTP_SEND_FAILED: 'We could not send the code. Check the number and try again.',
    INVALID_PHONE: safeServerMessage(p) || 'That phone number does not look right.',
    UNSUPPORTED_COUNTRY: 'This country is not supported yet.',
    GUEST_BLOCKED: 'This account cannot be used for guest booking. Please contact support.',
    GUEST_BOOKING_DISABLED: 'Booking without an account is not available yet.',
  };
  if (p.code === 'ACCOUNT_EXISTS') return { text: 'This number already has a Runserv account. Please sign in.', action: 'SIGNIN' };
  if (p.code && by[p.code]) return { text: by[p.code], action: ['OTP_EXPIRED', 'OTP_EXPIRED_OR_MISSING', 'OTP_LOCKED', 'OTP_USED'].includes(p.code) ? 'RESEND' : p.code === 'OTP_WRONG' ? 'RETRY_CODE' : 'NONE' };
  if (p.network) return { text: 'No connection. Check your network and try again.', action: 'NONE' };
  if (p.status === 429) return { text: 'Too many attempts. Please wait a minute and try again.', action: 'NONE' };
  return { text: safeServerMessage(p) || 'Something went wrong. Please try again.', action: 'NONE' };
}

const REQUOTE = ['QUOTE_EXPIRED', 'QUOTE_INVALID', 'QUOTE_LOCATION_MISMATCH', 'QUOTE_PARCEL_MISMATCH', 'QUOTE_ALREADY_USED', 'QUOTE_REQUIRED'];
const FIX = ['PARCEL_CATEGORY_REQUIRED', 'PARCEL_WEIGHT_REQUIRED', 'PARCEL_DESCRIPTION_REQUIRED', 'RECIPIENT_NAME_REQUIRED', 'RECIPIENT_PHONE_INVALID', 'RECIPIENT_EMAIL_REQUIRED', 'RECIPIENT_EMAIL_INVALID', 'PROHIBITED_ACK_REQUIRED', 'ADDRESS_REQUIRED'];

/**
 * Failure of POST /guest/bookings (and other session calls) -> { text, action }.
 * action: REQUOTE (go back, get a new price) | REVERIFY (phone session ended) | FIX (edit the form) | WAIT | RETRY (same key is safe) |
 *         NEW_ATTEMPT (key clashed: start a fresh attempt) | SIGNIN | SUPPORT | NONE
 */
export function bookingErrorMessage(err) {
  const p = parseApiError(err);
  if (p.network) return { text: 'No connection. Your booking may or may not have gone through: tap “Try again” and we will not book twice.', action: 'RETRY' };
  const c = p.code;
  if (c === 'QUOTE_EXPIRED') return { text: 'This price has expired. Get a fresh price to continue.', action: 'REQUOTE' };
  if (REQUOTE.includes(c)) return { text: 'Something changed since the price was shown. Get a fresh price to continue.', action: 'REQUOTE' };
  if (c === 'GUEST_SESSION_EXPIRED' || c === 'GUEST_SESSION_REQUIRED' || p.status === 401) return { text: 'Your phone verification has ended. Verify your number again to continue.', action: 'REVERIFY' };
  if (c === 'GUEST_BLOCKED') return { text: 'This number cannot be used for guest booking. Please contact support.', action: 'SUPPORT' };
  if (c === 'GUEST_DAILY_LIMIT') return { text: 'You have reached the daily limit for booking without an account. Create an account to keep booking.', action: 'SIGNIN' };
  if (c === 'ACTIVE_BOOKING_EXISTS') return { text: safeServerMessage(p) || 'You already have a trip in progress. Open it from your bookings.', action: 'OPEN_ACTIVE' };
  if (c === 'IDEMPOTENCY_MISMATCH') return { text: 'That attempt was already used for different details. Review and confirm again.', action: 'NEW_ATTEMPT' };
  if (c === 'COUNTRY_MISMATCH') return { text: 'This price is for a different country than your verified number.', action: 'REQUOTE' };
  if (c === 'VEHICLE_UNAVAILABLE') return { text: 'That vehicle type is not available right now. Choose another.', action: 'REQUOTE' };
  if (c === 'GUEST_BOOKING_DISABLED') return { text: 'Booking without an account is not available yet.', action: 'NONE' };
  if (c && (FIX.includes(c) || c.startsWith('PARCEL_'))) return { text: safeServerMessage(p) || 'Please check the details and try again.', action: 'FIX' };
  if (p.status === 429) return { text: 'Too many attempts. Please wait a minute and try again.', action: 'WAIT' };
  if (p.status >= 500) return { text: 'Something went wrong on our side. Try again: we will not book twice.', action: 'RETRY' };
  return { text: safeServerMessage(p) || 'We could not complete the booking. Please try again.', action: 'NONE' };
}

/** Account conversion failures. */
export function convertErrorMessage(err) {
  const p = parseApiError(err);
  if (p.network) return 'No connection. Check your network and try again.';
  const by = { EMAIL_TAKEN: 'That email is already registered. Please sign in instead.', INVALID_EMAIL: 'Enter a valid email address.', WEAK_PASSWORD: 'Choose a password of at least 8 characters.', ALREADY_CONVERTED: 'This number already has an account. Please sign in.', GUEST_SESSION_EXPIRED: 'Your phone verification has ended. Verify your number again.' };
  return by[p.code] || safeServerMessage(p) || 'We could not create your account. Please try again.';
}

export const STATUS_LABEL = {
  FINDING_DRIVER: 'Finding your driver', DRIVER_ASSIGNED: 'Driver on the way', DRIVER_ARRIVED: 'Driver has arrived', IN_PROGRESS: 'Trip in progress', COMPLETED: 'Trip completed',
  FINDING_COURIER: 'Finding a courier', COURIER_ASSIGNED: 'Courier on the way to collect', PARCEL_PICKED_UP: 'Parcel collected', IN_TRANSIT: 'On the way to the recipient', DELIVERED: 'Delivered',
  DELIVERY_FAILED_RETURNING: 'Delivery failed: parcel coming back', RETURNED_TO_SENDER: 'Parcel returned to you', CANCELLED: 'Cancelled', UNKNOWN: 'Status unavailable',
};
export const FINAL_STATUSES = ['COMPLETED', 'DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER'];
export const statusLabel = (s) => STATUS_LABEL[s] || String(s || '').replace(/_/g, ' ').toLowerCase() || 'Status unavailable';
export const isFinalStatus = (s) => FINAL_STATUSES.includes(s);

/** Poll while the trip is live; back off when requests fail; stop when it is over. Returns ms, or null to stop. */
export function pollDelayMs(status, failures = 0) {
  if (isFinalStatus(status)) return null;
  const base = ['FINDING_DRIVER', 'FINDING_COURIER'].includes(status) ? 6000 : 8000;
  return Math.min(60000, base * 2 ** Math.min(failures, 4));
}

/** Show the hand-over code only while it is useful: a parcel that has not been handed over, failed or been cancelled. */
export const showHandoverCode = (booking, view) => !!(booking?.podCode && view && !view.delivery?.proofVerified && !isFinalStatus(view.status) && view.status !== 'DELIVERY_FAILED_RETURNING');

/** "Return fee N" line for a recipient-side failed delivery, or null. */
export const failedFeeLine = (view, formatMoney) => (view?.delivery?.failedFee ? `Return fee: ${formatMoney(view.delivery.failedFee.amount, view.delivery.failedFee.currency)}, paid to the courier in cash.` : null);

/** Reverse-geocode response -> the place the planner stores, or null. `fallbackLabel` is used when the server only has coordinates. */
export function placeFromReverse(res, lat, lng, fallbackLabel = 'Pinned location') {
  const la = Number(lat); const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  const d = res?.data || res || {};
  const label = String(d.formattedAddress || d.address || d.description || '').trim();
  return { label: label || fallbackLabel, latitude: la, longitude: ln, approximate: !label };
}

/** What the confirm screen sends. Only fields the server reads; the signed quote is passed through untouched. */
export function buildBookingBody({ quote, pickup, destination, contactName, notes, parcel, service }) {
  const body = {
    quote,
    pickup: { latitude: pickup.latitude, longitude: pickup.longitude, address: pickup.label },
    destination: { latitude: destination.latitude, longitude: destination.longitude, address: destination.label },
  };
  const name = String(contactName || '').trim(); if (name) body.contactName = name.slice(0, 40);
  const n = String(notes || '').trim(); if (n) body.notes = n.slice(0, 300);
  if (service === 'PARCEL') {
    body.parcel = {
      category: parcel.category, weightKg: Number(parcel.weightKg),
      ...(parcel.longestSideCm ? { longestSideCm: Number(parcel.longestSideCm) } : {}),
      description: String(parcel.description || '').trim(), recipientName: String(parcel.recipientName || '').trim(),
      recipientPhone: cleanPhoneInput(parcel.recipientPhone), acknowledgedProhibited: parcel.acknowledged === true,
      ...(cleanEmailInput(parcel.recipientEmail) ? { recipientEmail: cleanEmailInput(parcel.recipientEmail) } : {}),
    };
  }
  return body;
}

// ── Session + attempt rules (pure; services/guestSession.js stores them) ───────────────────────────────────────────────────────
/** Short stable fingerprint of a request body, so a saved idempotency key is only reused for the SAME request. */
export function fingerprint(body) {
  const s = JSON.stringify(body);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length.toString(36)}-${h.toString(36)}`;
}

export const ATTEMPT_TTL_MS = 30 * 60 * 1000;

/**
 * Same request + a recent attempt -> reuse its key (a double tap, a retry after a dropped connection or an app restart then returns the
 * ORIGINAL booking instead of creating a second one). Different request, or an old attempt -> a fresh key.
 */
export function attemptFor(body, saved, now = Date.now(), rand = Math.random) {
  const fp = fingerprint(body);
  if (saved?.key && saved.fp === fp && now - Number(saved.at || 0) < ATTEMPT_TTL_MS) return { key: saved.key, fp, at: saved.at, reused: true };
  return { key: newIdempotencyKey(rand, () => now), fp, at: now, reused: false };
}

/** Is a stored phone-verification session still worth sending? (The server is the authority; this avoids a doomed request.) */
export const sessionUsable = (s, now = Date.now()) => !!(s && s.session && Number(new Date(s.expiresAt).getTime()) > now + 15 * 1000);
