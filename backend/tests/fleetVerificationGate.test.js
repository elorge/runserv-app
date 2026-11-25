const { dispatchEligibility, dispatchReasons } = require('../src/services/fleetCompliance');
const NOW = new Date('2026-11-01');
const vehicle = { status: 'ACTIVE', isActive: true, insuranceExpiresAt: '2027-06-01', roadworthyExpiresAt: '2027-06-01', permitExpiresAt: null };
describe('fleet verification gate', () => {
  it('blocks an ACTIVE but unverified fleet with FLEET_NOT_VERIFIED', () => {
    const fleetPartner = { status: 'ACTIVE', verificationStatus: 'PENDING' };
    expect(dispatchEligibility({ fleetPartner, vehicle }, { now: NOW }).ok).toBe(false);
    const r = dispatchReasons({ fleetPartner, vehicle }, { now: NOW });
    expect(r.reasons.map((x) => x.code)).toContain('FLEET_NOT_VERIFIED');
  });
  it('allows a verified fleet', () => {
    expect(dispatchEligibility({ fleetPartner: { status: 'ACTIVE', verificationStatus: 'VERIFIED' }, vehicle }, { now: NOW }).ok).toBe(true);
  });
});
