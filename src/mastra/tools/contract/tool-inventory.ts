/**
 * The one list of agent tools, with a sample input for each.
 *
 * The contract test (`../tool-contract.test.ts`) runs every case here and
 * checks the request against the app procedure it calls. A tool in
 * `src/mastra/tools/` that is not in this list fails that test, so a new tool
 * cannot skip it. See docs/tool-contracts.md.
 *
 * To add a tool: add one entry. Give it an input a model would send, with the
 * optional fields that reach the app. A tool that never calls the app gets
 * `skip` and the reason.
 */
import type { ViolationRule } from './contract.js';
import {
  parseActionItemsTool,
  getActionItemsTool,
  updateActionItemTool,
} from '../action-items-tools.js';
import {
  getMethodTool,
  getContextTool,
} from '../agent-guidance-tools.js';
import {
  logDecisionTool,
  updateDecisionTool,
  listDecisionsTool,
} from '../decision-tools.js';
import {
  ingestDocumentTool,
  searchDocumentsTool,
  getDocumentsTool,
  getDocumentDownloadUrlTool,
  deleteDocumentTool,
} from '../document-tools.js';
import {
  checkEmailConnectionTool,
  getRecentEmailsTool,
  getEmailByIdTool,
  searchEmailsTool,
  sendEmailTool,
  replyToEmailTool,
} from '../email-tools.js';
import {
  ideateFeaturesTool,
} from '../feature-ideation-tools.js';
import {
  binancePriceTool,
  binanceCandlestickTool,
  pierreTradingQueryTool,
  weatherTool,
  getProjectContextTool,
  getProjectActionsTool,
  createProjectActionTool,
  quickCreateActionTool,
  updateProjectStatusTool,
  getProjectGoalsTool,
  getAllGoalsTool,
  getAllProjectsTool,
  getMeetingTranscriptionsTool,
  queryMeetingContextTool,
  getMeetingInsightsTool,
  getCalendarEventsTool,
  getTodayCalendarEventsTool,
  getUpcomingCalendarEventsTool,
  getCalendarEventsInRangeTool,
  findAvailableTimeSlotsTool,
  createCalendarEventTool,
  checkCalendarConnectionTool,
  lookupContactByEmailTool,
  getWhatsAppContextTool,
  createCrmContactTool,
  searchCrmContactsTool,
  getCrmContactTool,
  createFullCrmContactTool,
  updateCrmContactTool,
  addCrmInteractionTool,
  searchCrmOrganizationsTool,
  createCrmOrganizationTool,
  queryExponentialDocsTool,
} from '../index.js';
import {
  notionSearchTool,
  notionGetPageTool,
  notionQueryDatabaseTool,
  notionCreatePageTool,
  notionUpdatePageTool,
} from '../notion-tools.js';
import {
  getOkrObjectivesTool,
  createOkrObjectiveTool,
  updateOkrObjectiveTool,
  deleteOkrObjectiveTool,
  createOkrKeyResultTool,
  updateOkrKeyResultTool,
  deleteOkrKeyResultTool,
  checkInOkrKeyResultTool,
  getOkrStatsTool,
  linkProjectToGoalTool,
  unlinkProjectFromGoalTool,
  linkProjectToKeyResultTool,
  unlinkProjectFromKeyResultTool,
  linkObjectiveToParentTool,
  addObjectiveCommentTool,
  addObjectiveUpdateTool,
} from '../okr-tools.js';
import {
  createProjectTool,
  updateProjectTool,
  updateActionTool,
  getTodaysActionsTool,
  getOverdueTriageTool,
  deferActionsTool,
  rescheduleActionsTool,
  deleteProjectTool,
  getUserWorkspacesTool,
  bulkCreateWorkspaceStructureTool,
} from '../project-tools.js';
import {
  createPageTool,
  updatePageTool,
} from '../knowledge-tools.js';
import {
  saveToReadingListTool,
  listReadingListTool,
  markReadingListItemTool,
} from '../reading-list-tools.js';
import {
  listProductsTool,
  createTicketTool,
  bulkCreateTicketsTool,
  importNotionCycleTicketsTool,
  listCyclesTool,
  listTicketsTool,
  addTicketDependenciesTool,
} from '../ticket-tools.js';
import {
  listWhatsAppChatsTool,
  getWhatsAppChatHistoryTool,
  searchWhatsAppChatsTool,
} from '../whatsapp-tools.js';
import {
  getActiveSprintTool,
  getSprintMetricsTool,
  getRiskSignalsTool,
  getGitHubActivityTool,
  captureDailySnapshotTool,
} from '../pm-tools.js';
import {
  sendSlackMessageTool,
  updateSlackMessageTool,
  getSlackUserInfoTool,
  listSlackChannelsTool,
  getSlackChannelHistoryTool,
  getSlackThreadRepliesTool,
  searchSlackMessagesTool,
  getSlackMentionsTool,
  getSlackUnreadsTool,
} from '../slack-tools.js';
import {
  listAssignableMembersTool,
  assignActionTool,
} from '../routing-tools.js';
import {
  listSetupsTool,
  createSetupTool,
  listAlertsTool,
  createAlertTool,
  deleteAlertTool,
  listPositionsTool,
  syncTradesTool,
  dailySummaryTool,
} from '../tradescape-tools.js';
import {
  ingestTranscriptTool,
  searchContextTool,
  getParticipantHistoryTool,
  findRelatedMeetingsTool,
} from '../meeting-context-tools.js';
import {
  researchContactTool,
  one2bGetTrackQuestionsTool,
  one2bCreateLeadTool,
  one2bLookupLeadTool,
  one2bEscalateTool,
} from '../one2b-tools.js';
import {
  getRunContextTool,
  reportProgressTool,
  commentOnActionTool,
  reassignActionTool,
  askOwnerTool,
  finishRunTool,
  runUpdateActionTool,
} from '../run-tools.js';

/** A Mastra tool, as much of it as the inventory needs. */
export interface AnyTool {
  id: string;
  execute?: (input: never, context: never) => Promise<unknown>;
}

export interface ContractCase {
  /** Says which branch of the tool this case takes. Needed when a tool has more than one case. */
  name?: string;
  /** What the model sends. It goes through the tool's own input schema first, as in a real turn. */
  input: Record<string, unknown>;
  /** Request-context values on top of the default turn (authToken, userId, workspaceId). `undefined` removes one. */
  context?: Record<string, string | undefined>;
  /** What the app returns, by procedure. Only for a tool whose later request depends on an earlier response. */
  responses?: Record<string, unknown>;
}

/** A request the app rejects today, with the ticket that tracks the fix. */
export interface KnownViolation {
  procedure: string;
  field: string;
  rule: ViolationRule;
  /** The Exponential ticket, and the pull request when there is one. */
  ticket: string;
}

export interface CoveredTool {
  tool: AnyTool;
  /** True when the tool changes data in the app. A probe against a live app must leave these out. */
  writes: boolean;
  cases: ContractCase[];
  /**
   * Violations that are filed and not yet fixed. The test fails on any other
   * violation, and on an entry here that no longer happens: remove the entry
   * in the change that fixes the tool.
   */
  knownViolations?: KnownViolation[];
}

export interface SkippedTool {
  tool: AnyTool;
  /** Why the tool has no contract case. */
  skip: string;
}

export type InventoryEntry = CoveredTool | SkippedTool;

export function isSkipped(entry: InventoryEntry): entry is SkippedTool {
  return 'skip' in entry;
}

const SLACK = 'Calls the Slack API, not the app.';
const TRADESCAPE = 'Calls the Tradescape API, not the app.';
const ONE2B = 'Calls the One2B app, a separate deployment with its own router. The contract covers the Exponential app only.';
const WHATSAPP_STORE = "Reads the WhatsApp gateway's message store in this process, not the app.";

export const TOOL_INVENTORY: InventoryEntry[] = [
  // ── action-items-tools.ts ──
  {
    tool: parseActionItemsTool,
    writes: true,
    cases: [
      {
        input: { transcriptionSessionId: 'meeting_1' },
        // The second request is built from the transcript the first one returns.
        responses: {
          'transcription.getById': {
            id: 'meeting_1',
            summary: '**Pat Example**\nSend the pricing draft by 2026-11-20 (12:30)\nBook the venue when you get a chance (14:05)',
          },
        },
      },
    ],
  },
  {
    tool: getActionItemsTool,
    writes: false,
    cases: [
      {
        input: { transcriptionSessionId: 'meeting_1', assigneeEmail: 'pat@example.com', status: 'ACTIVE', limit: 20 },
      },
    ],
  },
  {
    tool: updateActionItemTool,
    writes: true,
    cases: [
      {
        input: {
          actionItemId: 'action_1',
          status: 'COMPLETED',
          priority: 'HIGH',
          description: 'Send the pricing draft',
          dueDate: '2026-11-20T09:00:00.000Z',
          completionNote: 'Sent on Friday.',
        },
        // The completion note is only posted after the update returns a row.
        responses: { 'action.update': { id: 'action_1', status: 'COMPLETED', updatedAt: '2026-11-17T09:00:00.000Z' } },
      },
    ],
  },

  // ── agent-guidance-tools.ts ──
  { tool: getMethodTool, writes: false, cases: [{ input: {} }] },
  { tool: getContextTool, writes: false, cases: [{ input: { workspaceId: 'ws_contract', projectId: 'project_1' } }] },

  // ── decision-tools.ts ──
  {
    tool: logDecisionTool,
    writes: true,
    cases: [
      {
        input: {
          statement: 'Ship the importer behind a flag',
          body: 'Decided in the planning call.',
          status: 'ACCEPTED',
          decidedAt: '2026-11-17T09:00:00.000Z',
          transcriptionSessionId: 'meeting_1',
          projectId: 'project_1',
          productId: 'product_1',
          deciders: [{ name: 'Pat Example', email: 'pat@example.com' }],
          evidence: [{ turnIndex: 3, speaker: 'Pat Example', text: "Let's ship it behind a flag." }],
        },
      },
    ],
  },
  {
    tool: updateDecisionTool,
    writes: true,
    cases: [
      {
        // A text change and a status change: the tool sends one request for each.
        input: {
          decisionId: 'decision_1',
          statement: 'Ship the importer to everyone',
          body: 'The flag is gone.',
          decidedAt: '2026-11-17T09:00:00.000Z',
          status: 'SUPERSEDED',
          supersededById: 'decision_2',
        },
      },
    ],
  },
  {
    tool: listDecisionsTool,
    writes: false,
    cases: [{ input: { search: 'importer', status: 'ACCEPTED', projectId: 'project_1', limit: 10 } }],
  },

  // ── document-tools.ts ──
  {
    tool: ingestDocumentTool,
    writes: true,
    cases: [
      {
        input: {
          source: 'text',
          title: 'Pricing notes',
          description: 'Notes from the pricing review',
          sourceType: 'upload',
          text: 'Tier one is 20 per seat.',
        },
      },
    ],
  },
  {
    tool: searchDocumentsTool,
    writes: false,
    cases: [{ input: { query: 'pricing tiers', limit: 5, similarityThreshold: 0.4 } }],
  },
  {
    tool: getDocumentsTool,
    writes: false,
    cases: [
      { name: 'a source type the app knows', input: { sourceType: 'upload', ingestionStatus: 'completed', limit: 20 } },
      // The tool's own description offers "meeting" as a source type.
      { name: 'a source type the tool description lists', input: { sourceType: 'meeting' } },
    ],
    knownViolations: [
      { procedure: 'document.list', field: 'sourceType', rule: 'enum', ticket: 'chill.quail (963)' },
    ],
  },
  { tool: getDocumentDownloadUrlTool, writes: false, cases: [{ input: { documentId: 'document_1' } }] },
  { tool: deleteDocumentTool, writes: true, cases: [{ input: { documentId: 'document_1' } }] },

  // ── email-tools.ts ──
  { tool: checkEmailConnectionTool, writes: false, cases: [{ input: {} }] },
  {
    tool: getRecentEmailsTool,
    writes: false,
    cases: [{ input: { maxResults: 10, unreadOnly: true, since: '2026-11-16T00:00:00.000Z' } }],
  },
  { tool: getEmailByIdTool, writes: false, cases: [{ input: { emailId: 'email_1' } }] },
  { tool: searchEmailsTool, writes: false, cases: [{ input: { query: 'invoice', maxResults: 10 } }] },
  {
    tool: sendEmailTool,
    writes: true,
    cases: [
      {
        input: {
          to: 'pat@example.com',
          cc: 'sam@example.com',
          subject: 'Pricing draft',
          body: 'The draft is attached.',
          inReplyTo: '<message-1@example.com>',
          references: '<message-0@example.com>',
          userConfirmed: true,
        },
      },
    ],
  },
  {
    tool: replyToEmailTool,
    writes: true,
    cases: [{ input: { emailId: 'email_1', body: 'Thanks, received.', userConfirmed: true } }],
  },

  // ── feature-ideation-tools.ts ──
  {
    tool: ideateFeaturesTool,
    writes: true,
    cases: [{ input: { transcriptionId: 'meeting_1', focus: 'onboarding' } }],
  },

  // ── index.ts ──
  { tool: binancePriceTool, skip: 'Calls the Binance API, not the app.' },
  { tool: binanceCandlestickTool, skip: 'Calls the Binance API, not the app.' },
  { tool: pierreTradingQueryTool, skip: "Reads Mastra's own vector store, not the app." },
  { tool: weatherTool, skip: 'Calls the Open-Meteo API, not the app.' },
  { tool: queryExponentialDocsTool, skip: "Reads Mastra's own vector store, not the app." },
  { tool: getWhatsAppContextTool, skip: "Reads Mastra's own message store, not the app." },
  { tool: getProjectContextTool, writes: false, cases: [{ input: { projectId: 'project_1' } }] },
  { tool: getProjectActionsTool, writes: false, cases: [{ input: { projectId: 'project_1', status: 'ACTIVE' } }] },
  {
    tool: createProjectActionTool,
    writes: true,
    cases: [
      {
        input: {
          projectId: 'project_1',
          name: 'Send the pricing draft',
          description: 'To Pat, before the review',
          priority: 'Quick',
          dueDate: '2026-11-20T09:00:00.000Z',
          scheduledStart: '2026-11-19T09:00:00.000Z',
        },
      },
    ],
  },
  {
    tool: quickCreateActionTool,
    writes: true,
    cases: [
      {
        input: {
          text: 'Call Pat tomorrow about pricing',
          priority: 'Quick',
          projectId: 'project_1',
          scheduledStart: '2026-11-18T09:00:00.000Z',
          dueDate: '2026-11-20T09:00:00.000Z',
        },
      },
    ],
  },
  {
    tool: updateProjectStatusTool,
    writes: true,
    cases: [
      {
        input: {
          projectId: 'project_1',
          status: 'ACTIVE',
          priority: 'HIGH',
          progress: 40,
          reviewDate: '2026-11-24T09:00:00.000Z',
          nextActionDate: '2026-11-18T09:00:00.000Z',
        },
      },
    ],
  },
  { tool: getProjectGoalsTool, writes: false, cases: [{ input: { projectId: 'project_1' } }] },
  { tool: getAllGoalsTool, writes: false, cases: [{ input: {} }] },
  {
    tool: getAllProjectsTool,
    writes: false,
    cases: [
      { name: 'in a workspace', input: { includeAll: false } },
      { name: 'no workspace in the turn', input: { includeAll: true }, context: { workspaceId: undefined } },
    ],
  },
  {
    tool: getMeetingTranscriptionsTool,
    writes: false,
    cases: [
      {
        input: {
          transcriptionId: 'meeting_1',
          projectId: 'project_1',
          startDate: '2026-11-10T00:00:00.000Z',
          endDate: '2026-11-17T00:00:00.000Z',
          participants: ['Pat Example'],
          meetingType: 'planning',
          limit: 5,
          includeTranscript: true,
          truncateTranscript: true,
          maxTranscriptLength: 2000,
        },
      },
    ],
  },
  {
    tool: queryMeetingContextTool,
    writes: false,
    cases: [
      {
        input: {
          query: 'What did Pat say about pricing?',
          transcriptionId: 'meeting_1',
          projectId: 'project_1',
          dateRange: { start: '2026-11-10T00:00:00.000Z', end: '2026-11-17T00:00:00.000Z' },
          topK: 5,
        },
      },
    ],
  },
  {
    tool: getMeetingInsightsTool,
    writes: false,
    cases: [
      {
        input: {
          projectId: 'project_1',
          timeframe: 'custom',
          startDate: '2026-11-10T00:00:00.000Z',
          endDate: '2026-11-17T00:00:00.000Z',
          insightTypes: ['decisions', 'action_items'],
        },
      },
    ],
  },
  {
    tool: getCalendarEventsTool,
    writes: false,
    cases: [
      {
        input: {
          timeframe: 'custom',
          days: 7,
          timeMin: '2026-11-17T00:00:00.000Z',
          timeMax: '2026-11-24T00:00:00.000Z',
        },
      },
    ],
  },
  { tool: getTodayCalendarEventsTool, writes: false, cases: [{ input: {} }] },
  { tool: getUpcomingCalendarEventsTool, writes: false, cases: [{ input: { days: 7 } }] },
  {
    tool: getCalendarEventsInRangeTool,
    writes: false,
    cases: [
      { input: { timeMin: '2026-11-17T00:00:00.000Z', timeMax: '2026-11-24T00:00:00.000Z', provider: 'google' } },
    ],
  },
  {
    tool: findAvailableTimeSlotsTool,
    writes: false,
    cases: [{ input: { date: '2026-11-20', startHour: 9, endHour: 17, slotDurationMinutes: 30 } }],
  },
  {
    tool: createCalendarEventTool,
    writes: true,
    cases: [
      {
        input: {
          summary: 'Pricing review',
          description: 'Go through the draft',
          startDateTime: '2026-11-20T10:00:00.000Z',
          endDateTime: '2026-11-20T10:30:00.000Z',
          location: 'Room 2',
          attendees: [{ email: 'pat@example.com', displayName: 'Pat Example' }],
          provider: 'google',
          userConfirmed: true,
        },
      },
    ],
  },
  { tool: checkCalendarConnectionTool, writes: false, cases: [{ input: {} }] },
  { tool: lookupContactByEmailTool, writes: false, cases: [{ input: { email: 'pat@example.com' } }] },
  {
    tool: createCrmContactTool,
    writes: true,
    cases: [{ input: { email: 'pat@example.com', phone: '+353871234567', firstName: 'Pat', lastName: 'Example' } }],
  },
  {
    tool: searchCrmContactsTool,
    writes: false,
    cases: [{ input: { search: 'Pat', tags: ['investor'], organizationId: 'organization_1', limit: 10 } }],
  },
  { tool: getCrmContactTool, writes: false, cases: [{ input: { contactId: 'contact_1', includeInteractions: true } }] },
  {
    tool: createFullCrmContactTool,
    writes: true,
    cases: [
      {
        input: {
          firstName: 'Pat',
          lastName: 'Example',
          email: 'pat@example.com',
          phone: '+353871234567',
          linkedIn: 'https://www.linkedin.com/in/pat-example',
          telegram: '@patexample',
          twitter: '@patexample',
          github: 'patexample',
          about: 'Runs pricing at Example Ltd.',
          skills: ['pricing'],
          tags: ['investor'],
          organizationId: 'organization_1',
        },
      },
    ],
  },
  {
    tool: updateCrmContactTool,
    writes: true,
    cases: [
      {
        input: {
          contactId: 'contact_1',
          firstName: 'Pat',
          lastName: 'Example',
          email: 'pat@example.com',
          phone: '+353871234567',
          linkedIn: 'https://www.linkedin.com/in/pat-example',
          telegram: '@patexample',
          twitter: '@patexample',
          github: 'patexample',
          about: 'Runs pricing at Example Ltd.',
          skills: ['pricing'],
          tags: ['investor'],
          organizationId: 'organization_1',
        },
      },
    ],
  },
  {
    tool: addCrmInteractionTool,
    writes: true,
    cases: [
      {
        input: {
          contactId: 'contact_1',
          type: 'EMAIL',
          direction: 'OUTBOUND',
          subject: 'Pricing draft',
          notes: 'Sent the draft.',
        },
      },
    ],
  },
  {
    tool: searchCrmOrganizationsTool,
    writes: false,
    cases: [{ input: { search: 'Example', industry: 'Software', limit: 10 } }],
  },
  {
    tool: createCrmOrganizationTool,
    writes: true,
    cases: [
      {
        input: {
          name: 'Example Ltd',
          description: 'A customer',
          websiteUrl: 'https://example.com',
          industry: 'Software',
          size: '11-50',
        },
      },
    ],
  },

  // ── knowledge-tools.ts ──
  {
    tool: createPageTool,
    writes: true,
    cases: [
      { input: { title: 'Pricing notes', body: '# Pricing\n\nTier one is 20 per seat.', projectId: 'project_1', includeInSearch: true } },
    ],
  },
  {
    tool: updatePageTool,
    writes: true,
    cases: [{ input: { pageId: 'page_1', title: 'Pricing notes', body: '# Pricing\n\nTier one is 25 per seat.', includeInSearch: true } }],
  },

  // ── meeting-context-tools.ts ──
  { tool: ingestTranscriptTool, writes: true, cases: [{ input: { transcriptionSessionId: 'meeting_1' } }] },
  {
    tool: searchContextTool,
    writes: false,
    cases: [
      { input: { query: 'pricing tiers', limit: 5, participantEmail: 'pat@example.com', sourceType: 'transcription' } },
    ],
  },
  { tool: getParticipantHistoryTool, writes: false, cases: [{ input: { email: 'pat@example.com', limit: 5 } }] },
  {
    tool: findRelatedMeetingsTool,
    writes: false,
    cases: [
      {
        input: {
          meetingTitle: 'Pricing review',
          participantEmails: ['pat@example.com'],
          matchThreshold: 0.5,
          lookbackDays: 90,
          limit: 5,
        },
      },
    ],
  },

  // ── notion-tools.ts ──
  { tool: notionSearchTool, writes: false, cases: [{ input: { query: 'roadmap', filter: 'page' } }] },
  { tool: notionGetPageTool, writes: false, cases: [{ input: { pageId: 'notion_page_1' } }] },
  {
    tool: notionQueryDatabaseTool,
    writes: false,
    cases: [
      {
        input: {
          databaseId: 'notion_database_1',
          filter: { property: 'Status', select: { equals: 'In progress' } },
          sorts: [{ property: 'Created', direction: 'descending' }],
          startCursor: 'cursor_1',
        },
      },
    ],
  },
  {
    tool: notionCreatePageTool,
    writes: true,
    cases: [{ input: { databaseId: 'notion_database_1', title: 'Pricing notes', properties: { Status: 'Draft' } } }],
  },
  {
    tool: notionUpdatePageTool,
    writes: true,
    cases: [{ input: { pageId: 'notion_page_1', properties: { Status: 'Done' } } }],
  },

  // ── okr-tools.ts ──
  { tool: getOkrObjectivesTool, writes: false, cases: [{ input: { period: 'Q4-2026' } }] },
  {
    tool: createOkrObjectiveTool,
    writes: true,
    cases: [
      {
        input: {
          title: 'Grow paid seats',
          description: 'Double paid seats this quarter',
          whyThisGoal: 'Revenue funds the next hire',
          period: 'Q4-2026',
          lifeDomainId: 2,
          parentGoalId: 7,
        },
      },
    ],
  },
  {
    tool: updateOkrObjectiveTool,
    writes: true,
    cases: [
      {
        input: {
          id: 19,
          title: 'Grow paid seats',
          description: 'Double paid seats this quarter',
          whyThisGoal: 'Revenue funds the next hire',
          period: 'Q4-2026',
          lifeDomainId: 2,
        },
      },
    ],
  },
  { tool: deleteOkrObjectiveTool, writes: true, cases: [{ input: { id: 19 } }] },
  {
    tool: createOkrKeyResultTool,
    writes: true,
    cases: [
      {
        input: {
          goalId: 19,
          title: 'Reach 200 paid seats',
          description: 'Counted on the last day of the quarter',
          targetValue: 200,
          startValue: 100,
          unit: 'count',
          unitLabel: 'seats',
          period: 'Q4-2026',
        },
      },
    ],
  },
  {
    tool: updateOkrKeyResultTool,
    writes: true,
    cases: [
      {
        input: {
          id: 'key_result_1',
          title: 'Reach 220 paid seats',
          description: 'Counted on the last day of the quarter',
          targetValue: 220,
          currentValue: 140,
          startValue: 100,
          unit: 'count',
          unitLabel: 'seats',
          status: 'on-track',
          confidence: 70,
        },
      },
    ],
  },
  { tool: deleteOkrKeyResultTool, writes: true, cases: [{ input: { id: 'key_result_1' } }] },
  {
    tool: checkInOkrKeyResultTool,
    writes: true,
    cases: [{ input: { keyResultId: 'key_result_1', newValue: 150, notes: 'Ten new seats this week.' } }],
  },
  { tool: getOkrStatsTool, writes: false, cases: [{ input: { period: 'Q4-2026' } }] },
  { tool: linkProjectToGoalTool, writes: true, cases: [{ input: { goalId: 19, projectId: 'project_1' } }] },
  { tool: unlinkProjectFromGoalTool, writes: true, cases: [{ input: { goalId: 19, projectId: 'project_1' } }] },
  {
    tool: linkProjectToKeyResultTool,
    writes: true,
    cases: [{ input: { keyResultId: 'key_result_1', projectId: 'project_1' } }],
  },
  {
    tool: unlinkProjectFromKeyResultTool,
    writes: true,
    cases: [{ input: { keyResultId: 'key_result_1', projectId: 'project_1' } }],
  },
  {
    tool: linkObjectiveToParentTool,
    writes: true,
    cases: [
      { name: 'set a parent', input: { goalId: 19, parentGoalId: 7 } },
      { name: 'clear the parent', input: { goalId: 19, parentGoalId: null } },
    ],
  },
  { tool: addObjectiveCommentTool, writes: true, cases: [{ input: { goalId: 19, content: 'Seats are ahead of plan.' } }] },
  {
    tool: addObjectiveUpdateTool,
    writes: true,
    cases: [{ input: { goalId: 19, content: 'Ten new seats this week.', health: 'on-track' } }],
  },

  // ── one2b-tools.ts ──
  { tool: researchContactTool, skip: 'Calls the Serper search API, not the app.' },
  { tool: one2bGetTrackQuestionsTool, skip: ONE2B },
  { tool: one2bCreateLeadTool, skip: ONE2B },
  { tool: one2bLookupLeadTool, skip: ONE2B },
  { tool: one2bEscalateTool, skip: ONE2B },

  // ── pm-tools.ts ──
  { tool: getActiveSprintTool, writes: false, cases: [{ input: { workspaceId: 'ws_contract' } }] },
  { tool: getSprintMetricsTool, writes: false, cases: [{ input: { listId: 'list_1' } }] },
  { tool: getRiskSignalsTool, writes: false, cases: [{ input: { listId: 'list_1' } }] },
  {
    tool: getGitHubActivityTool,
    writes: false,
    cases: [{ input: { workspaceId: 'ws_contract', since: '2026-11-10T00:00:00.000Z' } }],
  },
  { tool: captureDailySnapshotTool, writes: true, cases: [{ input: { listId: 'list_1' } }] },

  // ── project-tools.ts ──
  {
    tool: createProjectTool,
    writes: true,
    cases: [
      {
        input: {
          name: 'Pricing review',
          description: 'Settle the tiers',
          status: 'ACTIVE',
          priority: 'HIGH',
          startDate: '2026-11-17T00:00:00.000Z',
          endDate: '2026-12-15T00:00:00.000Z',
        },
      },
    ],
  },
  {
    tool: updateProjectTool,
    writes: true,
    cases: [
      {
        input: {
          projectId: 'project_1',
          name: 'Pricing review',
          description: null,
          status: 'ON_HOLD',
          priority: 'LOW',
          startDate: '2026-11-17T00:00:00.000Z',
          endDate: null,
        },
      },
    ],
  },
  {
    tool: updateActionTool,
    writes: true,
    cases: [
      {
        input: {
          actionId: 'action_1',
          name: 'Send the pricing draft',
          description: null,
          projectId: 'project_1',
          priority: 'Scheduled',
          status: 'ACTIVE',
          dueDate: '2026-11-20T09:00:00.000Z',
          scheduledStart: '2026-11-19T09:00:00.000Z',
          scheduledEnd: '2026-11-19T09:30:00.000Z',
          duration: 30,
        },
      },
    ],
  },
  { tool: getTodaysActionsTool, writes: false, cases: [{ input: { workspaceId: 'ws_contract' } }] },
  { tool: getOverdueTriageTool, writes: false, cases: [{ input: { workspaceId: 'ws_contract' } }] },
  { tool: deferActionsTool, writes: true, cases: [{ input: { actionIds: ['action_1', 'action_2'] } }] },
  {
    tool: rescheduleActionsTool,
    writes: true,
    cases: [{ input: { actionIds: ['action_1'], date: '2026-11-21' } }],
  },
  { tool: deleteProjectTool, writes: true, cases: [{ input: { projectId: 'project_1', confirmDeletion: true } }] },
  { tool: getUserWorkspacesTool, writes: false, cases: [{ input: {} }] },
  {
    tool: bulkCreateWorkspaceStructureTool,
    writes: true,
    cases: [
      {
        input: {
          workspaceId: 'ws_contract',
          parentGoalId: 7,
          goals: [
            {
              title: 'Grow paid seats',
              description: 'Double paid seats this quarter',
              projects: [
                {
                  name: 'Pricing review',
                  description: 'Settle the tiers',
                  priority: 'HIGH',
                  actions: [{ name: 'Send the pricing draft' }],
                },
              ],
            },
          ],
        },
      },
    ],
  },

  // ── reading-list-tools.ts ──
  {
    tool: saveToReadingListTool,
    writes: true,
    cases: [{ input: { url: 'https://example.com/article', title: 'An article', note: 'Read before the review' } }],
  },
  { tool: listReadingListTool, writes: false, cases: [{ input: { status: 'unread', limit: 10 } }] },
  {
    tool: markReadingListItemTool,
    writes: true,
    cases: [{ input: { resourceId: 'resource_1', readStatus: 'read' } }],
  },

  // ── routing-tools.ts ──
  {
    tool: listAssignableMembersTool,
    writes: false,
    cases: [
      { name: 'an existing action', input: { actionId: 'action_1' } },
      { name: 'an action about to be created', input: { projectId: 'project_1' } },
    ],
  },
  { tool: assignActionTool, writes: true, cases: [{ input: { actionId: 'action_1', userIds: ['user_2'] } }] },

  // ── run-tools.ts ──
  { tool: getRunContextTool, writes: false, cases: [{ input: {} }] },
  { tool: reportProgressTool, writes: true, cases: [{ input: { text: 'Read the brief. Drafting now.' } }] },
  { tool: commentOnActionTool, writes: true, cases: [{ input: { markdown: 'The draft is **ready**.' } }] },
  { tool: reassignActionTool, writes: true, cases: [{ input: { userId: 'user_2' } }] },
  { tool: askOwnerTool, writes: true, cases: [{ input: { question: 'Which tier is the default?' } }] },
  { tool: finishRunTool, writes: true, cases: [{ input: { summary: 'Drafted the pricing page.', readyToClose: true } }] },
  {
    tool: runUpdateActionTool,
    writes: true,
    cases: [{ input: { actionId: 'action_1', name: 'Send the pricing draft', dueDate: '2026-11-20T09:00:00.000Z' } }],
  },

  // ── slack-tools.ts ──
  { tool: sendSlackMessageTool, skip: SLACK },
  { tool: updateSlackMessageTool, skip: SLACK },
  { tool: getSlackUserInfoTool, skip: SLACK },
  { tool: listSlackChannelsTool, skip: SLACK },
  { tool: getSlackChannelHistoryTool, skip: SLACK },
  { tool: getSlackThreadRepliesTool, skip: SLACK },
  { tool: searchSlackMessagesTool, skip: SLACK },
  { tool: getSlackMentionsTool, skip: SLACK },
  { tool: getSlackUnreadsTool, skip: SLACK },

  // ── ticket-tools.ts ──
  { tool: listProductsTool, writes: false, cases: [{ input: { workspaceId: 'ws_contract' } }] },
  {
    tool: createTicketTool,
    writes: true,
    cases: [
      {
        input: {
          productId: 'product_1',
          title: 'Importer drops the last row',
          body: 'Seen on a 2,000-row file.',
          type: 'BUG',
          status: 'BACKLOG',
          priority: 1,
          points: 2,
          assigneeId: 'user_2',
        },
      },
    ],
  },
  {
    tool: bulkCreateTicketsTool,
    writes: true,
    cases: [
      {
        input: {
          productId: 'product_1',
          tickets: [
            {
              title: 'Importer drops the last row',
              body: 'Seen on a 2,000-row file.',
              type: 'BUG',
              status: 'BACKLOG',
              priority: 1,
              points: 2,
              cycleName: 'Cycle 18',
              assigneeName: 'Pat Example',
              labels: ['importer'],
            },
          ],
          labels: ['from-notion'],
        },
      },
    ],
  },
  {
    tool: importNotionCycleTicketsTool,
    writes: true,
    cases: [
      {
        input: {
          productId: 'product_1',
          notionDatabaseId: 'notion_database_1',
          cycleName: 'Cycle 18',
          cyclePageId: 'notion_page_1',
          relationProperty: 'Cycle',
          labels: ['from-notion'],
          targetCycleName: 'Cycle 18',
          properties: { status: 'Status', priority: 'Priority', type: 'Type', effort: 'Effort', label: 'Label' },
          dryRun: true,
        },
      },
    ],
  },
  { tool: listCyclesTool, writes: false, cases: [{ input: { productId: 'product_1', workspaceId: 'ws_contract' } }] },
  {
    tool: listTicketsTool,
    writes: false,
    cases: [{ input: { productId: 'product_1', cycle: 'current', status: 'IN_PROGRESS', type: 'BUG', limit: 20 } }],
  },
  {
    tool: addTicketDependenciesTool,
    writes: true,
    cases: [{ input: { productId: 'product_1', dependencies: [{ ticketNumber: 12, dependsOnNumber: 11 }] } }],
  },

  // ── tradescape-tools.ts ──
  { tool: listSetupsTool, skip: TRADESCAPE },
  { tool: createSetupTool, skip: TRADESCAPE },
  { tool: listAlertsTool, skip: TRADESCAPE },
  { tool: createAlertTool, skip: TRADESCAPE },
  { tool: deleteAlertTool, skip: TRADESCAPE },
  { tool: listPositionsTool, skip: TRADESCAPE },
  { tool: syncTradesTool, skip: TRADESCAPE },
  { tool: dailySummaryTool, skip: TRADESCAPE },

  // ── whatsapp-tools.ts ──
  { tool: listWhatsAppChatsTool, skip: WHATSAPP_STORE },
  { tool: getWhatsAppChatHistoryTool, skip: WHATSAPP_STORE },
  { tool: searchWhatsAppChatsTool, skip: WHATSAPP_STORE },
];
