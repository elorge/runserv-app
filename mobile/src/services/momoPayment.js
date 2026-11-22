// MTN MoMo collection (Request-to-Pay) client flow.
//
// The customer approves a prompt on their phone; we never see the result directly. The backend reads the status back from
// MTN, so the app only (1) starts the attempt with an Idempotency-Key, (2) polls /momo/verify, (3) shows the outcome.
// A booking must exist first (rideId | deliveryId): the amount is taken from the booking on the server, never from here.
import * as Crypto from 'expo-crypto';
import { paymentAPI } from './api';

const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One key per payment attempt. Reuse it ONLY to retry the same attempt (e.g. after a dropped connection). */
export const newIdempotencyKey = () => `momo-${Crypto.randomUUID()}`;

const unwrap = (res) => res?.data?.data ?? res?.data ?? {};

/** Starts the attempt. Returns { paymentId, reference, status, replay }. Throws an Error with a user-safe message. */
export const startMomoPayment = async ({ rideId, deliveryId, phone, idempotencyKey }) => {
  if (!idempotencyKey) throw new Error('Missing idempotency key');
  try {
    const res = await paymentAPI.initializeMomo({ ...(rideId ? { rideId } : { deliveryId }), phone }, idempotencyKey);
    return unwrap(res);
  } catch (e) {
    throw new Error(e?.response?.data?.message ?? e?.message ?? 'Could not start the MTN MoMo payment');
  }
};

/**
 * Polls until the payment is final. Resolves { status } with COMPLETED | FAILED | CANCELLED | EXPIRED | REVIEW_REQUIRED,
 * or { status: 'PENDING', timedOut: true } if the customer has not approved yet (offer "check again", don't spin forever).
 * REVIEW_REQUIRED means we are checking the payment; tell the customer not to pay again.
 */
export const waitForMomo = async ({ paymentId, reference, attempts = POLL_ATTEMPTS, delayMs = POLL_DELAY_MS, onTick }) => {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await paymentAPI.verifyMomo(paymentId ? { paymentId } : { reference });
      const status = unwrap(res)?.status;
      if (status && status !== 'PENDING') return { status };
    } catch (e) {
      const status = e?.response?.data?.data?.status;
      if (status && status !== 'PENDING') return { status };
      if (e?.response?.status && e.response.status !== 202 && e.response.status < 500) throw new Error(e?.response?.data?.message ?? 'Verification failed');
      // network blip or 5xx: keep polling, the server is the source of truth
    }
    onTick?.(i + 1);
    await sleep(delayMs);
  }
  return { status: 'PENDING', timedOut: true };
};
