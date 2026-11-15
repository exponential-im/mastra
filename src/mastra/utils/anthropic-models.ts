import { anthropic } from '@ai-sdk/anthropic';
import {
  withAnthropicPromptCache,
  type AnthropicRequestDefaults,
} from './anthropic-prompt-cache.js';

/**
 * The two Anthropic models the agents run on, each named once here so the
 * next model change is one line, with the request settings that model needs.
 */

/**
 * The Sonnet tier: Zoe, the Assistant, agent runs, the local wiki and the
 * meeting agents.
 *
 * Claude Sonnet 5.5 replaced Claude Sonnet 4.5, which Anthropic retires on
 * 30 November 2026. What differs from 4.5, and where it is handled:
 *
 * - **Thinking is always on.** Omitting `thinking` runs adaptive thinking and
 *   `{ type: 'disabled' }` is a 400. Depth is set with `effort`, below.
 * - **Sampling parameters are rejected.** A non-default `temperature`, `topP`
 *   or `topK` is a 400, so the Sonnet agents no longer set a temperature
 *   (@ai-sdk/anthropic also drops one a caller sends, with a warning).
 * - **Forced tool choice is rejected.** No agent uses `toolChoice`
 *   `required` or a named tool; the provider downgrades one to `auto`.
 * - **Thinking blocks are bound to their conversation.** See
 *   `SONNET_THINKING` below.
 *
 * `@ai-sdk/anthropic` must know the model: a release that does not list
 * `claude-sonnet-5-5` caps output at 4,096 tokens (thinking included) and
 * falls back to a forced-tool JSON mode the model rejects.
 */
export const SONNET_MODEL_ID = 'claude-sonnet-5-5';

export type SonnetEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Anthropic's starting point for multistep tool use; the API default is
 * `high`. `low` is its starting point for plain chat and extraction, and
 * skips thinking on most simple requests, so it is the lever to pull if
 * first-token latency matters more than depth. Not yet swept against our own
 * evals.
 */
export const SONNET_DEFAULT_EFFORT: SonnetEffort = 'medium';

/**
 * Adaptive thinking, with mismatched thinking blocks dropped instead of
 * rejected.
 *
 * Every thinking block Sonnet 5.5 returns is signed against the system
 * prompt, the tool set and all earlier messages, and thread memory stores the
 * block and replays it on later turns. When a request replays a block after
 * any of those changed, the API fails the whole request with a 400 on
 * accounts created on or after 31 August 2026, which includes every new
 * self-hosted install. Our history is not append-only: thread memory slides a
 * 40-message window, observational memory rewrites older turns into system
 * messages, and two processors flatten broken server-tool calls. With
 * `drop_block` the API discards the blocks that no longer match and answers
 * anyway. Within one turn's tool loop nothing changes, so reasoning still
 * carries from step to step. The provider adds the
 * `thinking-binding-controls-2026-08-01` beta header this needs.
 */
export const SONNET_THINKING = {
  type: 'adaptive',
  blockBinding: { prefixMismatchBehavior: 'drop_block' },
} as const;

/**
 * The cap Sonnet 4.5 ran with, kept on purpose. Left unset, the provider
 * sends the model's maximum (128,000), including on the non-streaming
 * `generate` path that agent runs and the chat gateways use.
 */
export const SONNET_MAX_OUTPUT_TOKENS = 64_000;

/** Sent with every Sonnet request unless the caller overrides a value. */
export function sonnetRequestDefaults(
  effort: SonnetEffort = SONNET_DEFAULT_EFFORT,
): AnthropicRequestDefaults {
  return {
    anthropic: { effort, thinking: SONNET_THINKING },
    maxOutputTokens: SONNET_MAX_OUTPUT_TOKENS,
  };
}

/**
 * The fast tier (`zoeAgentHaiku`, `assistantAgentHaiku`), still Claude Haiku
 * 4.5. It answers trivial turns on the same threads as the Sonnet tier.
 */
export const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';

/**
 * Haiku requests leave thinking blocks out. A thread it shares with the
 * Sonnet tier now carries Sonnet's thinking blocks, which only Sonnet 5.5
 * (and the models above it) can read. Anthropic documents that it drops them
 * for any other model; not replaying them keeps Haiku's requests exactly what
 * they were before the Sonnet tier started thinking. The stored thread is
 * untouched, so Sonnet still gets its own blocks back.
 */
export const HAIKU_REQUEST_DEFAULTS: AnthropicRequestDefaults = {
  anthropic: { sendReasoning: false },
};

type AnthropicModelFactory = (modelId: string) => ReturnType<typeof anthropic>;

interface ModelOptions {
  /** For tests that stub `fetch`; defaults to the shared `anthropic` provider. */
  provider?: AnthropicModelFactory;
}

/** The Sonnet model with the project-standard middleware stack and its request defaults. */
export function sonnetModel(options: ModelOptions & { effort?: SonnetEffort } = {}) {
  const provider = options.provider ?? anthropic;
  return withAnthropicPromptCache(provider(SONNET_MODEL_ID), {
    requestDefaults: sonnetRequestDefaults(options.effort),
  });
}

/** The Haiku model with the project-standard middleware stack and its request defaults. */
export function haikuModel(options: ModelOptions = {}) {
  const provider = options.provider ?? anthropic;
  return withAnthropicPromptCache(provider(HAIKU_MODEL_ID), {
    requestDefaults: HAIKU_REQUEST_DEFAULTS,
  });
}
