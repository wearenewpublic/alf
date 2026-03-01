// ABOUTME: Revision selection logic — determines which revision governs a given date

import type { RecurrenceRule, RecurrenceRuleCore, RecurrenceRevision } from './types.js';
import { compareDates } from './time.js';

/**
 * Find the governing rule for a given occurrence date.
 * Revisions are sorted by effectiveFromDate; the latest revision whose
 * effectiveFromDate <= occurrenceDate governs that occurrence.
 * If no revision applies, the base rule is used.
 */
export function getRuleForDate(fullRule: RecurrenceRule, occurrenceDate: string): RecurrenceRuleCore {
  const revisions = fullRule.revisions ?? [];
  if (revisions.length === 0) return fullRule.rule;

  // Sort revisions by effectiveFromDate descending, then find the first one <= occurrenceDate
  const sorted = [...revisions].sort((a, b) => compareDates(b.effectiveFromDate, a.effectiveFromDate));
  for (const rev of sorted) {
    if (compareDates(rev.effectiveFromDate, occurrenceDate) <= 0) {
      return rev.rule;
    }
  }
  return fullRule.rule;
}

/**
 * Get the earliest possible revision that could affect occurrences after a given date.
 * Used to determine what start date to use for the search.
 */
export function getLatestRevisionBefore(revisions: RecurrenceRevision[], beforeDate: string): RecurrenceRevision | null {
  const applicable = revisions.filter(r => compareDates(r.effectiveFromDate, beforeDate) <= 0);
  if (applicable.length === 0) return null;
  return applicable.reduce((latest, r) =>
    compareDates(r.effectiveFromDate, latest.effectiveFromDate) > 0 ? r : latest,
  );
}
