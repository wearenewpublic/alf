// ABOUTME: TypeScript types for the recurrence rule schema

/**
 * A wall-clock time in a specific IANA timezone.
 * Uses the following DST policy:
 *   - Gap (spring-forward): use the post-transition time (skip stays skipped)
 *   - Overlap (fall-back): use the earlier (pre-transition) occurrence
 */
export interface WallTime {
  type: 'wall_time';
  hour: number;      // 0-23
  minute: number;    // 0-59
  second?: number;   // 0-59, default 0
  timezone: string;  // IANA timezone string, e.g. "America/New_York"
}

/**
 * A fixed UTC instant for the time-of-day component.
 * The date component comes from the recurrence rule; the time is always this UTC offset.
 */
export interface FixedInstant {
  type: 'fixed_instant';
  utcOffsetMinutes: number; // e.g. -300 for UTC-5
  hour: number;
  minute: number;
  second?: number;
}

export type TimeSpec = WallTime | FixedInstant;

// ---- Exception types ----

export interface CancelException {
  type: 'cancel';
  date: string; // ISO date YYYY-MM-DD (in rule's timezone for wall_time rules)
}

export interface MoveException {
  type: 'move';
  date: string;       // Original date (ISO date)
  newDatetime: string; // New ISO 8601 datetime (UTC)
}

export interface OverrideTimeException {
  type: 'override_time';
  date: string;  // Original date (ISO date)
  time: TimeSpec; // Replacement time spec
}

export interface OverridePayloadException {
  type: 'override_payload';
  date: string;      // Original date (ISO date)
  record: Record<string, unknown>; // Override record content
}

export type RecurrenceException =
  | CancelException
  | MoveException
  | OverrideTimeException
  | OverridePayloadException;

// ---- Revision types ----

export interface RecurrenceRevision {
  id: string;           // UUID
  effectiveFromDate: string; // ISO date YYYY-MM-DD — this revision governs occurrences on/after this date
  rule: RecurrenceRuleCore; // The rule for this revision
}

// ---- Core rule types ----

export interface DailyRule {
  type: 'daily';
  interval?: number; // Every N days, default 1
  time: TimeSpec;
}

export interface WeeklyRule {
  type: 'weekly';
  interval?: number;          // Every N weeks, default 1
  daysOfWeek: number[];       // 0=Sunday, 1=Monday, ... 6=Saturday
  time: TimeSpec;
}

export interface MonthlyOnDayRule {
  type: 'monthly_on_day';
  interval?: number;  // Every N months, default 1
  dayOfMonth: number; // 1-31 (clamped to month end if > month length)
  time: TimeSpec;
}

export interface MonthlyNthWeekdayRule {
  type: 'monthly_nth_weekday';
  interval?: number; // Every N months, default 1
  nth: number;       // 1-4 (positive) or -1 (last)
  weekday: number;   // 0=Sunday, 1=Monday, ... 6=Saturday
  time: TimeSpec;
}

export interface OnceRule {
  type: 'once';
  datetime: string; // ISO 8601 UTC — "2024-03-15T14:30:00Z"
}

export interface YearlyOnMonthDayRule {
  type: 'yearly_on_month_day';
  interval?: number;  // default 1
  month: number;      // 1-12
  dayOfMonth: number; // 1-31, clamped to month end
  time: TimeSpec;
}

export interface YearlyNthWeekdayRule {
  type: 'yearly_nth_weekday';
  interval?: number; // default 1
  month: number;     // 1-12
  nth: number;       // 1-4, or -1 for last
  weekday: number;   // 0=Sun ... 6=Sat
  time: TimeSpec;
}

export interface MonthlyLastBusinessDayRule {
  type: 'monthly_last_business_day';
  interval?: number; // default 1
  time: TimeSpec;
}

export interface QuarterlyLastWeekdayRule {
  type: 'quarterly_last_weekday';
  interval?: number; // default 1 (every quarter)
  weekday: number;   // 0=Sun ... 6=Sat
  time: TimeSpec;
}

export type RecurrenceRuleCore =
  | DailyRule
  | WeeklyRule
  | MonthlyOnDayRule
  | MonthlyNthWeekdayRule
  | OnceRule
  | YearlyOnMonthDayRule
  | YearlyNthWeekdayRule
  | MonthlyLastBusinessDayRule
  | QuarterlyLastWeekdayRule;

/**
 * Full recurrence rule with optional revisions and exceptions.
 * Stored as JSON in schedules.recurrence_rule.
 */
export interface RecurrenceRule {
  // The current/primary rule (may be superseded by a revision)
  rule: RecurrenceRuleCore;

  // Optional start date: first occurrence must be on or after this date (ISO date)
  startDate?: string;

  // Optional end date: no occurrences after this date (ISO date)
  endDate?: string;

  // Optional max occurrences
  count?: number;

  // Revisions supersede the base rule from a given effective date
  revisions?: RecurrenceRevision[];

  // Exceptions modify or cancel specific occurrences
  exceptions?: RecurrenceException[];
}
