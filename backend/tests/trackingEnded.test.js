'use strict';
// M10: trip-specific tracking ends with the trip, and LOCATION_* error codes reach the app.
jest.mock('../src/lib/prisma', () => ({}));
const { emitTrackingEnded } = require('../src/services/socket.service');
const { errorHandler, AppError } = require('../src/middleware/errorHandler');

const fakeIo = () => { const sent = []; return { sent, to: (room) => ({ emit: (e, d) => sent.push([room, e, d]) }) }; };

describe('emitTrackingEnded', () => {
  test('tells both people and the trip room, once each', () => {
    const io = fakeIo();
    emitTrackingEnded(io, 'ride', 'r1', ['cust', 'drv', null], 'COMPLETED');
    expect(io.sent.map((x) => x[0]).sort()).toEqual(['ride:r1', 'user:cust', 'user:drv']);
    expect(io.sent.every((x) => x[1] === 'ride:tracking:ended' && x[2].rideId === 'r1' && x[2].reason === 'COMPLETED')).toBe(true);
  });
  test('deliveries use the delivery names', () => {
    const io = fakeIo();
    emitTrackingEnded(io, 'delivery', 'd1', ['cust'], 'DELIVERED');
    expect(io.sent[0][1]).toBe('delivery:tracking:ended'); expect(io.sent[0][2].deliveryId).toBe('d1');
  });
  test('no socket server is not an error', () => expect(() => emitTrackingEnded(null, 'ride', 'r1', ['a'])).not.toThrow());
});

describe('error handler', () => {
  test('LOCATION_ codes are passed to the app', () => {
    const e = new AppError('Allow location', 403); e.code = 'LOCATION_CONSENT_REQUIRED';
    const res = { status: jest.fn(() => res), json: jest.fn() };
    errorHandler(e, { path: '/x', method: 'PUT' }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
  });
});
