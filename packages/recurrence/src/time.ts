// ABOUTME: Time realization helpers for wall_time and fixed_instant specs using luxon

import { DateTime } from 'luxon';
import type { TimeSpec, WallTime, FixedInstant } from './types.js';

/**
 * Given a date string (YYYY-MM-DD) and a WallTime spec, compute the UTC Date for that occurrence.
 * DST policy:
 *   - Gap (spring-forward): use the post-transition time (Luxon's default)
 *   - Overlap (fall-back): use the earlier (pre-transition / pre-DST-end) occurrence
 */
export function wallTimeToUtc(date: string, spec: WallTime): Date {
  const second = spec.second ?? 0;
  const dt = DateTime.fromObject(
    {
      year: parseInt(date.substring(0, 4), 10),
      month: parseInt(date.substring(5, 7), 10),
      day: parseInt(date.substring(8, 10), 10),
      hour: spec.hour,
      minute: spec.minute,
      second,
    },
    { zone: spec.timezone },
  );

  if (!dt.isValid) {
    throw new Error(`Invalid date/timezone combination: ${date} in ${spec.timezone}`);
  }

  return dt.toJSDate();
}

/**
 * Given a date string (YYYY-MM-DD) and a FixedInstant spec, compute the UTC Date.
 */
export function fixedInstantToUtc(date: string, spec: FixedInstant): Date {
  const second = spec.second ?? 0;
  const year = parseInt(date.substring(0, 4), 10);
  const month = parseInt(date.substring(5, 7), 10);
  const day = parseInt(date.substring(8, 10), 10);
  // Build a UTC date at the given offset
  const offsetHours = Math.trunc(spec.utcOffsetMinutes / 60);
  const offsetMins = Math.abs(spec.utcOffsetMinutes % 60);
  const sign = spec.utcOffsetMinutes >= 0 ? '+' : '-';
  const padded = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const isoStr = `${year}-${padded(month)}-${padded(day)}T${padded(spec.hour)}:${padded(spec.minute)}:${padded(second)}${sign}${padded(offsetHours)}:${padded(offsetMins)}`;
  return new Date(isoStr);
}

/**
 * Realize a TimeSpec for a given date (YYYY-MM-DD) into a UTC Date.
 */
export function realizeTime(date: string, spec: TimeSpec): Date {
  if (spec.type === 'wall_time') {
    return wallTimeToUtc(date, spec);
  }
  return fixedInstantToUtc(date, spec as FixedInstant);
}

/**
 * Get the IANA timezone from a TimeSpec (for date arithmetic).
 */
export function getTimezone(spec: TimeSpec): string {
  if (spec.type === 'wall_time') {
    return (spec as WallTime).timezone;
  }
  return 'UTC';
}

/**
 * Format a UTC Date as an ISO date string (YYYY-MM-DD) in the given timezone.
 */
export function dateInZone(utcDate: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(utcDate, { zone: timezone });
  return dt.toISODate()!;
}

/**
 * Return a luxon DateTime for the given date string in the given timezone,
 * positioned at the start of the day.
 */
export function startOfDay(date: string, timezone: string): DateTime {
  return DateTime.fromISO(date, { zone: timezone }).startOf('day');
}

/**
 * Add days to a date string, returning the new date string.
 */
export function addDays(date: string, days: number, timezone: string): string {
  const dt = DateTime.fromISO(date, { zone: timezone }).plus({ days });
  return dt.toISODate()!;
}

/**
 * Add weeks to a date string.
 */
export function addWeeks(date: string, weeks: number, timezone: string): string {
  const dt = DateTime.fromISO(date, { zone: timezone }).plus({ weeks });
  return dt.toISODate()!;
}

/**
 * Add months to a date string.
 */
export function addMonths(date: string, months: number, timezone: string): string {
  const dt = DateTime.fromISO(date, { zone: timezone }).plus({ months });
  return dt.toISODate()!;
}

/**
 * Get the ISO date string for today in the given timezone.
 */
export function todayInZone(utcNow: Date, timezone: string): string {
  return DateTime.fromJSDate(utcNow, { zone: timezone }).toISODate()!;
}

/**
 * Compare two ISO date strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Get day of week (0=Sunday) for a date string in a timezone.
 */
export function dayOfWeek(date: string, timezone: string): number {
  const dt = DateTime.fromISO(date, { zone: timezone });
  // luxon weekday: 1=Monday, 7=Sunday
  return dt.weekday % 7; // 0=Sunday, 1=Monday, ..., 6=Saturday
}
