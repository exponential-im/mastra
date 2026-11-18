/**
 * The person's time zone, on every surface (exponential ticket 972, odd.frost).
 *
 * The web chat sends a zone with each turn: the one saved in the person's
 * profile, else the browser's (the app's stream route picks). Slack, WhatsApp,
 * Signal, Telegram, Matrix and API turns send none. For those, the zone saved
 * in the profile (`User.timezone`, Settings → Profile) is read from the app.
 * With neither, there is no zone and the agent asks. It never assumes UTC.
 *
 * The two tools let the agent answer "what time zone do you have for me?" and
 * change the saved zone after the person confirms ("I'm in Lisbon this week").
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { authenticatedTrpcCall, authenticatedTrpcQuery } from "../utils/authenticated-fetch.js";
import { asAppContext, type AppRequestContext } from "../types/request-context.js";
import { describeInstant, isValidTimeZone } from "./calendar-time.js";
import { looseBoolean } from "./zod-loose.js";

/** Where the zone came from: sent by the chat surface, or read from the profile. */
export type TimeZoneSource = "chat" | "profile";

export type UserTimeZone =
  | { zone: string; source: TimeZoneSource }
  | { zone: null; source: null };

const WHERE_TO_CHANGE = "Settings → Profile";

const NO_ZONE: UserTimeZone = { zone: null, source: null };

function authOf(requestContext: AppRequestContext | undefined) {
  const authToken = requestContext?.get("authToken");
  if (!authToken) return null;
  return {
    authToken,
    sessionId: requestContext?.get("whatsappSession"),
    userId: requestContext?.get("userId"),
  };
}

/**
 * The person's zone: the one the chat sent, else the one saved in their
 * profile, else none. A zone read from the profile is kept on the request
 * context, so later tools in the same turn do not read it again.
 *
 * A failed read is treated as no zone (the agent then asks), never as UTC.
 */
export async function resolveUserTimeZone(requestContext: AppRequestContext | undefined): Promise<UserTimeZone> {
  const fromChat = requestContext?.get("timezone");
  if (isValidTimeZone(fromChat)) {
    const source = requestContext?.get("timezoneSource") === "profile" ? "profile" : "chat";
    return { zone: fromChat, source };
  }

  const auth = authOf(requestContext);
  if (!auth) return NO_ZONE;
  try {
    const { data } = await authenticatedTrpcQuery<{ timezone?: string | null }>("user.getTimezone", auth);
    const saved = data?.timezone;
    if (!isValidTimeZone(saved)) return NO_ZONE;
    requestContext?.set("timezone", saved);
    requestContext?.set("timezoneSource", "profile");
    return { zone: saved, source: "profile" };
  } catch {
    return NO_ZONE;
  }
}

export const getMyTimeZoneTool = createTool({
  id: "get-my-time-zone",
  description:
    "Get the user's time zone and their local date and time. Use it when they ask what time zone you have for them, and before you propose, book or work out anything at a clock time when the conversation does not already state their local time. If it returns no zone, ask the user which time zone they are in (once; a city is enough) and do not assume UTC.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    timeZone: z.string().nullable(),
    source: z.string().nullable(),
    localNow: z.string().optional(),
    instruction: z.string(),
  }),
  execute: async (_inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const known = await resolveUserTimeZone(requestContext);
    if (!known.zone) {
      return {
        timeZone: null,
        source: null,
        instruction: `The user's time zone is not known: none is saved in their profile. Ask which time zone they are in (a city is enough). Do not assume UTC. When they answer, offer to save it with set-my-time-zone (only after they say yes); they can also set it in ${WHERE_TO_CHANGE}.`,
      };
    }
    const origin =
      known.source === "profile"
        ? `saved in their profile (${WHERE_TO_CHANGE})`
        : "the zone their chat is using (their saved zone, or their browser's when none is saved)";
    return {
      timeZone: known.zone,
      source: known.source,
      localNow: describeInstant(new Date(), known.zone),
      instruction: `Use ${known.zone}, ${origin}. Times the user gives are in this zone unless they name another. They can change it in ${WHERE_TO_CHANGE}, or tell you and you save it with set-my-time-zone after they confirm.`,
    };
  },
});

export const setMyTimeZoneTool = createTool({
  id: "set-my-time-zone",
  description:
    "Save the user's time zone to their profile (the zone used for their calendar events and working hours). Use it when they tell you their zone or that they are somewhere else (\"I'm in Lisbon this week\"). First say the IANA zone you will save (e.g. \"Europe/Lisbon\") and get their yes; never change it without one.",
  inputSchema: z.object({
    timeZone: z.string().describe('IANA time zone, e.g. "Europe/Lisbon". Map a city to its zone.'),
    userConfirmed: looseBoolean().describe(
      "REQUIRED: Must be true. Show the user the zone you will save and get their confirmation first.",
    ),
  }),
  outputSchema: z.object({
    timeZone: z.string().optional(),
    localNow: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, ctx) => {
    if (!inputData.userConfirmed) {
      return {
        error: "Tell the user the zone you will save and get their confirmation first. Then set userConfirmed to true.",
      };
    }
    const zone = inputData.timeZone.trim();
    if (!isValidTimeZone(zone)) {
      return { error: `"${zone}" is not a time zone I know. Use an IANA name such as "Europe/Lisbon".` };
    }
    const requestContext = asAppContext(ctx.requestContext);
    const auth = authOf(requestContext);
    if (!auth) throw new Error("No authentication token available");

    const { data } = await authenticatedTrpcCall<{ timezone?: string | null }>(
      "user.updateTimezone",
      { timezone: zone },
      auth,
    );
    const saved = isValidTimeZone(data?.timezone) ? data.timezone : zone;
    // The rest of this turn uses the new zone.
    requestContext?.set("timezone", saved);
    requestContext?.set("timezoneSource", "profile");
    return { timeZone: saved, localNow: describeInstant(new Date(), saved) };
  },
});
