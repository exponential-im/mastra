/**
 * Checks one request a tool sends against the app procedure it calls.
 *
 * The app writes the input of every procedure an agent tool calls to
 * `contracts/agent-procedures.json` in its own repo. This repo keeps a copy
 * (see docs/tool-contracts.md). `checkCall` validates a captured request
 * against that copy and returns one violation per problem.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS: under ESM the callable sits on `.default`.
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

export interface ProcedureContract {
  type: 'query' | 'mutation';
  /** True when the procedure accepts a call with no input at all. */
  inputOptional: boolean;
  /** JSON Schema of the input. `null` when the procedure declares none. */
  input: Record<string, unknown> | null;
}

export interface AgentProcedureContract {
  version: number;
  procedures: Record<string, ProcedureContract>;
}

/** One request to the app, as the tool handed it to the transport. */
export interface AppCall {
  method: 'GET' | 'POST';
  /** Procedure path, for example `mastra.queryMeetingContext`. */
  procedure: string;
  /** The input the app receives, after the JSON round trip. `undefined` when none was sent. */
  payload: unknown;
  /** Set when the request could not be read as a tRPC call at all. */
  malformed?: string;
}

export type ViolationRule =
  | 'no-schema-entry'
  | 'get-on-mutation'
  | 'malformed-request'
  | 'no-input'
  | 'required'
  | 'unsendable'
  | 'type'
  | 'enum'
  | 'format'
  | 'unknown-field'
  | 'other';

export interface Violation {
  procedure: string;
  /** Dotted path of the field, for example `dateRange.start`. Empty for the whole input. */
  field: string;
  rule: ViolationRule;
  /** A sentence that names the procedure and the field. */
  message: string;
}

/** The app repo file to change when a procedure has no schema entry. */
const APP_PROCEDURE_LIST = 'src/server/agentContract/agentProcedures.ts';

/** Splits `router.procedure?input=…` and reads the input a GET carries. */
export function parseEndpoint(endpoint: string): { procedure: string; payload: unknown; malformed?: string } {
  const queryStart = endpoint.indexOf('?');
  if (queryStart === -1) return { procedure: endpoint, payload: undefined };

  const procedure = endpoint.slice(0, queryStart);
  const rawInput = new URLSearchParams(endpoint.slice(queryStart + 1)).get('input');
  if (rawInput === null) return { procedure, payload: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return { procedure, payload: undefined, malformed: 'the GET input is not JSON' };
  }
  // The app deserializes with superjson, which reads the input from `json`.
  if (parsed === null || typeof parsed !== 'object' || !('json' in parsed)) {
    return {
      procedure,
      payload: undefined,
      malformed: 'the GET input is not wrapped as {"json": …}, so the app reads it as no input',
    };
  }
  return { procedure, payload: (parsed as { json: unknown }).json };
}

/** What `JSON.stringify` leaves of a payload: no `undefined` keys, dates as strings. */
export function overTheWire(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  const text = JSON.stringify(payload);
  return text === undefined ? undefined : JSON.parse(text);
}

function fieldOf(error: ErrorObject): string {
  const base = error.instancePath.split('/').filter(Boolean);
  if (error.keyword === 'required') base.push(String(error.params.missingProperty));
  if (error.keyword === 'additionalProperties') base.push(String(error.params.additionalProperty));
  return base.join('.');
}

function describe(error: ErrorObject, field: string): { rule: ViolationRule; problem: string } {
  const name = field === '' ? 'the input' : `field "${field}"`;
  switch (error.keyword) {
    case 'required':
      return { rule: 'required', problem: `${name} is required, and the tool did not send it` };
    case 'additionalProperties':
      return { rule: 'unknown-field', problem: `${name} is not accepted by the procedure` };
    case 'not': {
      const comment = (error.parentSchema as { $comment?: string } | undefined)?.$comment;
      return {
        rule: 'unsendable',
        problem: `${name} cannot be sent as JSON${comment ? `: ${comment}` : ''}`,
      };
    }
    case 'type':
      return {
        rule: 'type',
        problem: `${name} must be ${String(error.params.type)}, and the tool sent ${JSON.stringify(error.data)}`,
      };
    case 'enum':
    case 'const':
      return {
        rule: 'enum',
        problem: `${name} must be one of ${JSON.stringify(error.params.allowedValues ?? error.params.allowedValue)}, and the tool sent ${JSON.stringify(error.data)}`,
      };
    case 'format':
    case 'pattern':
      return {
        rule: 'format',
        problem: `${name} ${error.message ?? 'has the wrong format'}, and the tool sent ${JSON.stringify(error.data)}`,
      };
    default:
      return { rule: 'other', problem: `${name} ${error.message ?? `fails "${error.keyword}"`}` };
  }
}

export class ContractChecker {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly contract: AgentProcedureContract) {
    this.ajv = new Ajv({ allErrors: true, verbose: true, strict: false, useDefaults: false });
    addFormats(this.ajv);
    // `z.coerce.date()` on the app side: any string `new Date()` can parse.
    this.ajv.addFormat('coerce-date', {
      type: 'string',
      validate: (value: string) => !Number.isNaN(new Date(value).getTime()),
    });
  }

  has(procedure: string): boolean {
    return procedure in this.contract.procedures;
  }

  private validatorFor(procedure: string, schema: Record<string, unknown>): ValidateFunction {
    let validate = this.validators.get(procedure);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(procedure, validate);
    }
    return validate;
  }

  /** Every way the app would reject this request. Empty when it would accept it. */
  checkCall(call: AppCall): Violation[] {
    const { procedure } = call;
    const violation = (field: string, rule: ViolationRule, problem: string): Violation => ({
      procedure,
      field,
      rule,
      message: `${procedure}: ${problem}`,
    });

    const entry = this.contract.procedures[procedure];
    if (!entry) {
      return [
        violation(
          '',
          'no-schema-entry',
          `the contract has no entry for this procedure. Add the path to ${APP_PROCEDURE_LIST} in the app repo, regenerate the contract there, then run \`npm run contracts:sync\` here`,
        ),
      ];
    }

    const violations: Violation[] = [];
    if (call.method === 'GET' && entry.type === 'mutation') {
      violations.push(violation('', 'get-on-mutation', 'the tool sends a GET, and the procedure is a mutation. Use authenticatedTrpcCall'));
    }
    if (call.malformed) {
      violations.push(violation('', 'malformed-request', call.malformed));
      return violations;
    }

    const payload = overTheWire(call.payload);
    if (payload === undefined) {
      if (!entry.inputOptional) {
        violations.push(violation('', 'no-input', 'the procedure requires an input, and the tool sent none'));
      }
      return violations;
    }
    if (entry.input === null) return violations;

    const validate = this.validatorFor(procedure, entry.input);
    if (validate(payload)) return violations;

    const seen = new Set<string>();
    for (const error of validate.errors ?? []) {
      // `anyOf` and friends only restate that one of their branches failed.
      if (['anyOf', 'oneOf', 'allOf', 'if'].includes(error.keyword)) continue;
      // A bare `not: {}` is the "no input" branch of an optional input, not a
      // field that cannot be sent: the other branch reports the real problem.
      if (error.keyword === 'not' && !(error.parentSchema as { $comment?: string } | undefined)?.$comment) continue;
      const field = fieldOf(error);
      const { rule, problem } = describe(error, field);
      const key = `${field}|${rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(violation(field, rule, problem));
    }
    if (violations.length === 0) {
      violations.push(violation('', 'other', 'the input does not match the procedure schema'));
    }
    return violations;
  }
}
