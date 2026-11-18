import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InventoryEntry } from '../tools/contract/tool-inventory.js';
import type { ProbePlan } from './probes.js';
import type { ToolCanaryOptions } from './tool-canary.js';

// The transport is mocked only for the preflight call; the fake tools below
// never touch it. `withAppBaseUrl` stays real so the scoping is exercised.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/authenticated-fetch.js')>()),
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { resolveCanaryTarget, runToolCanary } = await import('./tool-canary.js');
const { currentAppBaseUrl } = await import('../utils/authenticated-fetch.js');
const { handleToolCanaryRequest } = await import('./tool-canary-route.js');

const TOKEN = 'exp_agent_secret_token_value';
const target = { baseUrl: 'https://staging.example.test', authToken: TOKEN, workspaceId: 'ws_fixture' };

type Execute = (input: Record<string, unknown>, ctx: { requestContext: { get: (key: string) => unknown } }) => Promise<unknown>;

/** An inventory entry and its probe plan, as the two real lists would hold them. */
interface Fake {
  entry: InventoryEntry;
  plan?: ProbePlan;
}

/** A read tool with a probe plan. */
function entry(name: string, execute: Execute, extra: Partial<Omit<ProbePlan, 'name' | 'tool'>> = {}): Fake {
  const tool = { id: name.toLowerCase(), execute: execute as never };
  return {
    entry: { tool, writes: false, cases: [{ input: {} }] },
    plan: { name, tool, procedures: [`mastra.${name}`], input: () => ({}), ...extra },
  };
}
/** A tool that changes data: in the inventory, never probed. */
function writeTool(name: string, execute: Execute): Fake {
  return { entry: { tool: { id: name, execute: execute as never }, writes: true, cases: [{ input: {} }] } };
}
/** A tool the inventory skips because it never calls the app. */
function externalTool(name: string, execute: Execute, skip = 'Calls the Slack API, not the app.'): Fake {
  return { entry: { tool: { id: name, execute: execute as never }, skip } };
}
/** A read tool nobody wrote a probe plan for. */
function unplanned(name: string, execute: Execute): Fake {
  return { entry: { tool: { id: name, execute: execute as never }, writes: false, cases: [{ input: {} }] } };
}

function run(fakes: Fake[], options: Omit<ToolCanaryOptions, 'inventory' | 'plans'> = {}) {
  return runToolCanary(target, {
    ...options,
    inventory: fakes.map((fake) => fake.entry),
    plans: fakes.flatMap((fake) => (fake.plan ? [fake.plan] : [])),
  });
}

beforeEach(() => {
  authenticatedTrpcCall.mockReset();
  authenticatedTrpcCall.mockResolvedValue({ data: { workspaces: [{ id: 'ws_fixture' }] } });
});

describe('runToolCanary', () => {
  it('reports every inventory entry as ok, failed or skipped, in inventory order', async () => {
    const report = await run([
      entry('okTool', async () => ({ fine: true })),
      entry('throwsTool', async () => {
        throw new Error('Request failed: 400 Bad Request - {"error":{"json":{"code":-32600,"data":{"code":"BAD_REQUEST","path":"mastra.x"}}}}');
      }),
      entry('badOutputTool', async () => ({
        error: true,
        message: 'Tool output validation failed for bad. The tool returned invalid output:\n- n: Expected number, received string',
      })),
      entry('staleSampleTool', async () => ({
        error: true,
        message: 'Tool input validation failed for stale. Please fix the following errors',
      })),
      writeTool('write-tool', async () => ({})),
      externalTool('slack-tool', async () => ({})),
      entry('mailTool', async () => ({}), { skip: 'needs a connected mailbox' }),
      unplanned('new-read-tool', async () => ({})),
    ]);

    expect(report.tools.map((tool) => [tool.name, tool.kind, tool.status, tool.errorKind ?? tool.reason])).toEqual([
      ['okTool', 'read', 'ok', undefined],
      ['throwsTool', 'read', 'failed', 'threw'],
      ['badOutputTool', 'read', 'failed', 'output-schema'],
      ['staleSampleTool', 'read', 'failed', 'input-schema'],
      ['write-tool', 'write', 'skipped', 'write tool: the canary never calls a tool that changes data'],
      ['slack-tool', 'external', 'skipped', 'Calls the Slack API, not the app.'],
      ['mailTool', 'read', 'skipped', 'needs a connected mailbox'],
      // Listed, with what to do about it: never silently left out.
      ['new-read-tool', 'read', 'skipped', 'no live probe is written for this tool yet: add one to src/mastra/canary/probes.ts'],
    ]);
    expect(report.counts).toEqual({ total: 8, ok: 1, failed: 3, skipped: 4 });
    expect(report.preflight).toEqual({ ok: true });
    expect(report.target).toEqual({ origin: 'https://staging.example.test', workspaceId: 'ws_fixture' });
    // The raw text is what the app's classifier names the procedure from.
    expect(report.tools[1]?.error).toContain('mastra.x');
    expect(report.tools[1]?.procedures).toEqual(['mastra.throwsTool']);
  });

  it('never executes a write tool, an external tool, a skipped probe or a tool with no plan', async () => {
    const execute = vi.fn(async () => ({}));
    await run([
      writeTool('write-tool', execute),
      externalTool('external-tool', execute),
      entry('skippedTool', execute, { skip: 'needs a calendar' }),
      unplanned('unplanned-tool', execute),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not probe a write tool even when someone wrote a plan for it', async () => {
    const execute = vi.fn(async () => ({}));
    const tool = { id: 'delete-thing', execute: execute as never };
    const report = await runToolCanary(target, {
      inventory: [{ tool, writes: true, cases: [{ input: {} }] }],
      plans: [{ name: 'deleteThingTool', tool, procedures: ['mastra.deleteThing'], input: () => ({}) }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(report.tools[0]).toMatchObject({ name: 'deleteThingTool', kind: 'write', status: 'skipped' });
  });

  it('feeds ids found by list tools to the tools that need them, and skips those when the fixture has none', async () => {
    const needsProject = vi.fn(async () => ({}));
    const report = await run([
      // Listed first on purpose: needs are resolved by pass, not by order.
      entry('projectContext', needsProject, { needs: ['projectId'], input: (fx) => ({ projectId: fx.projectId }) }),
      entry('contactDetail', async () => ({}), { needs: ['contactId'] }),
      entry('listProjects', async () => ({ projects: [{ id: 'proj_1' }] }), {
        provides: (output) => ({ projectId: (output as { projects: Array<{ id: string }> }).projects[0]?.id }),
      }),
      entry('listContacts', async () => ({ contacts: [] }), { provides: () => ({}) }),
    ]);

    expect(needsProject).toHaveBeenCalledWith({ projectId: 'proj_1' }, expect.anything());
    expect(report.tools.find((tool) => tool.name === 'contactDetail')).toMatchObject({
      status: 'skipped',
      reason: 'the fixture workspace has no contact to ask about',
    });
  });

  it('gives tools the token and workspace, and points them at the target only for the run', async () => {
    const seen: Record<string, unknown> = {};
    const outside = currentAppBaseUrl();
    await run([
      entry('spy', async (_input, ctx) => {
        seen.authToken = ctx.requestContext.get('authToken');
        seen.workspaceId = ctx.requestContext.get('workspaceId');
        seen.baseUrl = currentAppBaseUrl();
        return {};
      }),
    ]);
    expect(seen).toEqual({ authToken: TOKEN, workspaceId: 'ws_fixture', baseUrl: 'https://staging.example.test' });
    expect(currentAppBaseUrl()).toBe(outside);
    expect(outside).not.toBe('https://staging.example.test');
  });

  it('fails a tool that swallows the app\'s rejection and returns only an error message', async () => {
    const report = await run([
      // What the Notion tools return when the app rejects the request.
      entry('notionSearch', async () => ({ error: 'Request failed: 400 Bad Request - {"path":"mastra.notionSearch"}' })),
      // Normal answers that merely carry an error field, or say "not connected".
      entry('emailStatus', async () => ({ isConnected: false, error: 'No mailbox connected' })),
      entry('notionOff', async () => ({ connected: false })),
      entry('emptyError', async () => ({ error: '' })),
    ]);
    expect(report.tools.map((tool) => [tool.name, tool.status])).toEqual([
      ['notionSearch', 'failed'],
      ['emailStatus', 'ok'],
      ['notionOff', 'ok'],
      ['emptyError', 'ok'],
    ]);
    expect(report.tools[0]).toMatchObject({ errorKind: 'threw' });
    expect(report.tools[0]?.error).toContain('mastra.notionSearch');
  });

  it('removes its own token from failure text', async () => {
    const report = await run([
      entry('leaky', async () => {
        throw new Error(`Request failed: 500 - sent Authorization: Bearer ${TOKEN} and again ${TOKEN}`);
      }),
    ]);
    expect(report.tools[0]?.error).not.toContain(TOKEN);
    expect(report.tools[0]?.error).toContain('[token]');
  });

  it('reports a tool that does not answer as a timeout and carries on', async () => {
    const report = await run([entry('hangs', () => new Promise(() => undefined)), entry('after', async () => ({}))], {
      toolTimeoutMs: 20,
    });
    expect(report.tools.map((tool) => [tool.name, tool.status, tool.errorKind])).toEqual([
      ['hangs', 'failed', 'timeout'],
      ['after', 'ok', undefined],
    ]);
  });

  it('stops starting probes once the run budget is spent, and says so', async () => {
    let clock = 0;
    const report = await run(
      [
        entry('slow', async () => {
          clock += 500;
          return {};
        }),
        entry('late', async () => ({})),
      ],
      { budgetMs: 100, concurrency: 1, now: () => clock },
    );
    expect(report.tools[1]).toMatchObject({ status: 'failed', errorKind: 'timeout' });
    expect(report.tools[1]?.error).toMatch(/time budget/);
  });

  describe('when the target cannot be used', () => {
    const probed = vi.fn(async () => ({}));
    const fakes = [entry('a', probed), writeTool('w', async () => ({}))];

    it.each([
      ['Request failed: 401 Unauthorized - {}', 'auth'],
      ['Authentication failed: 401 Unauthorized', 'auth'],
      ['fetch failed', 'unreachable'],
      ['Request failed: 503 Service Unavailable - upstream', 'unreachable'],
    ])('blames the target, not each tool (%s)', async (message, kind) => {
      authenticatedTrpcCall.mockRejectedValue(new Error(message));
      const report = await run(fakes);
      expect(report.preflight).toMatchObject({ ok: false, kind });
      expect(report.counts.failed).toBe(0);
      expect(report.tools[0]).toMatchObject({ status: 'skipped' });
      expect(report.tools[0]?.reason).toContain(kind);
      // A write tool keeps its own reason.
      expect(report.tools[1]?.reason).toMatch(/write tool/);
      expect(probed).not.toHaveBeenCalled();
    });

    it('gives up on a target that accepts the call and never answers', async () => {
      authenticatedTrpcCall.mockReturnValue(new Promise(() => undefined));
      const report = await run(fakes, { toolTimeoutMs: 20 });
      expect(report.preflight).toMatchObject({ ok: false, kind: 'unreachable' });
      expect(report.counts.failed).toBe(0);
      expect(probed).not.toHaveBeenCalled();
    });

    it('says so when the credential cannot see the fixture workspace', async () => {
      authenticatedTrpcCall.mockResolvedValue({ data: { workspaces: [{ id: 'someone_elses' }] } });
      const report = await run(fakes);
      expect(report.preflight).toMatchObject({ ok: false, kind: 'workspace' });
    });

    it('still probes when only the preflight procedure itself is broken', async () => {
      // A 400 means the app answered: the fault is one procedure, which its
      // own tool's probe will report.
      authenticatedTrpcCall.mockRejectedValue(new Error('Request failed: 400 Bad Request - {}'));
      const report = await run([entry('a', async () => ({}))]);
      expect(report.preflight).toEqual({ ok: true });
      expect(report.tools[0]?.status).toBe('ok');
    });
  });
});

describe('resolveCanaryTarget', () => {
  const env = {
    TOOL_CANARY_APP_URL: 'https://staging.example.test/some/path',
    TOOL_CANARY_AUTH_TOKEN: TOKEN,
    TOOL_CANARY_WORKSPACE_ID: 'ws_fixture',
    TODO_APP_BASE_URL: 'https://www.exponential.im',
  };

  it('accepts a separate test target and keeps only its origin', () => {
    expect(resolveCanaryTarget(env)).toEqual({
      ok: true,
      target: { baseUrl: 'https://staging.example.test', authToken: TOKEN, workspaceId: 'ws_fixture' },
    });
  });

  it('is off until all three variables are set, and names the missing ones', () => {
    expect(resolveCanaryTarget({})).toEqual({
      ok: false,
      reason: 'not configured: set TOOL_CANARY_APP_URL, TOOL_CANARY_AUTH_TOKEN, TOOL_CANARY_WORKSPACE_ID',
    });
    expect(resolveCanaryTarget({ ...env, TOOL_CANARY_WORKSPACE_ID: ' ' })).toEqual({
      ok: false,
      reason: 'not configured: set TOOL_CANARY_WORKSPACE_ID',
    });
  });

  it.each(['https://www.exponential.im', 'https://exponential.im/', 'https://WWW.EXPONENTIAL.IM'])(
    'refuses production (%s)',
    (url) => {
      const result = resolveCanaryTarget({ ...env, TOOL_CANARY_APP_URL: url, TODO_APP_BASE_URL: undefined });
      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toMatch(/production host/);
    },
  );

  it('refuses the app this service itself serves, whatever its name', () => {
    const result = resolveCanaryTarget({
      ...env,
      TOOL_CANARY_APP_URL: 'https://selfhost.example.org',
      TODO_APP_BASE_URL: 'https://selfhost.example.org/',
    });
    expect((result as { reason: string }).reason).toMatch(/app this service serves/);
  });

  it('refuses hosts listed in TOOL_CANARY_FORBIDDEN_HOSTS', () => {
    const result = resolveCanaryTarget({ ...env, TOOL_CANARY_FORBIDDEN_HOSTS: 'other.example, staging.example.test' });
    expect(result).toMatchObject({ ok: false });
  });

  it('allows a local app even when it is the one this service serves (a developer laptop)', () => {
    expect(
      resolveCanaryTarget({ ...env, TOOL_CANARY_APP_URL: 'http://localhost:3000', TODO_APP_BASE_URL: 'http://localhost:3000' }),
    ).toMatchObject({ ok: true, target: { baseUrl: 'http://localhost:3000' } });
  });

  it('refuses a value that is not an http(s) URL', () => {
    expect(resolveCanaryTarget({ ...env, TOOL_CANARY_APP_URL: 'staging' })).toMatchObject({ ok: false });
    expect(resolveCanaryTarget({ ...env, TOOL_CANARY_APP_URL: 'ftp://staging.example.test' })).toMatchObject({ ok: false });
  });
});

describe('POST /api/ops/tool-canary', () => {
  const env = {
    TOOL_CANARY_SECRET: 'route-secret',
    TOOL_CANARY_APP_URL: 'https://staging.example.test',
    TOOL_CANARY_AUTH_TOKEN: TOKEN,
    TOOL_CANARY_WORKSPACE_ID: 'ws_fixture',
  };
  const runCanary = vi.fn(async () => ({ version: 1 }) as never);
  beforeEach(() => runCanary.mockClear());

  it('is off, not open, when no secret is configured', async () => {
    const response = await handleToolCanaryRequest('anything', { ...env, TOOL_CANARY_SECRET: undefined }, runCanary);
    expect(response.status).toBe(503);
    expect(runCanary).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'wrong', 'route-secret '])('rejects a missing or wrong secret (%j)', async (secret) => {
    const response = await handleToolCanaryRequest(secret, env, runCanary);
    expect(response.status).toBe(401);
    expect(runCanary).not.toHaveBeenCalled();
  });

  it('refuses to run against an unsafe or missing target, even with the right secret', async () => {
    const response = await handleToolCanaryRequest('route-secret', { ...env, TOOL_CANARY_APP_URL: 'https://www.exponential.im' }, runCanary);
    expect(response.status).toBe(503);
    expect((response.body as { error: string }).error).toMatch(/production host/);
    expect(runCanary).not.toHaveBeenCalled();
  });

  it('runs once for the right secret and returns the report', async () => {
    const response = await handleToolCanaryRequest('route-secret', env, runCanary);
    expect(response).toEqual({ status: 200, body: { version: 1 } });
    expect(runCanary).toHaveBeenCalledWith({ baseUrl: 'https://staging.example.test', authToken: TOKEN, workspaceId: 'ws_fixture' });
  });

  it('refuses a second run while one is in flight, then accepts again', async () => {
    let release: (value: never) => void = () => undefined;
    const slow = vi.fn(() => new Promise<never>((resolve) => (release = resolve)));
    const first = handleToolCanaryRequest('route-secret', env, slow);
    await Promise.resolve();
    expect((await handleToolCanaryRequest('route-secret', env, runCanary)).status).toBe(409);
    release({ version: 1 } as never);
    expect((await first).status).toBe(200);
    expect((await handleToolCanaryRequest('route-secret', env, runCanary)).status).toBe(200);
  });
});
