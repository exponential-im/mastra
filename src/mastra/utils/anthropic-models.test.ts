import { describe, it, expect, vi } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, tool, type ToolSet } from 'ai';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import {
  HAIKU_MODEL_ID,
  SONNET_MAX_OUTPUT_TOKENS,
  SONNET_MODEL_ID,
  haikuModel,
  sonnetModel,
} from './anthropic-models.js';
import { betasOf, scriptedAnthropic, type ScriptedReply } from './anthropic-test-server.js';

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ ...logged, debug: vi.fn(), error: vi.fn() }),
}));

// These tests drive the real @ai-sdk/anthropic provider (and, further down,
// real Mastra agents) against a scripted stand-in for the Messages endpoint,
// and assert on the request Anthropic would receive. They are the guard for
// the things Claude Sonnet 5.5 rejects with a 400, and they fail if the
// provider is ever downgraded to a release that does not know the model.

const ok: ScriptedReply = { content: [{ type: 'text', text: 'ok' }] };

function stubbed(replies: ScriptedReply[] = [ok]) {
  const server = scriptedAnthropic(replies);
  const provider = createAnthropic({ apiKey: 'test', fetch: server.fetch });
  return { server, provider };
}

const lookupInput = z.object({ q: z.string() });

describe('sonnetModel', () => {
  it('asks for adaptive thinking that drops mismatched blocks, medium effort and the 64K cap', async () => {
    const { server, provider } = stubbed();
    await generateText({ model: sonnetModel({ provider }), prompt: 'hi' });

    const [request] = server.requests;
    expect(request.body.model).toBe(SONNET_MODEL_ID);
    expect(request.body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(request.body.output_config).toEqual({ effort: 'medium' });
    expect(request.body.max_tokens).toBe(SONNET_MAX_OUTPUT_TOKENS);
    // `block_binding` is rejected without this header.
    expect(betasOf(request)).toContain('thinking-binding-controls-2026-08-01');
  });

  it('never sends sampling parameters, even when the caller sets them', async () => {
    const { server, provider } = stubbed();
    await generateText({
      model: sonnetModel({ provider }),
      prompt: 'hi',
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
    });

    const { body } = server.requests[0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('lets the caller override effort and the output cap', async () => {
    const { server, provider } = stubbed();
    await generateText({
      model: sonnetModel({ provider }),
      prompt: 'hi',
      maxOutputTokens: 2_000,
      providerOptions: { anthropic: { effort: 'low' } },
    });

    const { body } = server.requests[0];
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens).toBe(2_000);
    // The override replaces one key; the thinking default still applies.
    expect(body.thinking.type).toBe('adaptive');
  });

  it('takes its effort from the factory option', async () => {
    const { server, provider } = stubbed();
    await generateText({ model: sonnetModel({ provider, effort: 'high' }), prompt: 'hi' });

    expect(server.requests[0].body.output_config).toEqual({ effort: 'high' });
  });

  it('turns a forced tool choice into auto', async () => {
    const { server, provider } = stubbed();
    await generateText({
      model: sonnetModel({ provider }),
      prompt: 'look it up',
      tools: { lookup: tool({ description: 'Look something up', inputSchema: lookupInput }) },
      toolChoice: 'required',
    });

    expect(server.requests[0].body.tool_choice.type).toBe('auto');
  });

  it('defers function tools behind tool search and keeps the search tool loaded', async () => {
    const { server, provider } = stubbed();
    await generateText({
      model: sonnetModel({ provider }),
      prompt: 'look it up',
      // Cast: the provider's tool type comes from a newer @ai-sdk/provider-utils
      // than the one `ai` carries (see misrouted-server-tool-calls.test.ts).
      tools: {
        lookup: tool({ description: 'Look something up', inputSchema: lookupInput }),
        toolSearch: provider.tools.toolSearchBm25_20251119(),
      } as unknown as ToolSet,
    });

    const [request] = server.requests;
    const tools = request.body.tools as Array<Record<string, unknown>>;
    const lookup = tools.find((t) => t.name === 'lookup');
    const search = tools.find((t) => t.type === 'tool_search_tool_bm25_20251119');
    expect(lookup?.defer_loading).toBe(true);
    expect(search).toBeDefined();
    expect(search).not.toHaveProperty('defer_loading');
    expect(betasOf(request)).toContain('advanced-tool-use-2025-11-20');
  });
});

describe('haikuModel', () => {
  it('keeps its temperature and asks for no thinking', async () => {
    const { server, provider } = stubbed();
    await generateText({ model: haikuModel({ provider }), prompt: 'hi', temperature: 0.7 });

    const { body } = server.requests[0];
    expect(body.model).toBe(HAIKU_MODEL_ID);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });
});

describe('Mastra agents on the two tiers', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig_from_sonnet' };
  const blockTypes = (message: { content: Array<{ type: string }> }) =>
    message.content.map((block) => block.type);

  it('passes a step’s thinking block back unchanged with the tool result', async () => {
    const { server, provider } = stubbed([
      {
        content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'It is 42.' }] },
    ]);
    const agent = new Agent({
      id: 'probe',
      name: 'Probe',
      instructions: 'You are a probe.',
      model: sonnetModel({ provider }),
      tools: {
        lookup: createTool({
          id: 'lookup',
          description: 'Look something up',
          inputSchema: lookupInput,
          execute: async () => ({ answer: 42 }),
        }),
      },
    });

    const result = await agent.stream('what is it?');
    expect(await result.text).toBe('It is 42.');

    const secondStep = server.requests[1].body.messages;
    const assistantTurn = secondStep.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantTurn.content[0]).toEqual(thinking);
    expect(blockTypes(assistantTurn)).toEqual(['thinking', 'tool_use']);
  });

  it('replays stored thinking to Sonnet on the next turn, and leaves it out for Haiku', async () => {
    const { server, provider } = stubbed([
      { content: [thinking, { type: 'text', text: 'First answer.' }] },
      { content: [{ type: 'text', text: 'Second answer.' }] },
      { content: [{ type: 'text', text: 'Haiku answer.' }] },
    ]);
    // One thread, two tiers: what chat/stream does when pickModelTier sends a
    // trivial turn to the Haiku variant.
    const memory = new Memory({ storage: new InMemoryStore(), options: { lastMessages: 40 } });
    const identity = { name: 'Probe', instructions: 'You are a probe.', memory };
    const sonnet = new Agent({ ...identity, id: 'probe', model: sonnetModel({ provider }) });
    const haiku = new Agent({ ...identity, id: 'probeHaiku', model: haikuModel({ provider }) });
    const thread = { memory: { resource: 'user-1', thread: 'thread-1' } };

    await (await sonnet.stream('first question', thread)).text;
    await (await sonnet.stream('second question', thread)).text;
    await (await haiku.stream('third question', thread)).text;

    const [, sonnetTurn, haikuTurn] = server.requests.map((request) => request.body);
    type Turn = { role: string; content: Array<{ type: string }> };
    const firstReply = (body: Record<string, any>): Turn =>
      (body.messages as Turn[]).find((m) => m.role === 'assistant')!;

    // Thread memory stores the block, so the conversation-binding check applies
    // across turns. This is what `drop_block` is for.
    expect(sonnetTurn.model).toBe(SONNET_MODEL_ID);
    expect(firstReply(sonnetTurn).content[0]).toEqual(thinking);

    expect(haikuTurn.model).toBe(HAIKU_MODEL_ID);
    expect(blockTypes(firstReply(haikuTurn))).toEqual(['text']);
    expect(haikuTurn).not.toHaveProperty('thinking');
  });
});

describe('what a Sonnet turn logs', () => {
  it('names the classifier when the model refuses, and counts dropped thinking blocks', async () => {
    logged.info.mockClear();
    logged.warn.mockClear();
    const { provider } = stubbed([
      {
        content: [],
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'declined' },
        inputTransformations: [
          { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
        ],
      },
    ]);
    const agent = new Agent({
      id: 'probe',
      name: 'Probe',
      instructions: 'You are a probe.',
      model: sonnetModel({ provider }),
      // One step: the loop is not under test here (see stop-conditions.test.ts).
      defaultOptions: { maxSteps: 1 },
    });

    await (await agent.stream('hi')).text;

    expect(logged.warn).toHaveBeenCalledWith('model refused the request', {
      modelId: SONNET_MODEL_ID,
      category: 'cyber',
    });
    expect(logged.info).toHaveBeenCalledWith('thinking blocks dropped', {
      modelId: SONNET_MODEL_ID,
      count: 1,
      reasons: ['prefix_binding_mismatch'],
    });
  });
});
