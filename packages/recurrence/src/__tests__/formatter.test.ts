// ABOUTME: Tests for the recurrence rule formatter

import { formatRecurrenceRule } from '../formatter';
import type { RecurrenceRule } from '../types';

const UTC: import('../types').WallTime = { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' };
const ET:  import('../types').WallTime = { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/New_York' };

function r(rule: RecurrenceRule['rule'], extras?: Partial<RecurrenceRule>): RecurrenceRule {
  return { rule, ...extras };
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — daily', () => {
  it('every day', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: UTC }))).toBe('every day at 9am (UTC)');
  });

  it('every other day', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', interval: 2, time: UTC }))).toBe('every other day at 9am (UTC)');
  });

  it('every 3 days', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', interval: 3, time: UTC }))).toBe('every 3 days at 9am (UTC)');
  });

  it('noon', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 12, minute: 0, timezone: 'UTC' } }))).toBe('every day at noon (UTC)');
  });

  it('midnight', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 0, minute: 0, timezone: 'UTC' } }))).toBe('every day at midnight (UTC)');
  });

  it('5pm ET', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 17, minute: 0, timezone: 'America/New_York' } }))).toBe('every day at 5pm (ET)');
  });

  it('8:30am', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 8, minute: 30, timezone: 'UTC' } }))).toBe('every day at 8:30am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — weekly', () => {
  it('every weekday', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [1, 2, 3, 4, 5], time: UTC }))).toBe('every weekday at 9am (UTC)');
  });

  it('every weekend', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [0, 6], time: UTC }))).toBe('every weekend at 9am (UTC)');
  });

  it('single day', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [1], time: ET }))).toBe('every Monday at 9am (ET)');
  });

  it('two days', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [1, 5], time: UTC }))).toBe('every Monday and Friday at 9am (UTC)');
  });

  it('three days', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [1, 3, 5], time: UTC }))).toBe('every Monday, Wednesday and Friday at 9am (UTC)');
  });

  it('every 2 weeks on Tuesday', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', interval: 2, daysOfWeek: [2], time: UTC }))).toBe('every other week on Tuesday at 9am (UTC)');
  });

  it('every 3 weeks on Wednesday', () => {
    expect(formatRecurrenceRule(r({ type: 'weekly', interval: 3, daysOfWeek: [3], time: UTC }))).toBe('every 3 weeks on Wednesday at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Monthly on day
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — monthly_on_day', () => {
  it('every month on the 1st', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_on_day', dayOfMonth: 1, time: UTC }))).toBe('every month on the 1st at 9am (UTC)');
  });

  it('every month on the 15th', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_on_day', dayOfMonth: 15, time: UTC }))).toBe('every month on the 15th at 9am (UTC)');
  });

  it('every month on the 22nd', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_on_day', dayOfMonth: 22, time: UTC }))).toBe('every month on the 22nd at 9am (UTC)');
  });

  it('every other month on the 3rd', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_on_day', interval: 2, dayOfMonth: 3, time: UTC }))).toBe('every other month on the 3rd at 9am (UTC)');
  });

  it('every 3 months on the 1st', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_on_day', interval: 3, dayOfMonth: 1, time: UTC }))).toBe('every 3 months on the 1st at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Monthly nth weekday
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — monthly_nth_weekday', () => {
  it('first Monday of every month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_nth_weekday', nth: 1, weekday: 1, time: UTC }))).toBe('1st Monday of every month at 9am (UTC)');
  });

  it('last Friday of every month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_nth_weekday', nth: -1, weekday: 5, time: UTC }))).toBe('last Friday of every month at 9am (UTC)');
  });

  it('3rd Wednesday of every month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_nth_weekday', nth: 3, weekday: 3, time: UTC }))).toBe('3rd Wednesday of every month at 9am (UTC)');
  });

  it('last Tuesday of every other month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_nth_weekday', interval: 2, nth: -1, weekday: 2, time: UTC }))).toBe('last Tuesday of every other month at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Monthly last business day
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — monthly_last_business_day', () => {
  it('last business day of every month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_last_business_day', time: UTC }))).toBe('last business day of every month at 9am (UTC)');
  });

  it('last business day of every other month', () => {
    expect(formatRecurrenceRule(r({ type: 'monthly_last_business_day', interval: 2, time: UTC }))).toBe('last business day of every other month at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Quarterly last weekday
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — quarterly_last_weekday', () => {
  it('last Friday of every quarter', () => {
    expect(formatRecurrenceRule(r({ type: 'quarterly_last_weekday', weekday: 5, time: UTC }))).toBe('last Friday of every quarter at 9am (UTC)');
  });

  it('last Monday of every quarter', () => {
    expect(formatRecurrenceRule(r({ type: 'quarterly_last_weekday', weekday: 1, time: UTC }))).toBe('last Monday of every quarter at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Yearly
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — yearly', () => {
  it('every year on January 1st', () => {
    expect(formatRecurrenceRule(r({ type: 'yearly_on_month_day', month: 1, dayOfMonth: 1, time: UTC }))).toBe('every year on January 1st at 9am (UTC)');
  });

  it('every year on March 15th', () => {
    expect(formatRecurrenceRule(r({ type: 'yearly_on_month_day', month: 3, dayOfMonth: 15, time: UTC }))).toBe('every year on March 15th at 9am (UTC)');
  });

  it('last Friday of December every year', () => {
    expect(formatRecurrenceRule(r({ type: 'yearly_nth_weekday', month: 12, nth: -1, weekday: 5, time: UTC }))).toBe('last Friday of December every year at 9am (UTC)');
  });

  it('first Monday of March every year', () => {
    expect(formatRecurrenceRule(r({ type: 'yearly_nth_weekday', month: 3, nth: 1, weekday: 1, time: UTC }))).toBe('1st Monday of March every year at 9am (UTC)');
  });
});

// ---------------------------------------------------------------------------
// End conditions
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — end conditions', () => {
  it('appends startDate', () => {
    const result = formatRecurrenceRule(r({ type: 'daily', time: UTC }, { startDate: '2026-04-01' }));
    expect(result).toBe('every day at 9am (UTC), starting 2026-04-01');
  });

  it('appends endDate', () => {
    const result = formatRecurrenceRule(r({ type: 'daily', time: UTC }, { endDate: '2026-12-31' }));
    expect(result).toBe('every day at 9am (UTC), until 2026-12-31');
  });

  it('appends count', () => {
    const result = formatRecurrenceRule(r({ type: 'weekly', daysOfWeek: [1], time: UTC }, { count: 10 }));
    expect(result).toBe('every Monday at 9am (UTC), for 10 occurrences');
  });

  it('singular occurrence', () => {
    const result = formatRecurrenceRule(r({ type: 'daily', time: UTC }, { count: 1 }));
    expect(result).toBe('every day at 9am (UTC), for 1 occurrence');
  });
});

// ---------------------------------------------------------------------------
// Timezone display
// ---------------------------------------------------------------------------

describe('formatRecurrenceRule — timezone display', () => {
  it('America/New_York → ET', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/New_York' } }))).toContain('(ET)');
  });

  it('America/Chicago → CT', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/Chicago' } }))).toContain('(CT)');
  });

  it('America/Los_Angeles → PT', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/Los_Angeles' } }))).toContain('(PT)');
  });

  it('unknown IANA → shown as-is', () => {
    expect(formatRecurrenceRule(r({ type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/Phoenix' } }))).toContain('(America/Phoenix)');
  });

  it('fixed_instant UTC offset', () => {
    const result = formatRecurrenceRule(r({ type: 'daily', time: { type: 'fixed_instant', utcOffsetMinutes: -300, hour: 9, minute: 0 } }));
    expect(result).toContain('(UTC-5)');
  });
});
