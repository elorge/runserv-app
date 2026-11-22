import { parseApiError, safeServerMessage } from '../apiError';
import {
  newIdempotencyKey, cleanPhoneInput, looksLikePhone, isOtpCode, groupCode, formatCountdown, validateParcelForm, otpErrorMessage, bookingErrorMessage,
  convertErrorMessage, cleanEmailInput, looksLikeEmail, statusLabel, isFinalStatus, pollDelayMs, showHandoverCode, failedFeeLine, placeFromReverse, buildBookingBody,
} from '../guestBooking';

// what services/api.js rejects with: the body + status, or the raw axios error offline
const server = (status, body) => ({ success: false, status, ...body });
const offline = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });

describe('parseApiError', () => {
  test('reads code, status, attemptsLeft and message from a server answer', () => {
    expect(parseApiError(server(400, { message: 'No', code: 'POD_WRONG', attemptsLeft: 3 }))).toMatchObject({ status: 400, code: 'POD_WRONG', attemptsLeft: 3, message: 'No', network: false });
  });
  test('an axios error with no response is a network error and exposes no code', () => {
    expect(parseApiError(offline())).toMatchObject({ network: true, code: null, status: null });
  });
  test('still understands the raw axios shape and ignores junk', () => {
    expect(parseApiError({ response: { status: 410, data: { code: 'QUOTE_EXPIRED' } } })).toMatchObject({ status: 410, code: 'QUOTE_EXPIRED', network: false });
    expect(parseApiError(null).network).toBe(true);
    expect(parseApiError(server(400, { code: 'lower_case' })).code).toBeNull();
  });
  test('5xx server text is never shown to people', () => {
    expect(safeServerMessage(parseApiError(server(500, { message: 'prisma exploded' })))).toBeNull();
    expect(safeServerMessage(parseApiError(server(400, { message: 'Enter the weight.' })))).toBe('Enter the weight.');
  });
});

describe('idempotency keys', () => {
  test('match the server rule (8-64 of A-Za-z0-9._:-) and differ per attempt', () => {
    const a = newIdempotencyKey(); const b = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9._:-]{8,64}$/); expect(a).not.toBe(b);
  });
});

describe('phone and code inputs', () => {
  test('cleanPhoneInput strips punctuation and keeps one leading +', () => {
    expect(cleanPhoneInput('0803 123-4567')).toBe('08031234567');
    expect(cleanPhoneInput('+234 803 123 4567')).toBe('+2348031234567');
    expect(cleanPhoneInput('08+03')).toBe('0803');
  });
  test('looksLikePhone / isOtpCode / groupCode / formatCountdown', () => {
    expect(looksLikePhone('0803')).toBe(false); expect(looksLikePhone('08031234567')).toBe(true);
    expect(isOtpCode('123456')).toBe(true); expect(isOtpCode('12345')).toBe(false); expect(isOtpCode('12345a')).toBe(false);
    expect(groupCode('123456')).toBe('123 456'); expect(groupCode('')).toBe('');
    expect(formatCountdown(125)).toBe('2:05'); expect(formatCountdown(-4)).toBe('0:00');
  });
});

describe('parcel form', () => {
  const good = { description: 'Shoes', recipientName: 'Ada', recipientPhone: '08031234567', acknowledged: true };
  test('valid form passes; every missing piece is reported', () => {
    expect(validateParcelForm(good).ok).toBe(true);
    const bad = validateParcelForm({ description: 'x', recipientName: '', recipientPhone: '12', acknowledged: false });
    expect(Object.keys(bad.errors).sort()).toEqual(['acknowledged', 'description', 'recipientName', 'recipientPhone']);
  });
  test('the prohibited-items box must be explicitly true', () => { expect(validateParcelForm({ ...good, acknowledged: 'yes' }).ok).toBe(false); });
});

describe('error messages branch on the server code', () => {
  test('booking: expired price sends the person back for a new quote', () => {
    expect(bookingErrorMessage(server(410, { code: 'QUOTE_EXPIRED' }))).toMatchObject({ action: 'REQUOTE' });
    expect(bookingErrorMessage(server(409, { code: 'QUOTE_LOCATION_MISMATCH' })).action).toBe('REQUOTE');
  });
  test('booking: ended phone session means verify again; blocked means support; daily limit means sign in', () => {
    expect(bookingErrorMessage(server(401, { code: 'GUEST_SESSION_EXPIRED' })).action).toBe('REVERIFY');
    expect(bookingErrorMessage(server(401, {})).action).toBe('REVERIFY');
    expect(bookingErrorMessage(server(403, { code: 'GUEST_BLOCKED' })).action).toBe('SUPPORT');
    expect(bookingErrorMessage(server(429, { code: 'GUEST_DAILY_LIMIT' })).action).toBe('SIGNIN');
  });
  test('booking: offline and 5xx are safe to retry with the SAME key', () => {
    expect(bookingErrorMessage(offline()).action).toBe('RETRY');
    expect(bookingErrorMessage(server(500, { message: 'secret internals' }))).toMatchObject({ action: 'RETRY' });
    expect(bookingErrorMessage(server(500, { message: 'secret internals' })).text).not.toMatch(/secret/);
  });
  test('booking: field errors show the server text; key clash starts a new attempt', () => {
    expect(bookingErrorMessage(server(400, { code: 'RECIPIENT_PHONE_INVALID', message: 'Recipient phone: too short' }))).toMatchObject({ action: 'FIX', text: 'Recipient phone: too short' });
    expect(bookingErrorMessage(server(409, { code: 'IDEMPOTENCY_MISMATCH' })).action).toBe('NEW_ATTEMPT');
  });
  test('otp: wrong code retries, expired/locked asks for a new one, existing account says sign in, offline is friendly', () => {
    expect(otpErrorMessage(server(400, { code: 'OTP_WRONG' })).action).toBe('RETRY_CODE');
    expect(otpErrorMessage(server(400, { code: 'OTP_LOCKED' })).action).toBe('RESEND');
    expect(otpErrorMessage(server(409, { code: 'ACCOUNT_EXISTS' })).action).toBe('SIGNIN');
    expect(otpErrorMessage(offline()).text).toMatch(/No connection/);
  });
  test('convert: known codes and a safe fallback', () => {
    expect(convertErrorMessage(server(409, { code: 'EMAIL_TAKEN' }))).toMatch(/already registered/);
    expect(convertErrorMessage(server(500, { message: 'boom' }))).toBe('We could not create your account. Please try again.');
  });
});

describe('status helpers', () => {
  test('labels, final states and polling', () => {
    expect(statusLabel('COURIER_ASSIGNED')).toMatch(/Courier/);
    expect(['COMPLETED', 'DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER'].every(isFinalStatus)).toBe(true);
    expect(isFinalStatus('IN_TRANSIT')).toBe(false);
    expect(pollDelayMs('DELIVERED')).toBeNull();
    expect(pollDelayMs('FINDING_DRIVER')).toBe(6000);
    expect(pollDelayMs('IN_PROGRESS', 0)).toBe(8000);
    expect(pollDelayMs('IN_PROGRESS', 10)).toBe(60000); // backs off, capped
  });
  test('the hand-over code is shown only while it can still be used', () => {
    const b = { podCode: '123456' };
    expect(showHandoverCode(b, { status: 'IN_TRANSIT', delivery: { proofVerified: false } })).toBe(true);
    expect(showHandoverCode(b, { status: 'IN_TRANSIT', delivery: { proofVerified: true } })).toBe(false);
    expect(showHandoverCode(b, { status: 'DELIVERY_FAILED_RETURNING', delivery: {} })).toBe(false);
    expect(showHandoverCode(b, { status: 'DELIVERED', delivery: {} })).toBe(false);
    expect(showHandoverCode({}, { status: 'IN_TRANSIT', delivery: {} })).toBe(false);
  });
  test('failed-fee line', () => {
    const fmt = (a, c) => `${c} ${a}`;
    expect(failedFeeLine({ delivery: { failedFee: { amount: 1000, currency: 'NGN' } } }, fmt)).toMatch(/NGN 1000.*cash/);
    expect(failedFeeLine({ delivery: {} }, fmt)).toBeNull();
  });
});

describe('places and the booking body', () => {
  test('placeFromReverse uses the address, or flags an approximate pin, and rejects bad coordinates', () => {
    expect(placeFromReverse({ data: { formattedAddress: ' 12 Ring Rd ' } }, 7.3, 3.9)).toEqual({ label: '12 Ring Rd', latitude: 7.3, longitude: 3.9, approximate: false });
    expect(placeFromReverse({ data: {} }, 7.3, 3.9)).toMatchObject({ label: 'Pinned location', approximate: true });
    expect(placeFromReverse({}, 200, 3.9)).toBeNull(); expect(placeFromReverse({}, 'x', 3.9)).toBeNull();
  });
  const quote = { id: 'gq_1', signature: 'sig', service: 'PARCEL' };
  const pickup = { label: 'A street', latitude: 7.3775, longitude: 3.947 }; const destination = { label: 'B street', latitude: 7.4, longitude: 3.9 };
  test('ride body: quote untouched, addresses from labels, no parcel', () => {
    const b = buildBookingBody({ quote, pickup, destination, contactName: ' Tunde ', notes: '', service: 'RIDE' });
    expect(b).toMatchObject({ quote, contactName: 'Tunde', pickup: { address: 'A street', latitude: 7.3775 }, destination: { address: 'B street' } });
    expect(b.parcel).toBeUndefined(); expect(b.notes).toBeUndefined();
  });
  test('parcel body hashes to the same parcelKey the planner quoted (category|weight|size)', () => {
    const key = (p) => { const n = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2)); return `${String(p.category || '').toUpperCase()}|${n(p.weightKg)}|${n(p.longestSideCm)}`; };
    const quoted = key({ category: 'SMALL', weightKg: 2 }); // the planner quotes { category, weightKg } only
    const b = buildBookingBody({ quote, pickup, destination, service: 'PARCEL', parcel: { category: 'SMALL', weightKg: '2', description: ' Shoes ', recipientName: 'Ada B', recipientPhone: '0803 123 4567', acknowledged: true } });
    expect(key(b.parcel)).toBe(quoted);
    expect(b.parcel).toMatchObject({ description: 'Shoes', recipientPhone: '08031234567', acknowledgedProhibited: true });
  });
  test('the prohibited acknowledgement is only true when explicitly confirmed', () => {
    const b = buildBookingBody({ quote, pickup, destination, service: 'PARCEL', parcel: { category: 'SMALL', weightKg: 1, description: 'x y z', recipientName: 'Ada', recipientPhone: '0803', acknowledged: undefined } });
    expect(b.parcel.acknowledgedProhibited).toBe(false);
  });
});

import { fingerprint, attemptFor, sessionUsable, ATTEMPT_TTL_MS } from '../guestBooking';

describe('booking attempts never double-book', () => {
  const body = { quote: { id: 'gq_1' }, pickup: { latitude: 1, longitude: 2, address: 'A' } };
  test('fingerprint is stable and sensitive to every change', () => {
    expect(fingerprint(body)).toBe(fingerprint({ ...body }));
    expect(fingerprint(body)).not.toBe(fingerprint({ ...body, notes: 'x' }));
  });
  test('same request within 30 min reuses the key (retry / double tap / restart)', () => {
    const first = attemptFor(body, null, 1000);
    expect(first.reused).toBe(false);
    const again = attemptFor(body, { key: first.key, fp: first.fp, at: first.at }, 1000 + 60000);
    expect(again).toMatchObject({ key: first.key, reused: true });
  });
  test('a changed request, or an old attempt, gets a fresh key', () => {
    const first = attemptFor(body, null, 1000);
    expect(attemptFor({ ...body, notes: 'changed' }, first, 2000).key).not.toBe(first.key);
    expect(attemptFor(body, first, 1000 + ATTEMPT_TTL_MS + 1).key).not.toBe(first.key);
  });
});

describe('stored guest session', () => {
  test('usable only with a token that has more than a few seconds left', () => {
    const now = Date.now();
    expect(sessionUsable({ session: 's', expiresAt: new Date(now + 3600e3).toISOString() }, now)).toBe(true);
    expect(sessionUsable({ session: 's', expiresAt: new Date(now + 5e3).toISOString() }, now)).toBe(false);
    expect(sessionUsable({ session: 's', expiresAt: new Date(now - 1).toISOString() }, now)).toBe(false);
    expect(sessionUsable({ expiresAt: new Date(now + 3600e3).toISOString() }, now)).toBe(false);
    expect(sessionUsable(null, now)).toBe(false);
  });
});

describe('M16.1 email input', () => {
  test('cleanEmailInput trims and lowercases; looksLikeEmail agrees with the server rules', () => {
    expect(cleanEmailInput('  Ada@Example.COM ')).toBe('ada@example.com');
    for (const ok of ['a@b.co', 'ada.obi@example.com']) expect(looksLikeEmail(ok)).toBe(true);
    for (const bad of ['', 'ada', 'a@b', 'a b@c.com', 'a@@c.com', 'a..b@c.com', '<x>@c.com']) expect(looksLikeEmail(bad)).toBe(false);
  });
  test('email OTP errors have plain wording and the right action', () => {
    expect(otpErrorMessage(server(400, { code: 'INVALID_EMAIL' })).text).toMatch(/valid email/);
    expect(otpErrorMessage(server(429, { code: 'OTP_COOLDOWN' })).text).toMatch(/wait/);
    expect(otpErrorMessage(server(400, { code: 'OTP_EXPIRED' })).action).toBe('RESEND');
    expect(otpErrorMessage(server(503, { code: 'OTP_CHANNEL_DISABLED' })).text).toMatch(/not available/);
  });
});
