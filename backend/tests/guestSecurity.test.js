'use strict';
// Guards that keep the new guest path from weakening the existing one.
const jwt = require('jsonwebtoken');
let mockUser;
jest.mock('../src/lib/prisma', () => ({ user: { findUnique: async () => mockUser }, activityLog: { create: async () => ({}) } }));
process.env.JWT_SECRET = 'test-secret';
const { authenticate } = require('../src/middleware/auth.middleware');
const { scrub } = require('../src/middleware/scrubDocumentUrls');

test('a guest identity can never use an authenticated route, even with a forged-valid JWT', async () => {
  mockUser = { id: 'u1', isActive: true, isSuspended: false, role: 'CUSTOMER', authProvider: 'GUEST' };
  const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, 'test-secret', { algorithm: 'HS256' })}` } };
  let status; let body; let nexted = false;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
  await authenticate(req, res, () => { nexted = true; });
  expect(nexted).toBe(false); expect(status).toBe(403); expect(body.code).toBe('GUEST_NOT_ALLOWED');
});
test('a normal customer still passes', async () => {
  mockUser = { id: 'u2', isActive: true, isSuspended: false, role: 'CUSTOMER', authProvider: 'PASSWORD' };
  const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u2' }, 'test-secret', { algorithm: 'HS256' })}` } };
  let nexted = false; await authenticate(req, { status: () => ({ json: () => {} }) }, () => { nexted = true; });
  expect(nexted).toBe(true);
});
test('responses never carry the hand-over code hash and hide the proof photo', () => {
  const out = scrub({ delivery: { podCodeHash: 'abc', podPhotoUrl: 'https://res.cloudinary.com/x', podCodeAttempts: 1 } });
  expect(out.delivery.podCodeHash).toBeUndefined(); expect(out.delivery.podPhotoUrl).not.toContain('cloudinary'); expect(out.delivery.podCodeAttempts).toBe(1);
});
