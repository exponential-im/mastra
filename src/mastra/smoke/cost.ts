/**
 * Token totals and list-price cost for one smoke run.
 *
 * Prices are Anthropic's first-party list prices in USD per million tokens,
 * checked 2026-11-17. They are for reporting what a run cost, not for
 * billing: the Anthropic console is the record. Server tools (web search)
 * carry a per-use charge that is not counted here; the smoke prompt does not
 * use them.
 */

export interface TokenTotals {
  /** Input tokens billed at the full input price. */
  input: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** Input tokens read from the prompt cache. */
  cacheRead: number;
  output: number;
}

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write, the TTL the agents use. */
  cacheWrite: number;
}

// Longest prefix wins, so a dated id (claude-sonnet-4-5-20250929) matches.
const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function priceFor(modelId: string): ModelPrice | null {
  const match = Object.keys(PRICES)
    .filter((prefix) => modelId.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match] : null;
}

/** USD for the run, or null when the model has no price here. */
export function costUsd(modelId: string, tokens: TokenTotals): number | null {
  const price = priceFor(modelId);
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.cacheWrite * price.cacheWrite +
      tokens.cacheRead * price.cacheRead +
      tokens.output * price.output) /
    1_000_000
  );
}

export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  raw?: {
    inputTokens?: { noCache?: number; cacheRead?: number; cacheWrite?: number };
    outputTokens?: { total?: number };
  };
}

/**
 * Adds up the per-step usage Mastra reports. The top-level `inputTokens`
 * includes cached tokens, so the split comes from the provider's own
 * breakdown and falls back to the total only when that is missing.
 */
export function sumUsage(steps: Array<{ usage?: StepUsage }>): TokenTotals {
  const totals: TokenTotals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const { usage } of steps) {
    if (!usage) continue;
    const split = usage.raw?.inputTokens;
    if (split) {
      totals.input += split.noCache ?? 0;
      totals.cacheWrite += split.cacheWrite ?? 0;
      totals.cacheRead += split.cacheRead ?? 0;
    } else {
      totals.input += usage.inputTokens ?? 0;
    }
    totals.output += usage.raw?.outputTokens?.total ?? usage.outputTokens ?? 0;
  }
  return totals;
}
