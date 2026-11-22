'use strict';
const mockDb = { delivery: { findUnique: jest.fn() }, activityLog: { create: jest.fn().mockResolvedValue({}) }, fleetPartnerUser: { findFirst: jest.fn().mockResolvedValue(null) }, fleetDriverAssignment: { findFirst: jest.fn() } };
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/services/upload.service', () => ({ signedPrivateUrl: jest.fn() }));
const { requestDocumentAccess } = require('../src/services/documentAccess.service');
const { scrub } = require('../src/middleware/scrubDocumentUrls');
const { PRIVATE_MARKER } = require('../src/utils/storageRef');

const REF = 'cldp:image:jpg:runserv/deliveries/pod/abc123';
const signer = jest.fn(() => ({ url: 'https://signed.example/pod', expiresAt: '2026-11-21T00:02:00.000Z' }));
const row = { id: 'd1', customerId: 'cust', partnerId: 'courier', podPhotoUrl: REF, customer: { countryCode: 'NG' } };
const staff = (role, adminDepartment = null, over = {}) => ({ id: 's1', role, adminDepartment, countryCode: 'NG', supportCountries: [], ...over });
const ask = (user) => requestDocumentAccess({ user, source: 'DELIVERY_PROOF', id: 'd1', field: 'podPhotoUrl', signer });
const audited = (a) => mockDb.activityLog.create.mock.calls.some((c) => c[0].data.action === a);
beforeEach(() => { jest.clearAllMocks(); mockDb.activityLog.create.mockResolvedValue({}); mockDb.delivery.findUnique.mockResolvedValue(row); mockDb.fleetPartnerUser.findFirst.mockResolvedValue(null); });

describe('delivery proof photo access', () => {
  test('SUPER_ADMIN, SUPPORT and a deliveries/support ADMIN get a short-lived signed link, audited', async () => {
    for (const u of [staff('SUPER_ADMIN'), staff('SUPPORT'), staff('ADMIN', 'DELIVERIES'), staff('ADMIN', 'SUPPORT'), staff('ADMIN')]) {
      expect(await ask(u)).toMatchObject({ url: 'https://signed.example/pod', legacy: false });
    }
    expect(audited('document_accessed')).toBe(true);
  });
  test('moderators, other-department admins, the courier, the sender and strangers are refused (404) and audited', async () => {
    for (const u of [staff('MODERATOR'), staff('ADMIN', 'RIDES'), { id: 'courier', role: 'DELIVERY_PARTNER' }, { id: 'cust', role: 'CUSTOMER' }, { id: 'x', role: 'CUSTOMER' }]) {
      await expect(ask(u)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(audited('document_access_denied')).toBe(true);
    expect(signer).not.toHaveBeenCalled();
  });
  test('market scope: support staff outside the delivery\'s country are refused', async () => {
    mockDb.delivery.findUnique.mockResolvedValue({ ...row, customer: { countryCode: 'GH' } });
    await expect(ask(staff('SUPPORT', null, { countryCode: 'NG', supportCountries: ['NG'] }))).rejects.toMatchObject({ statusCode: 404 });
    expect((await ask(staff('SUPER_ADMIN'))).url).toBeTruthy();
  });
  test('a delivery without a photo is a 404, and unknown fields are a 400', async () => {
    mockDb.delivery.findUnique.mockResolvedValue({ ...row, podPhotoUrl: null });
    await expect(ask(staff('SUPER_ADMIN'))).rejects.toMatchObject({ statusCode: 404 });
    await expect(requestDocumentAccess({ user: staff('SUPER_ADMIN'), source: 'DELIVERY_PROOF', id: 'd1', field: 'podCodeHash', signer })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('the photo reference never appears in API responses', () => {
    expect(scrub({ delivery: { id: 'd1', podPhotoUrl: REF } }).delivery.podPhotoUrl).toBe(PRIVATE_MARKER);
  });
});
