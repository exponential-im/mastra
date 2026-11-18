# Tool canary

The tool canary calls every agent tool that reads from the Exponential app, for real, against a non-production app, and reports the ones that fail. It calls no model: there is no agent and no prompt, only `tool.execute` with a fixed input.

The contract test ([tool-contracts.md](tool-contracts.md)) proves the shape of a request. The canary proves the rest against a running app: auth, access rules, a renamed column, an answer that fails the tool's own output schema. `query-meeting-context` failed on every call for six months and the first sign was a person's chat.

## Terms

| Term | Meaning |
|---|---|
| Inventory | `src/mastra/tools/contract/tool-inventory.ts`. The one list of tools, owned by the contract test. It says which tools write and which never call the app. |
| Probe plan | An entry in `src/mastra/canary/probes.ts`: how to call one read tool against a live app. |
| Target | The non-production app the canary calls, with a fixture workspace and a credential for a member of it. |
| Report | What a run returns: every tool in the inventory as `ok`, `failed` or `skipped` with a reason. |

## What a run does

1. It checks the target answers and accepts the credential, within the same 20-second limit as a probe. If not, it stops and reports that one fault. No tool is blamed.
2. It skips every tool the inventory marks as a write, and every tool the inventory says does not call the app. It never calls either.
3. It calls the read tools that need no id. Their answers supply ids (a project, a product, a contact) from the fixture workspace.
4. It calls the read tools that need one of those ids. If the fixture has none, the tool is skipped and the report says which id was missing.
5. A tool fails when it throws, when it does not answer within 20 seconds, or when Mastra reports that its output failed the tool's output schema. Mastra returns that last case as a normal result, `{ error: true }`, so the canary checks for it.
6. A tool also fails when it returns nothing but an error message, `{ error: "..." }`. The Notion tools catch the app's rejection and return that. An answer that carries an `error` field next to its data is not a failure.

A run against a local app takes 2 to 20 seconds for 139 tools. The whole run stops starting probes after 4 minutes.

Three probes (`search-documents`, `search-context`, `query-meeting-context`) make the app embed a three-word query. That is the only model use in a run, and it is on the app side. The report marks those tools `embeds`.

## Where it runs

The canary is a route on this service: `POST /api/ops/tool-canary`. The app's Vercel cron (`/api/cron/tool-canary`, daily) calls it, files the failures as tickets and posts to the ops room. Sentry monitors every cron in the app's `vercel.json`, so a canary that stops running is itself reported.

The route needs the header `X-Canary-Secret`. Without `TOOL_CANARY_SECRET` set it answers 503: off, not open.

## The target is never production

The canary runs inside the production assistant service, so it refuses to run unless the target is named and safe (`resolveCanaryTarget`):

- all three of `TOOL_CANARY_APP_URL`, `TOOL_CANARY_AUTH_TOKEN` and `TOOL_CANARY_WORKSPACE_ID` are set;
- the host is not `exponential.im`, `www.exponential.im` or `app.exponential.im`, and not listed in `TOOL_CANARY_FORBIDDEN_HOSTS`;
- the origin is not this service's own app (`TODO_APP_BASE_URL`), unless that is a local address.

Tool calls go to the target only inside the canary's own call chain (`withAppBaseUrl` in `utils/authenticated-fetch.ts`). Every other request in the process keeps using `TODO_APP_BASE_URL`.

## Environment

| Variable | Meaning |
|---|---|
| `TOOL_CANARY_SECRET` | Shared with the app. The route is off without it. |
| `TOOL_CANARY_APP_URL` | Origin of the non-production app. |
| `TOOL_CANARY_AUTH_TOKEN` | A bearer credential that app accepts, for a member of the fixture workspace. An API token or an agent key. |
| `TOOL_CANARY_WORKSPACE_ID` | Id of the fixture workspace on that app. |
| `TOOL_CANARY_FORBIDDEN_HOSTS` | Optional. More hosts the canary must never call, comma-separated. |

## Run it by hand

```bash
TOOL_CANARY_APP_URL=http://localhost:3100 \
TOOL_CANARY_AUTH_TOKEN=<token> \
TOOL_CANARY_WORKSPACE_ID=<workspace id> \
npm run canary:tools
```

Add `-- --json` for the report the route returns. The exit code is 1 when a tool failed or the target could not be used, and 2 when the canary is not configured or the target is refused.

## Adding a tool

1. Add the tool to the inventory, as the contract test requires.
2. If it reads from the app (`writes: false`), add a probe plan in `src/mastra/canary/probes.ts`. `probes.test.ts` fails until you do.
3. If it cannot be called against the fixture workspace, give the plan a `skip` with a reason a person can act on, for example "needs a connected mailbox".

A write tool gets no plan. The canary skips it whatever `probes.ts` says.

## Limits

- Write tools are not probed. The contract test is their only check.
- A tool is probed with one input. A fault on another branch of the tool is not seen.
- Four read tools need something the fixture does not have: a connected mailbox (three tools) and a connected Google Calendar (one). One needs the token of a run in flight. The report lists each with its reason.
- The canary reports only. Tickets, deduplication and the ops room are the app's side: `dev-docs/OBSERVABILITY.md` in the app repo.
