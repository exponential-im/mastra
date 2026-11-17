/**
 * A stand-in for the Anthropic Messages endpoint, for tests that drive the
 * real `@ai-sdk/anthropic` provider (and real Mastra agents) without a paid
 * call. Hand it one scripted reply per expected request; it records every
 * request body and header set, and answers with JSON or, when the request
 * asked to stream, with the equivalent server-sent events.
 */

type ContentBlock = Record<string, unknown> & { type: string };

export interface ScriptedReply {
  content: ContentBlock[];
  stopReason?: string;
  /** Sent with a `refusal` stop reason: `{ type: "refusal", category, explanation }`. */
  stopDetails?: Record<string, unknown>;
  /** What the API reports when it dropped replayed thinking blocks. */
  inputTransformations?: Array<Record<string, unknown>>;
  model?: string;
}

export interface RecordedRequest {
  body: Record<string, any>;
  headers: Record<string, string>;
}

const usage = { input_tokens: 10, output_tokens: 5 };

function asJson(reply: ScriptedReply, index: number, model: string) {
  return {
    id: `msg_test_${index}`,
    type: 'message',
    role: 'assistant',
    model,
    content: reply.content,
    stop_reason: reply.stopReason ?? 'end_turn',
    stop_sequence: null,
    ...(reply.stopDetails ? { stop_details: reply.stopDetails } : {}),
    ...(reply.inputTransformations ? { input_transformations: reply.inputTransformations } : {}),
    usage,
  };
}

/** The same reply as the event stream Anthropic sends for `stream: true`. */
function asEvents(reply: ScriptedReply, index: number, model: string): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: { ...asJson(reply, index, model), content: [], stop_reason: null, stop_details: null },
    },
  ];
  reply.content.forEach((block, blockIndex) => {
    const delta = (payload: Record<string, unknown>) =>
      events.push({ type: 'content_block_delta', index: blockIndex, delta: payload });
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
      delta({ type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      if (block.thinking) delta({ type: 'thinking_delta', thinking: block.thinking });
      delta({ type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      delta({ type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) });
    } else {
      throw new Error(`anthropic-test-server: no stream encoding for a ${block.type} block`);
    }
    events.push({ type: 'content_block_stop', index: blockIndex });
  });
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: reply.stopReason ?? 'end_turn',
      stop_sequence: null,
      ...(reply.stopDetails ? { stop_details: reply.stopDetails } : {}),
    },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function scriptedAnthropic(replies: ScriptedReply[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (_url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const headers = Object.fromEntries(new Headers(init?.headers as never).entries());
    const index = requests.length;
    requests.push({ body, headers });
    const reply = replies[index];
    if (!reply) throw new Error(`anthropic-test-server: request ${index + 1} has no scripted reply`);
    const model = reply.model ?? String(body.model);
    if (body.stream === true) {
      return new Response(asEvents(reply, index, model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(asJson(reply, index, model)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetch as never, requests };
}

/** The `anthropic-beta` values a recorded request carried. */
export const betasOf = (request: RecordedRequest): string[] =>
  (request.headers['anthropic-beta'] ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean);
