'use strict';
const mockDb = {
  driverProfile: { findUnique: jest.fn() }, deliveryPartnerProfile: { findUnique: jest.fn() }, fleetPartnerDocument: { findUnique: jest.fn() },
  fleetPartnerUser: { findFirst: jest.fn() }, fleetDriverAssignment: { findFirst: jest.fn() }, activityLog: { create: jest.fn().mockResolvedValue({}) },
};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/services/upload.service', () => ({ signedPrivateUrl: jest.fn() }));
const { requestDocumentAccess } = require('../src/services/documentAccess.service');
const { scrub, stripMarkerFromBody } = require('../src/middleware/scrubDocumentUrls');
const { PRIVATE_MARKER, legacyUrlToParts } = require('../src/utils/storageRef');
const { isStoredDocumentRef, isFleetDocumentRef } = require('../src/utils/trustedFileUrl');

const REF = 'cldp:image:jpg:runserv/kyc/license/abc123';
const signer = jest.fn(() => ({ url: 'https://signed.example/x', expiresAt: '2026-11-20T00:02:00.000Z' }));
const profile = { id: 'p1', userId: 'drv', licenseImageUrl: REF, user: { countryCode: 'NG' } };
const staff = (role, adminDepartment = null) => ({ id: 's1', role, adminDepartment, countryCode: 'NG', supportCountries: [] });
const ask = (user, over = {}) => requestDocumentAccess({ user, source: 'DRIVER_PROFILE', id: 'p1', field: 'licenseImageUrl', signer, ...over });
const audited = (action) => mockDb.activityLog.create.mock.calls.some((c) => c[0].data.action === action);
beforeEach(() => { jest.clearAllMocks(); mockDb.activityLog.create.mockResolvedValue({}); mockDb.driverProfile.findUnique.mockResolvedValue(profile); mockDb.fleetPartnerUser.findFirst.mockResolvedValue(null); });

describe('document access rules', () => {
  test('SUPER_ADMIN and the owner get a signed link, and it is audited', async () => {
    expect(await ask(staff('SUPER_ADMIN'))).toMatchObject({ url: 'https://signed.example/x', legacy: false });
    expect(audited('document_accessed')).toBe(true);
    expect((await ask({ id: 'drv', role: 'DRIVER' })).url).toBe('https://signed.example/x');
  });
  test('SUPPORT, MODERATOR, a wrong-department ADMIN, and an unrelated user are refused (404) and the refusal is audited', async () => {
    for (const u of [staff('SUPPORT'), staff('MODERATOR'), staff('ADMIN', 'DELIVERIES'), { id: 'other', role: 'CUSTOMER' }]) {
      await expect(ask(u)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(audited('document_access_denied')).toBe(true); expect(signer).not.toHaveBeenCalled();
  });
  test('fleet: FLEET_MANAGER may open an assigned driver\'s file; FINANCE / OPERATIONS / VIEWER may not; other fleets may not', async () => {
    const as = (role, fleetPartnerId = 'f1') => mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ role, fleetPartnerId, fleetPartner: {} });
    mockDb.fleetDriverAssignment.findFirst.mockImplementation(async ({ where }) => (where.fleetPartnerId === 'f1' ? { id: 'a' } : null));
    as('FLEET_MANAGER'); expect((await ask({ id: 'm', role: 'CUSTOMER' })).url).toBeTruthy();
    for (const r of ['FINANCE', 'OPERATIONS', 'VIEWER']) { as(r); await expect(ask({ id: 'm', role: 'CUSTOMER' })).rejects.toMatchObject({ statusCode: 404 }); }
    as('OWNER', 'f2'); await expect(ask({ id: 'm', role: 'CUSTOMER' })).rejects.toMatchObject({ statusCode: 404 });
  });
  test('fleet document: only the owning fleet with viewDocuments', async () => {
    mockDb.fleetPartnerDocument.findUnique.mockResolvedValue({ id: 'd1', fleetPartnerId: 'f1', fileUrl: 'cldp:image:pdf:runserv/fleet/documents/zz' });
    const go = (role, f) => { mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ role, fleetPartnerId: f, fleetPartner: {} }); return requestDocumentAccess({ user: { id: 'm', role: 'CUSTOMER' }, source: 'FLEET_DOCUMENT', id: 'd1', field: 'fileUrl', signer }); };
    expect((await go('OWNER', 'f1')).url).toBeTruthy();
    await expect(go('VIEWER', 'f1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(go('OWNER', 'f2')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('unknown source/field is a 400; missing file is a 404; a legacy public link is flagged', async () => {
    await expect(ask(staff('SUPER_ADMIN'), { field: 'password' })).rejects.toMatchObject({ statusCode: 400 });
    mockDb.driverProfile.findUnique.mockResolvedValue({ ...profile, licenseImageUrl: null });
    await expect(ask(staff('SUPER_ADMIN'))).rejects.toMatchObject({ statusCode: 404 });
    mockDb.driverProfile.findUnique.mockResolvedValue({ ...profile, licenseImageUrl: 'https://res.cloudinary.com/c/image/upload/v1/runserv/kyc/ids/a.jpg' });
    expect(await ask(staff('SUPER_ADMIN'))).toMatchObject({ legacy: true, expiresAt: null });
  });
});

describe('response scrubbing', () => {
  test('replaces every document link at any depth, keeps other values, and leaves non-plain objects alone', () => {
    const d = new Date(); const out = scrub({ user: { driverProfile: { licenseImageUrl: REF, govtIdUrl: 'https://x/y.jpg', vehicleMake: 'Toyota', govtIdUrl2: 'k' } }, vehicles: [{ documents: [{ fileUrl: 'https://z', createdAt: d }] }], note: null });
    expect(out.user.driverProfile.licenseImageUrl).toBe(PRIVATE_MARKER); expect(out.user.driverProfile.govtIdUrl).toBe(PRIVATE_MARKER);
    expect(out.user.driverProfile.vehicleMake).toBe('Toyota'); expect(out.vehicles[0].documents[0].fileUrl).toBe(PRIVATE_MARKER);
    expect(out.vehicles[0].documents[0].createdAt).toBe(d); expect(JSON.stringify(out)).not.toMatch(/https:\/\/(x|z)/);
  });
  test('an empty/null link stays empty (so "no document" is still visible)', () => expect(scrub({ licenseImageUrl: null, insuranceUrl: '' })).toEqual({ licenseImageUrl: null, insuranceUrl: '' }));
  test('an echoed marker is stripped from inbound bodies', () => { const b = { licenseImageUrl: PRIVATE_MARKER, vehicleMake: 'x' }; stripMarkerFromBody(b); expect(b).toEqual({ vehicleMake: 'x' }); });
});

describe('references and legacy links', () => {
  test('validators accept private refs and our own Cloudinary links; reject the marker and foreign links', () => {
    const env = { CLOUDINARY_CLOUD_NAME: 'mine' };
    expect(isStoredDocumentRef(REF, env)).toBe(true);
    expect(isStoredDocumentRef('https://res.cloudinary.com/mine/image/upload/v1/runserv/kyc/ids/a.jpg', env)).toBe(true);
    expect(isStoredDocumentRef('https://res.cloudinary.com/other/image/upload/v1/runserv/a.jpg', env)).toBe(false);
    expect(isStoredDocumentRef('https://evil.example/a.jpg', env)).toBe(false);
    expect(isStoredDocumentRef(PRIVATE_MARKER, env)).toBe(false);
    expect(isFleetDocumentRef('cldp:image:pdf:runserv/fleet/documents/q')).toBe(true);
    expect(isFleetDocumentRef(REF)).toBe(false);
  });
  test('legacyUrlToParts strips version/transformations and the image extension', () => {
    expect(legacyUrlToParts('https://res.cloudinary.com/mine/image/upload/c_limit,w_1000/v123/runserv/kyc/ids/a.jpg')).toEqual({ cloud: 'mine', resourceType: 'image', format: 'jpg', publicId: 'runserv/kyc/ids/a' });
    expect(legacyUrlToParts('https://res.cloudinary.com/mine/image/upload/v1/other/a.jpg')).toBeNull();
  });
});

describe('route validators accept private references', () => {
  const fs = require('fs');
  test.each(['driver.routes.js', 'partner.routes.js', 'fleet.routes.js'])('%s no longer validates document fields with isURL()', (f) => {
    const src = fs.readFileSync(`${__dirname}/../src/routes/${f}`, 'utf8');
    for (const field of ['licenseImageUrl', 'vehicleRegUrl', 'insuranceUrl', 'idImageUrl', 'fileUrl']) {
      const line = src.split('\n').find((l) => l.includes(`body('${field}')`) && l.includes('isURL'));
      expect(line).toBeUndefined();
    }
  });
});
