import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Exponential app, for the smoke test where no app is
 * running (CI). The model call is still real; only the app is scripted. It
 * answers `action.getTodaysActions` with one action whose name appears
 * nowhere else, so a reply that mentions it proves the tool result reached
 * the model. Every other procedure is a 404 the agent can read and move past.
 */

export const STUB_ACTION_NAME = 'Repot the smoke-test ferns';
export const STUB_AUTH_TOKEN = 'smoke-stub-token';

const TODAYS_ACTIONS = {
  overdue: { count: 0, actions: [] },
  today: {
    count: 1,
    actions: [
      {
        id: 'smoke-action-1',
        name: STUB_ACTION_NAME,
        status: 'ACTIVE',
        scheduledStart: null,
        dueDate: null,
        projectName: null,
        workspaceName: 'Smoke Test',
      },
    ],
  },
  inbox: { count: 0, actions: [] },
};

export interface StubApp {
  url: string;
  /** tRPC procedures the agent called, in order. */
  calls: string[];
  close: () => Promise<void>;
}

export async function startStubApp(): Promise<StubApp> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    const procedure = (req.url ?? '').split('?')[0].replace(/^\/api\/trpc\//, '');
    calls.push(procedure);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${STUB_AUTH_TOKEN}`) {
      // 403, not 401: a 401 would send the tool down the token-refresh path.
      send(403, { error: { message: 'stub app: wrong or missing bearer token' } });
    } else if (procedure === 'action.getTodaysActions') {
      send(200, { result: { data: { json: TODAYS_ACTIONS } } });
    } else {
      send(404, { error: { message: `stub app: no procedure "${procedure}"` } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
