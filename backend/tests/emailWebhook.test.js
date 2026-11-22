'use strict';
// M16.1 P2: delivery events are authenticated, idempotent and reflected in the outbox status.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');

let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
const auth = require('../src/services/emailWebhookAuth.service');
const outbox = require('../src/services/emailOutbox.service');

const SECRET = 'brevo-hook-secret'; const SVIX = `whsec_${Buffer.from('svix-test-key-0123456789').toString('base64')}`;
process.env.BREVO_WEBHOOK_SECRET = SECRET; process.env.RESEND_WEBHOOK_SECRET = SVIX;
const app = () => { const a = express(); a.use('/hooks', express.raw({ type: '*/*' }), require('../src/routes/emailWebhook.routes')); return a; };
const seed = (id, status = 'SENT') => mockDb._t('emailOutbox').push({ id: `o-${id}`, kind: 'GUEST_OTP', otpId: 'x', status, providerMessageId: id, deliveryStatus: 'ACCEPTED', toMasked: 'a***@b.co', updatedAt: new Date() });
const svix = (body, over = {}) => { const id = over.id || 'msg_1'; const ts = String(over.ts || Math.floor(Date.now() / 1000)); const sig = crypto.createHmac('sha256', Buffer.from(SVIX.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64'); return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${over.sig || sig}`, 'content-type': 'application/json' }; };
beforeEach(() => { mockDb = makeFakeGuestPrisma(); });

describe('authenticity', () => {
  test('Brevo: bearer token required; wrong, missing, or unconfigured secret is refused (fail closed)', async () => {
    seed('<m1@x>');
    const body = JSON.stringify({ event: 'delivered', 'message-id': '<m1@x>', ts_event: 1 });
    await request(app()).post('/hooks/brevo').set('Content-Type', 'application/json').send(body).expect(401);
    await request(app()).post('/hooks/brevo').set('Authorization', 'Bearer nope').set('Content-Type', 'application/json').send(body).expect(401);
    expect(mockDb._t('emailOutbox')[0].deliveryStatus).toBe('ACCEPTED');
    await request(app()).post('/hooks/brevo').set('Authorization', `Bearer ${SECRET}`).set('Content-Type', 'application/json').send(body).expect(200);
    expect(mockDb._t('emailOutbox')[0].deliveryStatus).toBe('DELIVERED');
    expect(auth.verifyBrevo({ authorization: `Bearer ${SECRET}` }, {})).toMatchObject({ ok: false, status: 503 });
  });
  test('Resend (Svix): valid signature accepted; tampered body, bad signature, stale timestamp and missing headers refused', async () => {
    seed('re_1');
    const body = JSON.stringify({ type: 'email.delivered', created_at: 'now', data: { email_id: 're_1' } });
    await request(app()).post('/hooks/resend').set(svix(body, { sig: 'AAAA' })).send(body).expect(401);
    await request(app()).post('/hooks/resend').set(svix(body)).send(body.replace('re_1', 're_2')).expect(401);
    await request(app()).post('/hooks/resend').set(svix(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).send(body).expect(401);
    await request(app()).post('/hooks/resend').send(body).set('Content-Type', 'application/json').expect(401);
    expect(mockDb._t('emailOutbox')[0].deliveryStatus).toBe('ACCEPTED');
    await request(app()).post('/hooks/resend').set(svix(body)).send(body).expect(200);
    expect(mockDb._t('emailOutbox')[0].deliveryStatus).toBe('DELIVERED');
  });
});

describe('events', () => {
  test('mapping: delivered, hard/soft bounce, blocked, error; open/click events are ignored', () => {
    const n = (b) => outbox.normaliseWebhook('brevo', b);
    expect(n({ event: 'delivered', 'message-id': 'a' }).status).toBe('DELIVERED'); expect(n({ event: 'hard_bounce', 'message-id': 'a' }).status).toBe('HARD_BOUNCE');
    expect(n({ event: 'soft_bounce', 'message-id': 'a' }).status).toBe('SOFT_BOUNCE'); expect(n({ event: 'blocked', 'message-id': 'a' }).status).toBe('BLOCKED');
    expect(n({ event: 'error', 'message-id': 'a' }).status).toBe('ERROR'); expect(n({ event: 'opened', 'message-id': 'a' })).toBeNull();
    expect(outbox.normaliseWebhook('resend', { type: 'email.bounced', data: { email_id: 'x', bounce: { type: 'Transient' } } }).status).toBe('SOFT_BOUNCE');
    expect(outbox.normaliseWebhook('resend', { type: 'email.bounced', data: { email_id: 'x', bounce: { type: 'Permanent' } } }).status).toBe('HARD_BOUNCE');
  });
  test('idempotent: the same event twice is applied once; an older state never overwrites a newer one', async () => {
    seed('m9');
    const ev = (status, key) => ({ eventKey: key, messageId: 'm9', status, event: status });
    expect(await outbox.applyDeliveryEvent('brevo', ev('DELIVERED', 'k1'))).toEqual({ updated: true });
    expect(await outbox.applyDeliveryEvent('brevo', ev('DELIVERED', 'k1'))).toEqual({ duplicate: true });
    expect(await outbox.applyDeliveryEvent('brevo', ev('SOFT_BOUNCE', 'k2'))).toEqual({ ignored: true });
    expect(mockDb._t('emailOutbox')[0].deliveryStatus).toBe('DELIVERED');
    expect(await outbox.applyDeliveryEvent('brevo', ev('HARD_BOUNCE', 'k3'))).toEqual({ updated: true });
    expect(mockDb._t('emailWebhookEvent')).toHaveLength(3);
  });
  test('an unknown message id is acknowledged without error; a hard bounce is visible to Admin and to the app as FAILED', async () => {
    expect(await outbox.applyDeliveryEvent('brevo', { eventKey: 'z', messageId: 'ghost', status: 'DELIVERED', event: 'delivered' })).toEqual({ unknownMessage: true });
    seed('m7'); mockDb._t('emailOutbox')[0].otpId = 'otp-7';
    await outbox.applyDeliveryEvent('brevo', { eventKey: 'h', messageId: 'm7', status: 'HARD_BOUNCE', event: 'hard_bounce' });
    expect(mockDb._t('emailOutbox')[0]).toMatchObject({ deliveryStatus: 'HARD_BOUNCE', errorCategory: 'INVALID_ADDRESS' });
    expect(await outbox.stateForOtp('otp-7')).toBe('FAILED');
  });
});
