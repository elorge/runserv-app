'use strict';
const cal = require('../src/utils/orgCalendar');

describe('company-timezone calendar', () => {
  test('weekday is computed in the company timezone, not UTC', () => {
    // Sat 14 Nov 2026 23:30 UTC is already Sunday 00:30 in Lagos (UTC+1)
    const d = new Date('2026-11-14T23:30:00Z');
    expect(cal.zonedParts(d, 'UTC').weekday).toBe(6);
    expect(cal.zonedParts(d, 'Africa/Lagos').weekday).toBe(0);
    expect(cal.localDateString(d, 'Africa/Lagos')).toBe('2026-11-15');
  });

  test('a trip completed just after midnight on the 1st belongs to the new month', () => {
    expect(cal.periodOf(new Date('2026-11-30T22:59:00Z'), 'Africa/Lagos')).toBe('2026-11');
    expect(cal.periodOf(new Date('2026-11-30T23:00:00Z'), 'Africa/Lagos')).toBe('2026-12');
  });

  test('periodBounds are [local midnight 1st, local midnight next 1st)', () => {
    const { start, end } = cal.periodBounds('2026-11', 'Africa/Lagos');
    expect(start.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(cal.periodBounds('2026-12', 'Africa/Lagos').end.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  test('periodBounds respects DST zones', () => {
    const { start, end } = cal.periodBounds('2026-03', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-01T05:00:00.000Z');   // EST
    expect(end.toISOString()).toBe('2026-04-01T04:00:00.000Z');     // EDT
  });

  test('invalid period is rejected', () => {
    expect(() => cal.periodBounds('2026-13')).toThrow();
    expect(cal.isValidPeriod('2026-1')).toBe(false);
    expect(cal.isValidPeriod('2026-11')).toBe(true);
  });

  test('the monthly run bills the previous month, across the year boundary', () => {
    expect(cal.lastClosedPeriod(new Date('2027-01-02T10:00:00Z'), 'Africa/Lagos')).toBe('2026-12');
    expect(cal.lastClosedPeriod(new Date('2026-12-01T09:00:00Z'), 'Africa/Lagos')).toBe('2026-11');
  });

  test('unknown timezone falls back to Lagos instead of throwing', () => {
    expect(cal.safeTz('Mars/Olympus')).toBe('Africa/Lagos');
  });

  test('business hours window is 07:00–20:00 local', () => {
    expect(cal.isWithinBusinessHours(new Date('2026-11-16T05:59:00Z'), 'Africa/Lagos')).toBe(false); // 06:59
    expect(cal.isWithinBusinessHours(new Date('2026-11-16T06:00:00Z'), 'Africa/Lagos')).toBe(true);  // 07:00
    expect(cal.isWithinBusinessHours(new Date('2026-11-16T18:59:00Z'), 'Africa/Lagos')).toBe(true);  // 19:59
    expect(cal.isWithinBusinessHours(new Date('2026-11-16T19:00:00Z'), 'Africa/Lagos')).toBe(false); // 20:00
  });
});

describe('weekend policy (Mon–Fri always; Sat/Sun by policy or approval)', () => {
  const MON = 1, FRI = 5, SAT = 6, SUN = 0;
  test('weekdays are always allowed', () => {
    for (const policy of ['APPROVAL_REQUIRED', 'OPEN_SATURDAY', 'OPEN_WEEKEND', 'CLOSED']) {
      for (const weekday of [MON, FRI]) expect(cal.evaluateDayPolicy({ policy, weekday }).allowed).toBe(true);
    }
  });
  test('APPROVAL_REQUIRED: weekend needs an approved request for that date', () => {
    const no = cal.evaluateDayPolicy({ policy: 'APPROVAL_REQUIRED', weekday: SAT, hasApproval: false });
    expect(no).toMatchObject({ allowed: false, needsApproval: true, code: 'ORG_WEEKEND_APPROVAL_REQUIRED' });
    expect(cal.evaluateDayPolicy({ policy: 'APPROVAL_REQUIRED', weekday: SUN, hasApproval: true })).toMatchObject({ allowed: true, weekend: true });
  });
  test('OPEN_SATURDAY: Saturday is open, Sunday still needs approval', () => {
    expect(cal.evaluateDayPolicy({ policy: 'OPEN_SATURDAY', weekday: SAT }).allowed).toBe(true);
    expect(cal.evaluateDayPolicy({ policy: 'OPEN_SATURDAY', weekday: SUN }).allowed).toBe(false);
    expect(cal.evaluateDayPolicy({ policy: 'OPEN_SATURDAY', weekday: SUN, hasApproval: true }).allowed).toBe(true);
  });
  test('OPEN_WEEKEND: both days open', () => {
    expect(cal.evaluateDayPolicy({ policy: 'OPEN_WEEKEND', weekday: SAT }).allowed).toBe(true);
    expect(cal.evaluateDayPolicy({ policy: 'OPEN_WEEKEND', weekday: SUN }).allowed).toBe(true);
  });
  test('CLOSED: never, even with an old approval', () => {
    expect(cal.evaluateDayPolicy({ policy: 'CLOSED', weekday: SAT, hasApproval: true })).toMatchObject({ allowed: false, code: 'ORG_WEEKEND_CLOSED' });
  });
});

describe('weekend requests', () => {
  const todayLocal = '2026-11-16'; // Monday
  test('only Saturdays/Sundays in the future can be requested', () => {
    expect(cal.canRequestWeekendDate({ policy: 'APPROVAL_REQUIRED', localDate: '2026-11-21', todayLocal }).ok).toBe(true);   // Sat
    expect(cal.canRequestWeekendDate({ policy: 'APPROVAL_REQUIRED', localDate: '2026-11-22', todayLocal }).ok).toBe(true);   // Sun
    expect(cal.canRequestWeekendDate({ policy: 'APPROVAL_REQUIRED', localDate: '2026-11-18', todayLocal }).ok).toBe(false);  // Wed
    expect(cal.canRequestWeekendDate({ policy: 'APPROVAL_REQUIRED', localDate: '2026-11-14', todayLocal }).ok).toBe(false);  // past
    expect(cal.canRequestWeekendDate({ policy: 'APPROVAL_REQUIRED', localDate: 'nope', todayLocal }).ok).toBe(false);
  });
  test('no point requesting a day that is already open, or when weekends are closed', () => {
    expect(cal.canRequestWeekendDate({ policy: 'OPEN_WEEKEND', localDate: '2026-11-21', todayLocal }).ok).toBe(false);
    expect(cal.canRequestWeekendDate({ policy: 'OPEN_SATURDAY', localDate: '2026-11-21', todayLocal }).ok).toBe(false);
    expect(cal.canRequestWeekendDate({ policy: 'OPEN_SATURDAY', localDate: '2026-11-22', todayLocal }).ok).toBe(true);
    expect(cal.canRequestWeekendDate({ policy: 'CLOSED', localDate: '2026-11-21', todayLocal }).ok).toBe(false);
  });
});

describe('fare split', () => {
  test('Runserv cut + driver earnings always add up to the fare', () => {
    for (const fare of [350, 1250, 2275.5, 9999, 0]) {
      const s = cal.splitFare(fare, 0.18);
      expect(cal.round2(s.platformFee + s.driverEarnings)).toBe(cal.round2(fare));
    }
  });
  test('18% of ₦2,000 → ₦360 to Runserv, ₦1,640 to the driver', () => {
    expect(cal.splitFare(2000, 0.18)).toEqual({ platformFee: 360, driverEarnings: 1640 });
  });
  test('rate is clamped to 0–100%', () => {
    expect(cal.splitFare(1000, 5)).toEqual({ platformFee: 1000, driverEarnings: 0 });
    expect(cal.splitFare(1000, -1)).toEqual({ platformFee: 0, driverEarnings: 1000 });
  });
});
