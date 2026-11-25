'use strict';
jest.mock('../src/lib/prisma', () => ({ activityLog: { findMany: jest.fn(), groupBy: jest.fn() } }));
jest.mock('../src/middleware/auth.middleware', () => ({ authenticate: (req, _r, n) => { req.user = { id: 'a1', role: 'ADMIN' }; n(); }, authorize: () => (_q, _r, n) => n() }));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn() }));
const express = require('express'); const request = require('supertest');
const prisma = require('../src/lib/prisma');
const router = require('../src/routes/adminAudit.routes');
const app = express().use('/a', router);
const row = (i, d = {}) => ({ id: `id${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 10 - i)), action: 'x', entityType: 'User', entityId: 'e', userId: 'u', ipAddress: '1', details: d, user: null });
beforeEach(() => jest.clearAllMocks());
test('redacts secret-looking keys, deep', () => {
  expect(router.redact({ ok: 1, otpCode: '1', nested: { apiKey: 'k', password: 'p', fine: 2 }, list: [{ token: 't' }] })).toEqual({ ok: 1, otpCode: '[redacted]', nested: { apiKey: '[redacted]', password: '[redacted]', fine: 2 }, list: [{ token: '[redacted]' }] });
});
test('cursor pagination returns nextCursor and applies filters', async () => {
  prisma.activityLog.findMany.mockResolvedValue([row(1, { password: 'x' }), row(2), row(3)]);
  const r = await request(app).get('/a?limit=2&action=wallet_credit&from=2026-01-01');
  expect(r.status).toBe(200); expect(r.body.data.items).toHaveLength(2); expect(r.body.data.nextCursor).toBeTruthy();
  expect(r.body.data.items[0].details.password).toBe('[redacted]');
  const w = prisma.activityLog.findMany.mock.calls[0][0]; expect(w.take).toBe(3); expect(JSON.stringify(w.where)).toContain('wallet_credit');
  prisma.activityLog.findMany.mockResolvedValue([row(3)]);
  const r2 = await request(app).get(`/a?limit=2&cursor=${r.body.data.nextCursor}`);
  expect(r2.body.data.nextCursor).toBeNull(); expect(JSON.stringify(prisma.activityLog.findMany.mock.calls[1][0].where)).toContain('lt');
});
test('invalid cursor → 400; page size capped at 100', async () => {
  expect((await request(app).get('/a?cursor=%%%')).status).toBe(400);
  prisma.activityLog.findMany.mockResolvedValue([]); await request(app).get('/a?limit=9999');
  expect(prisma.activityLog.findMany.mock.calls[0][0].take).toBe(101);
});
test('export is audited, redacted and guards against formula injection', async () => {
  prisma.activityLog.findMany.mockResolvedValue([{ ...row(1, { token: 'zzz' }), action: '=cmd' }]);
  const r = await request(app).get('/a/export');
  expect(r.headers['content-type']).toMatch(/csv/); expect(r.text).toContain("\"'=cmd\""); expect(r.text).not.toContain('zzz');
  expect(require('../src/utils/auditLog').logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'audit_log_exported' }));
});
