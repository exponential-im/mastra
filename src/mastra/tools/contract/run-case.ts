/**
 * Runs one tool with a sample input and records the requests it sends to the
 * app. Nothing leaves the process: the caller replaces the transport
 * (`authenticatedTrpcCall`, `authenticatedTrpcQuery`) with `recorder`.
 */
import { parseEndpoint, type AppCall } from './contract.js';
import type { AnyTool, ContractCase } from './tool-inventory.js';

/** The request context of an ordinary chat turn in a workspace. */
export const DEFAULT_CONTEXT: Record<string, string> = {
  authToken: 'contract-test-token',
  userId: 'user_contract',
  workspaceId: 'ws_contract',
};

interface Recording {
  calls: AppCall[];
  responses: Record<string, unknown>;
}

let active: Recording | null = null;

function respond(procedure: string): { data: unknown } {
  if (!active) throw new Error(`${procedure} was called outside a contract case`);
  const data = procedure in active.responses ? active.responses[procedure] : {};
  // A fresh copy each time: tools change the data they get back.
  return { data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) };
}

/** Stand-ins for the transport. They record the request and return canned data. */
export const recorder = {
  trpcCall(endpoint: string, input: unknown): Promise<{ data: unknown }> {
    const { procedure } = parseEndpoint(endpoint);
    active?.calls.push({ method: 'POST', procedure, payload: input });
    return Promise.resolve(respond(procedure));
  },
  trpcQuery(endpoint: string): Promise<{ data: unknown }> {
    const { procedure, payload, malformed } = parseEndpoint(endpoint);
    active?.calls.push({ method: 'GET', procedure, payload, malformed });
    return Promise.resolve(respond(procedure));
  },
};

export interface CaseRun {
  calls: AppCall[];
  /** What `execute` returned. Mastra returns an input-validation failure, it does not throw one. */
  result: unknown;
  /** What `execute` threw, if anything. A tool often throws on the canned response, after the request. */
  error: unknown;
}

export async function runCase(tool: AnyTool, contractCase: ContractCase): Promise<CaseRun> {
  const context = new Map<string, string>();
  for (const [key, value] of Object.entries({ ...DEFAULT_CONTEXT, ...contractCase.context })) {
    if (value !== undefined) context.set(key, value);
  }

  const recording: Recording = { calls: [], responses: contractCase.responses ?? {} };
  active = recording;
  let result: unknown;
  let error: unknown;
  try {
    result = await tool.execute!(contractCase.input as never, { requestContext: context } as never);
  } catch (thrown) {
    error = thrown;
  } finally {
    active = null;
  }
  return { calls: recording.calls, result, error };
}

/** Why a case sent nothing, in words: the sample input was wrong, or the tool threw first. */
export function whyNoCall(run: CaseRun): string {
  const result = run.result as { error?: boolean; message?: string } | undefined;
  if (result?.error === true && typeof result.message === 'string') {
    return `Mastra rejected the sample input before the tool ran:\n${result.message}`;
  }
  if (run.error) {
    return `the tool threw before it called the app: ${run.error instanceof Error ? run.error.message : String(run.error)}`;
  }
  return 'the tool returned without calling the app';
}
