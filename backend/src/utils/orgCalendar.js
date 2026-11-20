// backend/src/utils/orgCalendar.js
//
// Pure date helpers for the organisation product. Everything here works in the
// COMPANY's timezone (default Africa/Lagos), never the server's, because
// "is it Saturday?" and "which month does this trip belong to?" are questions
// about the company's calendar.
//
// No database access in this file — it is unit-tested in tests/orgCalendar.test.js.
'use strict';

const DEFAULT_TZ = 'Africa/Lagos';

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const safeTz = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};

/** Wall-clock parts of an instant in a timezone. weekday: 0 = Sunday … 6 = Saturday. */
const zonedParts = (date, tz = DEFAULT_TZ) => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year:    Number(p.year),
    month:   Number(p.month),
    day:     Number(p.day),
    hour:    Number(p.hour) % 24,
    minute:  Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday],
  };
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' of an instant in the company's timezone. */
const localDateString = (date, tz = DEFAULT_TZ) => {
  const z = zonedParts(date, tz);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}`;
};

/** 'YYYY-MM' billing period an instant belongs to. */
const periodOf = (date, tz = DEFAULT_TZ) => {
  const z = zonedParts(date, tz);
  return `${z.year}-${pad(z.month)}`;
};

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const isValidPeriod = (p) => typeof p === 'string' && PERIOD_RE.test(p);

/** The UTC instant at which the given wall-clock time occurs in `tz`. */
const zonedTimeToUtc = (year, month, day, hour, minute, tz = DEFAULT_TZ) => {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wallAsUtc;
  // Two passes handle DST transitions; fixed-offset zones (Lagos) settle on the first.
  for (let i = 0; i < 2; i++) {
    const z = zonedParts(new Date(guess), tz);
    const seenAsUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
    guess += wallAsUtc - seenAsUtc;
  }
  return new Date(guess);
};

/** [start, end) instants of a 'YYYY-MM' period in the company's timezone. */
const periodBounds = (period, tz = DEFAULT_TZ) => {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const y = Number(m[1]); const mo = Number(m[2]);
  const start = zonedTimeToUtc(y, mo, 1, 0, 0, tz);
  const end   = mo === 12 ? zonedTimeToUtc(y + 1, 1, 1, 0, 0, tz) : zonedTimeToUtc(y, mo + 1, 1, 0, 0, tz);
  return { start, end };
};

const previousPeriod = (period) => {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};

/** The billing period before the one `now` falls in — what the monthly invoice run bills. */
const lastClosedPeriod = (now = new Date(), tz = DEFAULT_TZ) => previousPeriod(periodOf(now, tz));

const isWeekend = (date, tz = DEFAULT_TZ) => {
  const wd = zonedParts(date, tz).weekday;
  return wd === 0 || wd === 6;
};

/** Is `localDate` ('YYYY-MM-DD') a Saturday (6) or Sunday (0)? Returns weekday number. */
const weekdayOfLocalDate = (localDate) => {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Decide whether an org-paid trip may be booked on a given day.
 *
 *   Mon–Fri  → always allowed.
 *   Sat/Sun  → depends on the company's weekendPolicy:
 *       CLOSED             never
 *       OPEN_WEEKEND       Sat + Sun
 *       OPEN_SATURDAY      Sat; Sunday needs an approved request
 *       APPROVAL_REQUIRED  Sat + Sun both need an approved request for that date
 *
 * @param {{policy:string, weekday:number, hasApproval:boolean}} p
 * @returns {{allowed:boolean, weekend:boolean, needsApproval:boolean, code:string|null, reason:string|null}}
 */
const evaluateDayPolicy = ({ policy = 'APPROVAL_REQUIRED', weekday, hasApproval = false }) => {
  const weekend = weekday === 0 || weekday === 6;
  if (!weekend) return { allowed: true, weekend: false, needsApproval: false, code: null, reason: null };

  const day = WEEKDAY_NAMES[weekday];
  if (policy === 'CLOSED') {
    return {
      allowed: false, weekend: true, needsApproval: false, code: 'ORG_WEEKEND_CLOSED',
      reason: `Your organisation does not allow ${day} rides on the company account. You can pay for this ride yourself.`,
    };
  }
  if (policy === 'OPEN_WEEKEND' || (policy === 'OPEN_SATURDAY' && weekday === 6)) {
    return { allowed: true, weekend: true, needsApproval: false, code: null, reason: null };
  }
  if (hasApproval) return { allowed: true, weekend: true, needsApproval: true, code: null, reason: null };
  return {
    allowed: false, weekend: true, needsApproval: true, code: 'ORG_WEEKEND_APPROVAL_REQUIRED',
    reason: `${day} rides on the company account need your organisation's approval. Send a weekend request first, or pay for this ride yourself.`,
  };
};

/** Can a weekend request be raised for this date under the company's policy? */
const canRequestWeekendDate = ({ policy, localDate, todayLocal }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate || '')) return { ok: false, reason: 'Invalid date.' };
  const wd = weekdayOfLocalDate(localDate);
  if (wd !== 0 && wd !== 6) return { ok: false, reason: 'Weekend requests are only for a Saturday or Sunday.' };
  if (localDate < todayLocal) return { ok: false, reason: 'That date has already passed.' };
  if (policy === 'CLOSED') return { ok: false, reason: 'Your organisation does not accept weekend ride requests.' };
  if (policy === 'OPEN_WEEKEND') return { ok: false, reason: 'Weekend rides are already open for everyone — no request needed.' };
  if (policy === 'OPEN_SATURDAY' && wd === 6) return { ok: false, reason: 'Saturday rides are already open for everyone — no request needed.' };
  return { ok: true, weekday: wd };
};

/** Mon–Fri-style office window used by the optional "business hours only" staff restriction: 07:00–20:00 local. */
const isWithinBusinessHours = (date, tz = DEFAULT_TZ) => {
  const { hour } = zonedParts(date, tz);
  return hour >= 7 && hour < 20;
};

/** Round to 2 decimals without float noise (money values). */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Split an org trip fare between Runserv and the driver. Returns whole-unit amounts that always add up to the fare. */
const splitFare = (fare, commissionRate) => {
  const rate = Math.min(Math.max(Number(commissionRate) || 0, 0), 1);
  const platform = Math.round(fare * rate);
  return { platformFee: platform, driverEarnings: round2(fare - platform) };
};

module.exports = {
  DEFAULT_TZ, WEEKDAY_NAMES,
  safeTz, zonedParts, localDateString, periodOf, isValidPeriod,
  zonedTimeToUtc, periodBounds, previousPeriod, lastClosedPeriod,
  isWeekend, weekdayOfLocalDate, evaluateDayPolicy, canRequestWeekendDate,
  isWithinBusinessHours, round2, splitFare,
};
