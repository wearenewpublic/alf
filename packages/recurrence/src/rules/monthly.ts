// ABOUTME: Monthly recurrence rules — monthly_on_day, monthly_nth_weekday, monthly_last_business_day

import { DateTime } from 'luxon';
import type { MonthlyOnDayRule, MonthlyNthWeekdayRule, MonthlyLastBusinessDayRule } from '../types.js';
import { getTimezone } from '../time.js';
import { nthDayOfMonth, nthWeekdayOfMonth, lastBusinessDayOfMonth } from './helpers.js';

/**
 * Generate candidate dates for monthly_on_day rule.
 */
export function* monthlyOnDayCandidates(rule: MonthlyOnDayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;
  let month = startDt.month;

  for (let i = 0; i < 1200; i++) { // Up to 100 years of monthly
    const candidate = nthDayOfMonth(year, month, rule.dayOfMonth, timezone);
    if (candidate >= startDate) {
      yield candidate;
    }

    const nextDt = DateTime.fromObject({ year, month }, { zone: timezone }).plus({ months: interval });
    year = nextDt.year;
    month = nextDt.month;
  }
}

/**
 * Generate candidate dates for monthly_nth_weekday rule.
 */
export function* monthlyNthWeekdayCandidates(rule: MonthlyNthWeekdayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;
  let month = startDt.month;

  for (let i = 0; i < 1200; i++) {
    const candidate = nthWeekdayOfMonth(year, month, rule.nth, rule.weekday, timezone);
    if (candidate !== null && candidate >= startDate) {
      yield candidate;
    }

    const nextDt = DateTime.fromObject({ year, month }, { zone: timezone }).plus({ months: interval });
    year = nextDt.year;
    month = nextDt.month;
  }
}

/**
 * Generate candidate dates for monthly_last_business_day rule.
 */
export function* monthlyLastBusinessDayCandidates(rule: MonthlyLastBusinessDayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;
  let month = startDt.month;

  for (let i = 0; i < 1200; i++) {
    const candidate = lastBusinessDayOfMonth(year, month, timezone);
    if (candidate >= startDate) {
      yield candidate;
    }

    const nextDt = DateTime.fromObject({ year, month }, { zone: timezone }).plus({ months: interval });
    year = nextDt.year;
    month = nextDt.month;
  }
}
