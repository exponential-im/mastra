# Exponential Mastra agents

The AI agents behind [Exponential](https://www.exponential.im): the Assistant, Zoe, the agent-run
worker and the messaging gateways, built on [Mastra](https://mastra.ai). The Exponential app calls
this service at `MASTRA_API_URL`; the agents call back into the app's tRPC API with a per-user token.

Architecture, agents, tools and environment variables are documented in [CLAUDE.md](CLAUDE.md) and
[docs/](docs/).

## Commands

```bash
npm install
npm run dev          # Mastra dev server on :4111
npm test             # unit tests, no network, no key
npx tsc --noEmit     # typecheck
npm run smoke:live   # one REAL agent turn, see below
```

## Running a real agent turn

`npm test` never calls a model. To see a change to a prompt, a tool or a model setting work before
it ships, run the live smoke test: one real turn of the Assistant agent, with one real tool call,
against a real Anthropic model.

```bash
npm run smoke:live -- --stub-app
```

It prints the reply, every tool call with its result, the token counts and the cost at list price,
and exits non-zero unless the agent called `getTodaysActionsTool` and answered from what it
returned. A run is two or three model calls and costs a few cents.

The agent is your working tree: instructions, model, options and tools are imported from
`src/mastra/agents/assistant-agent.ts`. It runs without memory, so it never touches the memory
store. The code is in [src/mastra/smoke/](src/mastra/smoke/).

### The development key

The smoke test spends **`ANTHROPIC_API_KEY_DEV`** and nothing else. This is a separate Anthropic
key, in its own Anthropic workspace, with a monthly spend limit, so a runaway loop cannot spend the
production budget.

| | |
|---|---|
| Variable | `ANTHROPIC_API_KEY_DEV` |
| Locally | in this checkout's `.env` (gitignored; `npm run smoke:live` loads it) |
| In CI | repository secret `ANTHROPIC_API_KEY_DEV`, read only by `.github/workflows/eval.yml` |
| Spend limit | 50 USD a month, set on the key's workspace in the Anthropic console (to be confirmed there once the key exists; review after the first month of eval runs) |

The script refuses to run, before any model call, when:

- `ANTHROPIC_API_KEY_DEV` is not set. It never falls back to `ANTHROPIC_API_KEY`, the production
  variable.
- `ANTHROPIC_API_KEY_DEV` holds the same key as `ANTHROPIC_API_KEY`.
- the key's SHA-256 is listed in `ANTHROPIC_PRODUCTION_KEY_SHA256` (optional, comma-separated).
  Storing the production key's digest there catches it under the development name on a machine
  that does not have the production variable, such as CI. A digest is not a secret.
- it is running in production (`NODE_ENV=production`, or a running Railway deployment). A `.env`
  copied from `railway variables` is fine: it has the Railway environment name but not the
  deployment id.
- the app URL, or `ANTHROPIC_BASE_URL` if set, is not on this machine (Anthropic's own API aside).

Inside the process, the development key replaces `ANTHROPIC_API_KEY`, so every model call the turn
makes is billed to it. Keys are never printed.

### Against a local app

`--stub-app` answers the tool call from a built-in stub, so nothing else needs to run. To exercise
the real path, tools calling a real Exponential app, start the app locally and give the script an
agent token for it:

```bash
# in the exponential app checkout
npm run dev:seed-fixture                      # once: the dev-fixture user and workspace
npm run dev                                   # the app on :3000

# in this checkout
SMOKE_AUTH_TOKEN=$(cd ../exponential-app && npm run -s dev:agent-token) npm run smoke:live
```

The token lasts 30 minutes and only works against an app that shares your local `AUTH_SECRET`. The
app must be on `localhost`; the script will not run tools against anything else. Options:

```
--app <url>           the local app (default: TODO_APP_BASE_URL, else http://localhost:3000)
--prompt <text>       ask something else (keep it read-only: tools really execute)
--expect-tool <key>   the assistantTools key that must be called (default: getTodaysActionsTool)
--json <file>         also write the report as JSON
```

### In CI

`.github/workflows/eval.yml` runs `npm run smoke:live -- --stub-app` on pushes to `main` that touch
agents, tools or the smoke test, every Monday, and on demand:

```bash
gh workflow run eval.yml --ref <branch>
```

Use the on-demand run to put a real result in a pull request instead of "not run against a live
model". The reply, tool calls and cost appear in the run's summary. The workflow has no
pull-request trigger, so a pull request from a fork cannot start it or read the key; a test pins
that.

What the smoke test covers: the Assistant's prompt, model settings, tool loading and one
tool round trip. It does not cover memory, the chat route in the app, the other agents, or answer
quality; the golden eval set is for that.
