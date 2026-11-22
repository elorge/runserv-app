jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }), { virtual: true });
import { sanitizeDraft, newPassCode, mergeDraft, isPassCodeForPath } from '../earnerDraft';

const NOW = 1_800_000_000_000;
const good = { v: 1, path: 'DRIVER', passCode: 'DP-AB23', step: 2, updatedAt: NOW - 1000, driver: { vehicleType: 'CAR', hours: 8, days: [0, 1, 2], multiplier: 1.2 } };

describe('earner draft', () => {
  it('pass codes say which pass they are and avoid look-alike characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newPassCode('DRIVER')).toMatch(/^DP-[A-HJ-NP-Z2-9]{4}$/);
      expect(newPassCode('COURIER')).toMatch(/^CP-[A-HJ-NP-Z2-9]{4}$/);
    }
  });
  it('keeps a well-formed draft', () => {
    const d = sanitizeDraft(good, NOW);
    expect(d.path).toBe('DRIVER');
    expect(d.driver).toEqual({ vehicleType: 'CAR', hours: 8, days: [0, 1, 2], multiplier: 1.2 });
    expect(d.passCode).toBe('DP-AB23');
  });
  it('drops drafts that are old, wrong version or have an unknown path', () => {
    expect(sanitizeDraft({ ...good, updatedAt: NOW - 31 * 86400000 }, NOW)).toBeNull();
    expect(sanitizeDraft({ ...good, v: 2 }, NOW)).toBeNull();
    expect(sanitizeDraft({ ...good, path: 'CUSTOMER' }, NOW)).toBeNull();
    expect(sanitizeDraft(null, NOW)).toBeNull();
  });
  it('repairs out-of-range values instead of trusting them', () => {
    const d = sanitizeDraft({ ...good, step: 99, driver: { vehicleType: 'HOVERCRAFT', hours: 99, days: [9, -1, 'x', 3, 3], multiplier: 5 } }, NOW);
    expect(d.step).toBe(4);
    expect(d.driver).toEqual({ vehicleType: 'CAR', hours: 14, days: [3], multiplier: 1.3 });
  });
  it('replaces a malformed pass code', () => {
    expect(sanitizeDraft({ ...good, passCode: 'nope' }, NOW).passCode).toMatch(/^DP-/);
  });

  describe('pass code consistency (mergeDraft)', () => {
    it('adopts the code the screen supplies, so shown == saved', () => {
      const prev = { ...good, createdAt: NOW };
      const out = mergeDraft(prev, { path: 'COURIER', passCode: 'CP-ZZ99' }, NOW);
      expect(out.passCode).toBe('CP-ZZ99');
    });
    it('does not silently replace a valid supplied code on a path switch', () => {
      const out = mergeDraft({ ...good }, { path: 'COURIER', passCode: 'CP-ABCD' }, NOW);
      expect(out.passCode).toBe('CP-ABCD');
    });
    it('keeps the stored code when the path is unchanged and none is supplied', () => {
      expect(mergeDraft({ ...good }, { step: 3 }, NOW).passCode).toBe('DP-AB23');
    });
    it('generates a code of the right type when a switch supplies none or a wrong-typed one', () => {
      expect(mergeDraft({ ...good }, { path: 'COURIER' }, NOW).passCode).toMatch(/^CP-/);
      expect(mergeDraft({ ...good }, { path: 'COURIER', passCode: 'DP-AB23' }, NOW).passCode).toMatch(/^CP-/);
    });
    it('DRIVER -> COURIER -> DRIVER: every saved code matches what the screen generated', () => {
      let saved = null;
      const screen = { code: newPassCode('DRIVER') };
      saved = mergeDraft(saved, { path: 'DRIVER', passCode: screen.code }, NOW);
      expect(saved.passCode).toBe(screen.code);
      screen.code = newPassCode('COURIER');
      saved = mergeDraft(saved, { path: 'COURIER', passCode: screen.code }, NOW);
      expect(saved.passCode).toBe(screen.code);
      screen.code = newPassCode('DRIVER');
      saved = mergeDraft(saved, { path: 'DRIVER', passCode: screen.code }, NOW);
      expect(saved.passCode).toBe(screen.code);
      // restore after "app restart": sanitize keeps the same code
      expect(sanitizeDraft(JSON.parse(JSON.stringify(saved)), NOW).passCode).toBe(screen.code);
    });
    it('isPassCodeForPath is path-specific', () => {
      expect(isPassCodeForPath('DP-AB23', 'DRIVER')).toBe(true);
      expect(isPassCodeForPath('DP-AB23', 'COURIER')).toBe(false);
    });
  });
});
