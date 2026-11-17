import { describe, expect, it } from 'vitest';

import { TOOL_INVENTORY, isSkipped } from '../tools/contract/tool-inventory.js';
import { PROBE_PLANS, STATIC_FIXTURE, exportNameOf } from './probes.js';
import * as toolIndex from '../tools/index.js';
import * as runTools from '../tools/run-tools.js';

type StandardSchemaLike = { '~standard': { validate: (value: unknown) => unknown } };
function inputIssues(tool: unknown, input: unknown): readonly unknown[] | undefined {
  const schema = (tool as { inputSchema?: StandardSchemaLike }).inputSchema;
  if (!schema) return undefined;
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise) throw new Error('inputSchema validated asynchronously');
  return (result as { issues?: readonly unknown[] }).issues;
}

const planned = new Map(PROBE_PLANS.map((plan) => [plan.tool, plan]));
const readTools = TOOL_INVENTORY.filter((entry) => !isSkipped(entry) && entry.writes === false);

describe('canary probe plans', () => {
  it('has a plan for every tool the inventory says reads from the app, so none can skip the canary', () => {
    expect(readTools.length).toBeGreaterThan(40);
    const missing = readTools.filter((entry) => !planned.has(entry.tool)).map((entry) => exportNameOf(entry.tool));
    expect(missing, `add a plan for these to src/mastra/canary/probes.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('plans only tools the inventory lists as read tools: a write tool must never be probed', () => {
    const readSet = new Set(readTools.map((entry) => entry.tool));
    expect(PROBE_PLANS.filter((plan) => !readSet.has(plan.tool)).map((plan) => plan.name)).toEqual([]);
  });

  it('plans no tool twice', () => {
    const names = PROBE_PLANS.map((plan) => plan.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    expect(planned.size).toBe(PROBE_PLANS.length);
  });

  it('names each plan by the key agents register that tool under', () => {
    // The app files a canary finding and a chat finding on one ticket only
    // when both name the tool the same way.
    expect(PROBE_PLANS.filter((plan) => exportNameOf(plan.tool) !== plan.name).map((plan) => plan.name)).toEqual([]);
    expect(exportNameOf(toolIndex.queryMeetingContextTool)).toBe('queryMeetingContextTool');
    // Two tools share the id "update-action"; their export names tell them apart.
    expect(exportNameOf(runTools.runUpdateActionTool)).toBe('runUpdateActionTool');
    expect(exportNameOf(toolIndex.updateActionTool)).toBe('updateActionTool');
  });

  it('gives every plan an input that passes the tool\'s own input schema', () => {
    for (const plan of PROBE_PLANS) {
      const issues = inputIssues(plan.tool, plan.input(STATIC_FIXTURE));
      expect(issues, `${plan.name}: ${JSON.stringify(issues)}`).toBeUndefined();
    }
  });

  it('names the app procedures each plan exercises, and a reason for each skip', () => {
    for (const plan of PROBE_PLANS) {
      expect(plan.procedures.length, plan.name).toBeGreaterThan(0);
      if (plan.skip !== undefined) expect(plan.skip.trim().length, plan.name).toBeGreaterThan(10);
    }
  });

  it('can supply every fixture id a plan needs from another plan', () => {
    const provided = new Set<string>(['workspaceId']);
    const sampleOutputs: unknown[] = [
      { projects: [{ id: 'p' }] },
      { products: [{ id: 'p' }] },
      { contacts: [{ id: 'c' }] },
      [{ id: 'd' }],
      { id: 'sprint' },
    ];
    for (const plan of PROBE_PLANS) {
      for (const output of sampleOutputs) {
        for (const key of Object.keys(plan.provides?.(output) ?? {})) provided.add(key);
      }
    }
    const unmet = PROBE_PLANS.flatMap((plan) => (plan.needs ?? []).filter((key) => !provided.has(key)).map((key) => `${plan.name}:${key}`));
    expect(unmet).toEqual([]);
  });

  it('never lets a plan that needs an id supply ids (the canary runs in two passes)', () => {
    expect(PROBE_PLANS.filter((plan) => plan.needs?.length && plan.provides).map((plan) => plan.name)).toEqual([]);
  });
});
