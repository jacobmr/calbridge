/**
 * Minimal iCalendar (RFC 5545) serializer. Just enough for what we expose:
 * a feed of group events with start/end + summary + location + description.
 *
 * Doesn't try to roundtrip with the parser in lib/providers/ics.mjs — this
 * is one-way, ours-out. Keep features narrow; iCal compliance is a swamp.
 */

import { createHash } from "node:crypto";

/** Format a Date as iCal UTC: 20260615T180000Z */
function toIcsUtc(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

/** Format an all-day date as iCal: 20260615 */
function toIcsDate(yyyyMmDd) {
  return String(yyyyMmDd).replace(/-/g, "");
}

/** Escape commas/semicolons/newlines/backslashes per RFC 5545 §3.3.11. */
function escapeText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Fold long lines per RFC 5545 §3.1 — every 75 octets, CRLF + space. */
function foldLine(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  out.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    out.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return out.join("\r\n");
}

function makeUid(seed) {
  return (
    createHash("sha1").update(String(seed)).digest("hex").slice(0, 24) +
    "@mical.net"
  );
}

/**
 * Build an iCalendar VCALENDAR string from normalized events.
 *
 * @param {object} args
 * @param {string} args.calendarName     X-WR-CALNAME — what calendar apps show
 * @param {Array}  args.events           Normalized events (start/end/summary/location/description, sharer info optional)
 * @returns {string} CRLF-joined ICS body
 */
export function buildIcs({ calendarName, events }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MiCal//Group Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:UTC`,
  ];
  const now = toIcsUtc(new Date());
  for (const e of events) {
    const isAllDay = !!e.start?.date;
    const startLine = isAllDay
      ? `DTSTART;VALUE=DATE:${toIcsDate(e.start.date)}`
      : `DTSTART:${toIcsUtc(new Date(e.start?.dateTime || 0))}`;
    const endLine = isAllDay
      ? `DTEND;VALUE=DATE:${toIcsDate(e.end?.date || e.start.date)}`
      : `DTEND:${toIcsUtc(new Date(e.end?.dateTime || e.start?.dateTime || 0))}`;
    // Compose a per-event UID that's stable across re-fetches but unique
    // to the source provider. Calendar apps merge by UID.
    const uid = makeUid(`${e.calendar_id || ""}|${e.id || ""}`);

    // For free/busy events, the title was server-stripped (null). Show
    // the sharer's name so the subscriber can still see whose calendar
    // the busy block belongs to.
    const summary =
      e.summary || (e.sharer_display ? `Busy · ${e.sharer_display}` : "Busy");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      startLine,
      endLine,
      `SUMMARY:${escapeText(summary)}`,
      e.description
        ? `DESCRIPTION:${escapeText(e.description)}`
        : `DESCRIPTION:${escapeText(`Shared by ${e.sharer_display || "MiCal"}`)}`,
      e.location ? `LOCATION:${escapeText(e.location)}` : "",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).map(foldLine).join("\r\n");
}
