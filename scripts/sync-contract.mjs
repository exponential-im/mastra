#!/usr/bin/env node
/**
 * Keeps contracts/agent-procedures.json equal to the app's copy.
 *
 * The app repo owns the file. This repo keeps a copy so the contract test
 * runs with no network (docs/tool-contracts.md).
 *
 *   npm run contracts:check   fail when the copy differs from the app's main
 *   npm run contracts:sync    replace the copy with the app's main
 *
 * --allow-missing   (check only) pass with a warning when the app's main has
 *                   no contract file yet.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  process.env.AGENT_CONTRACT_URL ??
  'https://raw.githubusercontent.com/exponential-im/exponential/main/contracts/agent-procedures.json';
const COPY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contracts/agent-procedures.json');

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const allowMissing = args.has('--allow-missing');
const inActions = process.env.GITHUB_ACTIONS === 'true';

/** The app's file, or `null` when it does not exist there. */
async function fetchSource() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(SOURCE_URL, { headers: { 'cache-control': 'no-cache' } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`Could not read ${SOURCE_URL}: ${lastError?.message ?? lastError}`);
}

/** The procedures that differ between two contract files. */
function difference(copyText, sourceText) {
  const procedures = (text) => {
    try {
      return JSON.parse(text).procedures ?? {};
    } catch {
      return {};
    }
  };
  const copy = procedures(copyText);
  const source = procedures(sourceText);
  const lines = [];
  for (const name of Object.keys(source)) {
    if (!(name in copy)) lines.push(`  added    ${name}`);
    else if (JSON.stringify(copy[name]) !== JSON.stringify(source[name])) lines.push(`  changed  ${name}`);
  }
  for (const name of Object.keys(copy)) {
    if (!(name in source)) lines.push(`  removed  ${name}`);
  }
  return lines;
}

let source;
try {
  source = await fetchSource();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (source === null) {
  const message = `The app has no contract file at ${SOURCE_URL}.`;
  if (check && allowMissing) {
    console.log(`${inActions ? '::warning::' : 'Warning: '}${message} The copy in this repo was not checked.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const copy = await readFile(COPY, 'utf8').catch(() => '');

if (copy === source) {
  console.log('contracts/agent-procedures.json matches the app.');
  process.exit(0);
}

if (!check) {
  await writeFile(COPY, source);
  console.log('contracts/agent-procedures.json updated from the app:');
  console.log(difference(copy, source).join('\n') || '  (formatting only)');
  console.log('Run `npm test`. A tool that now breaks the contract fails there.');
  process.exit(0);
}

console.error('contracts/agent-procedures.json differs from the app:');
console.error(difference(copy, source).join('\n') || '  (formatting only)');
console.error('');
console.error('Run `npm run contracts:sync`, then `npm test`, and commit the file.');
console.error('A tool that now breaks the contract fails in `npm test`: fix the tool in the same change.');
process.exit(1);
