const mockDb = { opsAlert: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() }, opsAlertDelivery: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() }, user: { findMany: jest.fn(async () => []) } };
jest.mock('../src/lib/prisma', () => mockDb);
const svc = require('../src/services/opsAlert.service');
beforeEach(() => { jest.clearAllMocks(); mockDb.opsAlertDelivery.create.mockImplementation(async ({ data }) => ({ id: 'd1', attempts: 0, ...data })); });
it('delivers a newly created alert', async () => {
  mockDb.opsAlert.findFirst.mockResolvedValue(null);
  mockDb.opsAlert.create.mockResolvedValue({ id: 'a1', kind: 'X', title: 't', message: 'm', data: {} });
  const out = await svc.raiseAndDeliver({ kind: 'X', dedupeKey: 'k', title: 't', message: 'm' });
  expect(out.created).toBe(true);
  expect(mockDb.opsAlertDelivery.create).toHaveBeenCalled();
});
it('only bumps an already-open alert without re-delivering', async () => {
  mockDb.opsAlert.findFirst.mockResolvedValue({ id: 'a1' });
  const out = await svc.raiseAndDeliver({ kind: 'X', dedupeKey: 'k', title: 't', message: 'm' });
  expect(out.created).toBe(false);
  expect(mockDb.opsAlertDelivery.create).not.toHaveBeenCalled();
});
