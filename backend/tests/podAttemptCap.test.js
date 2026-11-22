'use strict';
// M16.1 P1: proof-of-delivery wrong-code attempts are strictly capped under concurrency.
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
process.env.JWT_SECRET = 'test-secret';
const pod = require('../src/services/proofOfDelivery.service');
const booking = require('../src/services/guestBooking.service');

const ID = 'd-1'; const P = 'partner-1'; const CODE = '482913';
const seed = (over = {}) => makeFakeGuestPrisma({ delivery: [{ id: ID, partnerId: P, status: 'IN_TRANSIT', podCodeHash: booking.podHash(ID, CODE), podCodeAttempts: 0, podVerifiedAt: null, failedAt: null, returnStatus: null, ...over }] });
const verify = (code, over = {}) => pod.verifyProof({ deliveryId: ID, partnerId: P, code, ip: '1.1.1.1', ...over });
const d = () => mockDb._t('delivery')[0];
beforeEach(() => { mockDb = seed(); });

test('50 parallel wrong codes: the counter never exceeds the maximum, and exactly the budget is spent', async () => {
  const res = await Promise.allSettled(Array.from({ length: 50 }, () => verify('000000')));
  expect(d().podCodeAttempts).toBe(pod.MAX_POD_ATTEMPTS);
  expect(res.filter((r) => r.reason?.code === 'POD_WRONG' || (r.reason?.code === 'POD_LOCKED' && r.reason.attemptsLeft === 0)).length).toBeGreaterThanOrEqual(0);
  expect(res.filter((r) => r.reason?.code === 'POD_LOCKED').length).toBeGreaterThanOrEqual(45);
});
test('once locked, even the CORRECT code is refused and the delivery cannot be verified', async () => {
  await Promise.allSettled(Array.from({ length: 8 }, () => verify('000000')));
  await expect(verify(CODE)).rejects.toMatchObject({ code: 'POD_LOCKED', statusCode: 429 });
  expect(d().podVerifiedAt).toBeNull(); expect(d().podCodeAttempts).toBe(pod.MAX_POD_ATTEMPTS);
});
test('parallel guesses mixed with the right code: at most MAX attempts are ever evaluated', async () => {
  const codes = Array.from({ length: 30 }, (_, i) => (i === 17 ? CODE : '111111'));
  const res = await Promise.allSettled(codes.map((c) => verify(c)));
  expect(d().podCodeAttempts).toBeLessThanOrEqual(pod.MAX_POD_ATTEMPTS);
  expect(res.length).toBe(30);
});
test('the attempt that exhausts the budget leaves an auditable POD_LOCKED event for Admin review', async () => {
  for (let i = 0; i < pod.MAX_POD_ATTEMPTS; i += 1) await verify('000000').catch(() => {});
  const events = mockDb._calls.audit.map((e) => e.event);
  expect(events.filter((e) => e === 'POD_WRONG_CODE')).toHaveLength(pod.MAX_POD_ATTEMPTS);
  const locked = mockDb._calls.audit.find((e) => e.event === 'POD_LOCKED');
  expect(locked.meta).toMatchObject({ deliveryId: ID, partnerId: P, needsAdminReview: true });
  expect(JSON.stringify(mockDb._calls.audit)).not.toContain(CODE);
});
test('a verified delivery accepts no further attempts and its counter does not move', async () => {
  await verify(CODE);
  expect(d().podVerifiedAt).toBeTruthy();
  const before = d().podCodeAttempts;
  await expect(verify('000000')).resolves.toMatchObject({ verified: true, already: true });
  expect(d().podCodeAttempts).toBe(before);
});
test('a failed delivery cannot consume or bypass attempts', async () => {
  mockDb = seed({ failedAt: new Date(), returnStatus: 'RETURNING' });
  await expect(verify('000000')).rejects.toMatchObject({ code: 'ALREADY_FAILED' }); await expect(verify(CODE)).rejects.toMatchObject({ code: 'ALREADY_FAILED' });
  expect(d().podCodeAttempts).toBe(0); expect(d().podVerifiedAt).toBeNull();
});
test('only the courier it is assigned to, and only while in transit, can spend attempts', async () => {
  await expect(verify('000000', { partnerId: 'someone-else' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  mockDb = seed({ status: 'PICKED_UP' }); await expect(verify('000000')).rejects.toMatchObject({ code: 'NOT_IN_TRANSIT' });
  expect(d().podCodeAttempts).toBe(0);
});
test('a state change between the read and the guarded update spends nothing and reports a conflict', async () => {
  const real = mockDb.delivery.updateMany;
  mockDb.delivery.updateMany = async (a) => { d().status = 'CANCELLED'; return real(a); };
  await expect(verify('000000')).rejects.toMatchObject({ code: 'CONFLICT' }); expect(d().podCodeAttempts).toBe(0);
});
test('the right code under the cap still verifies and reports the method', async () => {
  await verify('000000').catch(() => {}); await expect(verify(CODE)).resolves.toEqual({ verified: true, already: false });
  expect(d().podMethod).toBe('CODE');
});
