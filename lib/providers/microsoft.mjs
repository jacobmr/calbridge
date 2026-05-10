/**
 * Microsoft Graph ProviderClient.
 *
 * Translates between the normalized event shape (defined in ./types.mjs)
 * and Microsoft Graph's event shape on the wire.
 *
 * Field mapping:
 *   summary       <-> subject
 *   description   <-> body.content (contentType: "Text")
 *   start.dateTime <-> start.dateTime + start.timeZone
 *   start.date    <-> isAllDay=true + start.dateTime=YYYY-MM-DDT00:00:00 + timeZone="UTC"
 *   end           <-> end (same translation)
 *   location      <-> location.displayName
 *   transparency=transparent <-> showAs="free"
 *   visibility=private       <-> sensitivity="private"
 *
 * Read normalization is already done by listMicrosoftEvents in lib/microsoft.mjs.
 */

import {
  getValidMicrosoftAccessToken,
  listMicrosoftCalendars,
  listMicrosoftEvents,
  createMicrosoftEvent,
  updateMicrosoftEvent,
  deleteMicrosoftEvent,
} from "../microsoft.mjs";
import { CAPABILITIES_RW } from "./types.mjs";

/**
 * Convert a normalized event time {dateTime?, date?, timeZone?} to an MS Graph
 * dateTimeTimeZone object {dateTime, timeZone}.
 */
function toMsTime(t) {
  if (!t) return undefined;
  if (t.date) {
    // All-day: MS expects "YYYY-MM-DDT00:00:00" + UTC
    return { dateTime: `${t.date}T00:00:00`, timeZone: "UTC" };
  }
  if (t.dateTime) {
    // Pass through, default timezone to UTC if absent.
    return { dateTime: t.dateTime, timeZone: t.timeZone || "UTC" };
  }
  return undefined;
}

/**
 * Build an MS Graph event payload from a normalized event.
 * Only includes fields the caller actually set (PATCH-friendly).
 */
function toMsEvent(normalized) {
  const out = {};
  if (normalized.summary !== undefined) out.subject = normalized.summary;
  if (normalized.description !== undefined) {
    out.body = { contentType: "Text", content: normalized.description || "" };
  }
  if (normalized.start) {
    out.start = toMsTime(normalized.start);
    if (normalized.start.date) out.isAllDay = true;
  }
  if (normalized.end) out.end = toMsTime(normalized.end);
  if (normalized.location !== undefined) {
    out.location = { displayName: normalized.location || "" };
  }
  if (normalized.transparency !== undefined) {
    out.showAs = normalized.transparency === "transparent" ? "free" : "busy";
  }
  if (normalized.visibility !== undefined) {
    out.sensitivity =
      normalized.visibility === "private" ? "private" : "normal";
  }
  return out;
}

export function createMicrosoftProvider({ oauthAccountRow }) {
  if (!oauthAccountRow) {
    throw new Error("createMicrosoftProvider: oauthAccountRow required");
  }

  async function token() {
    return getValidMicrosoftAccessToken(oauthAccountRow);
  }

  return {
    provider: "microsoft",
    capabilities: CAPABILITIES_RW,

    async listCalendars() {
      const t = await token();
      return listMicrosoftCalendars(t);
    },

    async listEvents(calendarId, timeMin, timeMax) {
      const t = await token();
      return listMicrosoftEvents(t, calendarId, timeMin, timeMax);
    },

    async createEvent(calendarId, event) {
      const t = await token();
      const created = await createMicrosoftEvent(t, calendarId, toMsEvent(event));
      // Return id only; caller rarely needs the full payload back.
      return { id: created.id };
    },

    async updateEvent(calendarId, eventId, patch) {
      const t = await token();
      const updated = await updateMicrosoftEvent(
        t,
        calendarId,
        eventId,
        toMsEvent(patch),
      );
      return { id: updated.id };
    },

    async deleteEvent(calendarId, eventId) {
      const t = await token();
      return deleteMicrosoftEvent(t, calendarId, eventId);
    },
  };
}
