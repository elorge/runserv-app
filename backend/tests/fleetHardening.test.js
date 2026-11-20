'use strict';
// M5 audit fixes in the fleet portal API.
const mockDb = {
  fleetPartnerUser: { findFirst: jest.fn() },
  fleetPartner: { findUnique: jest.fn(), update: jest.fn() },
  fleetVehicle: { findFirst: jest.fn() },
  fleetPartnerDocument: { create: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], countryCode: 'NG' }; next(); },
}));
const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const { isRunservUploadUrl } = require('../src/utils/trustedFileUrl');

const app = express(); app.use(express.json()); app.use('/api/fleet', require('../src/routes/fleet.routes')); app.use(errorHandler);
const member = (role) => mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ role, fleetPartnerId: 'fleetA', fleetPartner: { id: 'fleetA', status: 'ACTIVE' } });
const GOOD = 'https://res.cloudinary.com/runserv-prod/image/upload/v1731800000/runserv/fleet/documents/insurance_abc.pdf';
beforeEach(() => { jest.clearAllMocks(); delete process.env.CLOUDINARY_CLOUD_NAME; });

describe('isRunservUploadUrl', () => {
  test('accepts a file in the fleet documents folder (image or raw resource)', () => {
    expect(isRunservUploadUrl(GOOD)).toBe(true);
    expect(isRunservUploadUrl(GOOD.replace('/image/', '/raw/'))).toBe(true);
  });
  test.each([
    'https://evil.example/runserv/fleet/a.pdf', 'http://res.cloudinary.com/x/image/upload/runserv/fleet/a.pdf',
    'https://res.cloudinary.com.evil.example/x/image/upload/runserv/fleet/a.pdf', 'https://res.cloudinary.com@evil.example/x/image/upload/runserv/fleet/a.pdf',
    'https://res.cloudinary.com/x/image/upload/runserv/drivers/a.pdf', 'https://res.cloudinary.com/x/image/upload/v1/other/a.pdf',
    'https://res.cloudinary.com/x/image/upload/runserv/fleet/../../../evil.pdf', 'https://res.cloudinary.com/x/image/fetch/https://evil.example/a.png',
    'javascript:alert(1)', '', null, undefined, 5, 'https://res.cloudinary.com/x/image/upload/runserv/fleet/a b.pdf',
  ])('refuses %p', (u) => expect(isRunservUploadUrl(u)).toBe(false));
  test('when the cloud name is configured, another account’s files are refused', () => {
    expect(isRunservUploadUrl(GOOD, { CLOUDINARY_CLOUD_NAME: 'runserv-prod' })).toBe(true);
    expect(isRunservUploadUrl(GOOD, { CLOUDINARY_CLOUD_NAME: 'someone-else' })).toBe(false);
  });
});

describe('POST /api/fleet/documents', () => {
  const body = (fileUrl) => ({ documentType: 'insurance', fileUrl });
  test('an arbitrary https link typed by a fleet user is refused', async () => {
    member('OWNER');
    const r = await request(app).post('/api/fleet/documents').set('x-user', 'u').send(body('https://evil.example/phish'));
    expect(r.status).toBe(400); expect(mockDb.fleetPartnerDocument.create).not.toHaveBeenCalled();
  });
  test('a file Runserv stored is accepted', async () => {
    member('OWNER'); mockDb.fleetPartnerDocument.create.mockResolvedValue({ id: 'd1' });
    const r = await request(app).post('/api/fleet/documents').set('x-user', 'u').send(body(GOOD));
    expect(r.status).toBe(201); expect(mockDb.fleetPartnerDocument.create.mock.calls[0][0].data).toMatchObject({ fleetPartnerId: 'fleetA', fileUrl: GOOD });
  });
});

describe('payout account changes are traceable', () => {
  test('changing the account number is audit-logged with old and new masked, never in full', async () => {
    member('OWNER');
    mockDb.fleetPartner.findUnique.mockResolvedValue({ payoutAccountNumber: '0123456789', payoutBankCode: '058' });
    mockDb.fleetPartner.update.mockResolvedValue({ id: 'fleetA', payoutAccountNumber: '9876543210', payoutBankCode: '058' });
    const r = await request(app).put('/api/fleet/profile').set('x-user', 'u').send({ payoutAccountNumber: '9876543210' });
    expect(r.status).toBe(200);
    const call = mockDb.activityLog.create.mock.calls.map((c) => c[0].data).find((d) => d.action === 'fleet_payout_account_changed');
    expect(call).toBeTruthy();
    expect(JSON.stringify(call)).toContain('••••3210'); expect(JSON.stringify(call)).toContain('••••6789');
    expect(JSON.stringify(call)).not.toMatch(/0123456789|9876543210/);
  });
  test('editing only contact details does not raise a payout alert', async () => {
    member('OWNER'); mockDb.fleetPartner.update.mockResolvedValue({ id: 'fleetA' });
    await request(app).put('/api/fleet/profile').set('x-user', 'u').send({ address: '1 Marina' });
    expect(mockDb.activityLog.create.mock.calls.some((c) => c[0].data.action === 'fleet_payout_account_changed')).toBe(false);
    expect(mockDb.fleetPartner.findUnique).not.toHaveBeenCalled();
  });
});

describe('applying', () => {
  test('is rate-limited per signed-in user', async () => {
    mockDb.fleetPartnerUser.findFirst.mockResolvedValue(null);
    const bad = { legalName: '' }; let last;
    for (let i = 0; i < 7; i += 1) last = await request(app).post('/api/fleet/apply').set('x-user', 'spammer').send(bad);
    expect(last.status).toBe(429);
    const other = await request(app).post('/api/fleet/apply').set('x-user', 'someone-else').send(bad);
    expect(other.status).toBe(400); // a different user is not affected
  });
});
