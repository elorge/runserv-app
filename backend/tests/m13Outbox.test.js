'use strict';
const mockDb = { outboxEvent: { upsert: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn(), findFirst: jest.fn() }, activityLog: { create: jest.fn().mockResolvedValue({}) } };
jest.mock('../src/lib/prisma', () => mockDb);
const mockRecord = jest.fn();
jest.mock('../src/services/fleet.service', () => ({ recordFleetTrip: (...a) => mockRecord(...a) }));
const ob = require('../src/services/outbox.service');
const payload = ob.tripCompletedPayload({ serviceType: 'RIDE', rideId: 'r1', driverUserId: 'd1', fare: 1500, currency: 'NGN', completedAt: '2026-11-18T10:00:00Z' });
const ev = (o = {}) => ({ id: 'e1', type: 'TRIP_COMPLETED', aggregateType: 'RIDE', aggregateId: 'r1', payload, attempts: 1, ...o });
beforeEach(() => { jest.clearAllMocks(); mockDb.outboxEvent.updateMany.mockResolvedValue({ count: 1 }); mockDb.outboxEvent.update.mockResolvedValue({}); mockDb.activityLog.create.mockResolvedValue({}); });

test('enqueue is an idempotent upsert on (type, aggregate) inside the caller\'s transaction', async () => {
  const tx = { outboxEvent: { upsert: jest.fn().mockResolvedValue({}) } };
  await ob.enqueueTx(tx, { type: 'TRIP_COMPLETED', aggregateType: 'RIDE', aggregateId: 'r1', payload });
  expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { type_aggregateType_aggregateId: { type: 'TRIP_COMPLETED', aggregateType: 'RIDE', aggregateId: 'r1' } }, update: {} }));
  expect(payload).toMatchObject({ fare: '1500', completedAt: '2026-11-18T10:00:00.000Z', rideId: 'r1' });
});
test('success -> DONE and the handler gets a real Date', async () => {
  mockDb.outboxEvent.findUnique.mockResolvedValue(ev()); mockRecord.mockResolvedValue({ id: 't' });
  expect(await ob.processEvent('e1')).toEqual({ done: true });
  expect(mockRecord.mock.calls[0][0].completedAt).toBeInstanceOf(Date);
  expect(mockDb.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }));
});
test('a non-fleet trip (handler returns null) is still a success, not a retry', async () => {
  mockDb.outboxEvent.findUnique.mockResolvedValue(ev()); mockRecord.mockResolvedValue(null);
  expect(await ob.processEvent('e1')).toEqual({ done: true });
});
test('failure -> PENDING with back-off; at max attempts -> DEAD and an audit row', async () => {
  mockRecord.mockRejectedValue(new Error('db down'));
  mockDb.outboxEvent.findUnique.mockResolvedValue(ev({ attempts: 1 }));
  expect(await ob.processEvent('e1')).toEqual({ retry: true });
  const retry = mockDb.outboxEvent.update.mock.calls[0][0].data;
  expect(retry.status).toBe('PENDING'); expect(retry.lastError).toBe('db down'); expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  mockDb.outboxEvent.findUnique.mockResolvedValue(ev({ attempts: ob.MAX_ATTEMPTS }));
  expect(await ob.processEvent('e1')).toEqual({ dead: true });
  expect(mockDb.activityLog.create.mock.calls.some((c) => c[0].data.action === 'outbox_event_dead')).toBe(true);
});
test('a lost claim (another worker has it) does nothing', async () => {
  mockDb.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
  expect(await ob.processEvent('e1')).toEqual({ skipped: true }); expect(mockRecord).not.toHaveBeenCalled();
});
test('back-off doubles and is capped at one hour', () => { expect(ob.backoffMs(1)).toBe(30000); expect(ob.backoffMs(2)).toBe(60000); expect(ob.backoffMs(30)).toBe(3600000); });
test('processDue handles each due event; stats raises alerts for dead and stale events', async () => {
  mockDb.outboxEvent.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]); mockDb.outboxEvent.findUnique.mockResolvedValue(ev()); mockRecord.mockResolvedValue({});
  expect(await ob.processDue()).toMatchObject({ processed: 2, done: 2 });
  mockDb.outboxEvent.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
  mockDb.outboxEvent.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 30 * 60000) });
  const s = await ob.stats(); expect(s.dead).toBe(2); expect(s.alerts.length).toBe(2);
});
