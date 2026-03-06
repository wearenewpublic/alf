// ABOUTME: Natural language → RecurrenceRule parser. Zero dependencies, deterministic regex/grammar approach.

import type {
  RecurrenceRule,
  RecurrenceRuleCore,
  WallTime,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a plain-English recurrence description into a RecurrenceRule.
 * Returns null if the input doesn't match any known pattern.
 *
 * @param input - Natural language string, e.g. "every Monday at 9am ET"
 * @param defaultTimezone - IANA timezone to use when none detected; defaults to 'UTC'
 */
export function parseRecurrenceRule(
  input: string,
  defaultTimezone = 'UTC',
): RecurrenceRule | null {
  // Capture IANA timezone from original input (before lowercasing) so we preserve casing
  const originalIanaMatch = input.match(IANA_RE);
  const originalIana = originalIanaMatch ? originalIanaMatch[0] : null;

  const text = normalize(input);
  if (!text) return null;

  // Extract end conditions first, removing them from text
  const { cleaned, startDate, endDate, count } = extractEndConditions(text);

  // Extract time info (pass original IANA if found so it's used verbatim)
  const timeResult = extractTime(cleaned, defaultTimezone, originalIana);
  const timeSpec = timeResult.time;
  const withoutTime = timeResult.remaining;

  // Detect rule type (ordered most-specific → least-specific)
  const core = detectRule(withoutTime, timeSpec);
  if (!core) return null;

  const rule: RecurrenceRule = { rule: core };
  if (startDate) rule.startDate = startDate;
  if (endDate) rule.endDate = endDate;
  if (count != null) rule.count = count;

  return rule;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;!?]+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// End condition extraction
// ---------------------------------------------------------------------------

interface EndConditions {
  cleaned: string;
  startDate?: string;
  endDate?: string;
  count?: number;
}

function extractEndConditions(text: string): EndConditions {
  let cleaned = text;
  let startDate: string | undefined;
  let endDate: string | undefined;
  let count: number | undefined;

  // "starting YYYY-MM-DD" or "starting on YYYY-MM-DD"
  cleaned = cleaned.replace(
    /\bstarting (?:on )?(\d{4}-\d{2}-\d{2})\b/,
    (_, d) => { startDate = d; return ''; },
  );

  // "until YYYY-MM-DD" or "through YYYY-MM-DD"
  cleaned = cleaned.replace(
    /\b(?:until|through|thru|ending|ends?) (?:on )?(\d{4}-\d{2}-\d{2})\b/,
    (_, d) => { endDate = d; return ''; },
  );

  // "for N times" / "for N occurrences" / "N times"
  cleaned = cleaned.replace(
    /\bfor (\d+) (?:times?|occurrences?|repetitions?)\b/,
    (_, n) => { count = parseInt(n, 10); return ''; },
  );
  if (count == null) {
    cleaned = cleaned.replace(
      /\b(\d+) (?:times?|occurrences?)\b/,
      (_, n) => { count = parseInt(n, 10); return ''; },
    );
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return { cleaned, startDate, endDate, count };
}

// ---------------------------------------------------------------------------
// Time extraction
// ---------------------------------------------------------------------------

interface TimeResult {
  time: WallTime;
  remaining: string;
}

function extractTime(text: string, defaultTimezone: string, originalIana?: string | null): TimeResult {
  let remaining = text;
  let hour = 9;
  let minute = 0;
  // Use the original-case IANA string if we found one, else detect from lowercased text
  let timezone = originalIana ?? parseTimezone(text, defaultTimezone);

  // Remove timezone abbreviations/IANA strings from text
  remaining = removeTimezone(remaining, timezone, defaultTimezone);

  // "at noon" / "at midnight"
  const noonMatch = remaining.match(/\bat noon\b/);
  const midnightMatch = remaining.match(/\bat midnight\b/);
  if (noonMatch) {
    hour = 12; minute = 0;
    remaining = remaining.replace(/\bat noon\b/, '').trim();
  } else if (midnightMatch) {
    hour = 0; minute = 0;
    remaining = remaining.replace(/\bat midnight\b/, '').trim();
  } else {
    // "at H:MM am/pm", "at H am/pm", "at HH:MM" (24h)
    const timeRe = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/;
    const m = remaining.match(timeRe);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      const ampm = m[3];
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      hour = h;
      minute = min;
      remaining = remaining.replace(timeRe, '').trim();
    }
  }

  remaining = remaining.replace(/\s+/g, ' ').trim();

  return {
    time: { type: 'wall_time', hour, minute, timezone },
    remaining,
  };
}

// ---------------------------------------------------------------------------
// Timezone parsing
// ---------------------------------------------------------------------------

const TZ_MAP: Record<string, string> = {
  'est': 'America/New_York',
  'edt': 'America/New_York',
  'et': 'America/New_York',
  'eastern': 'America/New_York',
  'eastern time': 'America/New_York',
  'cst': 'America/Chicago',
  'cdt': 'America/Chicago',
  'ct': 'America/Chicago',
  'central': 'America/Chicago',
  'central time': 'America/Chicago',
  'mst': 'America/Denver',
  'mdt': 'America/Denver',
  'mt': 'America/Denver',
  'mountain': 'America/Denver',
  'mountain time': 'America/Denver',
  'pst': 'America/Los_Angeles',
  'pdt': 'America/Los_Angeles',
  'pt': 'America/Los_Angeles',
  'pacific': 'America/Los_Angeles',
  'pacific time': 'America/Los_Angeles',
  'gmt': 'UTC',
  'utc': 'UTC',
  'bst': 'Europe/London',
  'london': 'Europe/London',
  'cet': 'Europe/Paris',
  'cest': 'Europe/Paris',
  'paris': 'Europe/Paris',
  'jst': 'Asia/Tokyo',
  'tokyo': 'Asia/Tokyo',
  'aest': 'Australia/Sydney',
  'aedt': 'Australia/Sydney',
  'sydney': 'Australia/Sydney',
};

// Known IANA timezone pattern
const IANA_RE = /\b(america|europe|asia|australia|africa|pacific|atlantic|indian|arctic|antarctica)\/[\w_]+\b/i;

function parseTimezone(text: string, defaultTz: string): string {
  // Check for IANA timezone first
  const ianaMatch = text.match(IANA_RE);
  if (ianaMatch) return ianaMatch[0];

  // Check multi-word timezone phrases first (longer matches take priority)
  const multiWord = ['eastern time', 'central time', 'mountain time', 'pacific time'];
  for (const phrase of multiWord) {
    if (text.includes(phrase)) {
      return TZ_MAP[phrase]!;
    }
  }

  // Check single-word abbreviations
  // Use word boundary matching
  for (const [abbr, iana] of Object.entries(TZ_MAP)) {
    if (abbr.includes(' ')) continue; // Already handled above
    const re = new RegExp(`\\b${abbr}\\b`, 'i');
    if (re.test(text)) return iana;
  }

  return defaultTz;
}

function removeTimezone(text: string, detectedTz: string, defaultTz: string): string {
  if (detectedTz === defaultTz) return text; // Nothing detected, nothing to remove

  // Remove IANA timezone
  let result = text.replace(IANA_RE, '');

  // Remove timezone phrases (longest first to avoid partial matches)
  const phrases = [
    'eastern time', 'central time', 'mountain time', 'pacific time',
    'eastern', 'central', 'mountain', 'pacific',
    'london', 'paris', 'tokyo', 'sydney',
    'est', 'edt', 'et',
    'cst', 'cdt', 'ct',
    'mst', 'mdt', 'mt',
    'pst', 'pdt', 'pt',
    'gmt', 'utc', 'bst', 'cet', 'cest', 'jst', 'aest', 'aedt',
  ];

  for (const phrase of phrases) {
    const re = new RegExp(`\\b${phrase}\\b`, 'gi');
    result = result.replace(re, '');
  }

  return result.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

function parseInterval(text: string): number {
  // "every other" → 2
  if (/\bevery other\b/.test(text)) return 2;

  // "every N" / "every Nth"
  const m = text.match(/\bevery (\d+)(?:st|nd|rd|th)?\b/);
  if (m) return parseInt(m[1], 10);

  // "each N"
  const m2 = text.match(/\beach (\d+)(?:st|nd|rd|th)?\b/);
  if (m2) return parseInt(m2[1], 10);

  return 1;
}

// ---------------------------------------------------------------------------
// Weekday parsing
// ---------------------------------------------------------------------------

const WEEKDAY_MAP: Record<string, number> = {
  'sunday': 0, 'sun': 0,
  'monday': 1, 'mon': 1,
  'tuesday': 2, 'tue': 2, 'tues': 2,
  'wednesday': 3, 'wed': 3,
  'thursday': 4, 'thu': 4, 'thur': 4, 'thurs': 4,
  'friday': 5, 'fri': 5,
  'saturday': 6, 'sat': 6,
};

function parseWeekdays(text: string): number[] {
  if (/\bweekdays?\b/.test(text) || /\bwork\s*days?\b/.test(text)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(text)) return [0, 6];

  const found: number[] = [];

  // Match full names and abbreviations
  const dayPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/g;
  let m: RegExpExecArray | null;
  while ((m = dayPattern.exec(text)) !== null) {
    const day = WEEKDAY_MAP[m[1]];
    if (day != null && !found.includes(day)) {
      found.push(day);
    }
  }

  return found.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Ordinal (nth) parsing
// ---------------------------------------------------------------------------

function parseNth(text: string): number | null {
  if (/\blast\b/.test(text)) return -1;
  if (/\bfirst\b|\b1st\b/.test(text)) return 1;
  if (/\bsecond\b|\b2nd\b/.test(text)) return 2;
  if (/\bthird\b|\b3rd\b/.test(text)) return 3;
  if (/\bfourth\b|\b4th\b/.test(text)) return 4;
  return null;
}

// ---------------------------------------------------------------------------
// Month name parsing
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, number> = {
  'january': 1, 'jan': 1,
  'february': 2, 'feb': 2,
  'march': 3, 'mar': 3,
  'april': 4, 'apr': 4,
  'may': 5,
  'june': 6, 'jun': 6,
  'july': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'october': 10, 'oct': 10,
  'november': 11, 'nov': 11,
  'december': 12, 'dec': 12,
};

function parseMonthName(text: string): number | null {
  const m = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/);
  if (m) return MONTH_MAP[m[1]] ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Rule detection (ordered most-specific → least-specific)
// ---------------------------------------------------------------------------

function detectRule(text: string, time: WallTime): RecurrenceRuleCore | null {
  // quarterly_last_weekday — "last [weekday] of each/every quarter"
  if (/\bquarter(?:ly)?\b/.test(text)) {
    if (/\blast\b/.test(text)) {
      const days = parseWeekdays(text);
      const weekday = days.length > 0 ? days[0] : 5; // default Friday
      return { type: 'quarterly_last_weekday', weekday, time };
    }
  }

  // monthly_last_business_day — "last business day" / "last weekday of the month"
  if (
    /\blast\s+business\s+day\b/.test(text) ||
    /\blast\s+weekday\s+of\s+(?:the\s+)?month\b/.test(text)
  ) {
    const interval = parseInterval(text);
    return { type: 'monthly_last_business_day', interval, time };
  }

  // yearly_nth_weekday — "[nth] [weekday] of [month] every year" / "annually"
  if (/\b(?:year(?:ly)?|annually|each year|every year)\b/.test(text)) {
    const month = parseMonthName(text);
    const nth = parseNth(text);
    const days = parseWeekdays(text);
    if (month != null && nth != null && days.length > 0) {
      return { type: 'yearly_nth_weekday', month, nth, weekday: days[0], time };
    }
    if (month != null) {
      // yearly_on_month_day
      const domMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
      const dayOfMonth = domMatch ? parseInt(domMatch[1], 10) : 1;
      return { type: 'yearly_on_month_day', month, dayOfMonth, time };
    }
    // No month specified — can't determine a yearly rule
    return null;
  }

  // monthly_nth_weekday — "[nth/last] [weekday] of (each|every) month"
  if (/\b(?:month(?:ly)?|each month|every month)\b/.test(text)) {
    const nth = parseNth(text);
    const days = parseWeekdays(text);
    if (nth != null && days.length > 0) {
      const interval = parseInterval(text);
      return { type: 'monthly_nth_weekday', nth, weekday: days[0], interval, time };
    }

    // monthly_last_business_day (also catches "last business day of each month")
    if (/\blast\s+business\s+day\b/.test(text)) {
      const interval = parseInterval(text);
      return { type: 'monthly_last_business_day', interval, time };
    }

    // monthly_on_day — "every month on the Nth" / "Nth of each month"
    const domMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (domMatch) {
      const dayOfMonth = parseInt(domMatch[1], 10);
      const interval = parseInterval(text);
      return { type: 'monthly_on_day', dayOfMonth, interval, time };
    }

    // Monthly with no further spec — default to 1st of month
    return { type: 'monthly_on_day', dayOfMonth: 1, interval: 1, time };
  }

  // monthly_on_day — "Nth of each month" patterns without explicit "monthly"
  const nthOfMonth = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:each|every|the)\s+month\b/);
  if (nthOfMonth) {
    const dayOfMonth = parseInt(nthOfMonth[1], 10);
    return { type: 'monthly_on_day', dayOfMonth, interval: 1, time };
  }

  // weekly — "every [weekday list]" / "weekdays" / "weekends" / "every N weeks on ..."
  if (
    /\bweek(?:ly)?\b/.test(text) ||
    /\bweekdays?\b/.test(text) ||
    /\bweekends?\b/.test(text) ||
    /\bwork\s*days?\b/.test(text)
  ) {
    const days = parseWeekdays(text);
    const daysOfWeek = days.length > 0 ? days : [1]; // default Monday
    const interval = parseInterval(text);
    return { type: 'weekly', daysOfWeek, interval, time };
  }

  // Check for weekday names without explicit "weekly" keyword
  const namedDays = parseWeekdays(text);
  if (namedDays.length > 0) {
    const interval = parseInterval(text);
    return { type: 'weekly', daysOfWeek: namedDays, interval, time };
  }

  // daily — "every day" / "daily" / "every N days"
  if (/\b(?:daily|every day|each day|every \d+ days?)\b/.test(text) || /\bdays?\b/.test(text)) {
    const interval = parseInterval(text);
    return { type: 'daily', interval, time };
  }

  // If text contains "every" or "each" but nothing else matched, try daily
  if (/\b(?:every|each)\b/.test(text)) {
    const interval = parseInterval(text);
    return { type: 'daily', interval, time };
  }

  return null;
}
