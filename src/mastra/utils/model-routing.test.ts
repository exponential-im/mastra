import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropic } from '@ai-sdk/anthropic';
import { APICallError } from 'ai';
import { Agent } from '@mastra/core/agent';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  ANTHROPIC_OBSERVER_MODEL,
  ProviderToolFreeRouterModel,
  channelSummarizerModels,
  describeModelRouting,
  isOpenRouterConfigured,
  observationalMemoryModel,
  openRouterSlug,
  stripAnthropicProviderTools,
  withOpenRouterFallback,
} from './model-routing.js';

// No test here reaches a real provider: the OpenRouter path is stubbed at
// ModelRouterLanguageModel.prototype.doStream and the primary is a mock.

const WITH_KEY = { OPENROUTER_API_KEY: 'sk-or-test-placeholder' };
const NO_KEY = {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenRouter configuration', () => {
  it('is off when the key is unset or blank', () => {
    expect(isOpenRouterConfigured(NO_KEY)).toBe(false);
    expect(isOpenRouterConfigured({ OPENROUTER_API_KEY: '   ' })).toBe(false);
    expect(isOpenRouterConfigured(WITH_KEY)).toBe(true);
  });

  it('uses the default slug unless a role override is set', () => {
    expect(openRouterSlug('observer', NO_KEY)).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterSlug('summarizer', NO_KEY)).toBe('openai/gpt-4o-mini');
    expect(openRouterSlug('haikuFallback', NO_KEY)).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterSlug('observer', { OPENROUTER_OBSERVER_MODEL: 'z-ai/glm-5.3-flash' })).toBe(
      'z-ai/glm-5.3-flash',
    );
  });

  it('accepts an override written with the openrouter/ prefix', () => {
    expect(
      openRouterSlug('haikuFallback', { OPENROUTER_FALLBACK_MODEL: 'openrouter/qwen/qwen3.7-flash' }),
    ).toBe('qwen/qwen3.7-flash');
  });
});

describe('observationalMemoryModel', () => {
  it('stays on Anthropic Haiku direct without a key', () => {
    expect(observationalMemoryModel(NO_KEY)).toBe(ANTHROPIC_OBSERVER_MODEL);
  });

  it('runs on OpenRouter first, Anthropic second, with a key', () => {
    const model = observationalMemoryModel(WITH_KEY);
    expect(Array.isArray(model)).toBe(true);
    expect(model).toEqual([
      { id: 'observer-openrouter', model: 'openrouter/anthropic/claude-haiku-4.5', maxRetries: 1 },
      { id: 'observer-anthropic', model: ANTHROPIC_OBSERVER_MODEL, maxRetries: 0 },
    ]);
  });

  it('honours the observer model override', () => {
    const model = observationalMemoryModel({ ...WITH_KEY, OPENROUTER_OBSERVER_MODEL: 'z-ai/glm-5.3-flash' });
    expect((model as Array<{ model: unknown }>)[0]?.model).toBe('openrouter/z-ai/glm-5.3-flash');
  });
});

describe('channelSummarizerModels', () => {
  it('is OpenAI gpt-4o-mini direct alone without a key', () => {
    const models = channelSummarizerModels(NO_KEY);
    expect(models).toHaveLength(1);
    const [direct] = models as Array<{ provider: string; modelId: string }>;
    expect(direct?.provider).toMatch(/^openai/);
    expect(direct?.modelId).toBe('gpt-4o-mini');
  });

  it('is OpenRouter then OpenAI direct with a key', () => {
    const models = channelSummarizerModels(WITH_KEY) as Array<{ provider: string; modelId: string }>;
    expect(models).toHaveLength(2);
    expect(models[0]?.provider).toMatch(/^openrouter/);
    expect(models[0]?.modelId).toBe('openai/gpt-4o-mini');
    expect(models[1]?.provider).toMatch(/^openai/);
    expect(models[1]?.modelId).toBe('gpt-4o-mini');
  });
});

describe('withOpenRouterFallback', () => {
  const primary = { specificationVersion: 'v3', modelId: 'claude-haiku-4-5' };

  it('returns the primary untouched without a key', () => {
    expect(withOpenRouterFallback(primary, NO_KEY)).toBe(primary);
  });

  it('puts an OpenRouter fallback behind the primary with a key', () => {
    const models = withOpenRouterFallback(primary, WITH_KEY) as Array<{
      id: string;
      model: unknown;
      maxRetries: number;
    }>;
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: 'anthropic-primary', model: primary, maxRetries: 0 });
    expect(models[1]?.id).toBe('openrouter-fallback');
    expect(models[1]?.maxRetries).toBe(1);
    const fallback = models[1]?.model as ProviderToolFreeRouterModel;
    expect(fallback).toBeInstanceOf(ProviderToolFreeRouterModel);
    // Mastra passes ModelRouterLanguageModel instances through as-is.
    expect(fallback).toBeInstanceOf(ModelRouterLanguageModel);
    expect(fallback.provider).toBe('openrouter');
    expect(fallback.modelId).toBe('anthropic/claude-haiku-4.5');
  });
});

describe('describeModelRouting', () => {
  it('says which provider each job is on', () => {
    expect(describeModelRouting(NO_KEY).haikuFallback).toBe('none');
    expect(describeModelRouting(WITH_KEY)).toMatchObject({
      openrouter: 'configured',
      haikuFallback: 'openrouter/anthropic/claude-haiku-4.5',
    });
  });
});

describe('stripAnthropicProviderTools', () => {
  const fnTool = { type: 'function', name: 'getTodaysActionsTool', inputSchema: {} };
  const webSearch = { type: 'provider', id: 'anthropic.web_search_20250305', name: 'webSearch', args: {} };
  const toolSearchV5 = {
    type: 'provider-defined',
    id: 'anthropic.tool_search_bm25_20251119',
    name: 'toolSearch',
    args: {},
  };

  it('keeps function tools only', () => {
    const out = stripAnthropicProviderTools({ tools: [fnTool, webSearch, toolSearchV5], prompt: [] });
    expect(out.tools).toEqual([fnTool]);
  });

  it('resets a toolChoice that names a dropped tool', () => {
    const out = stripAnthropicProviderTools({
      tools: [fnTool, webSearch],
      toolChoice: { type: 'tool', toolName: 'webSearch' },
    });
    expect(out.toolChoice).toEqual({ type: 'auto' });

    const kept = stripAnthropicProviderTools({
      tools: [fnTool, webSearch],
      toolChoice: { type: 'tool', toolName: 'getTodaysActionsTool' },
    });
    expect(kept.toolChoice).toEqual({ type: 'tool', toolName: 'getTodaysActionsTool' });
  });

  it('removes server-tool calls and results from history, keeping the text', () => {
    const prompt = [
      { role: 'system', content: 'soul' },
      { role: 'user', content: [{ type: 'text', text: 'what is the weather in Berlin?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'srvtoolu_1',
            toolName: 'webSearch',
            input: { query: 'Berlin weather' },
            providerExecuted: true,
          },
          { type: 'tool-result', toolCallId: 'srvtoolu_1', toolName: 'webSearch', output: { type: 'json', value: [] } },
          { type: 'text', text: 'It is 12°C in Berlin.' },
          { type: 'tool-call', toolCallId: 'toolu_2', toolName: 'getTodaysActionsTool', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'toolu_2', toolName: 'getTodaysActionsTool', output: { type: 'json', value: [] } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'srvtoolu_3', toolName: 'webFetch', input: {}, providerExecuted: true },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'srvtoolu_3', toolName: 'webFetch', output: { type: 'text', value: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];

    const out = stripAnthropicProviderTools({ prompt });

    expect(out.prompt).toEqual([
      { role: 'system', content: 'soul' },
      { role: 'user', content: [{ type: 'text', text: 'what is the weather in Berlin?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'It is 12°C in Berlin.' },
          { type: 'tool-call', toolCallId: 'toolu_2', toolName: 'getTodaysActionsTool', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'toolu_2', toolName: 'getTodaysActionsTool', output: { type: 'json', value: [] } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ]);
  });

  it('does not mutate the options it is given', () => {
    const options = {
      tools: [fnTool, webSearch],
      prompt: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'srvtoolu_1', toolName: 'webSearch', input: {}, providerExecuted: true }],
        },
      ],
    };
    const snapshot = structuredClone(options);
    stripAnthropicProviderTools(options);
    expect(options).toEqual(snapshot);
  });
});

/** A V2 stream like the one ModelRouterLanguageModel returns for a text answer. */
function textStream(text: string) {
  const chunks = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

describe('ProviderToolFreeRouterModel', () => {
  it('strips provider tools before handing the call to the model router', async () => {
    const routerStream = vi
      .spyOn(ModelRouterLanguageModel.prototype, 'doStream')
      .mockResolvedValue(textStream('ok') as never);
    const model = new ProviderToolFreeRouterModel('openrouter/anthropic/claude-haiku-4.5');

    await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { type: 'function', name: 'getTodaysActionsTool', inputSchema: { type: 'object' } },
        { type: 'provider-defined', id: 'anthropic.web_search_20250305', name: 'webSearch', args: {} },
      ],
    } as never);

    expect(routerStream).toHaveBeenCalledTimes(1);
    const sent = routerStream.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(sent.tools.map((t) => t.name)).toEqual(['getTodaysActionsTool']);
  });
});

describe('Haiku-tier runtime fallback (real Mastra Agent)', () => {
  function anthropicFailing(statusCode: number, message: string) {
    let calls = 0;
    const model = new MockLanguageModelV3({
      provider: 'anthropic.messages',
      modelId: 'claude-haiku-4-5-20251001',
      doStream: async () => {
        calls++;
        throw new APICallError({
          message,
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode,
          responseBody: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
          isRetryable: false,
        });
      },
    });
    return { model, calls: () => calls };
  }

  const getTodaysActionsTool = createTool({
    id: 'get-todays-actions',
    description: 'List today’s actions',
    inputSchema: z.object({}),
    execute: async () => ({ actions: [] }),
  });

  function agentWith(model: unknown) {
    return new Agent({
      id: 'haikuFallbackProbe',
      name: 'Haiku fallback probe',
      instructions: 'probe',
      model: model as never,
      tools: {
        getTodaysActionsTool,
        webSearch: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
        toolSearch: anthropic.tools.toolSearchBm25_20251119(),
      },
    });
  }

  it.each([
    [400, 'Your credit balance is too low to access the Anthropic API.'],
    [402, 'Payment required'],
  ])('completes the turn on OpenRouter when Anthropic returns %i', async (status, message) => {
    const routerStream = vi
      .spyOn(ModelRouterLanguageModel.prototype, 'doStream')
      .mockResolvedValue(textStream('answered by the fallback') as never);
    const primary = anthropicFailing(status, message);

    const agent = agentWith(withOpenRouterFallback(primary.model, WITH_KEY));
    const result = await agent.stream('hi');
    const text = await result.text;

    expect(text).toBe('answered by the fallback');
    expect(primary.calls()).toBe(1);
    expect(routerStream).toHaveBeenCalledTimes(1);
    const sent = routerStream.mock.calls[0]?.[0] as { tools?: Array<{ type: string; name: string }> };
    expect(sent.tools?.every((t) => t.type === 'function')).toBe(true);
    expect(sent.tools?.map((t) => t.name)).toEqual(['getTodaysActionsTool']);
  });

  it('has no fallback without a key: the Anthropic error stands', async () => {
    const routerStream = vi.spyOn(ModelRouterLanguageModel.prototype, 'doStream');
    const primary = anthropicFailing(400, 'Your credit balance is too low to access the Anthropic API.');

    const agent = agentWith(withOpenRouterFallback(primary.model, NO_KEY));
    const result = await agent.stream('hi');
    await result.consumeStream().catch(() => {});

    expect(primary.calls()).toBe(1);
    expect(routerStream).not.toHaveBeenCalled();
    expect(await result.text).toBe('');
    expect(result.error).toBeDefined();
  });
});
