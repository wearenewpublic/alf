// ABOUTME: Weekly recurrence rule — fires on specific days of the week, every N weeks

import type { WeeklyRule } from '../types.js';
import { getTimezone, addDays, dayOfWeek, addWeeks } from '../time.js';
import { DateTime } from 'luxon';

/**
 * Given a start date, generate candidate dates matching the weekly rule's daysOfWeek.
 * The interval applies to the week boundary (every N weeks of the same day pattern).
 */
export function* weeklyCandidates(rule: WeeklyRule, startDate: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const timezone = getTimezone(rule.time);
  const daysOfWeek = [...rule.daysOfWeek].sort();

  if (daysOfWeek.length === 0) return;

  // Find the start of the week containing startDate (Sunday = 0)
  const startDt = DateTime.fromISO(startDate, { zone: timezone });
  const startDow = startDt.weekday % 7; // 0=Sunday, 1=Monday, ... 6=Saturday

  // Find first candidate on or after startDate
  // First, try the current week
  let weekStart = startDate;
  // Go back to Sunday of current week
  const daysFromSunday = startDow;
  const sundayOfWeek = addDays(startDate, -daysFromSunday, timezone);
  weekStart = sundayOfWeek;

  let safety = 0;
  while (safety++ < 3650) {
    // Generate candidates for this week
    const weekCandidates = daysOfWeek
      .map(dow => addDays(weekStart, dow, timezone))
      .filter(d => d >= startDate);

    for (const candidate of weekCandidates) {
      yield candidate;
    }

    weekStart = addWeeks(weekStart, interval, timezone);
  }
}
