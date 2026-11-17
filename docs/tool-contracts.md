# Tool contracts

A contract test checks every request an agent tool sends to the Exponential app against the procedure it calls. It runs in `npm test`. It calls no model and no network.

It exists because `query-meeting-context` called `mastra.queryMeetingContext` without `workspaceId` for six months after the app made the field required. Every call returned 400. Nothing compared the two repos.

## Terms

| Term | Meaning |
|---|---|
| Contract | `contracts/agent-procedures.json`. The input of each app procedure, as JSON Schema. The app repo writes it. |
| Copy | The same file in this repo. The test reads the copy. |
| Inventory | `src/mastra/tools/contract/tool-inventory.ts`. The one list of tools, with a sample input for each. |
| Case | One sample input for one tool. |
| Violation | A request the app would reject. |

## How the test works

1. The test runs each case: it calls the tool's `execute` with the sample input and a turn's request context (`authToken`, `userId`, `workspaceId`).
2. The transport (`authenticatedTrpcCall`, `authenticatedTrpcQuery`) is replaced. It records the procedure and the payload, and returns canned data.
3. The test validates the payload against the contract entry for that procedure.
4. A violation fails the test. The message names the tool, the procedure and the field:

   ```
   query-meeting-context → mastra.queryMeetingContext: field "workspaceId" is required, and the tool did not send it
   ```

The payload is checked as the app receives it: after `JSON.stringify`, with `meta: {}`. So a `Date` arrives as a string, and a field the app declares as `z.date()` always fails. The app must use `z.coerce.date()` for a date an agent sends.

## What the test cannot skip

- A tool exported from `src/mastra/tools/` with no inventory entry fails the test.
- A case that sends nothing to the app fails the test.
- A procedure with no contract entry fails the test.
- A procedure that a tool file calls, and no case in that file reaches, fails the test.

## Add a tool

1. Add one entry to the inventory. Give it an input a model would send. Include the optional fields that reach the app.
2. Set `writes: true` if the tool changes data in the app.
3. If the tool makes a second request that depends on the first response, give the first response in `responses`.
4. If the tool has two branches that call different procedures, add one case for each branch.
5. If the tool never calls the app, use `skip` and give the reason.
6. Run `npm test`.

If the test reports "the contract has no entry for this procedure", add the path to `src/server/agentContract/agentProcedures.ts` in the app repo. Run `npm run contracts:generate` there. Then run `npm run contracts:sync` here.

## When the test fails

| Message | Do this |
|---|---|
| `sends a request the app rejects` | Fix the tool's payload. If the app is wrong, fix the procedure there and sync the copy. |
| `sent nothing to the app` | The sample input is wrong, or the tool threw before the request. The message says which. |
| `no longer breaks the contract` | The tool is fixed. Remove its `knownViolations` entry. |
| `have no entry in … tool-inventory.ts` | Add the tool to the inventory. |

`knownViolations` holds a violation that is filed and not yet fixed, with its ticket. Remove the entry in the change that fixes the tool. Do not add an entry to make a new failure pass: fix the tool, or file the bug first.

## Keep the copy current

CI runs `npm run contracts:check`. It reads the contract from the app's `main` and fails when the copy differs.

1. Run `npm run contracts:sync`.
2. Run `npm test`.
3. Fix any tool that now fails.
4. Commit the copy with the fix.

### Why a copy, and not a read from the app

The test must run with no network, and it must give the same result for the same commit. A test that reads the app's `main` does neither: it fails offline, and a commit that passed yesterday can fail today.

With a copy, a contract change is a diff in this repo, next to the tool change that answers it. The drift check is a separate CI job, so a red drift check and a red test mean different things.

The cost is one command when the app changes a contract.

## What the contract does not check

- Inputs the cases do not use. The test checks the sample inputs. If a tool passes a free-text field to an app enum, only the sample value is checked. Add a case for a value you doubt.
- The response. The test checks the request only.
- `.refine()` and `.transform()` rules on the app side. JSON Schema holds the shape only.
- Access rules, auth and data. A request with the right shape can still fail in the app.
- Callers that are not tools (`src/mastra/proactive/`). Their procedures are in the contract, and nothing runs them here.
- Tools that call other services. They are in the inventory with `skip`.
