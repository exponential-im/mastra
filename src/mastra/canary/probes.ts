/**
 * Live-probe plans for the tool canary (ticket 959).
 *
 * The list of tools is NOT here: it is the contract tests' inventory
 * (`../tools/contract/tool-inventory.ts`, ticket 958), the one list of agent
 * tools. That list says which tools write and which never call the app, and
 * the canary leaves both out. For the rest, the tools that read from the app,
 * this file says how to call each one against a live app: the inventory's
 * sample inputs use made-up ids, which a real app answers with "not found".
 *
 * `probes.test.ts` fails when a read tool in the inventory has no plan here,
 * so a new read tool cannot skip the canary.
 *
 * Adding a read tool: add it to the inventory, then add a plan here. If it
 * cannot be called against the fixture workspace (it needs a connected
 * mailbox, say), give it `skip` with a reason a person can act on.
 */
import type { AnyTool } from '../tools/contract/tool-inventory.js';
import * as actionItems from '../tools/action-items-tools.js';
import * as agentGuidance from '../tools/agent-guidance-tools.js';
import * as decisions from '../tools/decision-tools.js';
import * as documents from '../tools/document-tools.js';
import * as email from '../tools/email-tools.js';
import * as featureIdeation from '../tools/feature-ideation-tools.js';
import * as core from '../tools/index.js';
import * as knowledge from '../tools/knowledge-tools.js';
import * as meetingContext from '../tools/meeting-context-tools.js';
import * as notion from '../tools/notion-tools.js';
import * as okr from '../tools/okr-tools.js';
import * as one2b from '../tools/one2b-tools.js';
import * as pm from '../tools/pm-tools.js';
import * as projects from '../tools/project-tools.js';
import * as readingList from '../tools/reading-list-tools.js';
import * as routing from '../tools/routing-tools.js';
import * as run from '../tools/run-tools.js';
import * as slack from '../tools/slack-tools.js';
import * as tickets from '../tools/ticket-tools.js';
import * as timeZone from '../tools/time-zone-tools.js';
import * as tradescape from '../tools/tradescape-tools.js';
import * as whatsapp from '../tools/whatsapp-tools.js';

/**
 * Ids a probe input may need. `workspaceId` is always known (the workspace the
 * run is scoped to); the rest are found at run time from the list tools
 * (`provides`), so nothing here is an id captured from a database.
 */
export interface ToolFixture {
  workspaceId: string;
  projectId?: string;
  productId?: string;
  contactId?: string;
  documentId?: string;
  sprintListId?: string;
}

export type FixtureKey = keyof ToolFixture;

/** Stand-in ids for checking the plans without an app (`probes.test.ts`). */
export const STATIC_FIXTURE: Required<ToolFixture> = {
  workspaceId: 'ws_probe_fixture',
  projectId: 'proj_probe_fixture',
  productId: 'prod_probe_fixture',
  contactId: 'contact_probe_fixture',
  documentId: 'doc_probe_fixture',
  sprintListId: 'list_probe_fixture',
};

export interface ProbePlan {
  /**
   * The export name, which is also the key agents register the tool under and
   * so the name a failed call is reported with (`queryMeetingContextTool`).
   * The app files the canary's finding and a chat's finding on one ticket
   * only because both use this name.
   */
  name: string;
  tool: AnyTool;
  /** App procedures (tRPC paths) the tool calls, for the report. */
  procedures: readonly string[];
  /** A valid input for a live app. */
  input: (fixture: ToolFixture) => Record<string, unknown>;
  /** Fixture ids `input` needs. Missing at run time means the probe is skipped, with that as the reason. */
  needs?: readonly FixtureKey[];
  /** Ids this tool's output supplies to later probes. */
  provides?: (output: unknown) => Partial<ToolFixture>;
  /** Why the canary does not call this read tool. Always a reason a person can act on. */
  skip?: string;
  /** The app embeds the query to answer this call (a few tokens of an embedding model, no chat model). */
  embeds?: boolean;
}

function isTool(value: unknown): value is AnyTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnyTool).id === 'string' &&
    typeof (value as AnyTool).execute === 'function'
  );
}

/**
 * tool -> export name, for every tool module. The report names each tool the
 * way agents do, including the write and external tools it only lists.
 */
const EXPORT_NAMES = new Map<AnyTool, string>();
for (const mod of [
  actionItems, agentGuidance, decisions, documents, email, featureIdeation, knowledge, meetingContext, notion,
  okr, one2b, pm, projects, readingList, routing, run, slack, tickets, timeZone, tradescape, whatsapp, core,
] as Array<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(mod)) {
    if (isTool(value) && !EXPORT_NAMES.has(value)) EXPORT_NAMES.set(value, name);
  }
}

/** The name agents know a tool by; its id when it is exported from nowhere we know. */
export function exportNameOf(tool: AnyTool): string {
  return EXPORT_NAMES.get(tool) ?? tool.id;
}

function firstId(output: unknown, listKey: string | null): string | undefined {
  const list = listKey === null ? output : (output as Record<string, unknown> | null | undefined)?.[listKey];
  if (!Array.isArray(list)) return undefined;
  const id = (list[0] as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function provide(key: FixtureKey, value: string | undefined): Partial<ToolFixture> {
  return value ? { [key]: value } : {};
}

const plan = (
  name: string,
  tool: AnyTool,
  procedures: readonly string[],
  input: (fixture: ToolFixture) => Record<string, unknown>,
  extra: Partial<Pick<ProbePlan, 'needs' | 'provides' | 'skip' | 'embeds'>> = {},
): ProbePlan => ({ name, tool, procedures, input, ...extra });

const NEEDS_MAILBOX = 'needs a connected mailbox, which the fixture workspace does not have';
const NEEDS_CALENDAR = 'needs a connected Google Calendar, which the fixture workspace does not have';
const NEEDS_RUN = 'needs the token of an assigned agent run, which exists only while a run is in flight';

/** A probe query with no ids or names in it. */
const PROBE_QUERY = 'tool canary probe';
/** An address that can never belong to a real person (RFC 2606). */
const PROBE_EMAIL = 'tool-canary@example.invalid';

export const PROBE_PLANS: readonly ProbePlan[] = [
  // --- Workspace, projects, actions -------------------------------------
  plan('getUserWorkspacesTool', projects.getUserWorkspacesTool, ['mastra.getUserWorkspaces'], () => ({})),
  plan('getAllProjectsTool', core.getAllProjectsTool, ['project.getAll'], () => ({ includeAll: true }), {
    provides: (output) => provide('projectId', firstId(output, 'projects')),
  }),
  plan('getProjectContextTool', core.getProjectContextTool, ['mastra.projectContext'], (fx) => ({ projectId: fx.projectId }), {
    needs: ['projectId'],
  }),
  plan('getProjectActionsTool', core.getProjectActionsTool, ['mastra.projectActions'], (fx) => ({ projectId: fx.projectId }), {
    needs: ['projectId'],
  }),
  plan('getProjectGoalsTool', core.getProjectGoalsTool, ['mastra.projectContext'], (fx) => ({ projectId: fx.projectId }), {
    needs: ['projectId'],
  }),
  plan('getAllGoalsTool', core.getAllGoalsTool, ['mastra.getAllGoals'], () => ({})),
  plan('getTodaysActionsTool', projects.getTodaysActionsTool, ['action.getTodaysActions'], (fx) => ({ workspaceId: fx.workspaceId })),
  plan('getOverdueTriageTool', projects.getOverdueTriageTool, ['action.getOverdueTriage'], (fx) => ({ workspaceId: fx.workspaceId })),
  plan('getActionItemsTool', actionItems.getActionItemsTool, ['action.findBySource'], () => ({ limit: 5 })),
  plan(
    'listAssignableMembersTool',
    routing.listAssignableMembersTool,
    ['action.getAssignableUsers', 'action.getAssignableUsersForContext'],
    (fx) => ({ projectId: fx.projectId }),
    { needs: ['projectId'] },
  ),

  // --- Method and context ------------------------------------------------
  plan('getMethodTool', agentGuidance.getMethodTool, ['agentGuidance.method'], () => ({})),
  plan('getContextTool', agentGuidance.getContextTool, ['agentGuidance.context'], (fx) => ({ workspaceId: fx.workspaceId })),

  // --- Decisions ----------------------------------------------------------
  plan('listDecisionsTool', decisions.listDecisionsTool, ['decision.list'], () => ({ limit: 5 })),

  // --- Documents and knowledge -------------------------------------------
  plan('getDocumentsTool', documents.getDocumentsTool, ['document.list'], () => ({ limit: 5 }), {
    provides: (output) => provide('documentId', firstId(output, null)),
  }),
  plan(
    'getDocumentDownloadUrlTool',
    documents.getDocumentDownloadUrlTool,
    ['document.getDownloadUrl'],
    (fx) => ({ documentId: fx.documentId }),
    { needs: ['documentId'] },
  ),
  plan('searchDocumentsTool', documents.searchDocumentsTool, ['knowledgeChunk.semanticSearch'], () => ({ query: PROBE_QUERY, limit: 3 }), {
    embeds: true,
  }),

  // --- Meetings -----------------------------------------------------------
  plan(
    'getMeetingTranscriptionsTool',
    core.getMeetingTranscriptionsTool,
    ['mastra.getMeetingTranscriptions'],
    () => ({ limit: 3, includeTranscript: false }),
  ),
  plan('queryMeetingContextTool', core.queryMeetingContextTool, ['mastra.queryMeetingContext'], () => ({ query: PROBE_QUERY, topK: 3 }), {
    embeds: true,
  }),
  plan('getMeetingInsightsTool', core.getMeetingInsightsTool, ['mastra.getMeetingInsights'], () => ({ timeframe: 'last_week' })),
  plan('searchContextTool', meetingContext.searchContextTool, ['knowledgeChunk.semanticSearch'], () => ({ query: PROBE_QUERY, limit: 3 }), {
    embeds: true,
  }),
  plan(
    'getParticipantHistoryTool',
    meetingContext.getParticipantHistoryTool,
    ['transcriptionSessionParticipant.getHistory'],
    () => ({ email: PROBE_EMAIL, limit: 3 }),
  ),
  plan('findRelatedMeetingsTool', meetingContext.findRelatedMeetingsTool, ['transcription.findRelated'], () => ({
    meetingTitle: PROBE_QUERY,
    limit: 3,
  })),

  // --- Calendar -----------------------------------------------------------
  // Only get-calendar-events insists on a connected Google Calendar; the
  // others answer with no events when nothing is connected.
  plan('checkCalendarConnectionTool', core.checkCalendarConnectionTool, ['mastra.getAllCalendarConnectionStatus'], () => ({})),
  // Reads the saved zone only when the turn carries none, as a canary turn does.
  plan('getMyTimeZoneTool', timeZone.getMyTimeZoneTool, ['user.getTimezone'], () => ({})),
  plan('getCalendarEventsTool', core.getCalendarEventsTool, ['mastra.getCalendarEvents'], () => ({ timeframe: 'today' }), {
    skip: NEEDS_CALENDAR,
  }),
  plan('getTodayCalendarEventsTool', core.getTodayCalendarEventsTool, ['mastra.getTodayCalendarEvents'], () => ({})),
  plan('getUpcomingCalendarEventsTool', core.getUpcomingCalendarEventsTool, ['mastra.getUpcomingCalendarEvents'], () => ({ days: 3 })),
  plan(
    'getCalendarEventsInRangeTool',
    core.getCalendarEventsInRangeTool,
    ['mastra.getCalendarEventsInRange'],
    () => ({ startDate: '2026-01-05', endDate: '2026-01-06' }),
  ),
  plan(
    'findAvailableTimeSlotsTool',
    core.findAvailableTimeSlotsTool,
    ['mastra.getCalendarEventsInRange'],
    // A canary turn carries no zone and the canary user may have none saved;
    // without one the tool asks instead of reading the calendar.
    () => ({ date: '2026-01-05', timeZone: 'Europe/Berlin' }),
  ),

  // --- Email --------------------------------------------------------------
  plan('checkEmailConnectionTool', email.checkEmailConnectionTool, ['mastra.checkEmailConnectionStatus'], () => ({})),
  plan('getRecentEmailsTool', email.getRecentEmailsTool, ['mastra.getEmails'], () => ({ maxResults: 1 }), {
    skip: NEEDS_MAILBOX,
  }),
  plan('getEmailByIdTool', email.getEmailByIdTool, ['mastra.getEmailById'], () => ({ emailId: 'probe' }), {
    skip: NEEDS_MAILBOX,
  }),
  plan('searchEmailsTool', email.searchEmailsTool, ['mastra.searchEmails'], () => ({ query: PROBE_QUERY, maxResults: 1 }), {
    skip: NEEDS_MAILBOX,
  }),

  // --- CRM ----------------------------------------------------------------
  plan('lookupContactByEmailTool', core.lookupContactByEmailTool, ['mastra.lookupContactByEmail'], () => ({ email: PROBE_EMAIL })),
  plan('searchCrmContactsTool', core.searchCrmContactsTool, ['mastra.searchCrmContacts'], () => ({ limit: 3 }), {
    provides: (output) => provide('contactId', firstId(output, 'contacts')),
  }),
  plan('getCrmContactTool', core.getCrmContactTool, ['mastra.getCrmContact'], (fx) => ({ contactId: fx.contactId }), {
    needs: ['contactId'],
  }),
  plan('searchCrmOrganizationsTool', core.searchCrmOrganizationsTool, ['mastra.searchCrmOrganizations'], () => ({ limit: 3 })),

  // --- Goals and key results ----------------------------------------------
  plan('getOkrObjectivesTool', okr.getOkrObjectivesTool, ['mastra.getOkrObjectives'], () => ({})),
  plan('getOkrStatsTool', okr.getOkrStatsTool, ['mastra.getOkrStats'], () => ({})),

  // --- Sprints ------------------------------------------------------------
  plan('getActiveSprintTool', pm.getActiveSprintTool, ['sprintAnalytics.getActiveSprint'], (fx) => ({ workspaceId: fx.workspaceId }), {
    provides: (output) => {
      const id = (output as { id?: unknown } | null | undefined)?.id;
      return provide('sprintListId', typeof id === 'string' ? id : undefined);
    },
  }),
  plan('getSprintMetricsTool', pm.getSprintMetricsTool, ['sprintAnalytics.getMetrics'], (fx) => ({ listId: fx.sprintListId }), {
    needs: ['sprintListId'],
  }),
  plan('getRiskSignalsTool', pm.getRiskSignalsTool, ['sprintAnalytics.getRiskSignals'], (fx) => ({ listId: fx.sprintListId }), {
    needs: ['sprintListId'],
  }),
  plan(
    'getGitHubActivityTool',
    pm.getGitHubActivityTool,
    ['sprintAnalytics.getGitHubActivity'],
    (fx) => ({ workspaceId: fx.workspaceId, since: '2026-01-05T00:00:00.000Z' }),
  ),

  // --- Reading list -------------------------------------------------------
  plan('listReadingListTool', readingList.listReadingListTool, ['resource.list'], () => ({ limit: 3 })),

  // --- Products and tickets -----------------------------------------------
  plan('listProductsTool', tickets.listProductsTool, ['mastra.listProducts'], (fx) => ({ workspaceId: fx.workspaceId }), {
    provides: (output) => provide('productId', firstId(output, 'products')),
  }),
  plan('listCyclesTool', tickets.listCyclesTool, ['mastra.listCycles'], (fx) => ({ workspaceId: fx.workspaceId })),
  plan('listTicketsTool', tickets.listTicketsTool, ['mastra.listTickets'], (fx) => ({ productId: fx.productId, limit: 3 }), {
    needs: ['productId'],
  }),

  // --- Notion (through the app's integration) -----------------------------
  // With no Notion connected the app answers that plainly, which still proves
  // the request shape, so the read tools are probed.
  plan('notionSearchTool', notion.notionSearchTool, ['mastra.notionSearch'], () => ({ query: PROBE_QUERY })),
  plan('notionGetPageTool', notion.notionGetPageTool, ['mastra.notionGetPage'], () => ({ pageId: 'probe' })),
  plan('notionQueryDatabaseTool', notion.notionQueryDatabaseTool, ['mastra.notionQueryDatabase'], () => ({ databaseId: 'probe' })),

  // --- Assigned agent runs -------------------------------------------------
  plan('getRunContextTool', run.getRunContextTool, ['mastra.getRunContext'], () => ({}), { skip: NEEDS_RUN }),

];
