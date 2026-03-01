// ABOUTME: Shared date helpers for monthly and yearly recurrence rule generators

import { DateTime } from 'luxon';

/**
 * Get the ISO date string for a specific day-of-month in a given month.
 * Clamps to the last day of the month if dayOfMonth > month length.
 */
export function nthDayOfMonth(year: number, month: number, dayOfMonth: number, timezone: string): string {
  const lastDay = DateTime.fromObject({ year, month }, { zone: timezone }).daysInMonth!;
  const day = Math.min(dayOfMonth, lastDay);
  return DateTime.fromObject({ year, month, day }, { zone: timezone }).toISODate()!;
}

/**
 * Get the ISO date for the Nth weekday of a month.
 * nth=1 means first, nth=2 means second, ..., nth=-1 means last.
 * weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
 */
export function nthWeekdayOfMonth(year: number, month: number, nth: number, weekday: number, timezone: string): string | null {
  const dt = DateTime.fromObject({ year, month, day: 1 }, { zone: timezone });
  const daysInMonth = dt.daysInMonth!;

  if (nth === -1) {
    for (let day = daysInMonth; day >= 1; day--) {
      const candidate = DateTime.fromObject({ year, month, day }, { zone: timezone });
      if (candidate.weekday % 7 === weekday) {
        return candidate.toISODate()!;
      }
    }
    return null;
  }

  let count = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const candidate = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (candidate.weekday % 7 === weekday) {
      count++;
      if (count === nth) {
        return candidate.toISODate()!;
      }
    }
  }
  return null;
}

/**
 * Get the ISO date for the last business day (Mon–Fri) of a month.
 * Walks backward from the last day of the month.
 */
export function lastBusinessDayOfMonth(year: number, month: number, timezone: string): string {
  const lastDay = DateTime.fromObject({ year, month }, { zone: timezone }).daysInMonth!;
  for (let day = lastDay; day >= 1; day--) {
    const candidate = DateTime.fromObject({ year, month, day }, { zone: timezone });
    // Luxon weekday: 1=Monday, 7=Sunday; 1-5 = Mon-Fri
    if (candidate.weekday >= 1 && candidate.weekday <= 5) {
      return candidate.toISODate()!;
    }
  }
  /* istanbul ignore next */
  return DateTime.fromObject({ year, month, day: 1 }, { zone: timezone }).toISODate()!;
}

/**
 * Get the ISO date for the last occurrence of a specific weekday in a month.
 * weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
 */
export function lastWeekdayOfMonth(year: number, month: number, weekday: number, timezone: string): string | null {
  const lastDay = DateTime.fromObject({ year, month }, { zone: timezone }).daysInMonth!;
  for (let day = lastDay; day >= 1; day--) {
    const candidate = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (candidate.weekday % 7 === weekday) {
      return candidate.toISODate()!;
    }
  }
  return null;
}
