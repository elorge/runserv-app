// mobile/src/utils/guestNotices.js — what to tell the guest when a booking SMS permanently failed (server: GET /guest/bookings/:id -> notices).
// The server sends delivery STATE only (never the number or text). Only a permanent failure ('DEAD') is worth interrupting the guest for.
export function smsNotices(notices, service) {
  const out = [];
  if (!notices) return out;
  if (notices.trackingSms === 'DEAD') out.push({ key: 'tracking', text: 'We could not text you the tracking link. Use “Share link” below to send it yourself.' });
  if (service === 'PARCEL' && notices.recipientSms === 'DEAD') out.push({ key: 'recipient', text: 'We could not text the hand-over code to the recipient. Tell them the code yourself, and only when the courier arrives.' });
  return out;
}

/**
 * M16.2: what to tell the SENDER about the recipient's hand-over code + tracking link. The server sends STATES only
 * (`recipientEmail` / `recipientSms`: DISABLED | NOT_PROVIDED | QUEUED | RETRYING | ACCEPTED | DELIVERED | FAILED | SKIPPED, and `recipientOverall`:
 * OK | PENDING | UNRESOLVED). ACCEPTED means a provider took it, not that the recipient has read it, so the wording never claims more.
 * Returns { line, warning }: `line` is a calm status, `warning` is set only when no channel got it through.
 */
export function recipientCodeNotice(notices, service) {
  if (service !== 'PARCEL' || !notices || !notices.recipientOverall) return { line: null, warning: null };
  const e = notices.recipientEmail; const s = notices.recipientSms;
  if (notices.recipientOverall === 'UNRESOLVED') {
    return { line: null, warning: 'We could not reach the recipient with the hand-over code. Contact Runserv support with your booking reference and we will resend it. Do not give the courier a code yourself.' };
  }
  const sent = (st) => ['ACCEPTED', 'DELIVERED'].includes(st);
  const via = [sent(e) ? 'email' : null, sent(s) ? 'SMS' : null].filter(Boolean);
  if (via.length) return { line: `The hand-over code and tracking link were sent to the recipient by ${via.join(' and ')}.`, warning: null };
  if (notices.recipientOverall === 'PENDING') return { line: 'Sending the hand-over code to the recipient…', warning: null };
  return { line: null, warning: null };
}
