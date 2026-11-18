import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// find-available-time-slots built the work day with the server's setHours, so
// on a UTC server a Berlin user's 9 to 17 was 10:00 to 18:00 Berlin time and
// every proposed slot was an hour off. These tests run the tool on a server
// clock that is not the user's and check the window it asks the app for.
const trpcQuery = vi.fn();
const trpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcQuery: (...args: unknown[]) => trpcQuery(...args),
  authenticatedTrpcCall: (...args: unknown[]) => trpcCall(...args),
}));

const { findAvailableTimeSlotsTool } = await import('./index.js');
const { workDayWindow } = await import('./calendar-time.js');

const BERLIN = 'Europe/Berlin';

type Ctx = Map<string, string>;
const turn = (values: Record<string, string> = {}): Ctx =>
  new Map(Object.entries({ authToken: 't', userId: 'u1', ...values }));

interface SlotResult {
  availableSlots: Array<{ start: string; end: string; durationMinutes: number; startsAt?: string; endsAt?: string }>;
  busySlots: Array<{ start: string; end: string; summary: string; startsAt?: string; endsAt?: string }>;
  timeZone?: string;
  workDay?: string;
  error?: string;
}
const run = (input: Record<string, unknown>, ctx: Ctx) =>
  findAvailableTimeSlotsTool.execute!(input as never, { requestContext: ctx } as never) as Promise<SlotResult>;

/** The window the tool asked the app for. */
const requestedWindow = () => {
  const [procedure, input] = trpcCall.mock.calls[0]!;
  expect(procedure).toBe('mastra.getCalendarEventsInRange');
  return input as { timeMin: string; timeMax: string };
};

// Node re-reads TZ when it is assigned, so this sets the server clock.
const serverZone = process.env.TZ;
const setServerZone = (zone: string | undefined) => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
};

beforeAll(() => setServerZone('UTC'));
afterAll(() => setServerZone(serverZone));

beforeEach(() => {
  trpcQuery.mockReset();
  trpcCall.mockReset();
  trpcCall.mockResolvedValue({ data: { events: [] } });
});

describe('workDayWindow', () => {
  it("places 9 to 17 on the zone's clock, not the server's", () => {
    expect(new Date(2026, 10, 20, 9).toISOString()).toBe('2026-11-20T09:00:00.000Z'); // the server clock is UTC
    const { start, end } = workDayWindow('2026-11-20', 9, 17, BERLIN);
    // Berlin in November is UTC+1.
    expect(start.toISOString()).toBe('2026-11-20T08:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-20T16:00:00.000Z');
  });

  it('follows the clock change on the day it happens', () => {
    // Clocks go forward at 02:00 on 29 March 2026: 9:00 is already CEST (UTC+2).
    expect(workDayWindow('2026-03-29', 9, 17, BERLIN).start.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    // Clocks go back at 03:00 on 25 October 2026: 9:00 is CET (UTC+1).
    expect(workDayWindow('2026-10-25', 9, 17, BERLIN).start.toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('gives each end its own offset when the window spans the change', () => {
    // 01:00 to 05:00 on the wall is 3 real hours in spring and 5 in autumn.
    const spring = workDayWindow('2026-03-29', 1, 5, BERLIN);
    expect(spring.start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T03:00:00.000Z');
    const autumn = workDayWindow('2026-10-25', 1, 5, BERLIN);
    expect(autumn.start.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(autumn.end.toISOString()).toBe('2026-10-25T04:00:00.000Z');
  });

  it('refuses a date it cannot read and an empty day', () => {
    expect(() => workDayWindow('20 November', 9, 17, BERLIN)).toThrow(/YYYY-MM-DD/);
    expect(() => workDayWindow('2026-11-20', 17, 9, BERLIN)).toThrow(/endHour/);
  });
});

describe('find-available-time-slots on a UTC server for a Berlin user', () => {
  it('asks the app for 9 to 17 Berlin time and describes slots in Berlin time', async () => {
    const result = await run(
      { date: '2026-11-20', startHour: 9, endHour: 17, slotDurationMinutes: 30 },
      turn({ timezone: BERLIN }),
    );

    expect(requestedWindow()).toEqual({ timeMin: '2026-11-20T08:00:00.000Z', timeMax: '2026-11-20T16:00:00.000Z' });
    expect(result.timeZone).toBe(BERLIN);
    expect(result.workDay).toBe(
      'Friday 20 November 2026, 09:00 (Europe/Berlin) to Friday 20 November 2026, 17:00 (Europe/Berlin)',
    );
    expect(result.availableSlots).toEqual([
      {
        start: '2026-11-20T08:00:00.000Z',
        end: '2026-11-20T16:00:00.000Z',
        durationMinutes: 480,
        startsAt: 'Friday 20 November 2026, 09:00 (Europe/Berlin)',
        endsAt: 'Friday 20 November 2026, 17:00 (Europe/Berlin)',
      },
    ]);
  });

  it('finds the gaps around meetings on the Berlin clock', async () => {
    trpcCall.mockResolvedValue({
      data: {
        events: [
          {
            summary: 'Standup',
            start: { dateTime: '2026-11-20T10:00:00+01:00' },
            end: { dateTime: '2026-11-20T10:30:00+01:00' },
          },
          { summary: 'All-day offsite', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } },
        ],
      },
    });

    const result = await run({ date: '2026-11-20', startHour: 9, endHour: 12 }, turn({ timezone: BERLIN }));

    expect(result.busySlots).toEqual([
      {
        start: '2026-11-20T10:00:00+01:00',
        end: '2026-11-20T10:30:00+01:00',
        summary: 'Standup',
        startsAt: 'Friday 20 November 2026, 10:00 (Europe/Berlin)',
        endsAt: 'Friday 20 November 2026, 10:30 (Europe/Berlin)',
      },
    ]);
    expect(result.availableSlots.map((s) => [s.startsAt, s.endsAt, s.durationMinutes])).toEqual([
      ['Friday 20 November 2026, 09:00 (Europe/Berlin)', 'Friday 20 November 2026, 10:00 (Europe/Berlin)', 60],
      ['Friday 20 November 2026, 10:30 (Europe/Berlin)', 'Friday 20 November 2026, 12:00 (Europe/Berlin)', 90],
    ]);
  });

  it('uses the zone saved in the profile when the surface sent none (Slack, WhatsApp)', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: BERLIN } });

    await run({ date: '2026-11-20' }, turn({ whatsappSession: 's1' }));

    expect(trpcQuery).toHaveBeenCalledWith('user.getTimezone', { authToken: 't', sessionId: 's1', userId: 'u1' });
    expect(requestedWindow()).toEqual({ timeMin: '2026-11-20T08:00:00.000Z', timeMax: '2026-11-20T16:00:00.000Z' });
  });

  it('uses a zone the model names over the user\'s own', async () => {
    await run({ date: '2026-11-20', timeZone: 'America/New_York' }, turn({ timezone: BERLIN }));
    // New York in November is UTC-5.
    expect(requestedWindow()).toEqual({ timeMin: '2026-11-20T14:00:00.000Z', timeMax: '2026-11-20T22:00:00.000Z' });
  });

  it('refuses a zone it does not know', async () => {
    await expect(run({ date: '2026-11-20', timeZone: 'Berlin' }, turn())).rejects.toThrow(/not a time zone/);
    expect(trpcCall).not.toHaveBeenCalled();
  });

  it('keeps 9 to 17 on the wall on the day the clocks go forward', async () => {
    await run({ date: '2026-03-29' }, turn({ timezone: BERLIN }));
    expect(requestedWindow()).toEqual({ timeMin: '2026-03-29T07:00:00.000Z', timeMax: '2026-03-29T15:00:00.000Z' });
  });

  it('gives the same window whatever the server clock is', async () => {
    setServerZone('America/Los_Angeles');
    try {
      await run({ date: '2026-11-20' }, turn({ timezone: BERLIN }));
      expect(requestedWindow()).toEqual({ timeMin: '2026-11-20T08:00:00.000Z', timeMax: '2026-11-20T16:00:00.000Z' });
    } finally {
      setServerZone('UTC');
    }
  });
});

describe('find-available-time-slots with no zone', () => {
  it('asks the user for their zone instead of assuming UTC', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: null } });

    const result = await run({ date: '2026-11-20' }, turn());

    expect(trpcCall).not.toHaveBeenCalled();
    expect(result.availableSlots).toEqual([]);
    expect(result.error).toMatch(/^Not checked/);
    expect(result.error).toMatch(/Ask the user for their time zone/);
    expect(result.error).toMatch(/set-my-time-zone/);
  });

  it('says the saved zone could not be read when the profile read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    trpcQuery.mockRejectedValue(new Error('down'));

    const result = await run({ date: '2026-11-20' }, turn());

    expect(trpcCall).not.toHaveBeenCalled();
    expect(result.error).toMatch(/could not be read/);
    warn.mockRestore();
  });
});
