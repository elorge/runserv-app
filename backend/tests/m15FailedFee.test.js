'use strict';
const { makeFakeGuestPrisma } = require('./helpers/fakeGuestPrisma');
let mockDb;
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
process.env.JWT_SECRET = 'test-secret';
const pod = require('../src/services/proofOfDelivery.service');
const booking = require('../src/services/guestBooking.service');

const ID = 'd-f1'; const P = 'partner-1';
const seed = (over = {}) => makeFakeGuestPrisma({ delivery: [{ id: ID, customerId: 'cust-1', partnerId: P, status: 'IN_TRANSIT', estimatedFee: 2001, currency: 'NGN', payerType: 'SELF', podCodeHash: booking.podHash(ID, booking.podCodeFor(ID)), podCodeAttempts: 0, podVerifiedAt: null, failedAt: null, returnStatus: null, ...over }] });
const pays = () => mockDb._t('payment');
beforeEach(() => { mockDb = seed(); });

describe('failedDeliveryFee (pure rules)', () => {
  const failed = (reason, over = {}) => ({ failedAt: new Date(), failedReason: reason, estimatedFee: 2001, payerType: 'SELF', ...over });
  test.each(['RECIPIENT_UNAVAILABLE', 'WRONG_ADDRESS', 'RECIPIENT_REFUSED'])('%s earns 50%% (rounded), no commission by default', (r) => {
    expect(pod.failedDeliveryFee(failed(r), {})).toMatchObject({ eligible: true, amount: 1001, platformFee: 0, courierEarnings: 1001 });
  });
  test('reason with a note still counts', () => expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS: gate locked'), {}).eligible).toBe(true));
  test.each(['PARCEL_DAMAGED', 'OTHER', '', undefined])('%s is left to support, never auto-paid', (r) => {
    expect(pod.failedDeliveryFee(failed(r), {})).toMatchObject({ eligible: false, reason: 'SUPPORT_REVIEW', amount: 0 });
  });
  test('company-billed, unfailed and fee-less deliveries are not charged in cash', () => {
    expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS', { payerType: 'ORGANIZATION' }), {}).reason).toBe('COMPANY_BILLED');
    expect(pod.failedDeliveryFee({ estimatedFee: 100 }, {}).reason).toBe('NOT_FAILED');
    expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS', { estimatedFee: 0 }), {}).reason).toBe('NO_FEE');
  });
  test('commission is opt-in and bounded', () => {
    expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS'), { FAILED_DELIVERY_COMMISSION_RATE: '0.2' })).toMatchObject({ amount: 1001, platformFee: 200, courierEarnings: 801 });
    expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS'), { FAILED_DELIVERY_COMMISSION_RATE: '0.9' }).platformFee).toBe(0);
    expect(pod.failedDeliveryFee(failed('WRONG_ADDRESS'), { FAILED_DELIVERY_COMMISSION_RATE: 'abc' }).platformFee).toBe(0);
  });
});

describe('payout on return', () => {
  test('recipient-side failure: returning shows the fee; return records ONE pending CASH payment for the courier', async () => {
    const f = await pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'RECIPIENT_UNAVAILABLE' });
    expect(f).toMatchObject({ returnStatus: 'RETURNING', failedFee: { amount: 1001, collectFromSender: true }, supportReview: false });
    expect(pays()).toHaveLength(0); // nothing is owed until the parcel is actually handed back
    const r = await pod.confirmReturned({ deliveryId: ID, partnerId: P, env: {} });
    expect(r).toMatchObject({ returned: true, courierFee: { amount: 1001 } });
    expect(pays()).toHaveLength(1);
    expect(pays()[0]).toMatchObject({ userId: 'cust-1', deliveryId: ID, amount: 1001, method: 'CASH', status: 'PENDING', driverEarnings: 1001, platformFee: 0 });
    expect(mockDb._t('commissionLedger')).toHaveLength(1);
    await expect(pod.confirmReturned({ deliveryId: ID, partnerId: P, env: {} })).rejects.toMatchObject({ code: 'BAD_STATUS' });
    expect(pays()).toHaveLength(1); // a repeat can never pay twice
  });
  test('damage / other: returned, no payment, flagged for support', async () => {
    await pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'PARCEL_DAMAGED' });
    const r = await pod.confirmReturned({ deliveryId: ID, partnerId: P, env: {} });
    expect(r).toMatchObject({ returned: true, courierFee: null, supportReview: true });
    expect(pays()).toHaveLength(0);
  });
  test('company-billed failure is returned without a cash payment', async () => {
    mockDb = seed({ payerType: 'ORGANIZATION' });
    await pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'WRONG_ADDRESS' });
    await pod.confirmReturned({ deliveryId: ID, partnerId: P, env: {} });
    expect(pays()).toHaveLength(0);
  });
  test('another courier cannot confirm the return', async () => {
    await pod.markFailed({ deliveryId: ID, partnerId: P, reason: 'WRONG_ADDRESS' });
    await expect(pod.confirmReturned({ deliveryId: ID, partnerId: 'x', env: {} })).rejects.toMatchObject({ statusCode: 403 });
    expect(pays()).toHaveLength(0);
  });
});

describe('proofView and the all-deliveries flag', () => {
  test('flag is off unless exactly "true"', () => {
    expect(pod.codeForAllDeliveries({})).toBe(false);
    expect(pod.codeForAllDeliveries({ POD_CODE_ALL_DELIVERIES: 'false' })).toBe(false);
    expect(pod.codeForAllDeliveries({ POD_CODE_ALL_DELIVERIES: 'TRUE' })).toBe(true);
  });
  test('proofView never leaks the hash and reports state', () => {
    const v = pod.proofView({ podCodeHash: 'secret', podCodeAttempts: 2, podVerifiedAt: null });
    expect(v).toMatchObject({ required: true, verified: false, failed: false });
    expect(v).not.toHaveProperty('attemptsLeft');           // M16.2.1: remaining attempts are never sent to the courier app
    expect(JSON.stringify(v)).not.toContain('secret');
    expect(pod.proofView({}).required).toBe(false);
  });
});

describe('recipient SMS is sent in international format', () => {
  const send = () => jest.fn().mockResolvedValue({});
  test('local Nigerian number is normalised before sending', async () => {
    const sms = { send: send() };
    const ok = await pod.smsRecipientCode({ phone: '0803 123 4567', countryCode: 'NG', code: '123456', reference: 'RS-ABC' }, { env: { ENABLE_SMS_DELIVERY: 'true' }, sms });
    expect(ok).toBe(true);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(sms.send.mock.calls[0][0]).toMatch(/^\+2348031234567$/);
    expect(sms.send.mock.calls[0][1]).toContain('123456');
  });
  test('disabled, invalid number and provider failure are all silent no-ops', async () => {
    const sms = { send: send() };
    expect(await pod.smsRecipientCode({ phone: '0803', countryCode: 'NG', code: '1' }, { env: { ENABLE_SMS_DELIVERY: 'true' }, sms })).toBe(false);
    expect(await pod.smsRecipientCode({ phone: '08031234567', countryCode: 'NG', code: '1' }, { env: {}, sms })).toBe(false);
    expect(sms.send).not.toHaveBeenCalled();
    const bad = { send: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await pod.smsRecipientCode({ phone: '08031234567', countryCode: 'NG', code: '1' }, { env: { ENABLE_SMS_DELIVERY: 'true' }, sms: bad })).toBe(false);
  });
});

describe('guest status view shows what is owed after a failed delivery', () => {
  const view = async (reason) => {
    mockDb = seed({ failedAt: new Date(), failedReason: reason, returnStatus: 'RETURNING', recipientName: 'Ada B', pickupAddress: 'A', dropoffAddress: 'B' });
    return booking.publicView({ id: 'b1', service: 'DELIVERY', deliveryId: ID, reference: 'RS-1', fare: 2001, currency: 'NGN', createdAt: new Date() }, { env: {} });
  };
  test('recipient-side failure shows the fee and a return-fee note', async () => {
    const a = await view('WRONG_ADDRESS');
    expect(a.delivery.failedFee).toMatchObject({ amount: 1001, currency: 'NGN' });
    expect(a.paymentNote).toMatch(/return fee/i);
  });
  test('damage shows no fee and tells the sender support will be in touch', async () => {
    const b = await view('PARCEL_DAMAGED');
    expect(b.delivery.failedFee).toBeUndefined();
    expect(b.paymentNote).toMatch(/support/i);
  });
});
