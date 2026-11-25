'use strict';
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mockDb = { smsOutbox: { updateMany: jest.fn(async () => ({ count: 1 })) } };
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
const { verifySms } = require('../src/services/smsWebhookAuth.service');
const SECRET = 'sms-hook-secret'; process.env.SMS_WEBHOOK_SECRET = SECRET;
const app = () => { const a = express(); a.use('/h', express.raw({ type: '*/*' }), require('../src/routes/smsWebhook.routes')); return a; };
const sign = (b) => crypto.createHmac('sha256', SECRET).update(b).digest('hex');
beforeEach(() => mockDb.smsOutbox.updateMany.mockClear());

test('rejects missing/wrong credentials and fails closed when unconfigured', async () => {
  const body = JSON.stringify({ message_id: 'm1', status: 'delivered' });
  await request(app()).post('/h/receipts').set('Content-Type', 'application/json').send(body).expect(401);
  await request(app()).post('/h/receipts').set('x-sms-signature', 'deadbeef').set('Content-Type', 'application/json').send(body).expect(401);
  expect(mockDb.smsOutbox.updateMany).not.toHaveBeenCalled();
  expect(verifySms({ authorization: `Bearer ${SECRET}` }, null, {})).toMatchObject({ ok: false, status: 503 });
});
test('HMAC signature over the raw body is accepted and a delivered receipt is applied', async () => {
  const body = JSON.stringify({ message_id: 'm1', status: 'Delivered' });
  const r = await request(app()).post('/h/receipts').set('x-sms-signature', `sha256=${sign(body)}`).set('Content-Type', 'application/json').send(body).expect(200);
  expect(r.body.applied).toBe(1);
  expect(mockDb.smsOutbox.updateMany.mock.calls[0][0].where.providerMessageId).toBe('m1');
  expect(mockDb.smsOutbox.updateMany.mock.calls[0][0].data.deliveryStatus).toBe('DELIVERED');
});
test('bearer token works; failed statuses map to FAILED; pending/unknown statuses are ignored; batches are handled', async () => {
  const body = JSON.stringify([{ message_id: 'a', status: 'failed' }, { message_id: 'b', status: 'queued' }, { messageId: 'c', status: 'Undelivered' }, { foo: 1 }]);
  await request(app()).post('/h/receipts').set('Authorization', `Bearer ${SECRET}`).set('Content-Type', 'application/json').send(body).expect(200);
  const calls = mockDb.smsOutbox.updateMany.mock.calls.map((c) => [c[0].where.providerMessageId, c[0].data.deliveryStatus]);
  expect(calls).toEqual([['a', 'FAILED'], ['c', 'FAILED']]);
});
test('a database error returns 500 so the provider retries; bad JSON is 400', async () => {
  mockDb.smsOutbox.updateMany.mockRejectedValueOnce(new Error('db'));
  const body = JSON.stringify({ message_id: 'm', status: 'delivered' });
  await request(app()).post('/h/receipts').set('Authorization', `Bearer ${SECRET}`).set('Content-Type', 'application/json').send(body).expect(500);
  await request(app()).post('/h/receipts').set('Authorization', `Bearer ${SECRET}`).set('Content-Type', 'application/json').send('{bad').expect(400);
});
