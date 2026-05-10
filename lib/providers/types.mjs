/**
 * ProviderClient — uniform interface over Google Calendar, Microsoft Graph, and ICS feeds.
 *
 * All implementations live in ./google.mjs, ./microsoft.mjs, ./ics.mjs.
 * Use {@link getProviderClient} from ./index.mjs to construct one for a given calendar row.
 *
 * --- Normalized event shape (the contract) ---
 *
 * Both reads and writes use this shape. Provider-specific clients translate
 * between it and the underlying API. Times are RFC3339 strings; all-day events
 * use { date: 'YYYY-MM-DD' } instead of { dateTime, timeZone }.
 *
 * @typedef {Object} NormalizedEventTime
 * @property {string} [dateTime]  RFC3339 timestamp, e.g. "2026-05-15T18:00:00-07:00"
 * @property {string} [timeZone]  IANA tz, e.g. "America/Los_Angeles"
 * @property {string} [date]      "YYYY-MM-DD" (all-day events; mutually exclusive with dateTime)
 *
 * @typedef {Object} NormalizedEvent
 * @property {string}              id           Provider-native event id
 * @property {string}              [summary]    Title / subject
 * @property {string}              [description] Body / notes (plain text)
 * @property {NormalizedEventTime} start
 * @property {NormalizedEventTime} end
 * @property {string}              [location]
 * @property {'opaque'|'transparent'} [transparency]  "transparent" = free, "opaque" = busy
 * @property {'default'|'public'|'private'|'confidential'} [visibility]
 * @property {string}              [etag]       Provider-supplied change marker (used by sync to detect updates)
 * @property {number}              [updatedMs]  Last-modified time as ms since epoch (alt to etag)
 *
 * --- Calendar shape ---
 *
 * @typedef {Object} NormalizedCalendar
 * @property {string}  id           Provider-native calendar id
 * @property {string}  summary      Display name
 * @property {string}  [description]
 * @property {boolean} primary
 * @property {string}  [accessRole]  "owner" | "writer" | "reader"
 *
 * --- The interface ---
 *
 * Implementations are objects (not classes) returned by the factory. Every method
 * is async. Throws Error with a numeric .statusCode on remote failures.
 *
 * @typedef {Object} ProviderClient
 * @property {() => Promise<NormalizedCalendar[]>} listCalendars
 * @property {(calendarId: string, timeMin: string, timeMax: string) => Promise<NormalizedEvent[]>} listEvents
 * @property {(calendarId: string, event: Partial<NormalizedEvent>) => Promise<NormalizedEvent>} createEvent
 * @property {(calendarId: string, eventId: string, patch: Partial<NormalizedEvent>) => Promise<NormalizedEvent>} updateEvent
 * @property {(calendarId: string, eventId: string) => Promise<void>} deleteEvent
 * @property {string} provider  "google" | "microsoft" | "ics"
 * @property {Object} [capabilities]  Feature flags; readers/writers can check before calling
 * @property {boolean} capabilities.canWrite  False for ICS
 * @property {boolean} capabilities.canUpdate
 * @property {boolean} capabilities.canDelete
 */

export const CAPABILITIES_RW = Object.freeze({
  canWrite: true,
  canUpdate: true,
  canDelete: true,
});

export const CAPABILITIES_READONLY = Object.freeze({
  canWrite: false,
  canUpdate: false,
  canDelete: false,
});

export class ProviderUnsupportedError extends Error {
  constructor(provider, op) {
    super(`provider ${provider} does not support ${op}`);
    this.statusCode = 400;
    this.code = "PROVIDER_UNSUPPORTED";
  }
}
