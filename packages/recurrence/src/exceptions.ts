// ABOUTME: Exception handling for recurrence rules (cancel, move, override_time, override_payload)

import type { RecurrenceException, CancelException, MoveException, OverrideTimeException, OverridePayloadException, TimeSpec } from './types.js';

export interface ExceptionResult {
  cancelled: boolean;
  movedTo?: Date;                               // If moved, the new UTC datetime
  overrideTime?: TimeSpec;                      // If time overridden
  overrideRecord?: Record<string, unknown>;     // If payload overridden
}

/**
 * Check exceptions for a given occurrence date (YYYY-MM-DD).
 * Returns the exception result for that date.
 */
export function checkExceptions(exceptions: RecurrenceException[], date: string): ExceptionResult {
  for (const ex of exceptions) {
    if (ex.date !== date) continue;

    if (ex.type === 'cancel') {
      return { cancelled: true };
    }
    if (ex.type === 'move') {
      return { cancelled: false, movedTo: new Date((ex as MoveException).newDatetime) };
    }
    if (ex.type === 'override_time') {
      return { cancelled: false, overrideTime: (ex as OverrideTimeException).time };
    }
    if (ex.type === 'override_payload') {
      return { cancelled: false, overrideRecord: (ex as OverridePayloadException).record };
    }
  }
  return { cancelled: false };
}

/**
 * Check if a given date has a cancelled exception.
 */
export function isCancelled(exceptions: RecurrenceException[], date: string): boolean {
  return exceptions.some(ex => ex.type === 'cancel' && (ex as CancelException).date === date);
}
