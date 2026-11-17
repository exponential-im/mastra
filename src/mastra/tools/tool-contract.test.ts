/**
 * Contract test: every agent tool sends the app a request the app accepts.
 *
 * Each case in the tool inventory runs the tool's `execute` with a sample
 * input and a turn's request context. The transport is replaced, so nothing
 * leaves the process and no model is called. The request the tool hands to the
 * transport is checked against `contracts/agent-procedures.json`, the app's
 * own description of each procedure's input.
 *
 * How it works, and what to do when it fails: docs/tool-contracts.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import { recorder, runCase, whyNoCall } from './contract/run-case.js';

vi.mock('../utils/authenticated-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatedTrpcCall: (endpoint: string, input: unknown) => recorder.trpcCall(endpoint, input),
  authenticatedTrpcQuery: (endpoint: string) => recorder.trpcQuery(endpoint),
  authenticatedFetch: (options: { url: string }) => {
    throw new Error(`authenticatedFetch(${options.url}) is not a tRPC call: the contract cannot check it`);
  },
}));

// No case may reach the network. A tool that calls another service belongs in the skip list.
vi.stubGlobal('fetch', (input: unknown) => {
  throw new Error(`fetch(${String(input)}) from a contract case: the contract test makes no network calls`);
});

import { ContractChecker, type AgentProcedureContract, type Violation } from './contract/contract.js';
import {
  TOOL_INVENTORY,
  isSkipped,
  type AnyTool,
  type CoveredTool,
  type KnownViolation,
} from './contract/tool-inventory.js';

const contract = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'contracts/agent-procedures.json'), 'utf8'),
) as AgentProcedureContract;
const checker = new ContractChecker(contract);

// Every tool module in this directory, and its source text.
const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const toolModules: Record<string, Record<string, unknown>> = {};
const toolSources: Record<string, string> = {};
for (const name of readdirSync(TOOLS_DIR).sort()) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
  const file = path.join(TOOLS_DIR, name);
  toolModules[`./${name}`] = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
  toolSources[`./${name}`] = readFileSync(file, 'utf8');
}

function isTool(value: unknown): value is AnyTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnyTool).id === 'string' &&
    typeof (value as AnyTool).execute === 'function'
  );
}

/** Each tool once, with the file that defines it. `index.ts` re-exports the others. */
function discoverTools(): Map<AnyTool, string> {
  const found = new Map<AnyTool, string>();
  for (const [file, exports] of Object.entries(toolModules)) {
    for (const value of Object.values(exports)) {
      if (!isTool(value)) continue;
      if (!found.has(value) || found.get(value) === './index.ts') found.set(value, file);
    }
  }
  return found;
}

/**
 * Files with a call site whose endpoint is a variable, and how many. The scan
 * below cannot read the procedure there. The cases still check the request.
 */
const COMPUTED_CALL_SITES: Record<string, number> = {
  // get-all-projects builds `project.getAll` with or without `?input=`.
  './index.ts': 1,
};

/**
 * Every call to the transport in a source file. `procedure` is the literal
 * first argument (`"router.procedure"` or a `router.procedure?input=…`
 * template), or `null` when the endpoint is computed.
 */
function findCallSites(source: string): { procedure: string | null }[] {
  const callSite = /authenticatedTrpc(?:Call|Query)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:["'`]([A-Za-z]\w*\.\w+))?/g;
  return [...source.matchAll(callSite)].map((match) => ({ procedure: match[1] ?? null }));
}

const discovered = discoverTools();
const covered = TOOL_INVENTORY.filter((entry): entry is CoveredTool => !isSkipped(entry));

/** The procedures each file's cases reached, filled in as the cases run. */
const reachedByFile = new Map<string, Set<string>>();

const same = (known: KnownViolation, actual: Violation) =>
  known.procedure === actual.procedure && known.field === actual.field && known.rule === actual.rule;

describe('tool inventory', () => {
  it('lists every tool in src/mastra/tools, once', () => {
    const listed = TOOL_INVENTORY.map((entry) => entry.tool);
    const missing = [...discovered.entries()]
      .filter(([tool]) => !listed.includes(tool))
      .map(([tool, file]) => `${tool.id} (${file})`);
    expect(
      missing,
      'These tools have no entry in src/mastra/tools/contract/tool-inventory.ts. ' +
        'Add a contract case for each, or a skip with the reason.',
    ).toEqual([]);

    const duplicates = listed.filter((tool, index) => listed.indexOf(tool) !== index).map((tool) => tool?.id);
    expect(duplicates, 'These tools are listed more than once.').toEqual([]);
  });

  it('lists only tools that exist', () => {
    const gone = TOOL_INVENTORY.filter((entry) => !isTool(entry.tool) || !discovered.has(entry.tool));
    expect(
      gone.map((entry) => entry.tool?.id ?? '(undefined import)'),
      'These inventory entries point at a tool that src/mastra/tools no longer exports.',
    ).toEqual([]);
  });

  it('gives every skipped tool a reason and every covered tool a case', () => {
    for (const entry of TOOL_INVENTORY) {
      if (isSkipped(entry)) {
        expect(entry.skip.trim().length, `${entry.tool.id} is skipped with no reason`).toBeGreaterThan(10);
      } else {
        expect(entry.cases.length, `${entry.tool.id} has no contract case`).toBeGreaterThan(0);
      }
    }
  });
});

describe('tool requests match the app procedures', () => {
  it.each(covered.map((entry) => [entry.tool.id, entry] as const))('%s', async (toolId, entry) => {
    const violations: Violation[] = [];
    const file = discovered.get(entry.tool) ?? '(unknown file)';
    const reached = reachedByFile.get(file) ?? new Set<string>();
    reachedByFile.set(file, reached);

    for (const contractCase of entry.cases) {
      const run = await runCase(entry.tool, contractCase);
      const label = contractCase.name ? `${toolId} [${contractCase.name}]` : toolId;
      expect(
        run.calls.length,
        `${label} sent nothing to the app, so the case checks nothing: ${whyNoCall(run)}`,
      ).toBeGreaterThan(0);

      for (const call of run.calls) {
        reached.add(call.procedure);
        violations.push(...checker.checkCall(call));
      }
    }

    const known = entry.knownViolations ?? [];
    const unexpected = violations.filter((actual) => !known.some((k) => same(k, actual)));
    expect(
      unexpected.map((v) => `${toolId} → ${v.message}`),
      `${toolId} sends a request the app rejects. Fix the tool, or the app procedure and its contract.`,
    ).toEqual([]);

    const stale = known.filter((k) => !violations.some((actual) => same(k, actual)));
    expect(
      stale.map((k) => `${toolId} → ${k.procedure}: ${k.field || 'the input'} (${k.rule}), ${k.ticket}`),
      `${toolId} no longer breaks the contract here. Remove the knownViolations entry from tool-inventory.ts.`,
    ).toEqual([]);
  });

  // Runs after the cases above: it reads what they reached.
  it('every procedure a tool file names is reached by a case in that file', () => {
    const unreached: string[] = [];
    const unreadable: string[] = [];
    for (const [file, source] of Object.entries(toolSources)) {
      const reached = reachedByFile.get(file) ?? new Set<string>();
      let computed = 0;
      for (const site of findCallSites(source)) {
        if (site.procedure === null) computed += 1;
        else if (!reached.has(site.procedure)) unreached.push(`${file}: ${site.procedure}`);
      }
      const declared = COMPUTED_CALL_SITES[file] ?? 0;
      if (computed !== declared) unreadable.push(`${file}: ${computed} found, ${declared} declared`);
    }
    expect(
      [...new Set(unreached)],
      'These procedures are called in tool source, and no contract case reaches them. ' +
        'Add a case for the tool, or for the branch of the tool, that makes the call.',
    ).toEqual([]);
    expect(
      unreadable,
      'A call site builds its endpoint at run time, so this scan cannot read the procedure. ' +
        'Check that a contract case reaches it, then set the count in COMPUTED_CALL_SITES.',
    ).toEqual([]);
  });
});
