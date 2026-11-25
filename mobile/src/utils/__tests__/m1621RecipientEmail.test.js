// Option B (registered customers' parcels): recipient email input rules and the sender's "code was emailed" notice. Pure logic + source guards.
import fs from 'fs';
import path from 'path';
import { recipientEmailError, recipientEmailPatch, recipientEmailServerError, handoverEmailedNotice, HANDOVER_EMAILED_NOTICE, RECIPIENT_EMAIL_INVALID_TEXT } from '../recipientEmail';
import { validateParcelForm } from '../guestBooking';
import { showHandoverCard } from '../proofOfDelivery';

const server = (status, body) => ({ ...body, status });
const owner = { id: 'u1' };
const base = { id: 'd1', customerId: 'u1', proof: { required: true, verified: false, failed: false } };

describe('recipientEmailPatch / recipientEmailError', () => {
  test('sends recipientEmail only when non-empty, trimmed and lower-cased', () => {
    expect(recipientEmailPatch('')).toEqual({}); expect(recipientEmailPatch('   ')).toEqual({}); expect(recipientEmailPatch(undefined)).toEqual({});
    expect(recipientEmailPatch('  Ada@Example.COM ')).toEqual({ recipientEmail: 'ada@example.com' });
  });
  test('empty is allowed (server decides), a typed bad address is rejected with the guest flow wording', () => {
    expect(recipientEmailError('')).toBeNull(); expect(recipientEmailError('ada@example.com')).toBeNull();
    for (const bad of ['ada', 'ada@', 'a@b', 'ada@exa mple.com', 'ada@@example.com', 'a..b@example.com']) expect(recipientEmailError(bad)).toBe(RECIPIENT_EMAIL_INVALID_TEXT);
    expect(RECIPIENT_EMAIL_INVALID_TEXT).toBe(validateParcelForm({ description: 'x', recipientName: 'x', recipientPhone: '+2348012345678', recipientEmail: 'bad', acknowledged: true }).errors.recipientEmail);
  });
});

describe('recipientEmailServerError', () => {
  test('maps the two server codes to inline field text', () => {
    expect(recipientEmailServerError(server(400, { code: 'RECIPIENT_EMAIL_REQUIRED' }))).toMatch(/recipient's email/);
    expect(recipientEmailServerError(server(400, { code: 'RECIPIENT_EMAIL_INVALID' }))).toBe(RECIPIENT_EMAIL_INVALID_TEXT);
  });
  test('other failures (and network errors) are not field errors', () => {
    expect(recipientEmailServerError(server(403, { code: 'PILOT_GUEST_ONLY' }))).toBeNull();
    expect(recipientEmailServerError({ message: 'Network Error' })).toBeNull();
    expect(recipientEmailServerError(null)).toBeNull();
  });
});

describe('handoverEmailedNotice', () => {
  test('shown to the owner when proof is required, not done, and the server sent no podCode', () => {
    expect(handoverEmailedNotice(base, owner)).toBe(HANDOVER_EMAILED_NOTICE);
    expect(HANDOVER_EMAILED_NOTICE).toBe('The hand-over code was emailed to the recipient. Ask them for it if the courier cannot complete the hand-over.');
  });
  test('never when verified, failed, not required, not the owner, or when podCode IS present (HandoverCodeCard handles that)', () => {
    expect(handoverEmailedNotice({ ...base, proof: { ...base.proof, verified: true } }, owner)).toBeNull();
    expect(handoverEmailedNotice({ ...base, proof: { ...base.proof, failed: true } }, owner)).toBeNull();
    expect(handoverEmailedNotice({ ...base, proof: { required: false } }, owner)).toBeNull();
    expect(handoverEmailedNotice({ ...base, proof: undefined }, owner)).toBeNull();
    expect(handoverEmailedNotice(base, { id: 'other' })).toBeNull();
    expect(handoverEmailedNotice(base, null)).toBeNull();
    expect(handoverEmailedNotice({ ...base, podCode: '123456' }, owner)).toBeNull();
  });
  test('legacy card behaviour is unchanged: it still shows exactly when podCode is present', () => {
    expect(showHandoverCard({ ...base, podCode: '123456' }, owner)).toBe(true);
    expect(showHandoverCard(base, owner)).toBe(false);
  });
  test('the notice carries no code and no address', () => {
    expect(HANDOVER_EMAILED_NOTICE).not.toMatch(/\d{3}|@/);
  });
});

describe('screen source guards', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  test.each(['screens/Customer/RequestDeliveryScreen.js', 'screens/Customer/NearbyPartnersScreen.js'])('%s: email field, patch, inline server error', (f) => {
    const src = read(f);
    expect(src).toMatch(/keyboardType="email-address"/); expect(src).toMatch(/autoCapitalize="none"/);
    expect(src).toMatch(/\.\.\.recipientEmailPatch\(recipientEmail\)/);
    expect(src).toMatch(/recipientEmailServerError\(err\)/);
    // the address is never logged: any console line that mentions it must redact it
    src.split('\n').filter((l) => /console\./.test(l) && /recipientEmail/.test(l)).forEach((l) => expect(l).toMatch(/\[set\]/));
  });
  test('HandoverCodeCard still gates the code on showHandoverCard', () => {
    const src = read('components/HandoverCodeCard.js');
    expect(src).toMatch(/const visible = showHandoverCard\(delivery, user\)/); expect(src).toMatch(/handoverEmailedNotice\(delivery, user\)/);
  });
});
