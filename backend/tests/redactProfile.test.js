'use strict';
const { redactUserForRole, HIDDEN } = require('../src/lib/redactProfile');

const user = () => ({
  id: 'u1', email: 'a@b.c', wallet: { balance: 5000, currency: 'NGN' },
  driverProfile: { id: 'p1', vehiclePlate: 'ABC123', isApproved: true, licenseNumber: 'L-1', govtIdUrl: 'x', guarantorIdUrl: 'y', currentLat: 6.5, currentLng: 3.3 },
  deliveryProfile: { id: 'p2', vehiclePlate: 'XYZ', idImageUrl: 'z', operatorPermitUrl: 'w' },
});

describe('redactUserForRole', () => {
  test.each(['ADMIN', 'SUPER_ADMIN'])('%s sees everything', (role) => {
    const u = user(); expect(redactUserForRole(u, role)).toEqual(user());
  });
  test.each(['SUPPORT', 'MODERATOR'])('%s sees operational facts only', (role) => {
    const out = redactUserForRole(user(), role);
    expect(out.wallet).toBeUndefined();
    for (const k of HIDDEN) { expect(out.driverProfile).not.toHaveProperty(k); expect(out.deliveryProfile).not.toHaveProperty(k); }
    expect(out.driverProfile).toMatchObject({ id: 'p1', vehiclePlate: 'ABC123', isApproved: true });
    expect(out.email).toBe('a@b.c');
  });
  test('does not mutate the input and tolerates missing profiles', () => {
    const u = user(); redactUserForRole(u, 'SUPPORT'); expect(u.driverProfile.licenseNumber).toBe('L-1');
    expect(redactUserForRole({ id: 'x', driverProfile: null, deliveryProfile: null }, 'SUPPORT').driverProfile).toBeNull();
    expect(redactUserForRole(null, 'SUPPORT')).toBeNull();
  });
});
