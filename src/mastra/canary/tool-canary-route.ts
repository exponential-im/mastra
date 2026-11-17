/**
 * The HTTP door to the tool canary: `POST /api/ops/tool-canary`.
 *
 * Called by the app's Vercel cron (`/api/cron/tool-canary`), which turns the
 * report into tickets and ops-room posts. A Vercel cron is the scheduler on
 * purpose: Sentry monitors every cron in the app's `vercel.json`, so a canary
 * that stops running is itself reported. A GitHub Actions schedule is the
 * thing that failed silently for five weeks (ticket 941).
 *
 * Auth is a shared secret in `X-Canary-Secret`, not `Authorization`: the
 * server middleware reads `Authorization` as a user's JWT.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { resolveCanaryTarget, runToolCanary, type ToolCanaryReport, type ToolCanaryTarget } from './tool-canary.js';

export const TOOL_CANARY_PATH = '/api/ops/tool-canary';
export const TOOL_CANARY_SECRET_HEADER = 'X-Canary-Secret';

export interface ToolCanaryResponse {
  status: 200 | 401 | 409 | 503;
  body: ToolCanaryReport | { error: string };
}

function secretsMatch(provided: string, expected: string): boolean {
  // Hash both so the comparison is constant-time whatever their lengths.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

let running = false;

/**
 * Decide the response for one request. Pure apart from `run`, so the auth and
 * configuration rules are testable without a server.
 */
export async function handleToolCanaryRequest(
  providedSecret: string | undefined,
  env: Record<string, string | undefined> = process.env,
  run: (target: ToolCanaryTarget) => Promise<ToolCanaryReport> = runToolCanary,
): Promise<ToolCanaryResponse> {
  const expected = env.TOOL_CANARY_SECRET?.trim();
  // Fail closed: with no secret configured the route is off, not open.
  if (!expected) return { status: 503, body: { error: 'tool canary is not configured: set TOOL_CANARY_SECRET' } };
  if (!providedSecret || !secretsMatch(providedSecret, expected)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  const resolution = resolveCanaryTarget(env);
  if (!resolution.ok) return { status: 503, body: { error: `tool canary ${resolution.reason}` } };

  // One run at a time: a retried cron call must not double the load on the target.
  if (running) return { status: 409, body: { error: 'a tool canary run is already in progress' } };
  running = true;
  try {
    return { status: 200, body: await run(resolution.target) };
  } finally {
    running = false;
  }
}

/** Route definition for `server.apiRoutes` in `src/mastra/index.ts`. */
export const toolCanaryRoute = {
  path: TOOL_CANARY_PATH,
  method: 'POST' as const,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: async () => async (c: any) => {
    const { status, body } = await handleToolCanaryRequest(c.req.header(TOOL_CANARY_SECRET_HEADER));
    return c.json(body, status);
  },
};
