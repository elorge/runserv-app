jest.mock('expo-constants', () => ({ expoConfig: { extra: {} } }), { virtual: true });
const { resolveVariant, roleAllowed, rolesFor, VARIANTS } = require('../../config/variant');

test('unknown or missing variants fall back to the customer app, never a mixed one', () => {
  for (const v of [undefined, null, '', 'admin', 'both', 'DRIVERS']) expect(resolveVariant(v).id).toBe('customer');
  expect(resolveVariant('driver').id).toBe('driver'); expect(resolveVariant('DRIVER').id).toBe('driver');
});
test('the customer app admits only customers', () => {
  expect(roleAllowed('customer', 'CUSTOMER')).toBe(true);
  expect(roleAllowed('customer', 'DRIVER')).toBe(false); expect(roleAllowed('customer', 'DELIVERY_PARTNER')).toBe(false);
});
test('the driver app admits drivers and couriers only', () => {
  expect(roleAllowed('driver', 'DRIVER')).toBe(true); expect(roleAllowed('driver', 'DELIVERY_PARTNER')).toBe(true); expect(roleAllowed('driver', 'CUSTOMER')).toBe(false);
});
test('staff roles are admitted by neither app', () => { for (const v of ['customer', 'driver']) for (const r of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', undefined]) expect(roleAllowed(v, r)).toBe(false); });
test('registration lists only the roles of this app', () => {
  const all = [{ id: 'CUSTOMER' }, { id: 'DRIVER' }, { id: 'DELIVERY_PARTNER' }];
  expect(rolesFor('customer', all).map((r) => r.id)).toEqual(['CUSTOMER']); expect(rolesFor('driver', all).map((r) => r.id)).toEqual(['DRIVER', 'DELIVERY_PARTNER']);
});
test('every role belongs to exactly one app', () => { const all = [...VARIANTS.customer.roles, ...VARIANTS.driver.roles]; expect(new Set(all).size).toBe(all.length); });
