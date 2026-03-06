// ABOUTME: Tests for the natural language recurrence rule parser

import { parseRecurrenceRule } from '../parser';

// Shorthand: get the core rule object with an any cast for property access
// (TypeScript can't narrow a union type across separate function calls)
function core(r: ReturnType<typeof parseRecurrenceRule>): any {
  return r!.rule;
}

// ---------------------------------------------------------------------------
// Daily rules
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — daily', () => {
  it('parses "every day"', () => {
    const r = parseRecurrenceRule('every day at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('daily');
  });

  it('parses "daily"', () => {
    const r = parseRecurrenceRule('daily at noon');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('daily');
  });

  it('parses "every 3 days"', () => {
    const r = parseRecurrenceRule('every 3 days at 8am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('daily');
    expect(core(r).interval).toBe(3);
  });

  it('parses "every other day" as interval 2', () => {
    const r = parseRecurrenceRule('every other day at 10am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('daily');
    expect(core(r).interval).toBe(2);
  });

  it('parses "each day" as daily', () => {
    const r = parseRecurrenceRule('each day at 6pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('daily');
  });
});

// ---------------------------------------------------------------------------
// Weekly rules
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — weekly', () => {
  it('parses "every Monday"', () => {
    const r = parseRecurrenceRule('every Monday at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).daysOfWeek).toEqual([1]);
  });

  it('parses "every Monday and Friday"', () => {
    const r = parseRecurrenceRule('every Monday and Friday at 9am ET');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).daysOfWeek).toEqual([1, 5]);
  });

  it('parses "weekdays" as Mon-Fri', () => {
    const r = parseRecurrenceRule('every weekday at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses "weekends" as Sat+Sun', () => {
    const r = parseRecurrenceRule('weekends at noon');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).daysOfWeek).toEqual([0, 6]);
  });

  it('parses "every 2 weeks on Tuesday"', () => {
    const r = parseRecurrenceRule('every 2 weeks on Tuesday at 10am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).interval).toBe(2);
    expect(core(r).daysOfWeek).toEqual([2]);
  });

  it('parses "every other week on Monday"', () => {
    const r = parseRecurrenceRule('every other week on Monday at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).interval).toBe(2);
  });

  it('parses multiple days: Mon, Wed, Fri', () => {
    const r = parseRecurrenceRule('every Monday, Wednesday, Friday at 8am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('weekly');
    expect(core(r).daysOfWeek).toEqual([1, 3, 5]);
  });
});

// ---------------------------------------------------------------------------
// Monthly on day
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — monthly_on_day', () => {
  it('parses "every month on the 15th"', () => {
    const r = parseRecurrenceRule('every month on the 15th at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_on_day');
    expect(core(r).dayOfMonth).toBe(15);
  });

  it('parses "1st of each month"', () => {
    const r = parseRecurrenceRule('1st of each month at noon');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_on_day');
    expect(core(r).dayOfMonth).toBe(1);
  });

  it('parses "monthly on the 28th"', () => {
    const r = parseRecurrenceRule('monthly on the 28th at 5pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_on_day');
    expect(core(r).dayOfMonth).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// Monthly nth weekday
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — monthly_nth_weekday', () => {
  it('parses "first Monday of each month"', () => {
    const r = parseRecurrenceRule('first Monday of each month at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_nth_weekday');
    expect(core(r).nth).toBe(1);
    expect(core(r).weekday).toBe(1);
  });

  it('parses "last Friday of every month"', () => {
    const r = parseRecurrenceRule('last Friday of every month at 5pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_nth_weekday');
    expect(core(r).nth).toBe(-1);
    expect(core(r).weekday).toBe(5);
  });

  it('parses "3rd Wednesday of each month"', () => {
    const r = parseRecurrenceRule('3rd Wednesday of each month at 10am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_nth_weekday');
    expect(core(r).nth).toBe(3);
    expect(core(r).weekday).toBe(3);
  });

  it('parses "second Tuesday of the month"', () => {
    const r = parseRecurrenceRule('second Tuesday of the month at 2pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_nth_weekday');
    expect(core(r).nth).toBe(2);
    expect(core(r).weekday).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Monthly last business day
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — monthly_last_business_day', () => {
  it('parses "last business day of each month"', () => {
    const r = parseRecurrenceRule('last business day of each month at 5pm UTC');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_last_business_day');
  });

  it('parses "last business day"', () => {
    const r = parseRecurrenceRule('last business day at noon');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_last_business_day');
  });

  it('parses "last weekday of the month"', () => {
    const r = parseRecurrenceRule('last weekday of the month at 4pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('monthly_last_business_day');
  });
});

// ---------------------------------------------------------------------------
// Quarterly last weekday
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — quarterly_last_weekday', () => {
  it('parses "last Friday of each quarter"', () => {
    const r = parseRecurrenceRule('last Friday of each quarter at 3pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('quarterly_last_weekday');
    expect(core(r).weekday).toBe(5);
  });

  it('parses "last Monday of every quarter"', () => {
    const r = parseRecurrenceRule('last Monday of every quarter at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('quarterly_last_weekday');
    expect(core(r).weekday).toBe(1);
  });

  it('parses "quarterly last Thursday"', () => {
    const r = parseRecurrenceRule('quarterly last Thursday at 10am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('quarterly_last_weekday');
    expect(core(r).weekday).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Yearly rules
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — yearly', () => {
  it('parses "every year on January 1st"', () => {
    const r = parseRecurrenceRule('every year on January 1st at midnight');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('yearly_on_month_day');
    expect(core(r).month).toBe(1);
    expect(core(r).dayOfMonth).toBe(1);
  });

  it('parses "March 15th each year"', () => {
    const r = parseRecurrenceRule('March 15th each year at 9am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('yearly_on_month_day');
    expect(core(r).month).toBe(3);
    expect(core(r).dayOfMonth).toBe(15);
  });

  it('parses "annually on July 4th"', () => {
    const r = parseRecurrenceRule('annually on July 4th at noon');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('yearly_on_month_day');
    expect(core(r).month).toBe(7);
    expect(core(r).dayOfMonth).toBe(4);
  });

  it('parses "last Friday of December every year"', () => {
    const r = parseRecurrenceRule('last Friday of December every year at 5pm');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('yearly_nth_weekday');
    expect(core(r).month).toBe(12);
    expect(core(r).nth).toBe(-1);
    expect(core(r).weekday).toBe(5);
  });

  it('parses "first Monday of March yearly"', () => {
    const r = parseRecurrenceRule('first Monday of March yearly at 8am');
    expect(r).not.toBeNull();
    expect(core(r).type).toBe('yearly_nth_weekday');
    expect(core(r).month).toBe(3);
    expect(core(r).nth).toBe(1);
    expect(core(r).weekday).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timezone extraction
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — timezone extraction', () => {
  it('extracts ET → America/New_York', () => {
    const r = parseRecurrenceRule('every Monday at 9am ET');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('America/New_York');
  });

  it('extracts EST → America/New_York', () => {
    const r = parseRecurrenceRule('every weekday at 8am EST');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('America/New_York');
  });

  it('extracts PT → America/Los_Angeles', () => {
    const r = parseRecurrenceRule('daily at 6pm PT');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('America/Los_Angeles');
  });

  it('extracts UTC', () => {
    const r = parseRecurrenceRule('every day at noon UTC');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('UTC');
  });

  it('extracts IANA timezone literal', () => {
    const r = parseRecurrenceRule('every Monday at 9am America/Chicago');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('America/Chicago');
  });

  it('uses defaultTimezone when no timezone mentioned', () => {
    const r = parseRecurrenceRule('every Tuesday at 10am', 'America/Denver');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('America/Denver');
  });

  it('falls back to UTC when no timezone and no default', () => {
    const r = parseRecurrenceRule('every Wednesday at 2pm');
    expect(r).not.toBeNull();
    expect(core(r).time.timezone).toBe('UTC');
  });
});

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — time parsing', () => {
  it('parses 12-hour am', () => {
    const r = parseRecurrenceRule('every day at 9am');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(9);
    expect(core(r).time.minute).toBe(0);
  });

  it('parses 12-hour pm', () => {
    const r = parseRecurrenceRule('every day at 5pm');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(17);
    expect(core(r).time.minute).toBe(0);
  });

  it('parses noon', () => {
    const r = parseRecurrenceRule('every day at noon');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(12);
    expect(core(r).time.minute).toBe(0);
  });

  it('parses midnight', () => {
    const r = parseRecurrenceRule('every day at midnight');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(0);
    expect(core(r).time.minute).toBe(0);
  });

  it('parses H:MM am', () => {
    const r = parseRecurrenceRule('every day at 8:30am');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(8);
    expect(core(r).time.minute).toBe(30);
  });

  it('parses 12pm as noon', () => {
    const r = parseRecurrenceRule('every day at 12pm');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(12);
    expect(core(r).time.minute).toBe(0);
  });

  it('parses 12am as midnight', () => {
    const r = parseRecurrenceRule('every day at 12am');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(0);
    expect(core(r).time.minute).toBe(0);
  });

  it('defaults to 9:00 when no time specified', () => {
    const r = parseRecurrenceRule('every day');
    expect(r).not.toBeNull();
    expect(core(r).time.hour).toBe(9);
    expect(core(r).time.minute).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Interval multipliers
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — interval multipliers', () => {
  it('parses "every 2 weeks"', () => {
    const r = parseRecurrenceRule('every 2 weeks on Monday at 9am');
    expect(r).not.toBeNull();
    expect(core(r).interval).toBe(2);
  });

  it('parses "every other day"', () => {
    const r = parseRecurrenceRule('every other day at 9am');
    expect(r).not.toBeNull();
    expect(core(r).interval).toBe(2);
  });

  it('parses "every 3 months"', () => {
    const r = parseRecurrenceRule('every 3 months on the 1st at noon');
    expect(r).not.toBeNull();
    expect(core(r).interval).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// End conditions
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — end conditions', () => {
  it('extracts "for N times" count', () => {
    const r = parseRecurrenceRule('every Monday at 9am for 10 times');
    expect(r).not.toBeNull();
    expect(r!.count).toBe(10);
    expect(core(r).type).toBe('weekly');
  });

  it('extracts "until YYYY-MM-DD" end date', () => {
    const r = parseRecurrenceRule('every day at noon until 2026-12-31');
    expect(r).not.toBeNull();
    expect(r!.endDate).toBe('2026-12-31');
  });

  it('extracts "starting YYYY-MM-DD" start date', () => {
    const r = parseRecurrenceRule('every week on Friday at 5pm starting 2026-04-01');
    expect(r).not.toBeNull();
    expect(r!.startDate).toBe('2026-04-01');
  });

  it('extracts both start and end', () => {
    const r = parseRecurrenceRule('every Monday at 9am starting 2026-03-01 until 2026-06-30');
    expect(r).not.toBeNull();
    expect(r!.startDate).toBe('2026-03-01');
    expect(r!.endDate).toBe('2026-06-30');
  });
});

// ---------------------------------------------------------------------------
// Null returns
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule — null for unparseable input', () => {
  it('returns null for empty string', () => {
    expect(parseRecurrenceRule('')).toBeNull();
  });

  it('returns null for gibberish', () => {
    expect(parseRecurrenceRule('asdf qwerty blah')).toBeNull();
  });

  it('returns null for just a time with no recurrence keyword', () => {
    expect(parseRecurrenceRule('at 9am')).toBeNull();
  });
});
