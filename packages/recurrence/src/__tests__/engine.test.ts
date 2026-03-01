// ABOUTME: Tests for the recurrence engine computeNextOccurrence

import { computeNextOccurrence, getOccurrenceRecord } from '../engine';
import type { RecurrenceRule } from '../types';

// Helper to parse an ISO string and get a Date
const d = (iso: string) => new Date(iso);

// Helper to format a Date as ISO string
const fmt = (date: Date | null) => date?.toISOString() ?? null;

describe('computeNextOccurrence — daily rules', () => {
  const dailyRule: RecurrenceRule = {
    rule: {
      type: 'daily',
      interval: 1,
      time: {
        type: 'wall_time',
        hour: 9,
        minute: 0,
        timezone: 'America/New_York',
      },
    },
  };

  it('returns the next day occurrence when called just before the fire time', () => {
    // 9:00 AM ET = 14:00 UTC (EST, UTC-5)
    // Ask for next after 2024-01-15T13:59:00Z (just before 9 AM ET)
    const next = computeNextOccurrence(dailyRule, d('2024-01-15T13:59:00Z'));
    // Should fire at 2024-01-15T14:00:00Z (9 AM ET)
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2024-01-15T14:00:00.000Z');
  });

  it('returns the next day when called after the fire time', () => {
    // After 9 AM ET on Jan 15, next is Jan 16
    const next = computeNextOccurrence(dailyRule, d('2024-01-15T14:01:00Z'));
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2024-01-16T14:00:00.000Z');
  });

  it('respects interval=2 (every other day)', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        interval: 2,
        time: { type: 'wall_time', hour: 12, minute: 0, timezone: 'UTC' },
      },
    };
    const next = computeNextOccurrence(rule, d('2024-01-01T12:00:00Z'));
    // After Jan 1 noon, next is Jan 3 noon
    expect(next?.toISOString()).toBe('2024-01-03T12:00:00.000Z');
  });

  it('respects startDate constraint', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
      startDate: '2024-03-01',
    };
    // Even though we ask for next after a much earlier date, startDate gates it
    const next = computeNextOccurrence(rule, d('2024-01-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2024-03-01T09:00:00.000Z');
  });

  it('returns null after endDate', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
      endDate: '2024-01-15',
    };
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    expect(next).toBeNull();
  });

  it('returns null after count is reached', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
      count: 3,
      startDate: '2024-01-01',
    };
    // Count=3 means occurrences on Jan 1, 2, 3. After Jan 3, no more.
    const next = computeNextOccurrence(rule, d('2024-01-03T09:01:00Z'));
    expect(next).toBeNull();
  });
});

describe('computeNextOccurrence — weekly rules', () => {
  it('fires on specified days of the week', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'weekly',
        daysOfWeek: [1, 3], // Monday, Wednesday
        time: { type: 'wall_time', hour: 10, minute: 0, timezone: 'UTC' },
      },
    };
    // 2024-01-15 is a Monday
    const next = computeNextOccurrence(rule, d('2024-01-15T10:01:00Z'));
    // Next is Wednesday Jan 17
    expect(next?.toISOString()).toBe('2024-01-17T10:00:00.000Z');
  });

  it('respects weekly interval', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'weekly',
        interval: 2,
        daysOfWeek: [1], // Every other Monday
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
      startDate: '2024-01-15', // Monday Jan 15
    };
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    // Next is 2 weeks later: Jan 29 (also a Monday)
    expect(next?.toISOString()).toBe('2024-01-29T09:00:00.000Z');
  });

  it('wraps to next week when no more days this week', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'weekly',
        daysOfWeek: [1], // Monday only
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
    };
    // After Monday Jan 15, next Monday is Jan 22
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    expect(next?.toISOString()).toBe('2024-01-22T09:00:00.000Z');
  });
});

describe('computeNextOccurrence — monthly_on_day rules', () => {
  it('fires on the specified day of month', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_on_day',
        dayOfMonth: 15,
        time: { type: 'wall_time', hour: 12, minute: 0, timezone: 'UTC' },
      },
    };
    // After Jan 15 noon, next is Feb 15 noon
    const next = computeNextOccurrence(rule, d('2024-01-15T12:01:00Z'));
    expect(next?.toISOString()).toBe('2024-02-15T12:00:00.000Z');
  });

  it('clamps day to end of month', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_on_day',
        dayOfMonth: 31,
        time: { type: 'wall_time', hour: 0, minute: 0, timezone: 'UTC' },
      },
    };
    // Jan 31 is valid; after Jan 31, next is Feb 29 (2024 is leap year)
    const next = computeNextOccurrence(rule, d('2024-01-31T00:01:00Z'));
    expect(next?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });
});

describe('computeNextOccurrence — monthly_nth_weekday rules', () => {
  it('fires on the 1st Monday of each month', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_nth_weekday',
        nth: 1,
        weekday: 1, // Monday
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
    };
    // First Monday of Jan 2024 = Jan 1
    // After Jan 1, first Monday of Feb 2024 = Feb 5
    const next = computeNextOccurrence(rule, d('2024-01-01T09:01:00Z'));
    expect(next?.toISOString()).toBe('2024-02-05T09:00:00.000Z');
  });

  it('fires on the last Friday (nth=-1) of each month', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_nth_weekday',
        nth: -1,
        weekday: 5, // Friday
        time: { type: 'wall_time', hour: 17, minute: 0, timezone: 'UTC' },
      },
    };
    // Last Friday of Jan 2024 = Jan 26
    const next = computeNextOccurrence(rule, d('2024-01-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2024-01-26T17:00:00.000Z');
  });
});

describe('computeNextOccurrence — fixed_instant rules', () => {
  it('handles fixed_instant time type', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: {
          type: 'fixed_instant',
          utcOffsetMinutes: -300, // UTC-5
          hour: 9,
          minute: 0,
        },
      },
    };
    // 9 AM at UTC-5 = 14:00 UTC
    const next = computeNextOccurrence(rule, d('2024-01-15T13:59:00Z'));
    expect(next?.toISOString()).toBe('2024-01-15T14:00:00.000Z');
  });
});

describe('computeNextOccurrence — exceptions', () => {
  const baseRule: RecurrenceRule = {
    rule: {
      type: 'daily',
      time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
    },
  };

  it('skips cancelled exception dates', () => {
    const rule: RecurrenceRule = {
      ...baseRule,
      exceptions: [{ type: 'cancel', date: '2024-01-16' }],
    };
    // After Jan 15, Jan 16 is cancelled, so next is Jan 17
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    expect(next?.toISOString()).toBe('2024-01-17T09:00:00.000Z');
  });

  it('uses moved datetime for move exceptions', () => {
    const rule: RecurrenceRule = {
      ...baseRule,
      exceptions: [{ type: 'move', date: '2024-01-16', newDatetime: '2024-01-16T15:00:00Z' }],
    };
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    // Jan 16 is moved to 15:00 UTC
    expect(next?.toISOString()).toBe('2024-01-16T15:00:00.000Z');
  });

  it('uses override time for override_time exceptions', () => {
    const rule: RecurrenceRule = {
      ...baseRule,
      exceptions: [{
        type: 'override_time',
        date: '2024-01-16',
        time: { type: 'wall_time', hour: 17, minute: 30, timezone: 'UTC' },
      }],
    };
    const next = computeNextOccurrence(rule, d('2024-01-15T09:01:00Z'));
    // Jan 16 at 17:30 UTC
    expect(next?.toISOString()).toBe('2024-01-16T17:30:00.000Z');
  });
});

describe('computeNextOccurrence — revisions', () => {
  it('applies revision time spec after effectiveFromDate', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
      revisions: [
        {
          id: 'rev1',
          effectiveFromDate: '2024-01-20',
          rule: {
            type: 'daily',
            time: { type: 'wall_time', hour: 14, minute: 0, timezone: 'UTC' },
          },
        },
      ],
    };
    // Before revision: 9 AM
    const before = computeNextOccurrence(rule, d('2024-01-18T09:01:00Z'));
    expect(before?.toISOString()).toBe('2024-01-19T09:00:00.000Z');

    // After revision kicks in: 2 PM
    const after = computeNextOccurrence(rule, d('2024-01-19T09:01:00Z'));
    expect(after?.toISOString()).toBe('2024-01-20T14:00:00.000Z');
  });
});

describe('computeNextOccurrence — DST handling', () => {
  it('handles spring-forward gap (clocks spring forward in America/New_York)', () => {
    // In 2024, US spring-forward: March 10 at 2 AM local → 3 AM
    // A rule firing at 2:30 AM ET on March 10 should resolve to 3:30 AM ET (7:30 AM UTC)
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 2, minute: 30, timezone: 'America/New_York' },
      },
    };
    const next = computeNextOccurrence(rule, d('2024-03-09T09:00:00Z'));
    // Luxon will resolve the 2:30 AM gap to the post-transition time
    // March 10 in ET spring-forward: 2:30 AM is in the gap, resolves to 3:30 AM EDT = 7:30 AM UTC
    expect(next).not.toBeNull();
  });

  it('handles fall-back overlap (clocks fall back in America/New_York)', () => {
    // In 2024, US fall-back: November 3 at 2 AM → 1 AM (clocks fall back)
    // Rule fires at 1:30 AM ET — there are two 1:30 AM ET on this day
    const rule: RecurrenceRule = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 1, minute: 30, timezone: 'America/New_York' },
      },
    };
    const next = computeNextOccurrence(rule, d('2024-11-02T09:00:00Z'));
    expect(next).not.toBeNull();
    // Luxon resolves ambiguous fall-back times to the post-transition (EST = UTC-5 → 6:30 AM UTC).
    // This is consistent behavior: same wall time after the clock has fallen back.
    expect(next!.toISOString()).toBe('2024-11-03T06:30:00.000Z');
  });
});

describe('computeNextOccurrence — once rule', () => {
  it('fires exactly once when datetime is in the future', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'once', datetime: '2024-06-15T10:00:00Z' },
    };
    const next = computeNextOccurrence(rule, d('2024-06-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2024-06-15T10:00:00.000Z');
  });

  it('returns null when called after the datetime', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'once', datetime: '2024-06-15T10:00:00Z' },
    };
    const next = computeNextOccurrence(rule, d('2024-06-15T10:00:00Z'));
    expect(next).toBeNull();
  });

  it('returns null when datetime is in the past relative to after', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'once', datetime: '2024-01-01T00:00:00Z' },
    };
    const next = computeNextOccurrence(rule, d('2024-06-01T00:00:00Z'));
    expect(next).toBeNull();
  });
});

describe('computeNextOccurrence — move exception with endDate', () => {
  it('returns null when a moved occurrence falls past endDate', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
      endDate: '2024-01-20',
      exceptions: [{ type: 'move', date: '2024-01-15', newDatetime: '2024-01-25T09:00:00Z' }],
    };
    // Jan 15 is moved to Jan 25, which is after endDate Jan 20 → should return null
    const next = computeNextOccurrence(rule, d('2024-01-14T09:01:00Z'));
    expect(next).toBeNull();
  });

  it('returns moved occurrence when it falls within endDate', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
      endDate: '2024-01-20',
      exceptions: [{ type: 'move', date: '2024-01-15', newDatetime: '2024-01-18T09:00:00Z' }],
    };
    // Jan 15 is moved to Jan 18, which is within endDate → should return the moved date
    const next = computeNextOccurrence(rule, d('2024-01-14T09:01:00Z'));
    expect(next?.toISOString()).toBe('2024-01-18T09:00:00.000Z');
  });
});

describe('getOccurrenceRecord — override_payload exception', () => {
  it('returns the override record for a matching override_payload exception', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
      exceptions: [{
        type: 'override_payload',
        date: '2024-03-15',
        record: { '$type': 'app.bsky.feed.post', text: 'Special post!' },
      }],
    };
    // occurrenceDate = March 15 at 9 AM UTC
    const overrideRecord = getOccurrenceRecord(rule, d('2024-03-15T09:00:00Z'));
    expect(overrideRecord).toBeDefined();
    expect(overrideRecord?.text).toBe('Special post!');
  });

  it('returns undefined when no override_payload exception matches', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
      exceptions: [{
        type: 'override_payload',
        date: '2024-03-15',
        record: { '$type': 'app.bsky.feed.post', text: 'Special post!' },
      }],
    };
    const overrideRecord = getOccurrenceRecord(rule, d('2024-03-16T09:00:00Z'));
    expect(overrideRecord).toBeUndefined();
  });
});

describe('computeNextOccurrence — DST exact UTC values', () => {
  it('spring-forward: 9 AM ET on 2024-03-10 → 2024-03-10T13:00:00Z (EDT=UTC-4)', () => {
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/New_York' } },
    };
    const next = computeNextOccurrence(rule, d('2024-03-09T14:00:00Z'));
    // After spring-forward, EDT = UTC-4, so 9 AM EDT = 13:00 UTC
    expect(next?.toISOString()).toBe('2024-03-10T13:00:00.000Z');
  });

  it('fall-back: 1:30 AM ET on 2024-11-03 → 2024-11-03T06:30:00Z (EST=UTC-5)', () => {
    // This test is the same as the existing fall-back test — verifying the exact UTC value
    const rule: RecurrenceRule = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 1, minute: 30, timezone: 'America/New_York' } },
    };
    const next = computeNextOccurrence(rule, d('2024-11-02T09:00:00Z'));
    expect(next?.toISOString()).toBe('2024-11-03T06:30:00.000Z');
  });
});

describe('computeNextOccurrence — yearly_on_month_day', () => {
  it('fires on Feb 14 annually for 3 consecutive years', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'yearly_on_month_day',
        month: 2,
        dayOfMonth: 14,
        time: { type: 'wall_time', hour: 12, minute: 0, timezone: 'UTC' },
      },
    };

    const first = computeNextOccurrence(rule, d('2024-01-01T00:00:00Z'));
    expect(first?.toISOString()).toBe('2024-02-14T12:00:00.000Z');

    const second = computeNextOccurrence(rule, first!);
    expect(second?.toISOString()).toBe('2025-02-14T12:00:00.000Z');

    const third = computeNextOccurrence(rule, second!);
    expect(third?.toISOString()).toBe('2026-02-14T12:00:00.000Z');
  });
});

describe('computeNextOccurrence — yearly_nth_weekday', () => {
  it('fires on the 3rd Monday of October each year', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'yearly_nth_weekday',
        month: 10,
        nth: 3,
        weekday: 1, // Monday
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
    };

    // 3rd Monday of Oct 2024 = Oct 21
    const next2024 = computeNextOccurrence(rule, d('2024-01-01T00:00:00Z'));
    expect(next2024?.toISOString()).toBe('2024-10-21T09:00:00.000Z');

    // 3rd Monday of Oct 2025 = Oct 20
    const next2025 = computeNextOccurrence(rule, next2024!);
    expect(next2025?.toISOString()).toBe('2025-10-20T09:00:00.000Z');
  });
});

describe('computeNextOccurrence — monthly_last_business_day', () => {
  it('fires on Dec 29 2023 (last=Sat, so last business day is Fri Dec 29)', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_last_business_day',
        time: { type: 'wall_time', hour: 17, minute: 0, timezone: 'UTC' },
      },
    };
    const next = computeNextOccurrence(rule, d('2023-12-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2023-12-29T17:00:00.000Z');
  });

  it('fires on Feb 29 2024 (leap year, Feb 29 is a Thursday)', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'monthly_last_business_day',
        time: { type: 'wall_time', hour: 17, minute: 0, timezone: 'UTC' },
      },
    };
    const next = computeNextOccurrence(rule, d('2024-02-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2024-02-29T17:00:00.000Z');
  });
});

describe('computeNextOccurrence — quarterly_last_weekday', () => {
  it('fires on last Friday of each quarter-end month (Mar, Jun, Sep, Dec)', () => {
    const rule: RecurrenceRule = {
      rule: {
        type: 'quarterly_last_weekday',
        weekday: 5, // Friday
        time: { type: 'wall_time', hour: 16, minute: 0, timezone: 'UTC' },
      },
    };

    // Last Friday of Mar 2024 = Mar 29
    const q1 = computeNextOccurrence(rule, d('2024-01-01T00:00:00Z'));
    expect(q1?.toISOString()).toBe('2024-03-29T16:00:00.000Z');

    // Last Friday of Jun 2024 = Jun 28
    const q2 = computeNextOccurrence(rule, q1!);
    expect(q2?.toISOString()).toBe('2024-06-28T16:00:00.000Z');

    // Last Friday of Sep 2024 = Sep 27
    const q3 = computeNextOccurrence(rule, q2!);
    expect(q3?.toISOString()).toBe('2024-09-27T16:00:00.000Z');

    // Last Friday of Dec 2024 = Dec 27
    const q4 = computeNextOccurrence(rule, q3!);
    expect(q4?.toISOString()).toBe('2024-12-27T16:00:00.000Z');
  });
});
