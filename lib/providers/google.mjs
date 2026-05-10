/**
 * Google Calendar ProviderClient.
 *
 * Implementation pending (T3.5.2). For now, this is a stub that wraps the
 * existing functions in lib/google.mjs so the interface is callable end-to-end.
 * T3.5.2 will: add updateEvent + deleteEvent, normalize the event shape, and
 * make this file the canonical home for Google calendar logic (replacing
 * direct imports of lib/google.mjs in the sync engine).
 */

import {
  getValidAccessToken,
  listGoogleEvents,
  listGoogleCalendars,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
} from "../google.mjs";
import { CAPABILITIES_RW } from "./types.mjs";

export function createGoogleProvider({ oauthAccountRow }) {
  if (!oauthAccountRow) {
    throw new Error("createGoogleProvider: oauthAccountRow required");
  }

  async function token() {
    return getValidAccessToken(oauthAccountRow);
  }

  return {
    provider: "google",
    capabilities: CAPABILITIES_RW,

    async listCalendars() {
      const t = await token();
      return listGoogleCalendars(t);
    },

    async listEvents(calendarId, timeMin, timeMax) {
      const t = await token();
      return listGoogleEvents(t, calendarId, timeMin, timeMax);
    },

    async createEvent(calendarId, event) {
      const t = await token();
      return createGoogleEvent(t, calendarId, event);
    },

    async updateEvent(calendarId, eventId, patch) {
      const t = await token();
      return updateGoogleEvent(t, calendarId, eventId, patch);
    },

    async deleteEvent(calendarId, eventId) {
      const t = await token();
      return deleteGoogleEvent(t, calendarId, eventId);
    },
  };
}
