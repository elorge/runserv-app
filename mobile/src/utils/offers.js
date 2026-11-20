// mobile/src/utils/offers.js — pure helpers for the Bank Offers screens (no React, easy to test).

/**
 * Only plain https links to a real host may be opened from an offer. Rejects http, other schemes (javascript:, intent:,
 * tel:, file:), links with embedded credentials (https://bank.com@evil.com) and anything that is not a URL.
 * Written without the URL class: React Native's URL is incomplete (credentials access throws on some versions).
 */
export const isSafeOutboundUrl = (raw) => {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\u0000-\u001f]/.test(raw)) return false;
  const m = /^https:\/\/([^/?#]+)([/?#].*)?$/i.exec(raw);
  if (!m) return false;
  const authority = m[1];
  if (authority.includes('@') || authority.includes('\\')) return false;
  const host = authority.replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(host)) return false; // raw IPv4 addresses are never a bank's public offer link
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
};

export const hostOf = (raw) => {
  const m = /^https:\/\/([^/?#]+)/i.exec(String(raw ?? ''));
  return m ? m[1].replace(/:\d+$/, '').toLowerCase() : '';
};

/** Whole days left until expiry (ceil, so "today" is 1 until it has passed); null when unknown, 0 when expired. */
export const daysLeft = (expiresAt, now = Date.now()) => {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  return t <= now ? 0 : Math.ceil((t - now) / 86400000);
};

/** Short label under an offer card: expired / ends today / N days left / ends on date. */
export const expiryKey = (expiresAt, now = Date.now()) => {
  const d = daysLeft(expiresAt, now);
  if (d === null) return null;
  if (d === 0) return { key: 'offers.expired' };
  if (d === 1) return { key: 'offers.endsToday' };
  if (d <= 14) return { key: 'offers.daysLeft', count: d };
  return { key: 'offers.endsOn', date: new Date(expiresAt) };
};

/** The feed is already filtered server-side; this is the client's second line of defence. */
export const visibleOffers = (offers, { creditEnabled = false, now = Date.now() } = {}) =>
  (Array.isArray(offers) ? offers : []).filter((o) => o && o.id && o.title && o.terms && o.bank?.name
    && (creditEnabled || !['CREDIT', 'DEFERRED_PAYMENT'].includes(o.offerType))
    && daysLeft(o.expiresAt, now) !== 0);
