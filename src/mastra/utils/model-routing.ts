/**
 * OpenRouter as a second model provider (exponential ticket 675
 * turbo.compass, ADR-0065 §3 in exponential).
 *
 * On 2026-10-07 the Anthropic account ran out of prepaid credit and every chat
 * turn failed. Anthropic direct stays the primary path for Zoe and the
 * Assistant (prompt caching, tool deferral and server tools only exist
 * there), but a second provider means one empty balance or one outage no
 * longer takes everything down.
 *
 * Everything here keys off `OPENROUTER_API_KEY`. Unset (local dev, CI, a
 * self-hosted install without an OpenRouter account), every function returns
 * exactly the model the code used before, so nothing changes.
 *
 * With the key set:
 *   - observational memory (observer + reflector) runs on OpenRouter, with
 *     Anthropic direct as the fallback entry;
 *   - the channel summarizer runs on OpenRouter, with OpenAI direct as the
 *     fallback;
 *   - the Haiku tier of Zoe and the Assistant keeps Anthropic direct as its
 *     primary and gains an OpenRouter fallback entry, used only when the
 *     Anthropic call fails (400 credit balance, 401, 402, 5xx after retries).
 *
 * Model ids go through Mastra's model router (`openrouter/<provider>/<model>`),
 * which ships an OpenRouter provider in @mastra/core 1.28, so no new package.
 * The summarizer calls the AI SDK's `generateText` directly rather than a
 * Mastra agent, so it reaches OpenRouter through `@ai-sdk/openai` pointed at
 * OpenRouter's OpenAI-compatible endpoint.
 *
 * The default OpenRouter models are the same models each job uses today, so
 * switching provider does not change output quality. The open-weight
 * candidates named in ADR-0065 (`z-ai/glm-5.3-flash`, `qwen/qwen3.7-flash`)
 * are one env var away once a sample confirms their quality (exponential
 * ticket 676, bright.bolt).
 */
import { createOpenAI, openai } from '@ai-sdk/openai';
import type { ModelWithRetries } from '@mastra/core/agent';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import type { LanguageModel } from 'ai';
import { createLogger } from './logger.js';

type Env = Record<string, string | undefined>;

export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenRouter model slugs (`<provider>/<model>`) each job uses by default. */
export const OPENROUTER_DEFAULT_MODELS = {
  observer: 'anthropic/claude-haiku-4.5',
  summarizer: 'openai/gpt-4o-mini',
  haikuFallback: 'anthropic/claude-haiku-4.5',
} as const;

export type OpenRouterRole = keyof typeof OPENROUTER_DEFAULT_MODELS;

/** Env vars that override a role's OpenRouter slug. */
export const OPENROUTER_MODEL_ENV: Record<OpenRouterRole, string> = {
  observer: 'OPENROUTER_OBSERVER_MODEL',
  summarizer: 'OPENROUTER_SUMMARIZER_MODEL',
  haikuFallback: 'OPENROUTER_FALLBACK_MODEL',
};

/** The model observational memory used before OpenRouter, and still uses without a key. */
export const ANTHROPIC_OBSERVER_MODEL = 'anthropic/claude-haiku-4-5-20251001';

/** The model the channel summarizer used before OpenRouter, and still uses without a key. */
export const DIRECT_SUMMARIZER_MODEL = 'gpt-4o-mini';

const logger = createLogger({ name: 'ModelRouting', level: 'info' });

/** The OpenRouter key, or undefined when it is unset or blank. */
export function openRouterApiKey(env: Env = process.env): string | undefined {
  const key = env[OPENROUTER_API_KEY_ENV]?.trim();
  return key ? key : undefined;
}

export function isOpenRouterConfigured(env: Env = process.env): boolean {
  return openRouterApiKey(env) !== undefined;
}

/**
 * The OpenRouter slug for a role: the env override when set, else the
 * default. A leading `openrouter/` is tolerated, so the override can be
 * written either way.
 */
export function openRouterSlug(role: OpenRouterRole, env: Env = process.env): string {
  const override = env[OPENROUTER_MODEL_ENV[role]]?.trim();
  if (!override) return OPENROUTER_DEFAULT_MODELS[role];
  return override.replace(/^openrouter\//, '');
}

/** Mastra model-router id for a role, e.g. `openrouter/anthropic/claude-haiku-4.5`. */
export function openRouterModelId(role: OpenRouterRole, env: Env = process.env): string {
  return `openrouter/${openRouterSlug(role, env)}`;
}

/**
 * The `model` for observational memory (it covers observer and reflector).
 * With a key: OpenRouter first, Anthropic direct as the fallback entry, so
 * memory keeps consolidating when either provider is down.
 */
export function observationalMemoryModel(
  env: Env = process.env,
): string | ModelWithRetries[] {
  if (!isOpenRouterConfigured(env)) return ANTHROPIC_OBSERVER_MODEL;
  return [
    { id: 'observer-openrouter', model: openRouterModelId('observer', env), maxRetries: 1 },
    { id: 'observer-anthropic', model: ANTHROPIC_OBSERVER_MODEL, maxRetries: 0 },
  ];
}

/**
 * Models for the channel summarizer, in the order to try them. With a key:
 * OpenRouter, then OpenAI direct.
 */
export function channelSummarizerModels(env: Env = process.env): LanguageModel[] {
  const direct = openai(DIRECT_SUMMARIZER_MODEL);
  const apiKey = openRouterApiKey(env);
  if (!apiKey) return [direct];
  const openrouter = createOpenAI({ name: 'openrouter', baseURL: OPENROUTER_BASE_URL, apiKey });
  return [openrouter.chat(openRouterSlug('summarizer', env)), direct];
}

// ---------------------------------------------------------------------------
// Haiku-tier fallback
// ---------------------------------------------------------------------------

type PromptPart = Record<string, unknown> & { type?: unknown };
type PromptMessage = Record<string, unknown> & { role?: unknown; content?: unknown };
type ToolLike = Record<string, unknown> & { type?: unknown; name?: unknown };

/**
 * Make a model call safe for a provider that has none of Anthropic's
 * provider tools. Only the outgoing request changes; stored thread history
 * is untouched.
 *
 * - Tools: keep function tools only. Anthropic's web search, web fetch and
 *   tool search are provider tools (`type: 'provider'` in AI SDK v6,
 *   `'provider-defined'` in v5), so they are dropped. A `toolChoice` that
 *   names a dropped tool falls back to `auto`.
 * - History: Anthropic ran its server tools itself, so the thread holds their
 *   calls (`providerExecuted: true`) and results in the assistant message,
 *   with no `tool` message answering them. Sent to an OpenAI-style API, the
 *   call becomes a `tool_calls` entry nothing answers, and the request is
 *   rejected. Those calls and results are removed, along with any `tool`
 *   result that answers one, and messages left empty are dropped. The
 *   assistant's own text about what it found stays.
 */
export function stripAnthropicProviderTools<T extends object>(options: T): T {
  const opts = options as T & {
    tools?: ToolLike[];
    toolChoice?: { type?: unknown; toolName?: unknown };
    prompt?: PromptMessage[];
  };
  const next: Record<string, unknown> = { ...opts };

  if (Array.isArray(opts.tools)) {
    const dropped = new Set(
      opts.tools.filter((t) => t.type !== 'function').map((t) => String(t.name)),
    );
    next.tools = opts.tools.filter((t) => t.type === 'function');
    if (
      opts.toolChoice?.type === 'tool' &&
      typeof opts.toolChoice.toolName === 'string' &&
      dropped.has(opts.toolChoice.toolName)
    ) {
      next.toolChoice = { type: 'auto' };
    }
  }

  if (Array.isArray(opts.prompt)) {
    const providerCallIds = new Set<string>();
    for (const msg of opts.prompt) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const part of msg.content as PromptPart[]) {
        if (
          part.type === 'tool-call' &&
          part.providerExecuted === true &&
          typeof part.toolCallId === 'string'
        ) {
          providerCallIds.add(part.toolCallId);
        }
      }
    }

    const prompt: PromptMessage[] = [];
    for (const msg of opts.prompt) {
      if (!Array.isArray(msg.content)) {
        prompt.push(msg);
        continue;
      }
      const parts = msg.content as PromptPart[];
      let kept = parts;
      if (msg.role === 'assistant') {
        kept = parts.filter(
          (p) =>
            !(p.type === 'tool-call' && p.providerExecuted === true) && p.type !== 'tool-result',
        );
      } else if (msg.role === 'tool') {
        kept = parts.filter(
          (p) =>
            !(
              p.type === 'tool-result' &&
              typeof p.toolCallId === 'string' &&
              providerCallIds.has(p.toolCallId)
            ),
        );
      }
      if (kept.length === 0) continue;
      prompt.push(kept === parts ? msg : { ...msg, content: kept });
    }
    next.prompt = prompt;
  }

  return next as T;
}

type CallOptions = Parameters<ModelRouterLanguageModel['doStream']>[0];

/**
 * A Mastra model-router model that strips Anthropic provider tools from every
 * call (see `stripAnthropicProviderTools`). A subclass, not a wrapper:
 * Mastra passes `ModelRouterLanguageModel` instances through untouched, where
 * a wrapper object would be re-wrapped and its stream converted twice.
 */
export class ProviderToolFreeRouterModel extends ModelRouterLanguageModel {
  override async doStream(options: CallOptions) {
    logger.warn('Anthropic call failed; turn is running on the OpenRouter fallback', {
      modelId: this.modelId,
    });
    return super.doStream(stripAnthropicProviderTools(options));
  }

  override async doGenerate(options: CallOptions) {
    logger.warn('Anthropic call failed; turn is running on the OpenRouter fallback', {
      modelId: this.modelId,
    });
    return super.doGenerate(stripAnthropicProviderTools(options));
  }
}

/**
 * The `model` for a Haiku-tier agent. Without a key: `primary`, unchanged.
 * With a key: `primary` first, then an OpenRouter model Mastra moves to only
 * when the primary call throws. Mastra keeps a turn on the fallback for the
 * rest of its steps once it has switched.
 *
 * The primary keeps `maxRetries: 0`, which is what a single-model agent gets
 * today; a billing or auth error is not retryable anyway. The fallback gets
 * one retry for transient OpenRouter errors.
 *
 * The fallback sees the agent's full function-tool map (no deferral outside
 * Anthropic, so ~25K tokens of schemas per step). That is the price of every
 * tool working during an outage, and it is paid only while Anthropic is down.
 */
export function withOpenRouterFallback<M>(
  primary: M,
  env: Env = process.env,
): M | ModelWithRetries[] {
  if (!isOpenRouterConfigured(env)) return primary;
  return [
    { id: 'anthropic-primary', model: primary as ModelWithRetries['model'], maxRetries: 0 },
    {
      id: 'openrouter-fallback',
      model: new ProviderToolFreeRouterModel(openRouterModelId('haikuFallback', env)),
      maxRetries: 1,
    },
  ];
}

/** One line for the boot log: which provider each job is on. */
export function describeModelRouting(env: Env = process.env): Record<string, string> {
  if (!isOpenRouterConfigured(env)) {
    return {
      openrouter: 'not configured (OPENROUTER_API_KEY unset)',
      observationalMemory: ANTHROPIC_OBSERVER_MODEL,
      channelSummarizer: `openai/${DIRECT_SUMMARIZER_MODEL}`,
      haikuFallback: 'none',
    };
  }
  return {
    openrouter: 'configured',
    observationalMemory: `${openRouterModelId('observer', env)} -> ${ANTHROPIC_OBSERVER_MODEL}`,
    channelSummarizer: `${openRouterModelId('summarizer', env)} -> openai/${DIRECT_SUMMARIZER_MODEL}`,
    haikuFallback: openRouterModelId('haikuFallback', env),
  };
}
