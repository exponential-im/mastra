#!/usr/bin/env npx tsx
/**
 * Live smoke test (exponential ticket 962): one real turn of the Assistant
 * agent, with one real tool call, against a real Anthropic model.
 *
 *   npm run smoke:live                 # against a local app (needs SMOKE_AUTH_TOKEN)
 *   npm run smoke:live -- --stub-app   # no app needed; what CI runs
 *
 * It prints the reply, the tool calls and the token cost, and exits non-zero
 * unless the agent called the expected tool and answered from its result.
 *
 * - The agent is this working tree: the Assistant's instructions, model,
 *   options and tools are imported from agents/assistant-agent.ts, so an edit
 *   to any of them is what gets exercised. It runs without memory, so nothing
 *   reads or writes the memory store.
 * - Tools really execute. The prompt asks a read-only question, and the app
 *   must be on this machine: a local `next dev`, or the built-in stub.
 * - The key is ANTHROPIC_API_KEY_DEV and nothing else (see dev-key.ts). This
 *   costs real money, a few cents a run.
 *
 * Run it through the npm script so .env is loaded when there is one.
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { costUsd, sumUsage, type StepUsage, type TokenTotals } from './cost.js';
import { DEV_KEY_ENV, DevKeyRefusal, PRODUCTION_KEY_ENV, resolveDevKey } from './dev-key.js';
import { STUB_ACTION_NAME, STUB_AUTH_TOKEN, startStubApp, type StubApp } from './stub-app.js';

export const DEFAULT_PROMPT = "What's on my plate today? List my actions by name.";
/** The tool the default prompt must reach, by its key in assistantTools. */
export const DEFAULT_EXPECTED_TOOL = 'getTodaysActionsTool';
const TURN_TIMEOUT_MS = 180_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface SmokeOptions {
  prompt: string;
  /** Bearer token the tools send to the app. */
  authToken: string;
  userId?: string;
  expectedTool: string;
  /** Text the reply must contain: proof the tool result reached the model. */
  expectedText?: string;
}

export interface SmokeToolCall {
  name: string;
  args: unknown;
  /** false when the tool threw or returned an error. */
  ok: boolean;
  resultPreview: string;
}

export interface SmokeReport {
  passed: boolean;
  failures: string[];
  model: string;
  reply: string;
  finishReason: string;
  steps: number;
  toolCalls: SmokeToolCall[];
  tokens: TokenTotals;
  /** List-price USD, or null for a model with no price in cost.ts. */
  costUsd: number | null;
  durationMs: number;
}

interface ToolChunk {
  payload?: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    error?: unknown;
  };
}

interface TurnStep {
  usage?: StepUsage;
  toolCalls?: ToolChunk[];
  toolResults?: ToolChunk[];
  response?: { modelId?: string };
}

interface TurnResult {
  text?: string;
  finishReason?: string;
  steps?: TurnStep[];
  error?: unknown;
}

const preview = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

function resultFailed(chunk: ToolChunk | undefined): boolean {
  if (!chunk?.payload) return true;
  const { isError, error, result } = chunk.payload;
  if (isError || error) return true;
  return Boolean(
    result && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error,
  );
}

/**
 * Runs the turn and grades it. The caller owns the environment: the Anthropic
 * key and TODO_APP_BASE_URL must be set BEFORE this is called, because the
 * agent modules read them when they are first imported (hence the dynamic
 * imports here).
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  // The memory module builds a Postgres store on import. The smoke agent has
  // no memory, so the store is never connected; it only needs a URL to parse.
  process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:9/unused';

  const { Agent } = await import('@mastra/core/agent');
  const { RequestContext } = await import('@mastra/core/request-context');
  const { INSTRUCTIONS, assistantModel, assistantDefaultOptions, assistantTools } = await import(
    '../agents/assistant-agent.js'
  );

  const agent = new Agent({
    id: 'assistantAgentSmoke',
    name: 'Assistant (live smoke)',
    instructions: INSTRUCTIONS,
    model: assistantModel,
    defaultOptions: assistantDefaultOptions,
    tools: assistantTools as ConstructorParameters<typeof Agent>[0]['tools'],
  });

  const requestContext = new RequestContext<Record<string, string>>([
    ['authToken', options.authToken],
    ...(options.userId ? ([['userId', options.userId]] as Array<[string, string]>) : []),
  ]);

  const startedAt = Date.now();
  const result = (await agent.generate(options.prompt, {
    requestContext,
    abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  } as never)) as TurnResult;
  const durationMs = Date.now() - startedAt;

  const steps = result.steps ?? [];
  const results = new Map<string, ToolChunk>();
  for (const chunk of steps.flatMap((step) => step.toolResults ?? [])) {
    if (chunk.payload?.toolCallId) results.set(chunk.payload.toolCallId, chunk);
  }
  const toolCalls: SmokeToolCall[] = steps
    .flatMap((step) => step.toolCalls ?? [])
    .map((call) => {
      const outcome = results.get(call.payload?.toolCallId ?? '');
      return {
        name: call.payload?.toolName ?? 'unknown',
        args: call.payload?.args,
        ok: !resultFailed(outcome),
        resultPreview: preview(outcome?.payload?.result ?? outcome?.payload?.error ?? '(no result)'),
      };
    });

  const reply = (result.text ?? '').trim();
  const failures: string[] = [];
  if (result.error) failures.push(`the turn ended in an error: ${preview(String(result.error))}`);
  if (!reply) failures.push(`the agent gave no reply (finish reason: ${result.finishReason ?? 'unknown'})`);
  // A real model reaches a deferred tool through tool search and calls it by
  // its id (get-todays-actions); a direct call uses the map key. Accept both.
  const expectedId = (assistantTools as Record<string, { id?: string }>)[options.expectedTool]?.id;
  const expected = toolCalls.filter((call) => call.name === options.expectedTool || call.name === expectedId);
  if (expected.length === 0) {
    failures.push(`the agent never called ${options.expectedTool}`);
  } else if (!expected.some((call) => call.ok)) {
    failures.push(`${options.expectedTool} was called but failed: ${expected[0].resultPreview}`);
  }
  if (options.expectedText && !reply.includes(options.expectedText)) {
    failures.push(`the reply does not mention "${options.expectedText}", which only the tool result contains`);
  }

  const model = steps[0]?.response?.modelId ?? String((assistantModel as { modelId?: string }).modelId);
  const tokens = sumUsage(steps);
  return {
    passed: failures.length === 0,
    failures,
    model,
    reply,
    finishReason: result.finishReason ?? 'unknown',
    steps: steps.length,
    toolCalls,
    tokens,
    costUsd: costUsd(model, tokens),
    durationMs,
  };
}

const formatCost = (usd: number | null): string =>
  usd === null ? 'unknown (no price for this model in smoke/cost.ts)' : `$${usd.toFixed(4)}`;

export function formatReport(report: SmokeReport): string {
  const { tokens } = report;
  const lines = [
    `Live smoke: ${report.passed ? 'PASSED' : 'FAILED'}`,
    ...report.failures.map((failure) => `  - ${failure}`),
    '',
    `Model:   ${report.model}`,
    `Steps:   ${report.steps} model call(s), ${(report.durationMs / 1000).toFixed(1)}s, finish reason ${report.finishReason}`,
    `Tokens:  ${tokens.input} input, ${tokens.cacheWrite} cache write, ${tokens.cacheRead} cache read, ${tokens.output} output`,
    `Cost:    ${formatCost(report.costUsd)} at list price`,
    '',
    `Tool calls (${report.toolCalls.length}):`,
    ...report.toolCalls.map(
      (call) => `  ${call.ok ? 'ok    ' : 'FAILED'} ${call.name}(${preview(call.args)}) -> ${call.resultPreview}`,
    ),
    '',
    'Reply:',
    report.reply || '(empty)',
  ];
  return lines.join('\n');
}

function formatSummaryMarkdown(report: SmokeReport, appLabel: string): string {
  const { tokens } = report;
  return [
    `## Live smoke: ${report.passed ? 'passed' : 'FAILED'}`,
    '',
    ...report.failures.map((failure) => `- ${failure}`),
    '',
    `| | |`,
    `|---|---|`,
    `| Model | \`${report.model}\` |`,
    `| App | ${appLabel} |`,
    `| Model calls | ${report.steps} |`,
    `| Tool calls | ${report.toolCalls.map((call) => `\`${call.name}\`${call.ok ? '' : ' (failed)'}`).join(', ') || 'none'} |`,
    `| Tokens | ${tokens.input} input, ${tokens.cacheWrite} cache write, ${tokens.cacheRead} cache read, ${tokens.output} output |`,
    `| Cost (list price) | ${formatCost(report.costUsd)} |`,
    '',
    '<details><summary>Reply</summary>',
    '',
    report.reply || '(empty)',
    '',
    '</details>',
    '',
  ].join('\n');
}

function usage(): never {
  console.error(
    [
      'Usage: npm run smoke:live -- [--stub-app | --app <url>] [--prompt <text>] [--expect-tool <key>] [--json <file>]',
      '',
      `  ${DEV_KEY_ENV}   required. The capped development key. ${PRODUCTION_KEY_ENV} is never used.`,
      '  SMOKE_AUTH_TOKEN        required without --stub-app. An agent token for the local app:',
      '                          in the app checkout, `npm run -s dev:agent-token`.',
      '  --stub-app              answer the tool call from a built-in stub instead of a running app.',
      '  --app <url>             the local app (default: TODO_APP_BASE_URL, else http://localhost:3000).',
    ].join('\n'),
  );
  process.exit(2);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

/** The smoke test only talks to an app on this machine. */
export function assertLocalUrl(url: string, what: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new DevKeyRefusal(`${what} is not a URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new DevKeyRefusal(
      `Refusing to run: ${what} is ${host}, not this machine. The smoke test executes real tools, ` +
        `so it only runs against a local app or --stub-app.`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage();
  const useStub = args.includes('--stub-app');
  const prompt = flagValue(args, '--prompt') ?? DEFAULT_PROMPT;
  const expectedTool = flagValue(args, '--expect-tool') ?? DEFAULT_EXPECTED_TOOL;
  const jsonPath = flagValue(args, '--json');

  const devKey = resolveDevKey();
  // The dev key must only ever be sent to Anthropic (or a loopback stand-in).
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl && new URL(baseUrl).hostname === 'api.anthropic.com') {
    // Anthropic's own API: use the provider's default. Claude Code exports
    // ANTHROPIC_BASE_URL=https://api.anthropic.com without the /v1 that
    // @ai-sdk/anthropic expects, which turns every call into a 404.
    delete process.env.ANTHROPIC_BASE_URL;
  } else if (baseUrl) {
    assertLocalUrl(baseUrl, 'ANTHROPIC_BASE_URL');
  }
  // In this process only: every Anthropic call the agent makes now spends the
  // development key, whatever ANTHROPIC_API_KEY held.
  process.env[PRODUCTION_KEY_ENV] = devKey;

  let stub: StubApp | undefined;
  let appUrl: string;
  let authToken: string;
  if (useStub) {
    stub = await startStubApp();
    appUrl = stub.url;
    authToken = STUB_AUTH_TOKEN;
  } else {
    appUrl = flagValue(args, '--app') ?? process.env.TODO_APP_BASE_URL ?? 'http://localhost:3000';
    assertLocalUrl(appUrl, 'the app URL');
    const token = process.env.SMOKE_AUTH_TOKEN?.trim();
    if (!token) {
      throw new DevKeyRefusal(
        'SMOKE_AUTH_TOKEN is not set. Mint one in the app checkout with `npm run -s dev:agent-token` ' +
          '(it lasts 30 minutes), or pass --stub-app to run without an app.',
      );
    }
    authToken = token;
  }
  process.env.TODO_APP_BASE_URL = appUrl;
  const appLabel = useStub ? 'built-in stub' : appUrl;

  console.error(`[live-smoke] app: ${appLabel}; prompt: ${JSON.stringify(prompt)}`);
  try {
    const report = await runSmoke({
      prompt,
      authToken,
      expectedTool,
      // Only the stub's data is known in advance; a local app's is not.
      expectedText: useStub && prompt === DEFAULT_PROMPT ? STUB_ACTION_NAME : undefined,
    });
    console.log(`\n${formatReport(report)}`);
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummaryMarkdown(report, appLabel));
    }
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await stub?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error: unknown) => {
      if (error instanceof DevKeyRefusal) {
        console.error(`[live-smoke] ${error.message}`);
        process.exitCode = 2;
      } else {
        // Name, message and status only: the full provider error carries the
        // whole request (85 tool schemas) and buries the one useful line.
        const { name, message, statusCode } = error as { name?: string; message?: string; statusCode?: number };
        console.error(
          `[live-smoke] FAILED before a reply: ${name ?? 'Error'}${statusCode ? ` (HTTP ${statusCode})` : ''}: ${message ?? String(error)}`,
        );
        process.exitCode = 1;
      }
    })
    // The agent modules leave handles open (pg pool, loggers).
    .finally(() => process.exit(process.exitCode ?? 0));
}
