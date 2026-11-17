import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

import { getMeetingTranscriptionsTool, queryMeetingContextTool } from './index.js';
import {
  MIN_TRANSCRIPT_SHARE,
  MULTI_MEETING_TRANSCRIPT_BUDGET,
  SINGLE_MEETING_TRANSCRIPT_CAP,
  fitTranscript,
  transcriptLimit,
} from './meeting-transcript-budget.js';

function makeRequestContext(entries: Record<string, string> = {}) {
  return new Map<string, string>(
    Object.entries({ authToken: 'token-123', userId: 'user-1', workspaceId: 'ws-1', ...entries }),
  );
}

const meeting = (id: string, chars: number) => ({
  id,
  title: `Meeting ${id}`,
  transcript: 'x'.repeat(chars),
  participants: [],
  meetingDate: '2026-11-16T09:00:00.000Z',
  summary: 'summary',
});

beforeEach(() => authenticatedTrpcCall.mockReset());

/**
 * `mastra.queryMeetingContext` has required `workspaceId` since May 2026. This
 * tool never sent it, so every call 400'd for six months while agents narrated
 * around the failure.
 */
describe('query-meeting-context', () => {
  it('sends the workspace from request context: the app rejects a search without one', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { results: [] } });

    await queryMeetingContextTool.execute!(
      { query: 'user stories', topK: 5 },
      { requestContext: makeRequestContext() } as never,
    );

    const [endpoint, payload] = authenticatedTrpcCall.mock.calls[0]!;
    expect(endpoint).toBe('mastra.queryMeetingContext');
    expect(payload).toMatchObject({ query: 'user stories', workspaceId: 'ws-1' });
    expect(payload).not.toHaveProperty('transcriptionId');
  });

  it('searches inside one meeting when given its id', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { results: [] } });

    await queryMeetingContextTool.execute!(
      { query: 'user stories', transcriptionId: 'meeting-1', topK: 5 },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'ws-1',
      transcriptionId: 'meeting-1',
    });
  });

  it('with no workspace, fails in words the model can act on instead of a 400', async () => {
    const requestContext = makeRequestContext();
    requestContext.delete('workspaceId');

    await expect(
      queryMeetingContextTool.execute!({ query: 'x', topK: 5 }, { requestContext } as never),
    ).rejects.toThrow(/needs a workspace.*get-meeting-transcriptions/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('get-meeting-transcriptions', () => {
  it('returns one meeting asked for by id whole, however long', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { transcriptions: [meeting('meeting-1', 50_000)], total: 1 },
    });

    const result = (await getMeetingTranscriptionsTool.execute!(
      { transcriptionId: 'meeting-1', limit: 5, includeTranscript: true, truncateTranscript: true },
      { requestContext: makeRequestContext() } as never,
    )) as { transcriptions: Array<Record<string, unknown>> };

    expect(authenticatedTrpcCall.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'ws-1',
      transcriptionId: 'meeting-1',
    });
    const [t] = result.transcriptions;
    expect(t!.transcriptTruncated).toBe(false);
    expect(t!.transcriptLength).toBe(50_000);
    expect(t!.transcriptNote).toBeUndefined();
    // Whole text is inside the untrusted-content wrapper.
    expect(String(t!.transcript)).toContain('x'.repeat(50_000));
  });

  it('shares a budget across several meetings and flags every cut with how to read the rest', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: {
        transcriptions: [meeting('a', 40_000), meeting('b', 40_000), meeting('c', 500)],
        total: 3,
      },
    });

    const result = (await getMeetingTranscriptionsTool.execute!(
      { limit: 5, includeTranscript: true, truncateTranscript: true },
      { requestContext: makeRequestContext() } as never,
    )) as { transcriptions: Array<Record<string, unknown>> };

    const share = MULTI_MEETING_TRANSCRIPT_BUDGET / 3;
    const [a, , c] = result.transcriptions;
    expect(a!.transcriptTruncated).toBe(true);
    expect(a!.transcriptLength).toBe(40_000);
    expect(String(a!.transcriptNote)).toContain(`first ${share} of 40000 characters`);
    expect(String(a!.transcriptNote)).toContain('transcriptionId "a"');
    expect(String(a!.transcript)).not.toContain('x'.repeat(share + 1));
    // A short meeting is untouched and carries no note.
    expect(c!.transcriptTruncated).toBe(false);
    expect(c!.transcriptNote).toBeUndefined();
  });

  it('leaves list-style results alone: no transcript, no length, no flag', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { transcriptions: [{ ...meeting('a', 0), transcript: '' }], total: 1 },
    });

    const result = (await getMeetingTranscriptionsTool.execute!(
      { limit: 5, includeTranscript: false, truncateTranscript: true },
      { requestContext: makeRequestContext() } as never,
    )) as { transcriptions: Array<Record<string, unknown>> };

    expect(result.transcriptions[0]).not.toHaveProperty('transcriptTruncated');
  });
});

describe('transcriptLimit', () => {
  it('gives a targeted meeting the single-meeting ceiling', () => {
    expect(transcriptLimit({ count: 1, targeted: true })).toBe(SINGLE_MEETING_TRANSCRIPT_CAP);
  });

  it('gives a lone untargeted meeting the whole shared budget', () => {
    expect(transcriptLimit({ count: 1, targeted: false })).toBe(MULTI_MEETING_TRANSCRIPT_BUDGET);
  });

  it('splits the budget between meetings, never below the floor', () => {
    expect(transcriptLimit({ count: 5, targeted: false })).toBe(MULTI_MEETING_TRANSCRIPT_BUDGET / 5);
    expect(transcriptLimit({ count: 500, targeted: false })).toBe(MIN_TRANSCRIPT_SHARE);
  });

  it('lets the model ask for less, even for a targeted meeting', () => {
    expect(transcriptLimit({ count: 1, targeted: true, explicitMax: 1500 })).toBe(1500);
  });
});

describe('fitTranscript', () => {
  it('returns a transcript within the limit untouched', () => {
    expect(fitTranscript('m', 'hello', 10)).toEqual({
      transcript: 'hello',
      transcriptLength: 5,
      transcriptTruncated: false,
    });
  });

  it('marks a cut and tells the model the read is partial', () => {
    const fitted = fitTranscript('m-9', 'a'.repeat(100), 10);
    expect(fitted.transcript).toBe(`${'a'.repeat(10)}…[truncated]`);
    expect(fitted.transcriptTruncated).toBe(true);
    expect(fitted.transcriptLength).toBe(100);
    expect(fitted.transcriptNote).toMatch(/PARTIAL READ.*do not conclude that something was not said/);
    expect(fitted.transcriptNote).toContain('transcriptionId "m-9"');
  });
});
