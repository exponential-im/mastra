import { describe, it, expect, vi } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { sonnetModel } from '../../utils/anthropic-models.js';
import { scriptedAnthropic, type ScriptedReply } from '../../utils/anthropic-test-server.js';
import { refused, stepLimit } from '../stop-conditions.js';

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// A real Mastra agent on the Sonnet model against a scripted Messages
// endpoint: how many requests one turn makes is the thing under test.

const refusal: ScriptedReply = {
  content: [{ type: 'text', text: 'I can’t help with that.' }],
  stopReason: 'refusal',
  stopDetails: { type: 'refusal', category: 'cyber', explanation: 'declined' },
};
const toolCall = (n: number): ScriptedReply => ({
  content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'lookup', input: { q: 'x' } }],
  stopReason: 'tool_use',
});

function probe(replies: ScriptedReply[], defaultOptions: Record<string, unknown>) {
  const server = scriptedAnthropic(replies);
  const provider = createAnthropic({ apiKey: 'test', fetch: server.fetch });
  const agent = new Agent({
    id: 'probe',
    name: 'Probe',
    instructions: 'You are a probe.',
    model: sonnetModel({ provider }),
    tools: {
      lookup: createTool({
        id: 'lookup',
        description: 'Look something up',
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ({ answer: 42 }),
      }),
    },
    defaultOptions: defaultOptions as never,
  });
  return { server, agent };
}

describe('stepLimit', () => {
  it('ends the turn on the step where the model refuses', async () => {
    const { server, agent } = probe(Array.from({ length: 12 }, () => refusal), {
      stopWhen: stepLimit(12),
    });

    const result = await agent.stream('hi');

    expect(await result.text).toBe('I can’t help with that.');
    expect(await result.finishReason).toBe('content-filter');
    expect(server.requests).toHaveLength(1);
  });

  it('is what stops it: with only a step cap, a refusal is re-sent on every step', async () => {
    const { server, agent } = probe(Array.from({ length: 4 }, () => refusal), { maxSteps: 4 });

    await (await agent.stream('hi')).text;

    expect(server.requests).toHaveLength(4);
  });

  it('still caps a turn that keeps calling tools', async () => {
    const { server, agent } = probe([toolCall(1), toolCall(2), toolCall(3), toolCall(4)], {
      stopWhen: stepLimit(3),
    });

    await (await agent.stream('hi')).text;

    expect(server.requests).toHaveLength(3);
  });
});

describe('refused', () => {
  it('looks only at the latest step', () => {
    expect(refused({ steps: [{ finishReason: 'content-filter' }] })).toBe(true);
    expect(refused({ steps: [{ finishReason: 'content-filter' }, { finishReason: 'tool-calls' }] })).toBe(false);
    expect(refused({ steps: [] })).toBe(false);
  });
});
