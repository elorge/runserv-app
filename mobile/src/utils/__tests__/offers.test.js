import { isSafeOutboundUrl, hostOf, daysLeft, expiryKey, visibleOffers } from '../offers';
import { shouldShowBanner, bannerTone, reasonKey } from '../dispatchStatus';

describe('isSafeOutboundUrl — what an offer may open', () => {
  test.each([
    'https://bank.example/open', 'https://www.bank.com.ng/open?ref=RS-1&utm_source=runserv', 'https://secure.bank.co.ng:8443/x', 'HTTPS://BANK.EXAMPLE',
  ])('allows %s', (u) => expect(isSafeOutboundUrl(u)).toBe(true));
  test.each([
    'http://bank.example/open', 'javascript:alert(1)', 'intent://x#Intent;scheme=http;end', 'tel:+234800', 'file:///etc/passwd', 'data:text/html,hi',
    'https://bank.com@evil.com/x', 'https://user:pw@bank.com', 'https://bank.example\\@evil.com', 'https://localhost/x', 'https://127.0.0.1', 'https://',
    'https://bank .example', 'not a url', '', null, undefined, 42, `https://bank.example/${'a'.repeat(3000)}`,
  ])('refuses %p', (u) => expect(isSafeOutboundUrl(u)).toBe(false));
  test('hostOf shows the real host for the confirmation prompt', () => {
    expect(hostOf('https://Secure.Bank.com:8443/a?b=1')).toBe('secure.bank.com');
    expect(hostOf('nonsense')).toBe('');
  });
});

describe('expiry', () => {
  const now = new Date('2026-11-17T12:00:00Z').getTime();
  test('daysLeft rounds up and never goes negative', () => {
    expect(daysLeft('2026-11-17T18:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-11-20T12:00:00Z', now)).toBe(3);
    expect(daysLeft('2026-11-17T11:59:59Z', now)).toBe(0);
    expect(daysLeft(null, now)).toBeNull(); expect(daysLeft('garbage', now)).toBeNull();
  });
  test('labels', () => {
    expect(expiryKey('2026-11-17T11:00:00Z', now)).toEqual({ key: 'offers.expired' });
    expect(expiryKey('2026-11-17T20:00:00Z', now)).toEqual({ key: 'offers.endsToday' });
    expect(expiryKey('2026-11-22T12:00:00Z', now)).toEqual({ key: 'offers.daysLeft', count: 5 });
    expect(expiryKey('2027-02-01T12:00:00Z', now).key).toBe('offers.endsOn');
    expect(expiryKey(null, now)).toBeNull();
  });
});

describe('visibleOffers — client-side second line of defence', () => {
  const now = new Date('2026-11-17T12:00:00Z').getTime();
  const o = (x = {}) => ({ id: 'a', title: 'T', terms: 'Terms', bank: { name: 'B' }, offerType: 'ACCOUNT_OPENING', expiresAt: '2026-12-31T00:00:00Z', ...x });
  test('keeps a complete offer', () => expect(visibleOffers([o()], { now })).toHaveLength(1));
  test('drops offers without terms, bank, title, or that have expired', () => {
    expect(visibleOffers([o({ terms: '' }), o({ bank: null }), o({ title: '' }), o({ expiresAt: '2026-11-01T00:00:00Z' }), null], { now })).toEqual([]);
  });
  test('hides credit offers unless the server says they are enabled', () => {
    expect(visibleOffers([o({ offerType: 'CREDIT' }), o({ id: 'b', offerType: 'DEFERRED_PAYMENT' })], { now })).toEqual([]);
    expect(visibleOffers([o({ offerType: 'CREDIT' })], { now, creditEnabled: true })).toHaveLength(1);
  });
  test('tolerates a bad payload', () => { expect(visibleOffers(undefined)).toEqual([]); expect(visibleOffers({})).toEqual([]); });
});

describe('dispatch banner', () => {
  test('only for fleet drivers with something to say', () => {
    expect(shouldShowBanner(null)).toBe(false);
    expect(shouldShowBanner({ isFleetDriver: false, reasons: [{ code: 'PROFILE_PENDING' }], warnings: [] })).toBe(false);
    expect(shouldShowBanner({ isFleetDriver: true, reasons: [], warnings: [] })).toBe(false);
    expect(shouldShowBanner({ isFleetDriver: true, reasons: [{ code: 'DOC_EXPIRED' }], warnings: [] })).toBe(true);
    expect(shouldShowBanner({ isFleetDriver: true, reasons: [], warnings: [{ code: 'DOC_EXPIRING' }] })).toBe(true);
  });
  test('tone and key', () => {
    expect(bannerTone({ reasons: [{}], warnings: [] })).toBe('blocked'); expect(bannerTone({ reasons: [], warnings: [{}] })).toBe('warning');
    expect(reasonKey('DOC_EXPIRED')).toBe('dispatchStatus.reason_DOC_EXPIRED');
  });
});
