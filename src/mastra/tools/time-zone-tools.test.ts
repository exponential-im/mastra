import { beforeEach, describe, expect, it, vi } from 'vitest';

// The app transport is replaced: these tests check which zone wins and what is
// sent, not the network.
const trpcQuery = vi.fn();
const trpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcQuery: (...args: unknown[]) => trpcQuery(...args),
  authenticatedTrpcCall: (...args: unknown[]) => trpcCall(...args),
}));

const { resolveUserTimeZone, getMyTimeZoneTool, setMyTimeZoneTool } = await import('./time-zone-tools.js');
const { createCalendarEventTool } = await import('./index.js');

type Ctx = Map<string, string>;
const turn = (values: Record<string, string> = {}): Ctx =>
  new Map(Object.entries({ authToken: 't', userId: 'u1', ...values }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: { execute?: (...a: any[]) => unknown }, input: unknown, ctx: Ctx) =>
  tool.execute!(input as never, { requestContext: ctx } as never);

beforeEach(() => {
  trpcQuery.mockReset();
  trpcCall.mockReset();
});

describe('resolveUserTimeZone: chat, then saved profile, then none', () => {
  it('uses the zone the chat sent and reads nothing', async () => {
    expect(await resolveUserTimeZone(turn({ timezone: 'Europe/Berlin' }) as never)).toEqual({
      zone: 'Europe/Berlin',
      source: 'chat',
    });
    expect(trpcQuery).not.toHaveBeenCalled();
  });

  it('reads the saved zone when the surface sent none (Slack, WhatsApp, API), once per turn', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: 'Europe/Berlin' } });
    const ctx = turn({ whatsappSession: 's1' });
    expect(await resolveUserTimeZone(ctx as never)).toEqual({ zone: 'Europe/Berlin', source: 'profile' });
    expect(await resolveUserTimeZone(ctx as never)).toEqual({ zone: 'Europe/Berlin', source: 'profile' });
    expect(trpcQuery).toHaveBeenCalledTimes(1);
    expect(trpcQuery).toHaveBeenCalledWith('user.getTimezone', { authToken: 't', sessionId: 's1', userId: 'u1' });
  });

  it('returns no zone, not UTC, when nothing is saved', async () => {
    trpcQuery.mockResolvedValueOnce({ data: { timezone: null } });
    expect(await resolveUserTimeZone(turn() as never)).toEqual({ zone: null, source: null });
  });

  it('marks a failed read as unreadable, not as nothing saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    trpcQuery.mockRejectedValueOnce(new Error('down'));
    expect(await resolveUserTimeZone(turn() as never)).toEqual({ zone: null, source: null, unreadable: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('create-calendar-event on a surface with no chat zone', () => {
  const eightThirty = {
    summary: 'German speaking practice',
    startDateTime: '2026-11-20T08:30:00',
    endDateTime: '2026-11-20T08:50:00',
    provider: 'google',
    userConfirmed: true,
  };

  it('books 8:30 on the saved zone clock with no question asked', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: 'Europe/Berlin' } });
    trpcCall.mockResolvedValue({ data: { event: { id: 'e1', summary: 's', htmlLink: 'h' }, provider: 'google' } });

    await run(createCalendarEventTool, eightThirty, turn({ whatsappSession: 's1' }));

    const [procedure, input] = trpcCall.mock.calls[0]!;
    expect(procedure).toBe('mastra.createCalendarEvent');
    // 08:30 in Berlin in November (UTC+1) is 07:30 UTC.
    expect(input.start).toEqual({ dateTime: '2026-11-20T07:30:00.000Z', timeZone: 'Europe/Berlin' });
  });

  it('prefers the zone the chat sent over the saved one', async () => {
    trpcCall.mockResolvedValue({ data: { event: { id: 'e1', summary: 's', htmlLink: 'h' }, provider: 'google' } });

    await run(createCalendarEventTool, eightThirty, turn({ timezone: 'Europe/Lisbon' }));

    expect(trpcQuery).not.toHaveBeenCalled();
    expect(trpcCall.mock.calls[0]![1].start).toEqual({ dateTime: '2026-11-20T08:30:00.000Z', timeZone: 'Europe/Lisbon' });
  });

  it('with no zone anywhere, refuses and tells the agent to ask', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: null } });

    await expect(run(createCalendarEventTool, eightThirty, turn())).rejects.toThrow(/Ask the user for their time zone/);
    expect(trpcCall).not.toHaveBeenCalled();
  });
});

describe('get-my-time-zone', () => {
  it('says the saved zone and the local time', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: 'Europe/Berlin' } });
    const out = (await run(getMyTimeZoneTool, {}, turn())) as Record<string, string>;
    expect(out.timeZone).toBe('Europe/Berlin');
    expect(out.source).toBe('profile');
    expect(out.localNow).toMatch(/\(Europe\/Berlin\)$/);
    expect(out.instruction).toContain('Settings → Profile');
  });

  it('throws when the saved zone cannot be read, so the failure is visible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    trpcQuery.mockRejectedValue(new Error('500'));
    await expect(run(getMyTimeZoneTool, {}, turn())).rejects.toThrow(/Could not read the user's saved time zone/);
    warn.mockRestore();
  });

  it('with no zone, tells the agent to ask', async () => {
    trpcQuery.mockResolvedValue({ data: { timezone: null } });
    const out = (await run(getMyTimeZoneTool, {}, turn())) as Record<string, string | null>;
    expect(out.timeZone).toBeNull();
    expect(out.instruction).toContain('Ask which time zone they are in');
  });
});

describe('set-my-time-zone', () => {
  it('saves only after confirmation', async () => {
    const out = (await run(setMyTimeZoneTool, { timeZone: 'Europe/Lisbon', userConfirmed: false }, turn())) as Record<string, string>;
    expect(out.error).toMatch(/confirmation/);
    expect(trpcCall).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a zone', async () => {
    const out = (await run(setMyTimeZoneTool, { timeZone: 'Lisbon', userConfirmed: true }, turn())) as Record<string, string>;
    expect(out.error).toMatch(/not a time zone/);
    expect(trpcCall).not.toHaveBeenCalled();
  });

  it('saves the zone and uses it for the rest of the turn', async () => {
    trpcCall.mockResolvedValue({ data: { success: true, timezone: 'Europe/Lisbon' } });
    const ctx = turn({ timezone: 'Europe/Berlin' });
    const out = (await run(setMyTimeZoneTool, { timeZone: 'Europe/Lisbon', userConfirmed: true }, ctx)) as Record<string, string>;
    expect(trpcCall).toHaveBeenCalledWith('user.updateTimezone', { timezone: 'Europe/Lisbon' }, { authToken: 't', sessionId: undefined, userId: 'u1' });
    expect(out.timeZone).toBe('Europe/Lisbon');
    expect(ctx.get('timezone')).toBe('Europe/Lisbon');
  });
});

describe('todayLine', () => {
  it('tells chat agents to read the zone, and leaves it out for background runs', async () => {
    const { todayLine } = await import('../agents/today-line.js');
    const now = new Date('2026-11-18T10:00:00Z');
    expect(todayLine(now)).toContain('get-my-time-zone');
    expect(todayLine(now, { canAskUser: false })).not.toContain('get-my-time-zone');
    expect(todayLine(now, { canAskUser: false })).not.toContain('ask the user');
  });
});
