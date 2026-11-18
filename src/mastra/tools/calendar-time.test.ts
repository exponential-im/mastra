import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

import { createCalendarEventTool } from './index.js';
import {
  alignToFirstOccurrence,
  describeInstant,
  describeRecurrence,
  resolveEventInstant,
  weekdayOf,
  weeklyRule,
} from './calendar-time.js';
import { todayLine } from '../agents/today-line.js';

const BERLIN = 'Europe/Berlin';

describe('resolveEventInstant', () => {
  it("reads a time with no offset on the person's clock, not UTC", () => {
    // The report: 8:30 in Berlin was booked as 08:30Z, which is 09:30 there.
    expect(resolveEventInstant('2026-11-18T08:30:00', BERLIN, 'startDateTime').toISOString()).toBe(
      '2026-11-18T07:30:00.000Z',
    );
  });

  it('follows daylight saving, including the day the clocks change', () => {
    expect(resolveEventInstant('2026-07-01T08:30:00', BERLIN, 's').toISOString()).toBe('2026-07-01T06:30:00.000Z');
    // Clocks go back at 03:00 on 25 October 2026.
    expect(resolveEventInstant('2026-10-25T08:30:00', BERLIN, 's').toISOString()).toBe('2026-10-25T07:30:00.000Z');
    expect(resolveEventInstant('2026-10-24T08:30:00', BERLIN, 's').toISOString()).toBe('2026-10-24T06:30:00.000Z');
  });

  it('keeps an explicit offset or Z as the instant it names', () => {
    expect(resolveEventInstant('2026-11-18T08:30:00+01:00', undefined, 's').toISOString()).toBe(
      '2026-11-18T07:30:00.000Z',
    );
    expect(resolveEventInstant('2026-11-18T08:30:00Z', BERLIN, 's').toISOString()).toBe('2026-11-18T08:30:00.000Z');
  });

  it('refuses a wall-clock time when no zone is known, instead of assuming UTC', () => {
    expect(() => resolveEventInstant('2026-11-18T08:30:00', undefined, 'startDateTime')).toThrow(
      /no time zone.*Ask the user/,
    );
  });

  it('refuses a date with no time and anything unreadable', () => {
    expect(() => resolveEventInstant('2026-11-18', BERLIN, 'startDateTime')).toThrow(/date and the time/);
    expect(() => resolveEventInstant('half eight', BERLIN, 'startDateTime')).toThrow(/Could not read/);
  });
});

describe('weekdays and recurrence', () => {
  it('knows 18 November 2026 is a Wednesday', () => {
    expect(weekdayOf(new Date('2026-11-18T07:30:00Z'), BERLIN)).toBe('WE');
    // 23:30 UTC on Wednesday is already Thursday in Berlin.
    expect(weekdayOf(new Date('2026-11-18T23:30:00Z'), BERLIN)).toBe('TH');
  });

  it('builds one weekly rule, days in week order', () => {
    expect(weeklyRule({ daysOfWeek: ['FR', 'MO', 'WE', 'MO'] })).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(weeklyRule({ daysOfWeek: ['MO'], until: '2026-12-31' })).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z',
    );
    expect(weeklyRule({ daysOfWeek: ['MO'], count: 6 })).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6');
    expect(() => weeklyRule({ daysOfWeek: [] })).toThrow(/at least one day/);
  });

  it('moves the start to the first real occurrence, keeping the wall-clock time', () => {
    // Asked on a Tuesday for Mon/Wed/Fri: the first occurrence is Wednesday.
    const start = resolveEventInstant('2026-11-17T08:30:00', BERLIN, 's');
    const end = resolveEventInstant('2026-11-17T08:50:00', BERLIN, 'e');
    const aligned = alignToFirstOccurrence(start, end, BERLIN, ['MO', 'WE', 'FR']);
    expect(aligned.movedDays).toBe(1);
    expect(describeInstant(aligned.start, BERLIN)).toBe('Wednesday 18 November 2026, 08:30 (Europe/Berlin)');
    expect(aligned.end.getTime() - aligned.start.getTime()).toBe(20 * 60 * 1000);
  });

  it('keeps 08:30 on the clock when the move crosses a daylight-saving change', () => {
    // Saturday 24 Oct (summer time) to Monday 26 Oct (winter time).
    const start = resolveEventInstant('2026-10-24T08:30:00', BERLIN, 's');
    const end = resolveEventInstant('2026-10-24T08:50:00', BERLIN, 'e');
    const aligned = alignToFirstOccurrence(start, end, BERLIN, ['MO']);
    expect(describeInstant(aligned.start, BERLIN)).toBe('Monday 26 October 2026, 08:30 (Europe/Berlin)');
  });

  it('describes a rule in words', () => {
    expect(describeRecurrence({ daysOfWeek: ['MO', 'WE', 'FR'] })).toBe('every Monday, Wednesday and Friday');
    expect(describeRecurrence({ daysOfWeek: ['TU'], count: 4 })).toBe('every Tuesday, 4 times');
  });
});

describe('todayLine', () => {
  it('states the weekday for today and the days after it', () => {
    const line = todayLine(new Date('2026-11-18T10:00:00Z'));
    expect(line).toContain('Today is Wednesday, 2026-11-18 (UTC).');
    expect(line).toContain('Thu 2026-11-19, Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23');
  });
});

describe('create-calendar-event', () => {
  const context = (entries: Record<string, string> = {}) =>
    ({
      requestContext: new Map(Object.entries({ authToken: 't', userId: 'u', timezone: BERLIN, ...entries })),
    }) as never;

  beforeEach(() => {
    authenticatedTrpcCall.mockReset();
    authenticatedTrpcCall.mockResolvedValue({
      data: { event: { id: 'e1', summary: 'German speaking practice', htmlLink: 'https://cal/e1' }, provider: 'google' },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T10:05:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const base = {
    summary: 'German speaking practice',
    provider: 'google' as const,
    userConfirmed: true,
  };

  it("creates ONE repeating event at 08:30 on the person's clock, and says what it made", async () => {
    const result = (await createCalendarEventTool.execute!(
      {
        ...base,
        startDateTime: '2026-11-18T08:30:00',
        endDateTime: '2026-11-18T08:50:00',
        recurrence: { daysOfWeek: ['MO', 'WE', 'FR'] },
      },
      context(),
    )) as Record<string, unknown>;

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = authenticatedTrpcCall.mock.calls[0]!;
    expect(endpoint).toBe('mastra.createCalendarEvent');
    expect(payload).toMatchObject({
      start: { dateTime: '2026-11-18T07:30:00.000Z', timeZone: BERLIN },
      end: { dateTime: '2026-11-18T07:50:00.000Z', timeZone: BERLIN },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    });
    expect(result.startsAt).toBe('Wednesday 18 November 2026, 08:30 (Europe/Berlin)');
    expect(result.repeats).toBe('every Monday, Wednesday and Friday');
    // 08:30 had already passed at 11:05 local: the model is told, not left to find out.
    expect(String(result.warning)).toMatch(/starts in the past/);
  });

  it('a zone the model names wins over the person\'s own', async () => {
    await createCalendarEventTool.execute!(
      { ...base, startDateTime: '2026-11-20T09:00:00', endDateTime: '2026-11-20T09:30:00', timeZone: 'America/New_York' },
      context(),
    );
    expect(authenticatedTrpcCall.mock.calls[0]![1]).toMatchObject({
      start: { dateTime: '2026-11-20T14:00:00.000Z', timeZone: 'America/New_York' },
    });
  });

  it('with no zone anywhere, asks instead of booking in UTC', async () => {
    const ctx = { requestContext: new Map(Object.entries({ authToken: 't', userId: 'u' })) } as never;
    await expect(
      createCalendarEventTool.execute!(
        { ...base, startDateTime: '2026-11-20T08:30:00', endDateTime: '2026-11-20T08:50:00' },
        ctx,
      ),
    ).rejects.toThrow(/no time zone/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });

  it('a future single event carries no warning and no recurrence', async () => {
    const result = (await createCalendarEventTool.execute!(
      { ...base, startDateTime: '2026-11-20T08:30:00', endDateTime: '2026-11-20T08:50:00' },
      context(),
    )) as Record<string, unknown>;
    expect(result.warning).toBeUndefined();
    expect(result.repeats).toBeUndefined();
    expect(authenticatedTrpcCall.mock.calls[0]![1]).not.toHaveProperty('recurrence');
    expect(result.startsAt).toBe('Friday 20 November 2026, 08:30 (Europe/Berlin)');
  });

  it('rejects an end that is not after the start, and an unknown zone', async () => {
    await expect(
      createCalendarEventTool.execute!(
        { ...base, startDateTime: '2026-11-20T08:30:00', endDateTime: '2026-11-20T08:30:00' },
        context(),
      ),
    ).rejects.toThrow(/must be after/);
    await expect(
      createCalendarEventTool.execute!(
        { ...base, startDateTime: '2026-11-20T08:30:00', endDateTime: '2026-11-20T08:50:00', timeZone: 'CET-ish' },
        context(),
      ),
    ).rejects.toThrow(/not a time zone/);
  });
});
