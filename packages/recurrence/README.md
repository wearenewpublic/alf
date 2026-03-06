# @newpublic/recurrence

Recurrence rule engine for ALF scheduled posts. Handles computing next occurrence dates, parsing plain-English schedule descriptions, and formatting rules back into readable strings.

## API

### `computeNextOccurrence(rule, after)`

Returns the next `Date` on or after `after` that matches the rule, or `null` if the rule has expired (past `endDate` or exhausted `count`).

```typescript
import { computeNextOccurrence } from '@newpublic/recurrence';

const next = computeNextOccurrence(rule, new Date());
```

### `parseRecurrenceRule(input, defaultTimezone?)`

Parses a plain-English string into a `RecurrenceRule`. Returns `null` if the input doesn't match a known pattern.

```typescript
import { parseRecurrenceRule } from '@newpublic/recurrence';

parseRecurrenceRule('every Monday and Friday at 9am ET');
// → { rule: { type: 'weekly', daysOfWeek: [1, 5], time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/New_York' } } }

parseRecurrenceRule('last business day of each month at 5pm UTC');
// → { rule: { type: 'monthly_last_business_day', time: { ... } } }

parseRecurrenceRule('gibberish'); // → null
```

`defaultTimezone` is an IANA timezone string used when the input contains no timezone. Defaults to `'UTC'`.

**Supported phrasings (examples):**

| Rule type | Example inputs |
|-----------|---------------|
| `daily` | "every day at 9am", "daily at noon", "every 3 days at 8am" |
| `weekly` | "every Monday", "every Monday and Friday at 9am ET", "weekdays at 9am", "weekends at noon", "every 2 weeks on Tuesday" |
| `monthly_on_day` | "every month on the 15th", "1st of each month at noon", "monthly on the 28th" |
| `monthly_nth_weekday` | "first Monday of each month", "last Friday of every month", "3rd Wednesday of each month" |
| `monthly_last_business_day` | "last business day", "last business day of each month", "last weekday of the month" |
| `quarterly_last_weekday` | "last Friday of each quarter", "quarterly last Thursday at 10am" |
| `yearly_on_month_day` | "every year on January 1st", "March 15th each year", "annually on July 4th" |
| `yearly_nth_weekday` | "last Friday of December every year", "first Monday of March yearly" |

**End conditions** can be appended to any phrase:
- `"every Monday at 9am for 10 times"` → `count: 10`
- `"every day at noon until 2026-12-31"` → `endDate: '2026-12-31'`
- `"every week on Friday starting 2026-04-01"` → `startDate: '2026-04-01'`

**Timezone recognition:** common abbreviations (`ET`, `CT`, `MT`, `PT`, `UTC`, `GMT`, `BST`, `CET`, `JST`, `AEST`) and raw IANA strings (`America/New_York`) are detected in the input text.

### `formatRecurrenceRule(rule)`

Formats a `RecurrenceRule` as a human-readable English string.

```typescript
import { formatRecurrenceRule } from '@newpublic/recurrence';

formatRecurrenceRule({ rule: { type: 'weekly', daysOfWeek: [1, 5], time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'America/New_York' } } });
// → "every Monday and Friday at 9am (ET)"

formatRecurrenceRule({ rule: { type: 'monthly_last_business_day', time: { type: 'wall_time', hour: 17, minute: 0, timezone: 'UTC' } } });
// → "last business day of every month at 5pm (UTC)"
```

Known IANA timezones are displayed as short labels (`ET`, `CT`, `MT`, `PT`, `JST`, etc.). Unknown IANA strings are shown verbatim. `fixed_instant` offsets are formatted as `UTC±N`.

## Rule types

See [`src/types.ts`](src/types.ts) for the full TypeScript type definitions, or the [ALF API reference](../../docs/api.md#recurrencerule-object) for a narrative description of all rule types with examples.
