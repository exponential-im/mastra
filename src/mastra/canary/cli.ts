#!/usr/bin/env npx tsx
/**
 * Run the tool canary once from a terminal and print the report.
 *
 *   TOOL_CANARY_APP_URL=http://localhost:3100 \
 *   TOOL_CANARY_AUTH_TOKEN=<bearer the target accepts> \
 *   TOOL_CANARY_WORKSPACE_ID=<fixture workspace id> \
 *   npm run canary:tools            # table
 *   npm run canary:tools -- --json  # the report the route returns
 *
 * Same code and the same target guard as the route (`/api/ops/tool-canary`):
 * it refuses production hosts. Exit code 1 when a tool failed or the target
 * could not be used, 2 when the canary is not configured.
 */
import { resolveCanaryTarget, runToolCanary } from './tool-canary.js';

const asJson = process.argv.includes('--json');
const resolution = resolveCanaryTarget();
if (!resolution.ok) {
  console.error(`tool canary ${resolution.reason}`);
  process.exit(2);
}

// The tools log every call; keep stdout for the report.
const realLog = console.log;
console.log = () => undefined;
const realError = console.error;
console.error = () => undefined;
const report = await runToolCanary(resolution.target);
console.log = realLog;
console.error = realError;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { counts } = report;
  console.log(`Tool canary against ${report.target.origin} (workspace ${report.target.workspaceId})`);
  console.log(`${counts.total} tools: ${counts.ok} ok, ${counts.failed} failed, ${counts.skipped} skipped, in ${report.durationMs}ms`);
  if (!report.preflight.ok) console.log(`\nTarget could not be used (${report.preflight.kind}): ${report.preflight.error}`);
  for (const status of ['failed', 'ok', 'skipped'] as const) {
    const rows = report.tools.filter((tool) => tool.status === status);
    if (rows.length === 0) continue;
    console.log(`\n${status.toUpperCase()} (${rows.length})`);
    for (const tool of rows) {
      const detail =
        status === 'failed'
          ? `${tool.errorKind}: ${(tool.error ?? '').split('\n')[0]?.slice(0, 200)}`
          : status === 'skipped'
            ? tool.reason
            : `${tool.durationMs}ms${tool.embeds ? ' (embeds the query)' : ''}`;
      console.log(`  ${tool.name.padEnd(34)} ${detail}`);
    }
  }
}

process.exit(report.preflight.ok && report.counts.failed === 0 ? 0 : 1);
