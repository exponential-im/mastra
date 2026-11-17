import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAnthropic, type ScriptedReply } from '../utils/anthropic-test-server.js';
import { costUsd, priceFor, sumUsage } from './cost.js';
import { DevKeyRefusal, keyDigest, resolveDevKey } from './dev-key.js';
import { STUB_ACTION_NAME, STUB_AUTH_TOKEN, startStubApp, type StubApp } from './stub-app.js';

/**
 * The live smoke test, exercised without a paid call: the real Assistant
 * model and tools run against a scripted Messages endpoint on loopback and
 * the stub app. What this cannot prove is that a real model picks the tool;
 * that is what `npm run smoke:live` is for.
 */

const DEV_KEY = 'sk-ant-test-dev-key';
const PRODUCTION_KEY = 'sk-ant-test-production-key';

describe('resolveDevKey', () => {
  it('returns the development key', () => {
    expect(resolveDevKey({ ANTHROPIC_API_KEY_DEV: DEV_KEY, ANTHROPIC_API_KEY: PRODUCTION_KEY })).toBe(DEV_KEY);
  });

  it('never falls back to the production variable', () => {
    expect(() => resolveDevKey({ ANTHROPIC_API_KEY: PRODUCTION_KEY })).toThrow(DevKeyRefusal);
    expect(() => resolveDevKey({ ANTHROPIC_API_KEY_DEV: '  ' })).toThrow(/ANTHROPIC_API_KEY_DEV is not set/);
  });

  it('refuses the production key under the development name', () => {
    expect(() =>
      resolveDevKey({ ANTHROPIC_API_KEY_DEV: PRODUCTION_KEY, ANTHROPIC_API_KEY: PRODUCTION_KEY }),
    ).toThrow(/same key as ANTHROPIC_API_KEY/);
  });

  it('refuses a key whose digest is listed as production', () => {
    expect(() =>
      resolveDevKey({
        ANTHROPIC_API_KEY_DEV: PRODUCTION_KEY,
        ANTHROPIC_PRODUCTION_KEY_SHA256: `deadbeef, ${keyDigest(PRODUCTION_KEY).toUpperCase()}`,
      }),
    ).toThrow(/production key under the development name/);
  });

  it('refuses to run in a production environment', () => {
    expect(() => resolveDevKey({ ANTHROPIC_API_KEY_DEV: DEV_KEY, NODE_ENV: 'production' })).toThrow(/NODE_ENV/);
    expect(() =>
      resolveDevKey({ ANTHROPIC_API_KEY_DEV: DEV_KEY, RAILWAY_ENVIRONMENT_NAME: 'production' }),
    ).toThrow(/Railway/);
  });

  it('never puts a key in the refusal', () => {
    for (const env of [
      { ANTHROPIC_API_KEY_DEV: PRODUCTION_KEY, ANTHROPIC_API_KEY: PRODUCTION_KEY },
      { ANTHROPIC_API_KEY_DEV: PRODUCTION_KEY, ANTHROPIC_PRODUCTION_KEY_SHA256: keyDigest(PRODUCTION_KEY) },
    ]) {
      try {
        resolveDevKey(env);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(String(error)).not.toContain(PRODUCTION_KEY);
      }
    }
  });
});

describe('cost', () => {
  it('prices a dated model id by its family', () => {
    expect(priceFor('claude-sonnet-4-5-20250929')).toEqual(priceFor('claude-sonnet-4-5'));
    expect(priceFor('some-other-model')).toBeNull();
  });

  it('charges each token class at its own rate', () => {
    const tokens = { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
    expect(costUsd('claude-sonnet-4-5-20250929', tokens)).toBeCloseTo(3 + 3.75 + 0.3 + 15);
    expect(costUsd('claude-sonnet-5-5', tokens)).toBeCloseTo(2 + 2.5 + 0.1 + 10);
    expect(costUsd('some-other-model', tokens)).toBeNull();
  });

  it('splits cached tokens out of the input total', () => {
    const totals = sumUsage([
      {
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          raw: { inputTokens: { noCache: 100, cacheRead: 0, cacheWrite: 900 }, outputTokens: { total: 50 } },
        },
      },
      {
        usage: {
          inputTokens: 1100,
          outputTokens: 70,
          raw: { inputTokens: { noCache: 200, cacheRead: 900, cacheWrite: 0 }, outputTokens: { total: 70 } },
        },
      },
      { usage: { inputTokens: 5, outputTokens: 1 } },
      {},
    ]);
    expect(totals).toEqual({ input: 305, cacheWrite: 900, cacheRead: 900, output: 121 });
  });
});

const callsTool: ScriptedReply = {
  content: [{ type: 'tool_use', id: 'toolu_smoke', name: 'getTodaysActionsTool', input: {} }],
  stopReason: 'tool_use',
};
const answers = (text: string): ScriptedReply => ({ content: [{ type: 'text', text }] });

/** Serves scripted Anthropic replies over loopback HTTP, for ANTHROPIC_BASE_URL. */
async function serveScripted(replies: ScriptedReply[]) {
  const scripted = scriptedAnthropic(replies);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const reply = await (scripted.fetch as unknown as (url: unknown, init: unknown) => Promise<Response>)(
        req.url,
        { body: Buffer.concat(chunks).toString(), headers: req.headers },
      );
      res.writeHead(reply.status, Object.fromEntries(reply.headers.entries()));
      res.end(await reply.text());
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: scripted.requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('runSmoke against a scripted model and the stub app', () => {
  let model: Awaited<ReturnType<typeof serveScripted>>;
  let app: StubApp;
  let runSmoke: typeof import('./live-smoke.js').runSmoke;
  const saved = { ...process.env };

  beforeAll(async () => {
    // One queue for the whole block: the provider reads its base URL once.
    model = await serveScripted([
      // 1. the passing turn
      callsTool,
      answers(`You have one thing today: ${STUB_ACTION_NAME}.`),
      // 2. answers without calling the tool
      answers('You have nothing on today.'),
      // 3. calls the tool, which the app rejects
      callsTool,
      answers('I could not load your actions.'),
    ]);
    app = await startStubApp();
    process.env.ANTHROPIC_BASE_URL = model.baseUrl;
    process.env.ANTHROPIC_API_KEY = DEV_KEY;
    process.env.TODO_APP_BASE_URL = app.url;
    ({ runSmoke } = await import('./live-smoke.js'));
  }, 60_000);

  afterAll(async () => {
    process.env = saved;
    await model.close();
    await app.close();
  });

  const options = {
    prompt: 'What is on my plate today?',
    authToken: STUB_AUTH_TOKEN,
    expectedTool: 'getTodaysActionsTool',
    expectedText: STUB_ACTION_NAME,
  };

  it('passes when the agent calls the tool and answers from its result', async () => {
    const report = await runSmoke(options);

    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.reply).toContain(STUB_ACTION_NAME);
    expect(report.steps).toBe(2);
    expect(report.toolCalls).toHaveLength(1);
    expect(report.toolCalls[0]).toMatchObject({ name: 'getTodaysActionsTool', ok: true });
    expect(report.toolCalls[0].resultPreview).toContain(STUB_ACTION_NAME);
    // The tool really ran: the stub app saw the request.
    expect(app.calls).toEqual(['action.getTodaysActions']);
    // Two scripted calls at 10 input / 5 output tokens each.
    expect(report.tokens).toEqual({ input: 20, cacheWrite: 0, cacheRead: 0, output: 10 });
    expect(report.costUsd).toBeCloseTo(costUsd(report.model, report.tokens)!);
    expect(report.costUsd).toBeGreaterThan(0);
    // The second model call carried the tool result back.
    expect(JSON.stringify(model.requests[1].body.messages)).toContain(STUB_ACTION_NAME);
  }, 60_000);

  it('fails when the agent answers without the tool', async () => {
    const report = await runSmoke(options);

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      'the agent never called getTodaysActionsTool',
      `the reply does not mention "${STUB_ACTION_NAME}", which only the tool result contains`,
    ]);
  }, 60_000);

  it('fails when the tool call itself fails', async () => {
    const report = await runSmoke({ ...options, authToken: 'wrong-token', expectedText: undefined });

    expect(report.passed).toBe(false);
    expect(report.toolCalls[0]).toMatchObject({ name: 'getTodaysActionsTool', ok: false });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/getTodaysActionsTool was called but failed/);
  }, 60_000);
});

describe('the smoke:live command', () => {
  const script = fileURLToPath(new URL('./live-smoke.ts', import.meta.url));

  function run(args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // A clean environment: nothing from the developer's shell or .env leaks in.
      const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('refuses to run without the development key, even when the production one is set', async () => {
    const result = await run(['--stub-app'], { ANTHROPIC_API_KEY: PRODUCTION_KEY });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ANTHROPIC_API_KEY_DEV is not set');
    expect(result.stdout + result.stderr).not.toContain(PRODUCTION_KEY);
  }, 60_000);

  it('refuses the production key under the development name', async () => {
    const result = await run(['--stub-app'], {
      ANTHROPIC_API_KEY: PRODUCTION_KEY,
      ANTHROPIC_API_KEY_DEV: PRODUCTION_KEY,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('same key as ANTHROPIC_API_KEY');
  }, 60_000);

  it('refuses an app that is not on this machine', async () => {
    const result = await run(['--app', 'https://www.exponential.im'], {
      ANTHROPIC_API_KEY_DEV: DEV_KEY,
      SMOKE_AUTH_TOKEN: 'token',
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not this machine');
  }, 60_000);

  it('refuses to send the development key to another host', async () => {
    const result = await run(['--stub-app'], {
      ANTHROPIC_API_KEY_DEV: DEV_KEY,
      ANTHROPIC_BASE_URL: 'https://example.com/v1',
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ANTHROPIC_BASE_URL');
  }, 60_000);

  it('runs a whole turn on the development key and reports reply, tool calls and cost', async () => {
    const model = await serveScripted([callsTool, answers(`Today: ${STUB_ACTION_NAME}.`)]);
    try {
      const result = await run(['--stub-app'], {
        ANTHROPIC_API_KEY: PRODUCTION_KEY,
        ANTHROPIC_API_KEY_DEV: DEV_KEY,
        ANTHROPIC_BASE_URL: model.baseUrl,
      });

      expect(result.stdout).toContain('Live smoke: PASSED');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Today: ${STUB_ACTION_NAME}.`);
      expect(result.stdout).toMatch(/ok\s+getTodaysActionsTool/);
      expect(result.stdout).toMatch(/Cost:\s+\$0\.\d{4} at list price/);
      // Every model call spent the development key, never the production one.
      expect(model.requests).toHaveLength(2);
      for (const request of model.requests) {
        expect(request.headers['x-api-key']).toBe(DEV_KEY);
      }
      expect(result.stdout + result.stderr).not.toContain(DEV_KEY);
      expect(result.stdout + result.stderr).not.toContain(PRODUCTION_KEY);
    } finally {
      await model.close();
    }
  }, 90_000);
});
