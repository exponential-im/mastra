/**
 * How much of each meeting transcript `get-meeting-transcriptions` hands the
 * model.
 *
 * The tool used to cut every transcript to its first 2,000 characters, even
 * when one meeting was the whole question. A standup's first 2,000 characters
 * are its first couple of minutes, so "did Cyril mention two user stories?"
 * was answered "no" from a read that never reached Cyril's update, with
 * nothing telling the model the read was partial.
 *
 * Two rules replace it:
 *  - one meeting asked for by id comes back whole (up to a safety ceiling);
 *  - several meetings share one budget, and every cut says so, outside the
 *    transcript text, with the way to read the rest.
 */

/** Ceiling for a single targeted meeting (~100k tokens; a multi-hour call). */
export const SINGLE_MEETING_TRANSCRIPT_CAP = 400_000;
/** Shared across the meetings of one untargeted call (~15k tokens). */
export const MULTI_MEETING_TRANSCRIPT_BUDGET = 60_000;
/** A meeting's share never drops below this, however many are returned. */
export const MIN_TRANSCRIPT_SHARE = 2_000;

export interface TranscriptLimitInput {
  /** Meetings in this result that carry transcript text. */
  count: number;
  /** The caller asked for one meeting by `transcriptionId`. */
  targeted: boolean;
  /** `maxTranscriptLength` when the model set it itself. */
  explicitMax?: number;
}

/** Characters each transcript in this result may keep. */
export function transcriptLimit({ count, targeted, explicitMax }: TranscriptLimitInput): number {
  if (typeof explicitMax === "number" && Number.isFinite(explicitMax) && explicitMax > 0) {
    return Math.floor(explicitMax);
  }
  if (targeted) return SINGLE_MEETING_TRANSCRIPT_CAP;
  if (count <= 1) return MULTI_MEETING_TRANSCRIPT_BUDGET;
  return Math.max(MIN_TRANSCRIPT_SHARE, Math.floor(MULTI_MEETING_TRANSCRIPT_BUDGET / count));
}

export interface FittedTranscript {
  transcript: string;
  /** Length of the full transcript, before any cut. */
  transcriptLength: number;
  transcriptTruncated: boolean;
  /**
   * Tool-authored (trusted) note for a cut transcript: what was not read and
   * how to read it. Kept out of `transcript`, which is wrapped as untrusted
   * meeting content.
   */
  transcriptNote?: string;
}

/** Cut one transcript to `limit`, saying so when it does. */
export function fitTranscript(id: string, transcript: string, limit: number): FittedTranscript {
  const transcriptLength = transcript.length;
  if (transcriptLength <= limit) {
    return { transcript, transcriptLength, transcriptTruncated: false };
  }
  return {
    transcript: `${transcript.slice(0, limit)}…[truncated]`,
    transcriptLength,
    transcriptTruncated: true,
    transcriptNote:
      `PARTIAL READ: only the first ${limit} of ${transcriptLength} characters of this meeting are included. ` +
      `The rest was not read, so do not conclude that something was not said. ` +
      `Call get-meeting-transcriptions with transcriptionId "${id}" for the whole transcript, ` +
      `or query-meeting-context with transcriptionId "${id}" to search inside it.`,
  };
}
