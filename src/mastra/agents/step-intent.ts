/**
 * Step intent: a model-written label for each tool call (Exponential ticket
 * cozy.olive).
 *
 * The exponential-app chat shows one row per tool call. Without help, that row
 * can only name the tool ("Fetched tickets"). With `intent`, the model writes
 * what the call is for ("Find Andi's open tickets in Cycle 17") and the app
 * shows that instead.
 *
 * `withStepIntent` adds an optional `intent` field to every function tool's
 * input schema, in one place, so the tool definitions stay unchanged. The
 * field is for display only: the wrapper removes it before the tool's own
 * `execute` runs. The app reads it from the tool-call args, and the args
 * persisted on the interaction keep it for traces and judges.
 *
 * `intent` stays optional. A required field makes the model fail validation
 * and retry when it forgets it (see tools/zod-loose.ts for that cost).
 */
import { Tool } from '@mastra/core/tools';
import { z } from 'zod';

export const STEP_INTENT_FIELD = 'intent';

export const STEP_INTENT_DESCRIPTION =
  'Five to ten words that tell the person what this call is for. Start with a verb. Use names, not ids. Example: Find Andi\'s open tickets in Cycle 17.';

const stepIntentSchema = z.string().max(120).optional().describe(STEP_INTENT_DESCRIPTION);

type AnyTool = Tool<any, any, any, any, any, any>;

// One wrapped instance per original tool. Zoe and her Haiku variant share a
// tool map; Mastra registers each tool by key, so both must get the same object.
const wrapped = new WeakMap<object, AnyTool>();

function isFunctionTool(value: unknown): value is AnyTool {
  return value instanceof Tool && value.inputSchema instanceof z.ZodObject;
}

function withoutIntent(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  if (!(STEP_INTENT_FIELD in input)) return input;
  const { [STEP_INTENT_FIELD]: _intent, ...rest } = input as Record<string, unknown>;
  return rest;
}

/** Wrap one tool. Anything that is not a Mastra function tool is returned as-is. */
export function withToolStepIntent<T>(tool: T): T {
  if (!isFunctionTool(tool)) return tool;
  const cached = wrapped.get(tool);
  if (cached) return cached as T;

  const schema = tool.inputSchema as unknown as z.AnyZodObject;
  if (STEP_INTENT_FIELD in schema.shape) {
    throw new Error(
      `Tool "${tool.id}" declares its own "${STEP_INTENT_FIELD}" field. ` +
        `"${STEP_INTENT_FIELD}" is reserved for the step label that withStepIntent adds.`,
    );
  }

  const original = tool;
  const next = new Tool({
    id: original.id,
    description: original.description,
    inputSchema: schema.extend({ [STEP_INTENT_FIELD]: stepIntentSchema }),
    // `original.execute` is bound to the original tool by Mastra's constructor,
    // so calling it bare is safe. Any further arguments are forwarded as-is.
    execute: (input: unknown, ...rest: unknown[]) =>
      (original.execute as (...args: unknown[]) => Promise<unknown>)(withoutIntent(input), ...rest),
  }) as AnyTool;

  // Keep every other property (output schema, approval, provider options,
  // toModelOutput, MCP metadata, ...) exactly as the original has it.
  for (const key of Object.keys(original) as (keyof AnyTool)[]) {
    if (key === 'inputSchema' || key === 'execute') continue;
    (next as unknown as Record<string, unknown>)[key] = original[key];
  }

  wrapped.set(original, next);
  return next as T;
}

/**
 * Add the optional `intent` field to every function tool in a tool map.
 * Provider tools (web search, web fetch, tool search) pass through unchanged.
 */
export function withStepIntent<T>(tools: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, tool] of Object.entries(tools)) out[key] = withToolStepIntent(tool);
  return out;
}
