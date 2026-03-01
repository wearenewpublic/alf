// ABOUTME: Main recurrence engine — computes the next occurrence after a given date

import type { RecurrenceRule, RecurrenceRuleCore, OnceRule, TimeSpec } from './types.js';
import { realizeTime, getTimezone, todayInZone, compareDates } from './time.js';
import { getRuleForDate } from './revisions.js';
import { checkExceptions } from './exceptions.js';
import { dailyCandidates } from './rules/daily.js';
import { weeklyCandidates } from './rules/weekly.js';
import { monthlyOnDayCandidates, monthlyNthWeekdayCandidates, monthlyLastBusinessDayCandidates } from './rules/monthly.js';
import { yearlyOnMonthDayCandidates, yearlyNthWeekdayCandidates } from './rules/yearly.js';
import { quarterlyLastWeekdayCandidates } from './rules/quarterly.js';

const MAX_CANDIDATES = 10000;

/**
 * Generate raw occurrence date strings (YYYY-MM-DD) from a rule core, starting from startDate.
 * Does NOT apply exceptions or revisions — those are applied in the engine.
 */
function* generateCandidateDates(rule: RecurrenceRuleCore, startDate: string): Generator<string> {
  switch (rule.type) {
    case 'daily':
      yield* dailyCandidates(rule, startDate);
      break;
    case 'weekly':
      yield* weeklyCandidates(rule, startDate);
      break;
    case 'monthly_on_day':
      yield* monthlyOnDayCandidates(rule, startDate);
      break;
    case 'monthly_nth_weekday':
      yield* monthlyNthWeekdayCandidates(rule, startDate);
      break;
    case 'monthly_last_business_day':
      yield* monthlyLastBusinessDayCandidates(rule, startDate);
      break;
    case 'yearly_on_month_day':
      yield* yearlyOnMonthDayCandidates(rule, startDate);
      break;
    case 'yearly_nth_weekday':
      yield* yearlyNthWeekdayCandidates(rule, startDate);
      break;
    case 'quarterly_last_weekday':
      yield* quarterlyLastWeekdayCandidates(rule, startDate);
      break;
    default:
      throw new Error(`Unsupported rule type: ${(rule as RecurrenceRuleCore).type}`);
  }
}

/**
 * Get the time spec from a rule core (all repeating rules have a `time` field).
 */
function getTimeSpec(rule: RecurrenceRuleCore): TimeSpec {
  return (rule as { time: TimeSpec }).time;
}

/**
 * Compute the next UTC occurrence after `after`.
 *
 * @param fullRule - The complete RecurrenceRule
 * @param after - Find occurrences strictly after this date
 * @returns The next UTC Date, or null if the series is exhausted
 */
export function computeNextOccurrence(fullRule: RecurrenceRule, after: Date): Date | null {
  // Special-case: once rules fire exactly once
  if (fullRule.rule.type === 'once') {
    const fireDate = new Date((fullRule.rule as OnceRule).datetime);
    return fireDate > after ? fireDate : null;
  }

  // Determine the base timezone from the base rule's time spec
  const baseTimezone = getTimezone(getTimeSpec(fullRule.rule));

  // Convert `after` to a date string in the rule's timezone
  const afterDateStr = todayInZone(after, baseTimezone);

  // Start searching from the day of `after` (inclusive — we'll filter by time below)
  let searchStartDate = afterDateStr;

  // Respect startDate constraint
  if (fullRule.startDate && compareDates(fullRule.startDate, searchStartDate) > 0) {
    searchStartDate = fullRule.startDate;
  }

  const exceptions = fullRule.exceptions ?? [];
  let fireCount = 0;
  const maxCount = fullRule.count;

  // When count is specified and startDate is given, we must count from startDate
  // to properly enforce the total count limit (not just the count since `after`).
  const generatorStartDate = (maxCount !== undefined && fullRule.startDate)
    ? fullRule.startDate
    : searchStartDate;

  // We need to iterate candidates. Because of revisions, the rule can change per date,
  // so we use the base rule to generate candidate dates, then look up the governing rule
  // to compute the actual UTC time.
  let candidateCount = 0;

  // We generate from the base rule, but when revisions apply, the candidate dates may differ.
  // Strategy: generate from base rule, check exceptions, apply revision's time spec for the time.
  const baseRule = fullRule.rule;
  const gen = generateCandidateDates(baseRule, generatorStartDate);

  for (const date of gen) {
    if (candidateCount++ > MAX_CANDIDATES) break;

    // Apply endDate constraint
    if (fullRule.endDate && compareDates(date, fullRule.endDate) > 0) {
      return null;
    }

    // Apply count constraint (we need to count all occurrences from the beginning,
    // but since we're searching for "next after", we approximate by limiting candidates)
    if (maxCount !== undefined && fireCount >= maxCount) {
      return null;
    }

    // Check exceptions
    const exResult = checkExceptions(exceptions, date);

    if (exResult.cancelled) {
      // This date is cancelled — skip it but still count toward count limit
      fireCount++;
      continue;
    }

    if (exResult.movedTo) {
      // This occurrence is moved to a different datetime
      const movedDate = exResult.movedTo;
      fireCount++;

      // Check endDate against the moved date
      if (fullRule.endDate) {
        const movedDateStr = todayInZone(movedDate, baseTimezone);
        if (compareDates(movedDateStr, fullRule.endDate) > 0) {
          return null;
        }
      }

      if (movedDate > after) {
        return movedDate;
      }
      continue;
    }

    // Determine governing rule for this date (may be a revision)
    const governingRule = getRuleForDate(fullRule, date);
    const timeSpec = exResult.overrideTime ?? getTimeSpec(governingRule);

    // Realize the UTC datetime for this date
    let occurrence: Date;
    try {
      occurrence = realizeTime(date, timeSpec);
    } catch {
      // Invalid date/timezone combination — skip
      fireCount++;
      continue;
    }

    fireCount++;

    // Must be strictly after `after`
    if (occurrence > after) {
      return occurrence;
    }
  }

  return null;
}

/**
 * Get the override record for a specific occurrence, if an override_payload exception applies.
 *
 * @param rule - The complete RecurrenceRule
 * @param occurrenceDate - The scheduled UTC datetime for this occurrence
 * @returns The override record, or undefined if no override_payload exception matches
 */
export function getOccurrenceRecord(
  rule: RecurrenceRule,
  occurrenceDate: Date,
): Record<string, unknown> | undefined {
  if (!rule.exceptions?.length) return undefined;

  // Convert occurrence date to a date string in the rule's timezone
  let dateStr: string;
  if (rule.rule.type === 'once') {
    dateStr = todayInZone(occurrenceDate, 'UTC');
  } else {
    const timezone = getTimezone(getTimeSpec(rule.rule));
    dateStr = todayInZone(occurrenceDate, timezone);
  }

  const exResult = checkExceptions(rule.exceptions, dateStr);
  return exResult.overrideRecord;
}
