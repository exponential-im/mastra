/**
 * Tool canary (ticket 959, `deep.moon`).
 *
 * Calls every agent tool that reads from the app, directly and with a fixed
 * input, against a NON-PRODUCTION app, and reports the ones that fail. No
 * model is involved: there is no agent, no prompt and no memory, only
 * `tool.execute`.
 *
 * A contract test proves the request shape. This proves the rest: auth, access
 * rules, a renamed column, an output that fails the tool's own schema. A tool
 * can fail on every call for months while the agent narrates around it
 * (`query-meeting-context`, ticket 957); the first sign should not be a
 * person's chat.
 *
 * The tools come from the one inventory the contract tests own
 * (`tools/contract/tool-inventory.ts`, ticket 958): it says which tools write
 * and which never call the app. How to call a read tool against a live app is
 * in `probes.ts`. Every inventory entry ends up in the report as `ok`,
 * `failed` or `skipped` with a reason. Nothing is left out silently.
 *
 * Deciding what to do with a failure (file a ticket, post to the ops room)
 * is the app's job: it owns the ticket ingest. This module only reports.
 */
import { RequestContext } from '@mastra/core/request-context';

import { TOOL_INVENTORY, isSkipped, type InventoryEntry } from '../tools/contract/tool-inventory.js';
import { authenticatedTrpcCall, withAppBaseUrl } from '../utils/authenticated-fetch.js';
import { PROBE_PLANS, exportNameOf, type FixtureKey, type ProbePlan, type ToolFixture } from './probes.js';

/** What a tool does to the app. Only `read` tools are ever called. */
export type ToolKind = 'read' | 'write' | 'external';

export type ToolProbeStatus = 'ok' | 'failed' | 'skipped';

/**
 * How a probe failed.
 *  - `threw`: the tool raised (the app rejected the call, or it could not be reached)
 *  - `output-schema`: the app answered, and the answer fails the tool's own output schema
 *  - `input-schema`: the inventory's sample input fails the tool's input schema (a stale sample)
 *  - `timeout`: no answer within the per-tool limit, or the run's time budget ran out
 */
export type ToolProbeErrorKind = 'threw' | 'output-schema' | 'input-schema' | 'timeout';

export interface ToolProbeResult {
  /** The key agents register the tool under, e.g. `queryMeetingContextTool`. */
  name: string;
  toolId: string;
  kind: ToolKind;
  procedures: readonly string[];
  status: ToolProbeStatus;
  durationMs?: number;
  /** Why a tool was skipped. Always present when `status` is `skipped`. */
  reason?: string;
  errorKind?: ToolProbeErrorKind;
  /** The failure text, with the canary's token removed and capped. */
  error?: string;
  /** The app embedded the probe query to answer (embedding tokens, no chat model). */
  embeds?: boolean;
}

export type PreflightFailureKind = 'unreachable' | 'auth' | 'workspace';

export interface ToolCanaryReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: { origin: string; workspaceId: string };
  /** Whether the target answered at all. When it did not, no tool is blamed. */
  preflight: { ok: true } | { ok: false; kind: PreflightFailureKind; error: string };
  tools: ToolProbeResult[];
  counts: { total: number; ok: number; failed: number; skipped: number };
}

export interface ToolCanaryTarget {
  /** Origin of the non-production app, e.g. https://staging.example.com */
  baseUrl: string;
  /** A bearer credential that app accepts, for a member of the fixture workspace. */
  authToken: string;
  /** The fixture workspace every probe is scoped to. */
  workspaceId: string;
}

export interface ToolCanaryOptions {
  /** The tools to report on. Default: the contract tests' inventory. */
  inventory?: readonly InventoryEntry[];
  /** How to call the read tools among them. Default: `PROBE_PLANS`. */
  plans?: readonly ProbePlan[];
  /** Per-tool limit. Default 20s. */
  toolTimeoutMs?: number;
  /** Whole-run limit; probes not started by then are reported as timed out. Default 4 minutes. */
  budgetMs?: number;
  /** Probes in flight at once. Default 6. */
  concurrency?: number;
  now?: () => number;
}

const SKIP_WRITE = 'write tool: the canary never calls a tool that changes data';
const SKIP_NO_PLAN = 'no live probe is written for this tool yet: add one to src/mastra/canary/probes.ts';
/**
 * Generous on purpose: a tRPC error names its procedure at the END of the
 * envelope (after the message, and after a stack trace on a dev server), and
 * the app builds the ticket title from that name. The app trims what it
 * stores.
 */
const MAX_ERROR_CHARS = 8000;

const FIXTURE_LABEL: Record<FixtureKey, string> = {
  workspaceId: 'workspace',
  projectId: 'project',
  productId: 'product',
  contactId: 'contact',
  documentId: 'document',
  sprintListId: 'active sprint',
};

// ---------------------------------------------------------------------------
// Target: refuse anything that could be production
// ---------------------------------------------------------------------------

/** Hosts the canary will never call, whatever the configuration says. */
const PRODUCTION_HOSTS = new Set(['exponential.im', 'www.exponential.im', 'app.exponential.im']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

export type CanaryTargetResolution =
  | { ok: true; target: ToolCanaryTarget }
  | { ok: false; reason: string };

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Read the canary's target from the environment and refuse unsafe ones.
 *
 * The canary runs inside the production assistant service, so "which app" is
 * the one thing that must not be left to a default. It runs only when all
 * three variables are set, and never against:
 *  - a known production host (plus any listed in TOOL_CANARY_FORBIDDEN_HOSTS);
 *  - the app this service itself serves (TODO_APP_BASE_URL), unless that is a
 *    local address, which is the developer-laptop case.
 */
export function resolveCanaryTarget(env: Record<string, string | undefined> = process.env): CanaryTargetResolution {
  const rawUrl = env.TOOL_CANARY_APP_URL?.trim();
  const authToken = env.TOOL_CANARY_AUTH_TOKEN?.trim();
  const workspaceId = env.TOOL_CANARY_WORKSPACE_ID?.trim();

  const missing = [
    !rawUrl && 'TOOL_CANARY_APP_URL',
    !authToken && 'TOOL_CANARY_AUTH_TOKEN',
    !workspaceId && 'TOOL_CANARY_WORKSPACE_ID',
  ].filter(Boolean);
  if (!rawUrl || !authToken || !workspaceId) {
    return { ok: false, reason: `not configured: set ${missing.join(', ')}` };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'TOOL_CANARY_APP_URL is not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'TOOL_CANARY_APP_URL must be http or https' };
  }

  const host = url.hostname.toLowerCase();
  const forbidden = new Set(PRODUCTION_HOSTS);
  for (const extra of (env.TOOL_CANARY_FORBIDDEN_HOSTS ?? '').split(',')) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) forbidden.add(trimmed);
  }
  if (forbidden.has(host)) {
    return { ok: false, reason: `refusing to probe ${host}: it is a production host` };
  }

  const isLocal = LOCAL_HOSTS.has(host);
  if (!isLocal && url.origin === originOf(env.TODO_APP_BASE_URL)) {
    return {
      ok: false,
      reason: `refusing to probe ${host}: it is the app this service serves (TODO_APP_BASE_URL), so it is not a separate test target`,
    };
  }

  return { ok: true, target: { baseUrl: url.origin, authToken, workspaceId } };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Remove the canary's own credential from text that leaves this process. */
function scrub(text: string, authToken: string): string {
  return text
    .split(authToken)
    .join('[token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [token]')
    .slice(0, MAX_ERROR_CHARS);
}

class ProbeTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout(`no answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mastra returns a schema failure as a normal result, `{ error: true, message }`,
 * not a throw. The message's opening words are the only signal of which side
 * failed.
 */
function schemaFailure(result: unknown): { kind: 'output-schema' | 'input-schema'; message: string } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { error, message } = result as { error?: unknown; message?: unknown };
  if (error !== true || typeof message !== 'string') return undefined;
  if (message.startsWith('Tool input validation failed')) return { kind: 'input-schema', message };
  return { kind: 'output-schema', message };
}

/**
 * Some tools catch the app's rejection and hand the model `{ error: "..." }`
 * instead of throwing (the Notion tools do). With no output schema nothing
 * else marks that as a failure, so a broken procedure would read as `ok`.
 * Only an object that is nothing but an error message counts: a normal answer
 * can carry an `error` field next to its data (`{ isConnected: false, error }`).
 */
function returnedError(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const keys = Object.keys(result);
  const { error } = result as { error?: unknown };
  return keys.length === 1 && typeof error === 'string' && error.trim().length > 0 ? error : undefined;
}

async function preflight(target: ToolCanaryTarget, timeoutMs: number): Promise<ToolCanaryReport['preflight']> {
  try {
    // Bounded like every probe: a target that accepts the connection and then
    // stalls must not hold the run (and the route's one-run-at-a-time lock) open.
    const { data } = await withTimeout(
      authenticatedTrpcCall<{ workspaces?: Array<{ id?: string }> }>(
        'mastra.getUserWorkspaces',
        {},
        { authToken: target.authToken },
      ),
      timeoutMs,
    );
    const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : undefined;
    if (workspaces && !workspaces.some((workspace) => workspace?.id === target.workspaceId)) {
      return {
        ok: false,
        kind: 'workspace',
        error: `the canary's credential is not a member of workspace ${target.workspaceId} on the target`,
      };
    }
    return { ok: true };
  } catch (error) {
    const text = scrub(errorText(error), target.authToken);
    if (error instanceof ProbeTimeout) return { ok: false, kind: 'unreachable', error: `the target did not answer: ${text}` };
    if (/authentication failed|request failed:\s*(401|403)\b/i.test(text)) {
      return { ok: false, kind: 'auth', error: text };
    }
    // A gateway error or no connection at all means the app is not answering.
    // Any other status (a 400, a plain 500) means it IS answering and this
    // one procedure is at fault, which the probe of its tool will report.
    if (/request failed:\s*(502|503|504)\b/i.test(text) || !/request failed:\s*\d{3}\b/i.test(text)) {
      return { ok: false, kind: 'unreachable', error: text };
    }
    return { ok: true };
  }
}

/** One inventory entry, joined with its probe plan when it has one. */
interface Candidate {
  name: string;
  toolId: string;
  kind: ToolKind;
  entry: InventoryEntry;
  plan?: ProbePlan;
}

function baseResult(candidate: Candidate): Pick<ToolProbeResult, 'name' | 'toolId' | 'kind' | 'procedures' | 'embeds'> {
  return {
    name: candidate.name,
    toolId: candidate.toolId,
    kind: candidate.kind,
    procedures: candidate.plan?.procedures ?? [],
    ...(candidate.plan?.embeds ? { embeds: true } : {}),
  };
}

function skipReason(candidate: Candidate): string | undefined {
  const { entry, plan } = candidate;
  // The inventory's own reason, e.g. "Calls the Slack API, not the app."
  if (isSkipped(entry)) return entry.skip;
  if (entry.writes) return SKIP_WRITE;
  if (!plan) return SKIP_NO_PLAN;
  if (plan.skip) return plan.skip;
  if (!entry.tool.execute) return 'the tool has no execute function';
  return undefined;
}

export async function runToolCanary(target: ToolCanaryTarget, options: ToolCanaryOptions = {}): Promise<ToolCanaryReport> {
  const inventory = options.inventory ?? TOOL_INVENTORY;
  const planByTool = new Map((options.plans ?? PROBE_PLANS).map((plan) => [plan.tool, plan]));
  const candidates: Candidate[] = inventory.map((entry) => {
    const plan = planByTool.get(entry.tool);
    return {
      name: plan?.name ?? exportNameOf(entry.tool),
      toolId: entry.tool.id,
      kind: isSkipped(entry) ? 'external' : entry.writes ? 'write' : 'read',
      entry,
      ...(plan ? { plan } : {}),
    };
  });
  const toolTimeoutMs = options.toolTimeoutMs ?? 20_000;
  const budgetMs = options.budgetMs ?? 4 * 60_000;
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const now = options.now ?? Date.now;

  const startedAtMs = now();
  const results = new Map<string, ToolProbeResult>();
  const fixture: ToolFixture = { workspaceId: target.workspaceId };

  const requestContext = new RequestContext();
  requestContext.set('authToken', target.authToken);
  requestContext.set('workspaceId', target.workspaceId);

  const probe = async (candidate: Candidate): Promise<void> => {
    const base = baseResult(candidate);
    const plan = candidate.plan!;
    const missing = (plan.needs ?? []).filter((key) => !fixture[key]);
    if (missing.length > 0) {
      const what = missing.map((key) => FIXTURE_LABEL[key]).join(' or ');
      results.set(candidate.name, { ...base, status: 'skipped', reason: `the fixture workspace has no ${what} to ask about` });
      return;
    }
    if (now() - startedAtMs > budgetMs) {
      results.set(candidate.name, {
        ...base,
        status: 'failed',
        errorKind: 'timeout',
        error: 'the run used up its time budget before this probe started',
      });
      return;
    }

    const probeStartedMs = now();
    const finish = (rest: Partial<ToolProbeResult> & { status: ToolProbeStatus }) =>
      results.set(candidate.name, { ...base, durationMs: now() - probeStartedMs, ...rest });

    try {
      const input = plan.input(fixture);
      const output = await withTimeout(
        candidate.entry.tool.execute!(input as never, { requestContext } as never),
        toolTimeoutMs,
      );
      const failure = schemaFailure(output);
      if (failure) {
        finish({ status: 'failed', errorKind: failure.kind, error: scrub(failure.message, target.authToken) });
        return;
      }
      const toolError = returnedError(output);
      if (toolError) {
        // Reported like a throw: the text is what the app answered.
        finish({ status: 'failed', errorKind: 'threw', error: scrub(toolError, target.authToken) });
        return;
      }
      Object.assign(fixture, plan.provides?.(output) ?? {});
      finish({ status: 'ok' });
    } catch (error) {
      finish({
        status: 'failed',
        errorKind: error instanceof ProbeTimeout ? 'timeout' : 'threw',
        error: scrub(errorText(error), target.authToken),
      });
    }
  };

  const runAll = async (entries: readonly Candidate[]): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const candidate = entries[next++]!;
        await probe(candidate);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  };

  const preflightResult = await withAppBaseUrl(target.baseUrl, async () => {
    const check = await preflight(target, toolTimeoutMs);

    const callable: Candidate[] = [];
    for (const candidate of candidates) {
      const reason = skipReason(candidate);
      if (reason) {
        results.set(candidate.name, { ...baseResult(candidate), status: 'skipped', reason });
      } else if (!check.ok) {
        // The target is not answering: that is one fault, not one per tool.
        results.set(candidate.name, {
          ...baseResult(candidate),
          status: 'skipped',
          reason: `the target could not be used (${check.kind}), so this tool was not called`,
        });
      } else {
        callable.push(candidate);
      }
    }

    // Tools that need nothing first: their output supplies the ids the rest need.
    await runAll(callable.filter((candidate) => !candidate.plan?.needs?.length));
    await runAll(callable.filter((candidate) => candidate.plan?.needs?.length));
    return check;
  });

  const tools = candidates.map((candidate) => results.get(candidate.name)!);
  const finishedAtMs = now();
  return {
    version: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    target: { origin: target.baseUrl, workspaceId: target.workspaceId },
    preflight: preflightResult,
    tools,
    counts: {
      total: tools.length,
      ok: tools.filter((tool) => tool.status === 'ok').length,
      failed: tools.filter((tool) => tool.status === 'failed').length,
      skipped: tools.filter((tool) => tool.status === 'skipped').length,
    },
  };
}
