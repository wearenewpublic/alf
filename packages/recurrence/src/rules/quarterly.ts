// ABOUTME: Quarterly recurrence rules — quarterly_last_weekday

import { DateTime } from 'luxon';
import type { QuarterlyLastWeekdayRule } from '../types.js';
import { getTimezone } from '../time.js';
import { lastWeekdayOfMonth } from './helpers.js';

// Quarter-end months
const QUARTER_END_MONTHS = [3, 6, 9, 12];

/**
 * Generate candidate dates for quarterly_last_weekday rule.
 * Fires on the last occurrence of a specific weekday in each quarter-end month (Mar, Jun, Sep, Dec).
 */
export function* quarterlyLastWeekdayCandidates(rule: QuarterlyLastWeekdayRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);

  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  let year = startDt.year;

  // Find which quarter-end month to start from
  let quarterIdx = QUARTER_END_MONTHS.findIndex(m => m >= startDt.month);
  if (quarterIdx === -1) {
    quarterIdx = 0;
    year++;
  }

  for (let i = 0; i < 400; i++) { // 100 years at quarterly
    const month = QUARTER_END_MONTHS[quarterIdx];
    const candidate = lastWeekdayOfMonth(year, month, rule.weekday, timezone);
    if (candidate !== null && candidate >= startDate) {
      yield candidate;
    }

    // Advance by interval quarters
    let nextMonth = month + interval * 3;
    while (nextMonth > 12) {
      nextMonth -= 12;
      year++;
    }
    quarterIdx = QUARTER_END_MONTHS.indexOf(nextMonth);
    if (quarterIdx === -1) {
      // interval took us off a quarter-end month — find next valid quarter
      quarterIdx = QUARTER_END_MONTHS.findIndex(m => m >= nextMonth);
      if (quarterIdx === -1) {
        quarterIdx = 0;
        year++;
      }
    }
  }
}
