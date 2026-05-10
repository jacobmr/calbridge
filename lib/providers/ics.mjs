/**
 * ICS read-only ProviderClient.
 *
 * Fetches the encrypted ICS URL, parses RFC 5545 with a minimal in-house
 * parser (no extra dependencies), normalizes events to the shape defined
 * in ./types.mjs, and caches the parsed result in kv_cache for ~15 min.
 *
 * Write methods always throw — ICS feeds are read-only by definition.
 */

import { createHash } from "node:crypto";
import { decrypt } from "../crypto.mjs";
import { kvGet, kvSet } from "../kv-cache.mjs";
import { CAPABILITIES_READONLY, ProviderUnsupportedError } from "./types.mjs";

const CACHE_TTL_MS = 15 * 60 * 1000;

/* ─── Minimal RFC 5545 (iCalendar) parser ──────────────────────────────────
 *
 * This is intentionally small: it handles VEVENT blocks, line unfolding
 * (continuation lines start with a space or tab), property parameters
 * (e.g. DTSTART;TZID=America/Los_Angeles:20260515T180000), and the most
 * common time formats. It does NOT expand RRULE recurrences — for v1 we
 * surface raw events and skip recurrence expansion (TODO when we ship the
 * merged family view, since recurring soccer practices matter).
 */

/** Unfold lines: a leading space or tab on a line means "join with previous". */
function unfoldLines(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Parse "KEY;PARAM=VAL;PARAM=VAL:VALUE" into { key, params, value }. */
function parseLine(line) {
  const colonAt = line.indexOf(":");
  if (colonAt === -1) return null;
  const head = line.slice(0, colonAt);
  const value = line.slice(colonAt + 1);
  const parts = head.split(";");
  const key = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { key, params, value };
}

/** Unescape \\, \,, \;, \n, \N. */
function unescapeText(s) {
  return String(s)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * Parse an iCal date/time value into a NormalizedEventTime.
 *  - "20260515"           → { date: "2026-05-15" } (all-day)
 *  - "20260515T180000Z"   → { dateTime: "2026-05-15T18:00:00Z" }
 *  - "20260515T180000" + TZID="America/Los_Angeles"
 *                         → { dateTime: "2026-05-15T18:00:00", timeZone: "America/Los_Angeles" }
 */
function parseIcsTime(value, params) {
  if (!value) return undefined;
  const isDate = params?.VALUE === "DATE" || /^\d{8}$/.test(value);
  if (isDate) {
    return {
      date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
    };
  }
  // DATE-TIME form: YYYYMMDDTHHMMSS[Z]
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
  if (params?.TZID) return { dateTime: iso, timeZone: params.TZID };
  return { dateTime: iso };
}

/** Parse an .ics document into an array of NormalizedEvent. */
export function parseIcs(text) {
  const lines = unfoldLines(text);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current && (current.start || current.end || current.summary)) {
        events.push(current);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.key) {
      case "UID":
        current.id = p.value;
        break;
      case "SUMMARY":
        current.summary = unescapeText(p.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeText(p.value);
        break;
      case "DTSTART":
        current.start = parseIcsTime(p.value, p.params);
        break;
      case "DTEND":
        current.end = parseIcsTime(p.value, p.params);
        break;
      case "LOCATION":
        current.location = unescapeText(p.value);
        break;
      case "TRANSP":
        current.transparency =
          p.value.toUpperCase() === "TRANSPARENT" ? "transparent" : "opaque";
        break;
      case "CLASS":
        current.visibility =
          p.value.toUpperCase() === "PRIVATE" ? "private" : "default";
        break;
      case "LAST-MODIFIED":
      case "DTSTAMP": {
        // Best-effort updatedMs for sync change detection
        const t = parseIcsTime(p.value, p.params);
        if (t?.dateTime) {
          const ms = Date.parse(t.dateTime);
          if (!Number.isNaN(ms)) current.updatedMs = ms;
        }
        break;
      }
      default:
        break;
    }
  }
  // Fallback id if UID missing — stable hash of title+start
  for (const e of events) {
    if (!e.id) {
      const seed = `${e.summary || ""}|${e.start?.dateTime || e.start?.date || ""}`;
      e.id = createHash("sha1").update(seed).digest("hex").slice(0, 16);
    }
  }
  return events;
}

function cacheKey(url) {
  return `ics:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

/* ─── Provider ────────────────────────────────────────────────────────────── */

export function createIcsProvider({ icsUrlEnc }) {
  if (!icsUrlEnc) {
    throw new Error("createIcsProvider: icsUrlEnc required");
  }
  // Decrypt once at construction; keep in closure.
  const url = decrypt(icsUrlEnc);

  async function fetchAndParse() {
    const key = cacheKey(url);
    const cached = await kvGet(key);
    if (cached) return cached;
    const res = await fetch(url, {
      headers: { Accept: "text/calendar, text/plain, */*" },
    });
    if (!res.ok) {
      const err = new Error(`ICS fetch failed: HTTP ${res.status}`);
      err.statusCode = 502;
      throw err;
    }
    const text = await res.text();
    const events = parseIcs(text);
    await kvSet(key, events, CACHE_TTL_MS);
    return events;
  }

  function inWindow(event, timeMin, timeMax) {
    const minMs = Date.parse(timeMin);
    const maxMs = Date.parse(timeMax);
    if (Number.isNaN(minMs) || Number.isNaN(maxMs)) return true;
    const start = event.start?.dateTime
      ? Date.parse(event.start.dateTime)
      : event.start?.date
        ? Date.parse(`${event.start.date}T00:00:00Z`)
        : null;
    if (start == null) return false;
    return start >= minMs && start <= maxMs;
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

    async listEvents(_calendarId, timeMin, timeMax) {
      const all = await fetchAndParse();
      return all.filter((e) => inWindow(e, timeMin, timeMax));
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
