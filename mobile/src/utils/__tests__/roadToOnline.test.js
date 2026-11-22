import { deriveRoad, STATE, licenceExpired, stepTarget } from '../roadToOnline';

const KEYS = ['a', 'b', 'c'];
const ids = (r) => r.steps.map((s) => s.id);
const state = (r, id) => r.steps.find((s) => s.id === id).state;
const NOW = new Date('2026-11-20T10:00:00Z');

describe('Road to online: driver', () => {
  it('a brand-new driver (no profile) is asked for their details first', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: null, requiredKeys: KEYS, now: NOW });
    expect(ids(r)).toEqual(['account', 'details', 'documents', 'licence', 'review', 'online']);
    expect(state(r, 'account')).toBe(STATE.DONE);
    expect(state(r, 'details')).toBe(STATE.CURRENT);
    expect(state(r, 'documents')).toBe(STATE.LOCKED);
    expect(r.focusId).toBe('details');
    expect(r.headline).toBe('action');
    expect(r.doneCount).toBe(1);
  });
  it('partly uploaded documents are counted, and resume at documents', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { a: 'u1', b: ' ', c: null }, requiredKeys: KEYS, now: NOW });
    expect(state(r, 'details')).toBe(STATE.DONE);
    expect(state(r, 'documents')).toBe(STATE.CURRENT);
    expect(r.steps.find((s) => s.id === 'documents').info).toEqual({ filled: 1, total: 3 });
    expect(r.focusId).toBe('documents');
  });
  it('all documents in -> Runserv is on it (licence + review waiting)', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { a: 'x', b: 'y', c: 'z', licenseImageUrl: 'l', licenseVerificationStatus: 'UNVERIFIED' }, requiredKeys: KEYS, now: NOW });
    expect(state(r, 'documents')).toBe(STATE.DONE);
    expect(state(r, 'licence')).toBe(STATE.WAITING);
    expect(state(r, 'review')).toBe(STATE.WAITING);
    expect(r.headline).toBe('waiting');
  });
  it('a rejected licence is blocked with the reviewer\'s reason, and outranks waiting', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { a: 'x', b: 'y', c: 'z', licenseImageUrl: 'l', licenseVerificationStatus: 'REJECTED', licenseRejectedReason: 'Blurry' }, requiredKeys: KEYS, now: NOW });
    expect(state(r, 'licence')).toBe(STATE.BLOCKED);
    expect(r.steps.find((s) => s.id === 'licence').info).toEqual({ reason: 'rejected', note: 'Blurry' });
    expect(r.focusId).toBe('licence');
    expect(r.headline).toBe('blocked');
  });
  it('an expired licence blocks even when it was verified', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { a: 'x', b: 'y', c: 'z', licenseImageUrl: 'l', licenseVerificationStatus: 'VERIFIED', licenseExpiresAt: '2026-11-19' }, requiredKeys: KEYS, now: NOW });
    expect(r.steps.find((s) => s.id === 'licence').info.reason).toBe('expired');
  });
  it('licence is valid through the whole of its expiry day', () => {
    expect(licenceExpired('2026-11-20', NOW)).toBe(false);
    expect(licenceExpired('2026-11-19', NOW)).toBe(true);
    expect(licenceExpired(null, NOW)).toBe(false);
  });
  it('a rejected application is blocked with its reason', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { a: 'x', b: 'y', c: 'z', isRejected: true, rejectionReason: 'ID mismatch' }, requiredKeys: KEYS, now: NOW });
    expect(state(r, 'review')).toBe(STATE.BLOCKED);
    expect(r.steps.find((s) => s.id === 'review').info.note).toBe('ID mismatch');
  });
  it('approval is final: earlier steps count as done even if a document is missing; going online is next', () => {
    const r = deriveRoad({ role: 'DRIVER', profile: { isApproved: true }, requiredKeys: KEYS, now: NOW });
    expect(r.steps.filter((s) => s.state === STATE.DONE).map((s) => s.id)).toEqual(['account', 'details', 'documents', 'licence', 'review']);
    expect(state(r, 'online')).toBe(STATE.CURRENT);
    expect(r.complete).toBe(false);
  });
  it('approved and has been online -> complete', () => {
    expect(deriveRoad({ role: 'DRIVER', profile: { isApproved: true, totalRides: 3 }, requiredKeys: KEYS, now: NOW }).complete).toBe(true);
    expect(deriveRoad({ role: 'DRIVER', profile: { isApproved: true, isOnline: true }, requiredKeys: KEYS, now: NOW }).headline).toBe('done');
  });
});

describe('Road to online: courier', () => {
  it('has no licence step', () => {
    const r = deriveRoad({ role: 'DELIVERY_PARTNER', profile: null, requiredKeys: KEYS, now: NOW });
    expect(ids(r)).toEqual(['account', 'details', 'documents', 'review', 'online']);
  });
  it('totalDeliveries counts as having been online', () => {
    expect(deriveRoad({ role: 'DELIVERY_PARTNER', profile: { isApproved: true, totalDeliveries: 1 }, requiredKeys: KEYS, now: NOW }).complete).toBe(true);
  });
  it('step targets point at the right screens', () => {
    expect(stepTarget('DRIVER', 'documents')).toBe('DriverDocuments');
    expect(stepTarget('DELIVERY_PARTNER', 'documents')).toBe('PartnerDocuments');
    expect(stepTarget('DRIVER', 'online')).toBe('DriverDashboard');
    expect(stepTarget('DELIVERY_PARTNER', 'online')).toBe('Dashboard');
    expect(stepTarget('DRIVER', 'account')).toBeNull();
  });
});
