// ABOUTME: Daily recurrence rule — fires every N days at a given time

import type { DailyRule } from '../types.js';
import { getTimezone, addDays } from '../time.js';

/**
 * Given a start date and an interval, generate candidate dates for a daily rule.
 * Yields dates in ascending order, starting from startDate.
 */
export function* dailyCandidates(rule: DailyRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);
  let current = startDate;
  // Safety: don't yield more than 3650 candidates (10 years of daily)
  for (let i = 0; i < 3650; i++) {
    yield current;
    current = addDays(current, interval, timezone);
  }
}
