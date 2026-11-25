'use strict';
const mockDb = {
  user: { findUnique: jest.fn() }, fleetPartnerUser: { findFirst: jest.fn(), upsert: jest.fn() },
  fleetInvitation: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn() }, fleetShift: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  $executeRaw: jest.fn(async () => 1), activityLog: { create: jest.fn(async () => ({})) },
};
mockDb.$transaction = jest.fn(async (fn) => fn(mockDb));
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn(async () => {}) }));
const svc = require('../src/services/fleetTeam.service');
beforeEach(() => { jest.clearAllMocks(); mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb)); });
const NOW = new Date('2026-11-24T08:00:00Z');

describe('invitations', () => {
  test('creates a hashed-token invitation, revokes older pending ones, e-mails the link, returns the link once', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    mockDb.fleetInvitation.create.mockImplementation(async ({ data }) => ({ id: 'i1', status: 'PENDING', ...data }));
    const mailer = jest.fn(async () => {});
    const out = await svc.invite({ fleetPartnerId: 'f', fleetName: 'F', email: ' New@X.com ', role: 'VIEWER', actor: 'u', now: NOW, mailer });
    const data = mockDb.fleetInvitation.create.mock.calls[0][0].data;
    const token = /token=(.+)$/.exec(out.acceptUrl)[1];
    expect(data.tokenHash).toBe(svc.hash(token)); expect(data.tokenHash).not.toBe(token); expect(data.email).toBe('new@x.com');
    expect(mockDb.fleetInvitation.updateMany.mock.calls[0][0].data.status).toBe('REVOKED');
    expect(out.emailed).toBe(true); expect(JSON.stringify(out.invitation)).not.toContain(token);
    expect(data.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86400000);
  });
  test('OWNER role, bad e-mail and existing members are refused; a failing mailer does not fail the invite', async () => {
    await expect(svc.invite({ fleetPartnerId: 'f', email: 'a@b.com', role: 'OWNER', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.invite({ fleetPartnerId: 'f', email: 'nope', role: 'VIEWER', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    mockDb.user.findUnique.mockResolvedValue({ id: 'x' }); mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ fleetPartnerId: 'other' });
    await expect(svc.invite({ fleetPartnerId: 'f', email: 'a@b.com', role: 'VIEWER', actor: 'u' })).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    mockDb.user.findUnique.mockResolvedValue(null); mockDb.fleetInvitation.create.mockResolvedValue({ id: 'i', status: 'PENDING' });
    const out = await svc.invite({ fleetPartnerId: 'f', email: 'a@b.com', role: 'VIEWER', actor: 'u', mailer: async () => { throw new Error('smtp'); } });
    expect(out.emailed).toBe(false); expect(out.acceptUrl).toContain('token=');
  });
  const inv = (o = {}) => ({ id: 'i1', fleetPartnerId: 'f', email: 'a@b.com', role: 'FINANCE', status: 'PENDING', expiresAt: new Date(NOW.getTime() + 1e6), ...o });
  test('accept: wrong e-mail, expired, used, and already-in-a-fleet are refused', async () => {
    const user = { id: 'u', email: 'a@b.com' };
    mockDb.fleetInvitation.findUnique.mockResolvedValue(null);
    await expect(svc.accept({ token: 't', user, now: NOW })).rejects.toMatchObject({ statusCode: 404 });
    mockDb.fleetInvitation.findUnique.mockResolvedValue(inv({ status: 'ACCEPTED' }));
    await expect(svc.accept({ token: 't', user, now: NOW })).rejects.toMatchObject({ statusCode: 404 });
    mockDb.fleetInvitation.findUnique.mockResolvedValue(inv({ expiresAt: new Date(NOW.getTime() - 1) }));
    await expect(svc.accept({ token: 't', user, now: NOW })).rejects.toMatchObject({ statusCode: 410 });
    mockDb.fleetInvitation.findUnique.mockResolvedValue(inv());
    await expect(svc.accept({ token: 't', user: { id: 'u', email: 'z@b.com' }, now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    mockDb.fleetPartnerUser.findFirst.mockResolvedValue({ id: 'm' });
    await expect(svc.accept({ token: 't', user, now: NOW })).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    expect(mockDb.fleetPartnerUser.upsert).not.toHaveBeenCalled();
  });
  test('accept: claims the invitation once and creates the membership with the invited role; a lost race is 409', async () => {
    mockDb.fleetInvitation.findUnique.mockResolvedValue(inv()); mockDb.fleetPartnerUser.findFirst.mockResolvedValue(null);
    mockDb.fleetInvitation.updateMany.mockResolvedValue({ count: 1 }); mockDb.fleetPartnerUser.upsert.mockResolvedValue({ id: 'm' });
    await svc.accept({ token: 't', user: { id: 'u', email: 'A@B.com' }, now: NOW });
    expect(mockDb.fleetPartnerUser.upsert.mock.calls[0][0].create).toMatchObject({ fleetPartnerId: 'f', userId: 'u', role: 'FINANCE' });
    mockDb.fleetInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.accept({ token: 't', user: { id: 'u', email: 'a@b.com' }, now: NOW })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('revoke only touches this fleet\'s pending invitations', async () => {
    mockDb.fleetInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.revoke({ id: 'i', fleetPartnerId: 'f', actor: 'u' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb.fleetInvitation.updateMany.mock.calls[0][0].where).toEqual({ id: 'i', fleetPartnerId: 'f', status: 'PENDING' });
  });
});

describe('shifts', () => {
  const base = { fleetPartnerId: 'f', vehicleId: 'v', driverUserId: 'd', actor: 'u', now: NOW };
  const at = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();
  test('validates period: end after start, max 24h, not already over, valid dates', async () => {
    await expect(svc.createShift({ ...base, startsAt: at(2), endsAt: at(1) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createShift({ ...base, startsAt: at(1), endsAt: at(26) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createShift({ ...base, startsAt: at(-5), endsAt: at(-1) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createShift({ ...base, startsAt: 'x', endsAt: at(1) })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('driver must be actively assigned to the vehicle in this fleet', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await expect(svc.createShift({ ...base, startsAt: at(1), endsAt: at(9) })).rejects.toMatchObject({ code: 'NOT_ASSIGNED' });
    expect(mockDb.fleetDriverAssignment.findFirst.mock.calls[0][0].where).toMatchObject({ fleetPartnerId: 'f', vehicleId: 'v', driverUserId: 'd', status: 'ACTIVE' });
  });
  test('overlap for the vehicle or the driver is refused, including a database exclusion violation', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ id: 'a' });
    mockDb.fleetShift.findFirst.mockResolvedValue({ vehicleId: 'v' });
    await expect(svc.createShift({ ...base, startsAt: at(1), endsAt: at(9) })).rejects.toMatchObject({ code: 'SHIFT_OVERLAP' });
    mockDb.fleetShift.findFirst.mockResolvedValue(null);
    mockDb.fleetShift.create.mockRejectedValue(Object.assign(new Error('x'), { code: 'P2010', message: 'code 23P01' }));
    await expect(svc.createShift({ ...base, startsAt: at(1), endsAt: at(9) })).rejects.toMatchObject({ code: 'SHIFT_OVERLAP' });
  });
  test('creates a shift; cancelling needs a scheduled shift of this fleet', async () => {
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ id: 'a' }); mockDb.fleetShift.findFirst.mockResolvedValue(null);
    mockDb.fleetShift.create.mockImplementation(async ({ data }) => ({ id: 's1', ...data }));
    const r = await svc.createShift({ ...base, startsAt: at(1), endsAt: at(9), note: 'night' });
    expect(r).toMatchObject({ fleetPartnerId: 'f', vehicleId: 'v', driverUserId: 'd', createdById: 'u' });
    mockDb.fleetShift.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.cancelShift({ id: 's', fleetPartnerId: 'f', actor: 'u' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb.fleetShift.updateMany.mock.calls[0][0].where).toEqual({ id: 's', fleetPartnerId: 'f', status: 'SCHEDULED' });
  });
});
