import { validateGuestSession, isRegisteredPayload, REGISTERED_KEYS } from '../guestAuth';
import { normalizeLocation, validateLocation, addressFromReverse, reverseErrorKey } from '../guestLocation';
import { proofState, proofBlocksCompletion, validateFailure, proofErrorMessage, showHandoverCard, cleanCode, isRecipientCode, spacedCode } from '../proofOfDelivery';

const NOW = 1_700_000_000_000;
const good = { session: 'x'.repeat(40), expiresAt: new Date(NOW + 3600_000).toISOString(), phone: '+234****678', countryCode: 'ng' };

describe('validateGuestSession', () => {
  test('accepts a usable session and cleans it', () => { const r = validateGuestSession(good, NOW); expect(r.ok).toBe(true); expect(r.session).toEqual({ ...good, countryCode: 'NG' }); });
  test.each([[null], [{}], [{ ...good, session: 'short' }], [{ ...good, expiresAt: 'nope' }], [{ ...good, expiresAt: new Date(NOW - 1000).toISOString() }], [{ ...good, converted: true }]])('refuses %j', (gs) => {
    const r = validateGuestSession(gs, NOW); expect(r.ok).toBe(false); expect(typeof r.message).toBe('string');
  });
  test('never carries unknown fields (no token smuggling into the registered keys)', () => { expect(Object.keys(validateGuestSession({ ...good, authToken: 'evil', user: {} }, NOW).session)).toEqual(['session', 'expiresAt', 'phone', 'countryCode']); });
  test('registered keys are fixed', () => expect(REGISTERED_KEYS).toEqual(['authToken', 'user']));
  test('conversion payload must look like a registered login', () => { expect(isRegisteredPayload({ token: 'a'.repeat(30), user: { id: '1', role: 'CUSTOMER' } })).toBe(true); expect(isRegisteredPayload({ token: 'a'.repeat(30) })).toBe(false); expect(isRegisteredPayload(null)).toBe(false); });
});

describe('location normalisation', () => {
  test('needs coordinates and an address', () => {
    expect(normalizeLocation({ latitude: 7.38, longitude: 3.9, address: ' Ring Rd, Ibadan ' })).toMatchObject({ latitude: 7.38, longitude: 3.9, address: 'Ring Rd, Ibadan', label: 'Ring Rd, Ibadan' });
    expect(normalizeLocation({ latitude: 7.38, longitude: 3.9, address: '' })).toBeNull();
    expect(normalizeLocation({ latitude: 91, longitude: 3.9, address: 'x' })).toBeNull();
    expect(normalizeLocation({ latitude: 0, longitude: 0, address: 'x' })).toBeNull();
    expect(normalizeLocation({ latitude: 'a', longitude: 3, address: 'x' })).toBeNull();
  });
  test('pickup and destination must differ', () => {
    const a = { latitude: 7.38, longitude: 3.9, address: 'A' };
    expect(validateLocation(a, { latitude: 7.38, longitude: 3.9 })).toEqual({ ok: false, reason: 'SAME_AS_OTHER' });
    expect(validateLocation(a, { latitude: 7.5, longitude: 3.9 }).ok).toBe(true);
    expect(validateLocation({ latitude: 1, longitude: 1 }).reason).toBe('INVALID');
  });
  test('reverse geocode never invents an address', () => { expect(addressFromReverse({ data: { formattedAddress: 'X St' } })).toEqual({ address: 'X St', approximate: false }); expect(addressFromReverse({ data: {} })).toEqual({ address: '', approximate: true }); expect(reverseErrorKey({ message: 'Network Error' })).toBe('UNAVAILABLE'); expect(reverseErrorKey({ status: 500 })).toBe('REVERSE_FAILED'); });
});

describe('proof of delivery rules', () => {
  const d = (proof) => ({ proof });
  test('state comes from the server payload', () => {
    expect(proofState(d(undefined))).toBe('NONE');
    expect(proofState(d({ required: false }))).toBe('NONE');
    expect(proofState(d({ required: true, verified: false }))).toBe('PENDING');
    expect(proofState(d({ required: true, locked: true }))).toBe('LOCKED');
    expect(proofState(d({ required: true, verified: true }))).toBe('VERIFIED');
    expect(proofState(d({ required: true, failed: true, returnStatus: 'RETURNING' }))).toBe('FAILED_RETURNING');
    expect(proofState(d({ required: true, failed: true, returnStatus: 'RETURNED' }))).toBe('RETURNED');
  });
  test('completion is blocked until the server says verified', () => {
    expect(proofBlocksCompletion(d({ required: true }))).toBe(true);
    expect(proofBlocksCompletion(d({ required: true, verified: true }))).toBe(false);
    expect(proofBlocksCompletion(d({ required: false }))).toBe(false);
    expect(proofBlocksCompletion({})).toBe(false);
  });
  test('failure form', () => {
    expect(validateFailure({ reason: 'WRONG_ADDRESS' }).ok).toBe(true);
    expect(validateFailure({ reason: 'NOPE' }).errors.reason).toBeDefined();
    expect(validateFailure({ reason: 'OTHER', note: 'hi' }).errors.note).toBeDefined();
    expect(validateFailure({ reason: 'OTHER', note: 'Gate was locked' }).ok).toBe(true);
    expect(validateFailure({ reason: 'WRONG_ADDRESS', note: 'x'.repeat(301) }).ok).toBe(false);
  });
  test('code entry', () => { expect(cleanCode('12a3 456789')).toBe('123456'); expect(isRecipientCode('123456')).toBe(true); expect(isRecipientCode('12345')).toBe(false); expect(spacedCode('123456')).toBe('123 456'); });
  test('error messages', () => {
    expect(proofErrorMessage({ message: 'Network Error' }).retry).toBe(true);
    expect(proofErrorMessage({ status: 400, code: 'POD_CODE_WRONG', attemptsLeft: 2 }).text).not.toMatch(/attempt/);
    expect(proofErrorMessage({ status: 429, code: 'POD_LOCKED' }).text).toMatch(/locked/);
  });
  test('hand-over card only for the owning sender while a code is still issued', () => {
    const base = { podCode: '123456', customerId: 'u1', proof: {} };
    expect(showHandoverCard(base, { id: 'u1' })).toBe(true);
    expect(showHandoverCard(base, { id: 'u2' })).toBe(false);
    expect(showHandoverCard({ ...base, podCode: undefined }, { id: 'u1' })).toBe(false);
    expect(showHandoverCard({ ...base, proof: { verified: true } }, { id: 'u1' })).toBe(false);
    expect(showHandoverCard(base, null)).toBe(false);
  });
});

import { smsNotices } from '../guestNotices';
describe('SMS failure notices', () => {
  test('only permanent failures interrupt the guest', () => {
    expect(smsNotices({ trackingSms: 'SENT', recipientSms: 'PENDING' }, 'PARCEL')).toEqual([]);
    expect(smsNotices({ trackingSms: 'SKIPPED', recipientSms: null }, 'PARCEL')).toEqual([]);
    expect(smsNotices(undefined, 'PARCEL')).toEqual([]);
  });
  test('tracking and recipient failures give different instructions', () => {
    expect(smsNotices({ trackingSms: 'DEAD' }, 'RIDE').map((n) => n.key)).toEqual(['tracking']);
    expect(smsNotices({ trackingSms: 'DEAD', recipientSms: 'DEAD' }, 'PARCEL').map((n) => n.key)).toEqual(['tracking', 'recipient']);
  });
  test('a ride never shows the recipient notice', () => { expect(smsNotices({ recipientSms: 'DEAD' }, 'RIDE')).toEqual([]); });
});

// ── M16.2: recipient email + hand-over code notices ─────────────────────────────────────────────────────────────────────────
describe('M16.2 recipient hand-over communications', () => {
  const { recipientCodeNotice } = require('../guestNotices');
  const { validateParcelForm, buildBookingBody } = require('../guestBooking');
  test('parcel form: a typed-but-invalid recipient email is rejected; empty is left to the server (it may be mandatory)', () => {
    const good = { description: 'Shoes', recipientName: 'Ada', recipientPhone: '08031234567', acknowledged: true };
    expect(validateParcelForm({ ...good, recipientEmail: '' }).ok).toBe(true);
    expect(validateParcelForm({ ...good, recipientEmail: 'ada@example.com' }).ok).toBe(true);
    expect(validateParcelForm({ ...good, recipientEmail: 'ada@' }).errors).toHaveProperty('recipientEmail');
  });
  test('booking body carries the cleaned recipient email only when given', () => {
    const base = { quote: { id: 'q' }, pickup: { latitude: 1, longitude: 2, label: 'A' }, destination: { latitude: 3, longitude: 4, label: 'B' }, service: 'PARCEL' };
    const p = { category: 'SMALL', weightKg: 1, description: 'x y z', recipientName: 'Ada', recipientPhone: '0803', acknowledged: true };
    expect(buildBookingBody({ ...base, parcel: { ...p, recipientEmail: '  Ada@Example.com ' } }).parcel.recipientEmail).toBe('ada@example.com');
    expect(buildBookingBody({ ...base, parcel: p }).parcel).not.toHaveProperty('recipientEmail');
  });
  test('sender notice: truthful wording, no claim of reading, warning only when nothing got through', () => {
    expect(recipientCodeNotice({ recipientEmail: 'ACCEPTED', recipientSms: 'DISABLED', recipientOverall: 'OK' }, 'PARCEL').line).toBe('The hand-over code and tracking link were sent to the recipient by email.');
    expect(recipientCodeNotice({ recipientEmail: 'ACCEPTED', recipientSms: 'DELIVERED', recipientOverall: 'OK' }, 'PARCEL').line).toMatch(/by email and SMS/);
    expect(recipientCodeNotice({ recipientEmail: 'QUEUED', recipientSms: 'DISABLED', recipientOverall: 'PENDING' }, 'PARCEL').line).toMatch(/Sending/);
    const bad = recipientCodeNotice({ recipientEmail: 'FAILED', recipientSms: 'DISABLED', recipientOverall: 'UNRESOLVED' }, 'PARCEL');
    expect(bad.warning).toMatch(/contact Runserv support/i); expect(bad.warning).toMatch(/Do not give the courier a code yourself/); expect(bad.line).toBeNull();
    expect(recipientCodeNotice({ recipientOverall: 'OK' }, 'RIDE')).toEqual({ line: null, warning: null });
    expect(recipientCodeNotice(null, 'PARCEL')).toEqual({ line: null, warning: null });
  });
});
