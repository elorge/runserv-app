// mobile/src/utils/recipientEmail.js — recipient email for REGISTERED customers' parcels (Option B) and the sender's "code was emailed" notice.
// Reuses the guest flow's cleaner/format check and its error wording (utils/guestBooking.js). The server decides when the email is mandatory.
import { cleanEmailInput, looksLikeEmail } from './guestBooking';
import { parseApiError } from './apiError';

export const RECIPIENT_EMAIL_INVALID_TEXT = 'Enter a valid email address for the recipient.';
export const RECIPIENT_EMAIL_REQUIRED_TEXT = 'Enter the recipient\'s email address. The hand-over code is sent there.';

/** Client-side check: empty is fine (the server says when it is required); typed-but-wrong is rejected. Returns an error string or null. */
export const recipientEmailError = (raw) => (String(raw || '').trim() && !looksLikeEmail(raw) ? RECIPIENT_EMAIL_INVALID_TEXT : null);

/** Request-body fragment: `recipientEmail` (trimmed, lower-cased) only when something was typed. */
export const recipientEmailPatch = (raw) => { const e = cleanEmailInput(raw); return e ? { recipientEmail: e } : {}; };

/** Server answer -> inline field error text, or null when the failure is about something else. */
export function recipientEmailServerError(err) {
  const c = parseApiError(err).code;
  if (c === 'RECIPIENT_EMAIL_REQUIRED') return RECIPIENT_EMAIL_REQUIRED_TEXT;
  if (c === 'RECIPIENT_EMAIL_INVALID') return RECIPIENT_EMAIL_INVALID_TEXT;
  return null;
}

export const HANDOVER_EMAILED_NOTICE = 'The hand-over code was emailed to the recipient. Ask them for it if the courier cannot complete the hand-over.';

/**
 * Sender's neutral notice: shown to the owner when proof is required and not yet done but the server sends NO podCode (the recipient's email carries it).
 * Never contains the code or the address. When podCode IS present the HandoverCodeCard is used instead.
 */
export function handoverEmailedNotice(delivery, user) {
  const p = delivery?.proof;
  if (!p?.required || p.verified || p.failed) return null;
  if (delivery.podCode) return null;
  if (!user?.id || delivery.customerId !== user.id) return null;
  return HANDOVER_EMAILED_NOTICE;
}
