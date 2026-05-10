/**
 * Microsoft Graph ProviderClient.
 *
 * Implementation pending (T3.5.3). Stub wraps existing helpers in
 * lib/microsoft.mjs. T3.5.3 will add update/delete + finalize event-shape
 * normalization (subject↔summary, body.content↔description, etc.).
 */

import {
  getValidMicrosoftAccessToken,
  listMicrosoftCalendars,
  listMicrosoftEvents,
  createMicrosoftEvent,
} from "../microsoft.mjs";
import { CAPABILITIES_RW, ProviderUnsupportedError } from "./types.mjs";

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
      // MS Graph calendarView wants startDateTime/endDateTime in same ISO format
      return listMicrosoftEvents(t, calendarId, timeMin, timeMax);
    },

    async createEvent(calendarId, event) {
      const t = await token();
      // T3.5.3: translate normalized event to MS shape (subject, body.content, ...)
      return createMicrosoftEvent(t, calendarId, event);
    },

    async updateEvent(/* calendarId, eventId, patch */) {
      throw new ProviderUnsupportedError(
        "microsoft",
        "updateEvent (pending T3.5.3)",
      );
    },

    async deleteEvent(/* calendarId, eventId */) {
      throw new ProviderUnsupportedError(
        "microsoft",
        "deleteEvent (pending T3.5.3)",
      );
    },
  };
}
