import { stepCountIs } from 'ai';

/**
 * True on the step where the model refused.
 *
 * Anthropic's safety classifiers can decline a request with HTTP 200 and
 * `stop_reason: "refusal"`, which reaches Mastra as the finish reason
 * `content-filter`. Mastra's loop only ends a turn on `stop`, `error` or
 * `length`, so without this it sends the refused request again on every
 * remaining step: twelve calls for one refusal, and any refusal text twelve
 * times over. Claude Sonnet 5.5 refuses in more categories than Sonnet 4.5
 * did, so this matters more than it used to.
 */
export const refused = ({ steps }: { steps: Array<{ finishReason?: unknown }> }): boolean =>
  steps.at(-1)?.finishReason === 'content-filter';

/**
 * The loop bounds for an Anthropic-backed agent: at most `maxSteps` steps,
 * ending at once if the model refuses.
 *
 * Pass it as `stopWhen` and do NOT also set `maxSteps`: Mastra turns a
 * numeric `maxSteps` into `stepCountIs(maxSteps)` and discards `stopWhen`.
 * The same holds per call, so a caller passing `maxSteps` to generate/stream
 * replaces these conditions for that call.
 */
export function stepLimit(maxSteps: number) {
  return [stepCountIs(maxSteps), refused];
}
