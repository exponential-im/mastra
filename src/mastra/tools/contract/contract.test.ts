import { describe, it, expect } from 'vitest';

import { ContractChecker, overTheWire, parseEndpoint, type AgentProcedureContract, type AppCall } from './contract.js';

/** A small contract in the shape the app writes (contracts/agent-procedures.json). */
const contract: AgentProcedureContract = {
  version: 1,
  procedures: {
    'mastra.search': {
      type: 'query',
      inputOptional: false,
      input: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          workspaceId: { type: 'string' },
          topK: { type: 'number', default: 5 },
          kind: { type: 'string', enum: ['meeting', 'page'] },
          range: {
            type: 'object',
            properties: { start: { type: 'string' }, end: { type: 'string' } },
            required: ['start', 'end'],
          },
          email: { type: 'string', format: 'email' },
          note: { type: ['string', 'null'] },
        },
        required: ['query', 'workspaceId'],
      },
    },
    'mastra.schedule': {
      type: 'mutation',
      inputOptional: false,
      input: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          // z.date() on the app side
          at: { not: {}, $comment: 'z.date() needs superjson meta, and agent tools post meta: {}. Use z.coerce.date().' },
          // z.coerce.date() on the app side
          due: { type: ['string', 'number'], format: 'coerce-date' },
        },
        required: ['id'],
      },
    },
    'mastra.strict': {
      type: 'mutation',
      inputOptional: false,
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
    'mastra.listMine': {
      type: 'query',
      inputOptional: true,
      input: { anyOf: [{ not: {} }, { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] }] },
    },
    'mastra.ping': { type: 'query', inputOptional: true, input: null },
  },
};

const checker = new ContractChecker(contract);

const post = (procedure: string, payload: unknown): AppCall => ({ method: 'POST', procedure, payload });
const rules = (call: AppCall) => checker.checkCall(call).map((v) => `${v.field}:${v.rule}`);

describe('ContractChecker', () => {
  it('accepts a request the procedure accepts', () => {
    expect(checker.checkCall(post('mastra.search', { query: 'pricing', workspaceId: 'ws_1', topK: 3 }))).toEqual([]);
  });

  it('names the procedure and the field when a required field is missing', () => {
    const violations = checker.checkCall(post('mastra.search', { query: 'pricing' }));
    expect(violations).toEqual([
      {
        procedure: 'mastra.search',
        field: 'workspaceId',
        rule: 'required',
        message: 'mastra.search: field "workspaceId" is required, and the tool did not send it',
      },
    ]);
  });

  it('treats an undefined value as not sent, as JSON.stringify does', () => {
    expect(rules(post('mastra.search', { query: 'pricing', workspaceId: undefined }))).toEqual(['workspaceId:required']);
  });

  it('names a nested field by its path', () => {
    expect(rules(post('mastra.search', { query: 'q', workspaceId: 'w', range: { start: '2026-11-01' } }))).toEqual([
      'range.end:required',
    ]);
  });

  it('reports a wrong type, a bad enum value and a bad format', () => {
    expect(
      rules(post('mastra.search', { query: 'q', workspaceId: 'w', topK: '5', kind: 'call', email: 'not-an-email' })),
    ).toEqual(['topK:type', 'kind:enum', 'email:format']);
  });

  it('reports a nullable field once when the value is neither type', () => {
    expect(rules(post('mastra.search', { query: 'q', workspaceId: 'w', note: 3 }))).toEqual(['note:type']);
  });

  it('passes extra keys, because the app strips them', () => {
    expect(checker.checkCall(post('mastra.search', { query: 'q', workspaceId: 'w', extra: true }))).toEqual([]);
  });

  it('fails an extra key on a strict input', () => {
    expect(rules(post('mastra.strict', { id: 'a', status: 'DONE' }))).toEqual(['status:unknown-field']);
  });

  it('fails a field the app declares as z.date(), and says why', () => {
    const violations = checker.checkCall(post('mastra.schedule', { id: 'a', at: '2026-11-17T09:00:00.000Z' }));
    expect(violations.map((v) => v.rule)).toEqual(['unsendable']);
    expect(violations[0]!.message).toContain('field "at" cannot be sent as JSON');
    expect(violations[0]!.message).toContain('z.coerce.date()');
  });

  it('fails a Date for a z.date() field too: it goes over the wire as a string', () => {
    expect(rules(post('mastra.schedule', { id: 'a', at: new Date('2026-11-17T09:00:00.000Z') }))).toEqual([
      'at:unsendable',
    ]);
  });

  it('accepts a date string for z.coerce.date(), and rejects a string that is not a date', () => {
    expect(checker.checkCall(post('mastra.schedule', { id: 'a', due: '2026-11-17' }))).toEqual([]);
    expect(rules(post('mastra.schedule', { id: 'a', due: 'next week' }))).toEqual(['due:format']);
  });

  it('fails a procedure the contract does not list, and points at the app file', () => {
    const violations = checker.checkCall(post('action.archive', { id: 'a' }));
    expect(violations.map((v) => v.rule)).toEqual(['no-schema-entry']);
    expect(violations[0]!.message).toContain('src/server/agentContract/agentProcedures.ts');
  });

  it('fails a call with no input when the procedure requires one', () => {
    expect(rules(post('mastra.search', undefined))).toEqual([':no-input']);
  });

  it('accepts a call with no input when the input is optional or absent', () => {
    expect(checker.checkCall(post('mastra.listMine', undefined))).toEqual([]);
    expect(checker.checkCall(post('mastra.ping', undefined))).toEqual([]);
    expect(checker.checkCall(post('mastra.ping', {}))).toEqual([]);
  });

  it('reports only the real problem for an optional input that is sent wrong', () => {
    expect(rules(post('mastra.listMine', {}))).toEqual(['workspaceId:required']);
  });

  it('fails a GET to a mutation: the app only overrides the method for POST', () => {
    expect(rules({ method: 'GET', procedure: 'mastra.strict', payload: { id: 'a' } })).toEqual([':get-on-mutation']);
  });

  it('fails a GET whose input the app cannot read', () => {
    const call: AppCall = { method: 'GET', ...parseEndpoint('mastra.search?input=%7B%22query%22%3A%22q%22%7D') };
    expect(rules(call)).toEqual([':malformed-request']);
  });
});

describe('parseEndpoint', () => {
  it('reads a bare procedure path', () => {
    expect(parseEndpoint('mastra.getAllGoals')).toEqual({ procedure: 'mastra.getAllGoals', payload: undefined });
  });

  it('reads the input of a GET from its {"json": …} wrapper', () => {
    const input = encodeURIComponent(JSON.stringify({ json: { email: 'pat@example.com' } }));
    expect(parseEndpoint(`mastra.lookupContactByEmail?input=${input}`)).toEqual({
      procedure: 'mastra.lookupContactByEmail',
      payload: { email: 'pat@example.com' },
    });
  });

  it('flags an input that is not JSON', () => {
    expect(parseEndpoint('mastra.search?input=%7Bnope').malformed).toContain('not JSON');
  });
});

describe('overTheWire', () => {
  it('drops undefined keys and turns a Date into its ISO string', () => {
    expect(overTheWire({ a: undefined, b: null, at: new Date('2026-11-17T09:00:00.000Z') })).toEqual({
      b: null,
      at: '2026-11-17T09:00:00.000Z',
    });
  });

  it('keeps "no input" as undefined', () => {
    expect(overTheWire(undefined)).toBeUndefined();
  });
});
