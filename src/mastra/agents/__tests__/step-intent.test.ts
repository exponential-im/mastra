import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { Tool, createTool } from '@mastra/core/tools';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { STEP_INTENT_DESCRIPTION, withStepIntent, withToolStepIntent } from '../step-intent.js';
import { agentTools } from '../toolsets.js';

const shapeOf = (tool: unknown) => ((tool as Tool).inputSchema as unknown as z.AnyZodObject).shape;

function makeTool(execute = vi.fn(async (input: unknown) => ({ got: input }))) {
  const tool = createTool({
    id: 'find-tickets',
    description: 'Find tickets',
    inputSchema: z.object({ assignee: z.string(), limit: z.number().optional() }),
    outputSchema: z.object({ got: z.unknown() }),
    requireApproval: true,
    execute,
  });
  return { tool, execute };
}

describe('withToolStepIntent', () => {
  it('adds an optional intent string of at most 120 characters, with the agreed description', () => {
    const { tool } = makeTool();
    const wrapped = withToolStepIntent(tool);
    const intent = shapeOf(wrapped).intent as z.ZodTypeAny;

    expect(intent).toBeDefined();
    expect(intent.description).toBe(STEP_INTENT_DESCRIPTION);
    expect(STEP_INTENT_DESCRIPTION).toBe(
      "Five to ten words that tell the person what this call is for. Start with a verb. Use names, not ids. Example: Find Andi's open tickets in Cycle 17.",
    );
    expect(intent.safeParse(undefined).success).toBe(true);
    expect(intent.safeParse('x'.repeat(120)).success).toBe(true);
    expect(intent.safeParse('x'.repeat(121)).success).toBe(false);
    // The tool's own fields are still there.
    expect(Object.keys(shapeOf(wrapped))).toEqual(['assignee', 'limit', 'intent']);
  });

  it('removes intent before the tool\'s own execute runs', async () => {
    const { tool, execute } = makeTool();
    const wrapped = withToolStepIntent(tool);

    const result = await wrapped.execute!(
      { assignee: 'Andi', intent: "Find Andi's open tickets in Cycle 17" } as never,
      undefined as never,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ assignee: 'Andi' });
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('intent');
    expect(result).toEqual({ got: { assignee: 'Andi' } });
  });

  it('runs the tool unchanged when the model leaves intent out', async () => {
    const { tool, execute } = makeTool();
    await withToolStepIntent(tool).execute!({ assignee: 'Andi', limit: 3 } as never, undefined as never);
    expect(execute.mock.calls[0]![0]).toEqual({ assignee: 'Andi', limit: 3 });
  });

  it('rejects an intent over 120 characters without calling the tool', async () => {
    const { tool, execute } = makeTool();
    const result = await withToolStepIntent(tool).execute!(
      { assignee: 'Andi', intent: 'x'.repeat(121) } as never,
      undefined as never,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: true });
  });

  it('keeps the tool id, description and other options', () => {
    const { tool } = makeTool();
    const wrapped = withToolStepIntent(tool);
    expect(wrapped).toBeInstanceOf(Tool);
    expect(wrapped).not.toBe(tool);
    expect(wrapped.id).toBe(tool.id);
    expect(wrapped.description).toBe(tool.description);
    expect(wrapped.requireApproval).toBe(true);
    expect(wrapped.outputSchema).toBe(tool.outputSchema);
  });

  it('returns the same wrapped instance for the same tool', () => {
    const { tool } = makeTool();
    expect(withToolStepIntent(tool)).toBe(withToolStepIntent(tool));
  });

  it('refuses a tool that declares its own intent field', () => {
    const tool = createTool({
      id: 'clashing',
      description: 'Has its own intent',
      inputSchema: z.object({ intent: z.string() }),
      execute: async () => ({}),
    });
    expect(() => withToolStepIntent(tool)).toThrow(/declares its own "intent" field/);
  });
});

describe('withStepIntent', () => {
  it('wraps function tools and leaves provider tools untouched', () => {
    const { tool } = makeTool();
    const webSearch = anthropic.tools.webSearch_20250305({ maxUses: 5 });
    const webFetch = anthropic.tools.webFetch_20250910({ maxUses: 3 });
    const toolSearch = anthropic.tools.toolSearchBm25_20251119();

    const out = withStepIntent({ findTickets: tool, webSearch, webFetch, toolSearch });

    expect(shapeOf(out.findTickets)).toHaveProperty('intent');
    expect(out.webSearch).toBe(webSearch);
    expect(out.webFetch).toBe(webFetch);
    expect(out.toolSearch).toBe(toolSearch);
  });

  it('is applied by agentTools for both profiles', () => {
    const { tool } = makeTool();
    const anthropicTools = agentTools({ findTickets: tool }, 'anthropic') as Record<string, unknown>;
    expect(shapeOf(anthropicTools.findTickets)).toHaveProperty('intent');

    const resolve = agentTools({ findTickets: tool }, 'generic') as (a: object) => Record<string, unknown>;
    expect(shapeOf(resolve({}).findTickets)).toHaveProperty('intent');
  });
});

// Every tool module, scanned the way tool-contract.test.ts does it. Importing
// the agents would boot the Postgres memory store.
describe('tool schemas', () => {
  it('no tool declares its own intent field (it is reserved for the step label)', async () => {
    const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
    const clashes: string[] = [];
    let count = 0;
    for (const name of readdirSync(toolsDir).sort()) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
      const mod = (await import(pathToFileURL(path.join(toolsDir, name)).href)) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        if (!(value instanceof Tool) || !(value.inputSchema instanceof z.ZodObject)) continue;
        count++;
        if ('intent' in shapeOf(value)) clashes.push(`${name}: ${value.id}`);
      }
    }
    expect(count).toBeGreaterThan(100);
    expect(clashes).toEqual([]);
  });
});
