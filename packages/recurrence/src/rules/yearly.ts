// ABOUTME: Yearly recurrence rules — yearly_on_month_day and yearly_nth_weekday

import { DateTime } from 'luxon';
import type { YearlyOnMonthDayRule, YearlyNthWeekdayRule } from '../types.js';
import { getTimezone } from '../time.js';
import { nthDayOfMonth, nthWeekdayOfMonth } from './helpers.js';

/**
 * Generate candidate dates for yearly_on_month_day rule.
 */
export function* yearlyOnMonthDayCandidates(rule: YearlyOnMonthDayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;

  for (let i = 0; i < 200; i++) { // Up to 200 years
    const candidate = nthDayOfMonth(year, rule.month, rule.dayOfMonth, timezone);
    if (candidate >= startDate) {
      yield candidate;
    }

    year += interval;
  }
}

/**
 * Generate candidate dates for yearly_nth_weekday rule.
 */
export function* yearlyNthWeekdayCandidates(rule: YearlyNthWeekdayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;

  for (let i = 0; i < 200; i++) {
    const candidate = nthWeekdayOfMonth(year, rule.month, rule.nth, rule.weekday, timezone);
    if (candidate !== null && candidate >= startDate) {
      yield candidate;
    }

    year += interval;
  }
}
