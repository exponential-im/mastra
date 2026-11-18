/**
 * Putting a calendar event on the person's clock.
 *
 * create-calendar-event used to take "ISO 8601" and convert whatever arrived
 * to UTC. A model asked for "8:30" sent `08:30:00Z`, so a person in Berlin got
 * 09:30. It also had no way to make an event repeat, and told the model
 * nothing about what it had really created, so "Monday 18 November" (a
 * Wednesday) was reported back as done.
 *
 * The rules here:
 *  - a time with no offset is the person's wall-clock time in their zone;
 *  - a time with no offset and no known zone is an error, never UTC;
 *  - a repeating event is ONE event with a rule, starting on its first real
 *    occurrence;
 *  - the tool answers with the weekday, date, time and zone it created.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields of an instant in a zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which a zone's clock shows these wall-clock fields. */
export function wallTimeToInstant(parts: LocalParts, timeZone: string): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // Two passes: the offset at the first guess can differ from the offset at
  // the answer on the day the clocks change.
  let instant = new Date(asUtc - offsetMs(new Date(asUtc), timeZone));
  instant = new Date(asUtc - offsetMs(instant, timeZone));
  return instant;
}

/**
 * Read a start or end time the model supplied.
 *
 * With an offset or `Z` it is that instant. Without one it is wall-clock time
 * in `timeZone`. Without one and without a zone it is refused: assuming UTC is
 * the bug this module exists to remove.
 */
export function resolveEventInstant(value: string, timeZone: string | undefined, field: string): Date {
  const s = value.trim();
  if (HAS_OFFSET.test(s)) {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Could not read ${field} "${value}". Use local time like "2026-11-18T08:30:00".`);
    }
    return parsed;
  }
  const match = WALL_TIME.exec(s);
  if (!match) {
    throw new Error(
      `Could not read ${field} "${value}". Give the date and the time as local wall-clock time, e.g. "2026-11-18T08:30:00".`,
    );
  }
  if (!timeZone) {
    throw new Error(
      `${field} "${value}" has no time zone and the user's zone is not known. Ask the user for their time zone, once, and pass it as timeZone (an IANA name such as "Europe/Berlin"). Offer to save it with set-my-time-zone so you need not ask again; without that tool, point them to Settings → Profile.`,
    );
  }
  const [, y, mo, d, h, mi, sec] = match;
  return wallTimeToInstant(
    { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(sec ?? 0) },
    timeZone,
  );
}

/** "MO" … "SU" for an instant in a zone. */
export function weekdayOf(instant: Date, timeZone: string): Weekday {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
  return ({ Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA", Sun: "SU" } as const)[
    short as "Mon"
  ];
}

/**
 * Move a start (and its end) forward, whole local days at a time, to the first
 * day in `days`. A calendar treats the start as the first occurrence even when
 * it is not on one of the rule's days, which leaves a stray extra event.
 */
export function alignToFirstOccurrence(
  start: Date,
  end: Date,
  timeZone: string,
  days: readonly Weekday[],
): { start: Date; end: Date; movedDays: number } {
  const duration = end.getTime() - start.getTime();
  const base = localParts(start, timeZone);
  for (let n = 0; n < 7; n++) {
    // Date.UTC normalises day overflow (31 + 1 → the 1st of next month).
    const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + n));
    const candidate = wallTimeToInstant(
      {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: base.hour,
        minute: base.minute,
        second: base.second,
      },
      timeZone,
    );
    if (days.includes(weekdayOf(candidate, timeZone))) {
      return { start: candidate, end: new Date(candidate.getTime() + duration), movedDays: n };
    }
  }
  return { start, end, movedDays: 0 };
}

export interface WeeklyRecurrence {
  daysOfWeek: readonly Weekday[];
  /** Last day it may occur, "YYYY-MM-DD". */
  until?: string;
  /** Or a number of occurrences. */
  count?: number;
}

/** "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR". Days in week order, no duplicates. */
export function weeklyRule(recurrence: WeeklyRecurrence): string {
  const days = WEEKDAYS.filter((d) => recurrence.daysOfWeek.includes(d));
  if (days.length === 0) throw new Error("recurrence.daysOfWeek needs at least one day (MO, TU, WE, TH, FR, SA, SU).");
  let rule = `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}`;
  if (recurrence.until) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(recurrence.until.trim());
    if (!match) throw new Error(`recurrence.until "${recurrence.until}" must be a date like "2026-12-31".`);
    rule += `;UNTIL=${match[1]}${match[2]}${match[3]}T235959Z`;
  } else if (recurrence.count && recurrence.count > 0) {
    rule += `;COUNT=${Math.floor(recurrence.count)}`;
  }
  return rule;
}

const DAY_NAMES: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

/** "every Monday, Wednesday and Friday". */
export function describeRecurrence(recurrence: WeeklyRecurrence): string {
  const names = WEEKDAYS.filter((d) => recurrence.daysOfWeek.includes(d)).map((d) => DAY_NAMES[d]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const ending = recurrence.until
    ? ` until ${recurrence.until}`
    : recurrence.count
      ? `, ${Math.floor(recurrence.count)} times`
      : "";
  return `every ${list}${ending}`;
}

/** "Wednesday 18 November 2026, 08:30 (Europe/Berlin)". What the model reports back. */
export function describeInstant(instant: Date, timeZone: string | undefined): string {
  const zone = timeZone ?? "UTC";
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(instant)
    .replace(",", "");
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    instant,
  );
  return `${date}, ${time} (${zone})`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The start and end instants of a work day on a zone's clock.
 *
 * find-available-time-slots used `new Date(date).setHours(9)`, which is 9:00
 * on the server's clock. On a UTC server a Berlin user's 9 to 17 was 10:00 to
 * 18:00 Berlin time. Each end is placed with its own offset, so a day on which
 * the clocks change is still 9 to 17 on the wall.
 */
export function workDayWindow(
  date: string,
  startHour: number,
  endHour: number,
  timeZone: string,
): { start: Date; end: Date } {
  const match = DATE_ONLY.exec(date.trim());
  if (!match) {
    throw new Error(`Could not read date "${date}". Use YYYY-MM-DD, e.g. "2026-11-20".`);
  }
  if (endHour <= startHour) {
    throw new Error(`endHour (${endHour}) must be after startHour (${startHour}).`);
  }
  const [, y, mo, d] = match;
  const day = { year: Number(y), month: Number(mo), day: Number(d), minute: 0, second: 0 };
  return {
    start: wallTimeToInstant({ ...day, hour: startHour }, timeZone),
    end: wallTimeToInstant({ ...day, hour: endHour }, timeZone),
  };
}
