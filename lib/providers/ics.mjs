/**
 * ICS read-only ProviderClient.
 *
 * Implementation pending (T3.5.4). T3.5.4 will: fetch the encrypted URL,
 * parse with a minimal RFC 5545 parser, normalize event shape, and cache
 * the parse result in kv_cache for ~15 minutes.
 *
 * Write methods always throw — ICS feeds are read-only by definition.
 */

import { CAPABILITIES_READONLY, ProviderUnsupportedError } from "./types.mjs";

export function createIcsProvider({ icsUrlEnc }) {
  if (!icsUrlEnc) {
    throw new Error("createIcsProvider: icsUrlEnc required");
  }

  return {
    provider: "ics",
    capabilities: CAPABILITIES_READONLY,

    async listCalendars() {
      // An ICS feed is itself a single calendar — return a synthetic entry.
      return [
        {
          id: "ics-feed",
          summary: "ICS Feed",
          description: "",
          primary: true,
          accessRole: "reader",
        },
      ];
    },

    async listEvents(/* calendarId, timeMin, timeMax */) {
      throw new ProviderUnsupportedError("ics", "listEvents (pending T3.5.4)");
    },

    async createEvent() {
      throw new ProviderUnsupportedError("ics", "createEvent (read-only feed)");
    },

    async updateEvent() {
      throw new ProviderUnsupportedError("ics", "updateEvent (read-only feed)");
    },

    async deleteEvent() {
      throw new ProviderUnsupportedError("ics", "deleteEvent (read-only feed)");
    },
  };
}
