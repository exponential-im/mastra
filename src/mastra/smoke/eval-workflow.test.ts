import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEV_KEY_ENV } from './dev-key.js';

/**
 * The development key is for the eval workflow only, and a pull request from
 * a fork must never be able to read it (ticket 962). GitHub only withholds
 * secrets from fork PRs on the `pull_request` trigger, and hands them over on
 * `pull_request_target`, so the rule here is simpler and stricter: the one
 * workflow that names the secret has no pull-request trigger at all.
 */
const workflowsDir = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(`${workflowsDir}${name}`, 'utf8') }));

/** The workflow without its comments, so prose about triggers does not count. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

describe('the development key in CI', () => {
  it('is read by the eval workflow and no other', () => {
    const readers = workflows.filter(({ text }) => code(text).includes(DEV_KEY_ENV)).map(({ name }) => name);
    expect(readers).toEqual(['eval.yml']);
  });

  it('cannot be reached from a pull request', () => {
    const evalWorkflow = code(workflows.find(({ name }) => name === 'eval.yml')!.text);
    expect(evalWorkflow).not.toMatch(/pull_request/);
    expect(evalWorkflow).not.toMatch(/workflow_run|issue_comment|workflow_call/);
    expect(evalWorkflow).toMatch(/github\.repository == 'exponential-im\/mastra'/);
  });
});
