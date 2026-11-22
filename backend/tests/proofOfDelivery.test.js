'use strict';
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
process.env.JWT_SECRET = 'test-secret';
const pod = require('../src/services/proofOfDelivery.service');
const booking = require('../src/services/guestBooking.service');

const ID = 'd-1'; const P = 'partner-1'; const CODE = booking.podCodeFor(ID);
const seed = (over = {}) => makeFakeGuestPrisma({ delivery: [{ id: ID, partnerId: P, status: 'IN_TRANSIT', podCodeHash: booking.podHash(ID, CODE), podCodeAttempts: 0, podVerifiedAt: null, failedAt: null, returnStatus: null, ...over }] });
const row = () => mockDb._t('delivery')[0];
beforeEach(() => { mockDb = seed(); });

describe('proof of delivery', () => {
  test('correct code verifies; completion is no longer blocked', async () => {
    expect(pod.proofPending(row())).toBe(true);
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: CODE })).resolves.toMatchObject({ verified: true });
    expect(row().podMethod).toBe('CODE'); expect(pod.proofPending(row())).toBe(false);
  });
  test('wrong codes lock at 5 (neutral errors, no attempts-left), even for the right code', async () => {
    const bad = CODE === '000000' ? '111111' : '000000';
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: bad })).rejects.toMatchObject({ code: 'POD_WRONG' });
    for (let i = 0; i < 4; i += 1) await pod.verifyProof({ deliveryId: ID, partnerId: P, code: bad }).catch(() => {});
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: CODE })).rejects.toMatchObject({ code: 'POD_LOCKED', statusCode: 429 });
    expect(row().podVerifiedAt).toBeNull();
  });
  test('another courier, wrong status, and non-stored photo links are refused', async () => {
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: 'other', code: CODE })).rejects.toMatchObject({ statusCode: 403 });
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: CODE, photoUrl: 'https://evil.example/x.jpg' })).rejects.toMatchObject({ code: 'POD_PHOTO_INVALID' });
    row().status = 'PICKED_UP';
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: CODE })).rejects.toMatchObject({ code: 'NOT_IN_TRANSIT' });
  });
  test('a code from another delivery does not work here', async () => {
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: booking.podCodeFor('d-2') === CODE ? '123456' : booking.podCodeFor('d-2') })).rejects.toMatchObject({ code: 'POD_WRONG' });
  });
});

describe('failed delivery and return', () => {
  test('fail → returning → returned closes as CANCELLED with the reason; cannot then be proven', async () => {
    await expect(pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'RECIPIENT_UNAVAILABLE', note: 'phone off' })).resolves.toMatchObject({ returnStatus: 'RETURNING' });
    await expect(pod.verifyProof({ deliveryId: ID, partnerId: P, code: CODE })).rejects.toMatchObject({ code: 'ALREADY_FAILED' });
    await pod.confirmReturned({ deliveryId: ID, partnerId: P });
    expect(row()).toMatchObject({ status: 'CANCELLED', returnStatus: 'RETURNED' }); expect(row().cancellationReason).toMatch(/RECIPIENT_UNAVAILABLE/);
  });
  test('needs a valid reason; cannot fail an already-delivered parcel; cannot return what was not failed', async () => {
    await expect(pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'BORED' })).rejects.toMatchObject({ code: 'FAIL_REASON_REQUIRED' });
    await expect(pod.confirmReturned({ deliveryId: ID, partnerId: P })).rejects.toMatchObject({ code: 'BAD_STATUS' });
    row().podVerifiedAt = new Date();
    await expect(pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'OTHER' })).rejects.toMatchObject({ code: 'ALREADY_DELIVERED' });
  });
});
