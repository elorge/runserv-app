// M16.2.1 courier offline / flaky-network rules for the hand-over code. Pure logic (no device): see docs for what is NOT covered.
import fs from 'fs';
import path from 'path';
import { proofErrorMessage, isAmbiguousFailure, proofFromActive, completionOutcome } from '../proofOfDelivery';

const server = (status, body) => ({ ...body, status });   // services/api.js rejects with the body + status

describe('courier error messages', () => {
  test('no HTTP answer (offline / timeout) is ambiguous and never says the code was wrong', () => {
    for (const e of [{ message: 'Network Error' }, { code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }, '<html>502</html>']) {
      expect(isAmbiguousFailure(e)).toBe(true);
      const m = proofErrorMessage(e);
      expect(m.ambiguous).toBe(true); expect(m.retry).toBe(true);
      expect(m.text).not.toMatch(/not accepted|wrong/i);
      expect(m.text).not.toMatch(/not lost|nothing was submitted/i);   // neither claim can be made after a timeout
    }
  });
  test('the server\'s real wrong/expired/replaced code (POD_WRONG) gets the one neutral message, no attempts-left', () => {
    const m = proofErrorMessage(server(400, { code: 'POD_WRONG', message: 'x', attemptsLeft: 2 }));
    expect(m.text).toMatch(/not accepted/); expect(m.text).not.toMatch(/attempt|expired|replaced|rotat/i); expect(m.retry).toBe(true);
    expect(isAmbiguousFailure(server(400, { code: 'POD_WRONG' }))).toBe(false);
  });
  test('lock stays explicit and tells the courier to contact support', () => {
    expect(proofErrorMessage(server(429, { code: 'POD_LOCKED' })).text).toMatch(/locked.*support/i);
  });
});

describe('re-check after an ambiguous failure', () => {
  test('proofFromActive only trusts the same delivery', () => {
    expect(proofFromActive({ data: { delivery: { id: 'd1', proof: { verified: true } } } }, 'd1')).toEqual({ verified: true });
    expect(proofFromActive({ data: { delivery: { id: 'd2', proof: { verified: true } } } }, 'd1')).toBeNull();
    expect(proofFromActive({ data: { delivery: null } }, 'd1')).toBeNull();
    expect(proofFromActive(undefined, 'd1')).toBeNull();
  });
  test('completionOutcome: finished or no longer active = DONE; still active = STILL_ACTIVE; unreadable = UNKNOWN', () => {
    expect(completionOutcome({ data: { delivery: null } }, 'd1')).toBe('DONE');
    expect(completionOutcome({ data: { delivery: { id: 'd1', status: 'DELIVERED' } } }, 'd1')).toBe('DONE');
    expect(completionOutcome({ data: { delivery: { id: 'd1', status: 'IN_TRANSIT' } } }, 'd1')).toBe('STILL_ACTIVE');
    expect(completionOutcome(undefined, 'd1')).toBe('UNKNOWN');
    expect(completionOutcome({}, 'd1')).toBe('UNKNOWN');
  });
});

// Source guards (the suites have no component renderer): the courier flow must stay online-only, in-memory and single-flight.
describe('courier flow source guards', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const panel = read('components/ProofOfDeliveryPanel.js'); const screen = read('screens/Partner/ActiveDeliveryScreen.js');
  test('the entered code is never written to device storage or logs', () => {
    expect(panel).not.toMatch(/AsyncStorage|SecureStore|setItem|console\./);
  });
  test('no offline queue or automatic retry around proof / completion', () => {
    expect(panel).not.toMatch(/NetInfo|setTimeout|setInterval|retryQueue/);
    expect(panel.match(/verifyProof\(/g)).toHaveLength(1);              // one call site, inside the single-flight guard
    expect(panel).toMatch(/if \(pending\.current\) return/);
    expect(screen.match(/completeDelivery\(/g)).toHaveLength(1);
  });
  test('submit buttons are disabled while a request is in flight', () => {
    expect(panel).toMatch(/onPress=\{confirmHandover\} disabled=\{busy\}/);
    expect(screen).toMatch(/onPress=\{handleComplete\}\s+disabled=\{acting\}/);
  });
});
