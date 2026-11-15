import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

import { createTicketTool, listLabelsTool, updateTicketTool } from './ticket-tools.js';

/**
 * Ticket labels for agents (cold.nebula in exponential). The tools are thin:
 * label resolution, access checks and the field edits all happen in the app's
 * mastra.createTicket / updateTicket / listLabels procedures. These tests pin
 * the input contract the model sees (stringified arrays and numbers coerce)
 * and the endpoint each tool calls.
 */

const ctx = () =>
  ({
    requestContext: new Map<string, string>([
      ['authToken', 'token-123'],
      ['userId', 'user-1'],
    ]),
  }) as never;

const parseInput = (tool: { inputSchema?: unknown }, value: unknown) =>
  (tool.inputSchema as z.ZodTypeAny).parse(value) as Record<string, unknown>;

const LABEL = { id: 'tag-1', name: 'Bug', slug: 'bug' };
const TICKET = {
  id: 't1',
  number: 498,
  shortId: 'cold.nebula',
  title: 'T',
  type: 'BUG',
  status: 'QA',
  priority: null,
  productId: 'p',
};

describe('create-ticket labels', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('accepts labels, including the comma-string shape models emit', () => {
    expect(
      parseInput(createTicketTool, { productId: 'p', title: 'T', labels: 'bug, ai-buildable' }).labels,
    ).toEqual(['bug', 'ai-buildable']);
    expect(parseInput(createTicketTool, { productId: 'p', title: 'T', labels: ['bug'] }).labels).toEqual(['bug']);
  });

  it('passes labels through to mastra.createTicket', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { ticket: TICKET, labels: [LABEL], warnings: [] },
    });
    const result = await createTicketTool.execute!(
      { productId: 'p', title: 'T', labels: ['bug'] } as never,
      ctx(),
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.createTicket',
      expect.objectContaining({ productId: 'p', labels: ['bug'] }),
      expect.objectContaining({ authToken: 'token-123' }),
    );
    expect(result).toMatchObject({ labels: [LABEL] });
  });
});

describe('update-ticket', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('coerces a stringified ticket number and label arrays', () => {
    const parsed = parseInput(updateTicketTool, {
      productId: 'p',
      ticketNumber: '498',
      addLabels: '["bug"]',
      status: 'In Progress',
      priority: null,
    });
    expect(parsed).toMatchObject({
      ticketNumber: 498,
      addLabels: ['bug'],
      status: 'IN_PROGRESS',
      priority: null,
    });
  });

  it('calls mastra.updateTicket with the edit', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { ticket: { ...TICKET, points: null, assigneeId: null }, labels: [LABEL], warnings: [] },
    });
    const result = await updateTicketTool.execute!(
      { productId: 'p', ticketNumber: 498, addLabels: ['bug'], removeLabels: ['wontfix'] } as never,
      ctx(),
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.updateTicket',
      { productId: 'p', ticketNumber: 498, addLabels: ['bug'], removeLabels: ['wontfix'] },
      expect.anything(),
    );
    expect(result).toMatchObject({ labels: [LABEL], warnings: [] });
  });

  it('still validates a createTicket response from an app without labels', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { ticket: TICKET } });
    const result = await createTicketTool.execute!({ productId: 'p', title: 'T' } as never, ctx());
    expect(result).toEqual({ ticket: TICKET });
  });

  it('refuses a call that names no ticket, before any request', async () => {
    await expect(
      updateTicketTool.execute!({ productId: 'p', addLabels: ['bug'] } as never, ctx()),
    ).rejects.toThrow(/ticketId, or productId with ticketNumber/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('list-labels', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('calls mastra.listLabels with the product', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { workspaceId: 'ws', labels: [] } });
    await listLabelsTool.execute!({ productId: 'p' } as never, ctx());
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.listLabels',
      { productId: 'p', workspaceId: undefined },
      expect.anything(),
    );
  });

  it('needs a product or a workspace', async () => {
    await expect(listLabelsTool.execute!({} as never, ctx())).rejects.toThrow(/productId/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});
