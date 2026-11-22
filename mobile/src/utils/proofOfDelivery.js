// mobile/src/utils/proofOfDelivery.js — pure rules for the courier proof-of-delivery UI and the sender's hand-over card.
import { parseApiError, safeServerMessage } from './apiError';

export const FAIL_REASONS = [
  { code: 'RECIPIENT_UNAVAILABLE', label: 'Recipient not available' },
  { code: 'WRONG_ADDRESS', label: 'Wrong or unreachable address' },
  { code: 'RECIPIENT_REFUSED', label: 'Recipient refused the parcel' },
  { code: 'PARCEL_DAMAGED', label: 'Parcel damaged' },
  { code: 'OTHER', label: 'Other reason' },
];

export const cleanCode = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);
export const isRecipientCode = (v) => /^\d{6}$/.test(String(v || ''));

/** What the proof panel should show for a delivery payload (`delivery.proof` comes from the server; the client never decides). */
export function proofState(delivery) {
  const p = delivery?.proof;
  if (!p) return 'NONE';
  if (p.failed) return p.returnStatus === 'RETURNED' ? 'RETURNED' : 'FAILED_RETURNING';
  if (p.verified) return 'VERIFIED';
  if (!p.required) return 'NONE';
  if (p.locked) return 'LOCKED';
  return 'PENDING';
}

/** Courier may only start "Mark as delivered" when a required proof has been verified by the SERVER. */
export const proofBlocksCompletion = (delivery) => ['PENDING', 'LOCKED', 'FAILED_RETURNING', 'RETURNED'].includes(proofState(delivery));

export function validateFailure({ reason, note }) {
  const errors = {};
  if (!FAIL_REASONS.some((r) => r.code === reason)) errors.reason = 'Choose why the delivery failed.';
  if (reason === 'OTHER' && String(note || '').trim().length < 5) errors.note = 'Add a short note so support understands what happened.';
  if (String(note || '').length > 300) errors.note = 'Keep the note under 300 characters.';
  return { ok: Object.keys(errors).length === 0, errors };
}

export function proofErrorMessage(err) {
  const p = parseApiError(err);
  if (p.network) return { text: 'No connection. Your code was not lost: check your network and try again.', retry: true };
  const by = {
    POD_CODE_WRONG: 'That code was not accepted. Check it with the recipient and try again.',
    POD_LOCKED: 'Too many wrong codes. This delivery is locked: contact Runserv support.',
    POD_ALREADY_VERIFIED: 'This hand-over was already confirmed.',
  };
  if (p.code && by[p.code]) return { text: by[p.code], retry: p.code === 'POD_CODE_WRONG' };
  if (p.status === 429) return { text: 'Too many attempts. Wait a moment and try again.', retry: true };
  return { text: safeServerMessage(p) || 'Could not confirm the hand-over. Please try again.', retry: p.status >= 500 };
}

/** Sender card: show only to the owner, only while the server still sends a code (it stops once verified/failed). */
export const showHandoverCard = (delivery, user) => !!(delivery?.podCode && user?.id && delivery.customerId === user.id && !delivery.proof?.verified && !delivery.proof?.failed);
export const maskCode = (code) => (code ? '••• •••' : '');
export const spacedCode = (code) => String(code || '').replace(/\D/g, '').replace(/^(\d{3})(\d{1,3})$/, '$1 $2');
