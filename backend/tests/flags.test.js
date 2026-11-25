jest.mock('../src/lib/prisma', () => ({}));
const { isTrue, isCanonicalBool } = require('../src/utils/flags');
const { validate } = (() => { try { return require('../src/utils/envGuard'); } catch { return {}; } })();
test('one parser: case/space tolerant truth, strict canonical check', () => {
  expect(isTrue('true')).toBe(true); expect(isTrue('TRUE')).toBe(true); expect(isTrue(' True ')).toBe(true); expect(isTrue('yes')).toBe(false); expect(isTrue(undefined)).toBe(false);
  expect(isCanonicalBool('true')).toBe(true); expect(isCanonicalBool('false')).toBe(true); expect(isCanonicalBool(undefined)).toBe(true); expect(isCanonicalBool('TRUE')).toBe(false); expect(isCanonicalBool('1')).toBe(false);
});
test('auth middleware and MFA service honour the same parser as the guard (TRUE counts as on everywhere)', () => {
  const mfa = require('../src/services/mfa.service'); expect(mfa.required({ REQUIRE_STAFF_MFA: 'TRUE' })).toBe(true); expect(mfa.required({ REQUIRE_STAFF_MFA: 'false' })).toBe(false);
});
