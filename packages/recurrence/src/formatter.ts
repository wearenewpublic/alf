// ABOUTME: Formats a RecurrenceRule as a plain-English string.

import type { RecurrenceRule, RecurrenceRuleCore, TimeSpec } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a RecurrenceRule as a human-readable English string.
 *
 * Examples:
 *   "every weekday at 9am (ET)"
 *   "last Friday of every month at 5pm (UTC)"
 *   "every year on January 1st at midnight (America/New_York)"
 */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  const core = formatCore(rule.rule);

  const suffixes: string[] = [];
  if (rule.startDate) suffixes.push(`starting ${rule.startDate}`);
  if (rule.endDate) suffixes.push(`until ${rule.endDate}`);
  if (rule.count != null) suffixes.push(`for ${rule.count} ${rule.count === 1 ? 'occurrence' : 'occurrences'}`);

  return suffixes.length > 0 ? `${core}, ${suffixes.join(', ')}` : core;
}

// ---------------------------------------------------------------------------
// Core rule formatting
// ---------------------------------------------------------------------------

function formatCore(rule: RecurrenceRuleCore): string {
  switch (rule.type) {
    case 'daily':
      return formatDaily(rule.interval ?? 1, rule.time);

    case 'weekly':
      return formatWeekly(rule.interval ?? 1, rule.daysOfWeek, rule.time);

    case 'monthly_on_day':
      return formatMonthlyOnDay(rule.interval ?? 1, rule.dayOfMonth, rule.time);

    case 'monthly_nth_weekday':
      return formatMonthlyNthWeekday(rule.interval ?? 1, rule.nth, rule.weekday, rule.time);

    case 'monthly_last_business_day':
      return formatMonthlyLastBusinessDay(rule.interval ?? 1, rule.time);

    case 'quarterly_last_weekday':
      return `last ${WEEKDAY_NAMES[rule.weekday]} of every quarter at ${formatTime(rule.time)}`;

    case 'yearly_on_month_day':
      return formatYearlyOnMonthDay(rule.interval ?? 1, rule.month, rule.dayOfMonth, rule.time);

    case 'yearly_nth_weekday':
      return formatYearlyNthWeekday(rule.interval ?? 1, rule.month, rule.nth, rule.weekday, rule.time);

    case 'once':
      return `once on ${formatIsoDatetime(rule.datetime)}`;
  }
}

// ---------------------------------------------------------------------------
// Per-type formatters
// ---------------------------------------------------------------------------

function formatDaily(interval: number, time: TimeSpec): string {
  const t = formatTime(time);
  if (interval === 1) return `every day at ${t}`;
  if (interval === 2) return `every other day at ${t}`;
  return `every ${interval} days at ${t}`;
}

function formatWeekly(interval: number, daysOfWeek: number[], time: TimeSpec): string {
  const t = formatTime(time);

  // Special aliases
  if (arraysEqual(daysOfWeek.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5])) {
    return interval === 1
      ? `every weekday at ${t}`
      : `every ${interval} weeks on weekdays at ${t}`;
  }
  if (arraysEqual(daysOfWeek.slice().sort((a, b) => a - b), [0, 6])) {
    return interval === 1
      ? `every weekend at ${t}`
      : `every ${interval} weeks on weekends at ${t}`;
  }

  const dayList = formatDayList(daysOfWeek);

  if (interval === 1) return `every ${dayList} at ${t}`;
  if (interval === 2) return `every other week on ${dayList} at ${t}`;
  return `every ${interval} weeks on ${dayList} at ${t}`;
}

function formatMonthlyOnDay(interval: number, dayOfMonth: number, time: TimeSpec): string {
  const t = formatTime(time);
  const dom = ordinal(dayOfMonth);
  if (interval === 1) return `every month on the ${dom} at ${t}`;
  if (interval === 2) return `every other month on the ${dom} at ${t}`;
  return `every ${interval} months on the ${dom} at ${t}`;
}

function formatMonthlyNthWeekday(interval: number, nth: number, weekday: number, time: TimeSpec): string {
  const t = formatTime(time);
  const day = WEEKDAY_NAMES[weekday] ?? `day ${weekday}`;
  const ord = nth === -1 ? 'last' : ordinal(nth);

  if (interval === 1) return `${ord} ${day} of every month at ${t}`;
  if (interval === 2) return `${ord} ${day} of every other month at ${t}`;
  return `${ord} ${day} of every ${interval} months at ${t}`;
}

function formatMonthlyLastBusinessDay(interval: number, time: TimeSpec): string {
  const t = formatTime(time);
  if (interval === 1) return `last business day of every month at ${t}`;
  if (interval === 2) return `last business day of every other month at ${t}`;
  return `last business day of every ${interval} months at ${t}`;
}

function formatYearlyOnMonthDay(interval: number, month: number, dayOfMonth: number, time: TimeSpec): string {
  const t = formatTime(time);
  const mon = MONTH_NAMES[month - 1] ?? `month ${month}`;
  const dom = ordinal(dayOfMonth);
  if (interval === 1) return `every year on ${mon} ${dom} at ${t}`;
  return `every ${interval} years on ${mon} ${dom} at ${t}`;
}

function formatYearlyNthWeekday(interval: number, month: number, nth: number, weekday: number, time: TimeSpec): string {
  const t = formatTime(time);
  const mon = MONTH_NAMES[month - 1] ?? `month ${month}`;
  const day = WEEKDAY_NAMES[weekday] ?? `day ${weekday}`;
  const ord = nth === -1 ? 'last' : ordinal(nth);
  if (interval === 1) return `${ord} ${day} of ${mon} every year at ${t}`;
  return `${ord} ${day} of ${mon} every ${interval} years at ${t}`;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatTime(spec: TimeSpec): string {
  const hour = spec.hour;
  const minute = spec.minute ?? 0;
  const tzSuffix = formatTz(spec);

  if (hour === 12 && minute === 0) return `noon${tzSuffix}`;
  if (hour === 0 && minute === 0) return `midnight${tzSuffix}`;

  const isPm = hour >= 12;
  const h = hour % 12 || 12;
  const m = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  const ampm = isPm ? 'pm' : 'am';
  return `${h}${m}${ampm}${tzSuffix}`;
}

function formatTz(spec: TimeSpec): string {
  if (spec.type === 'fixed_instant') {
    const offset = spec.utcOffsetMinutes;
    if (offset === 0) return ' (UTC)';
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m > 0
      ? ` (UTC${sign}${h}:${String(m).padStart(2, '0')})`
      : ` (UTC${sign}${h})`;
  }

  // wall_time — try to show a friendly abbreviation, otherwise show IANA
  const iana = spec.timezone;
  const abbr = IANA_TO_ABBR[iana];
  if (abbr) return ` (${abbr})`;
  if (iana === 'UTC') return ' (UTC)';
  return ` (${iana})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const IANA_TO_ABBR: Record<string, string> = {
  'America/New_York':    'ET',
  'America/Chicago':     'CT',
  'America/Denver':      'MT',
  'America/Los_Angeles': 'PT',
  'Europe/London':       'London',
  'Europe/Paris':        'Paris',
  'Asia/Tokyo':          'JST',
  'Australia/Sydney':    'Sydney',
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function formatDayList(days: number[]): string {
  const sorted = days.slice().sort((a, b) => a - b);
  const names = sorted.map(d => WEEKDAY_NAMES[d] ?? `day ${d}`);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function formatIsoDatetime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  });
}
