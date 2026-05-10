import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseIcs } from "../lib/providers/ics.mjs";

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-1@example.com
SUMMARY:Soccer practice
DTSTART;TZID=America/Los_Angeles:20260515T160000
DTEND;TZID=America/Los_Angeles:20260515T173000
LOCATION:Field 3
DESCRIPTION:Bring cleats\\nand water
TRANSP:OPAQUE
LAST-MODIFIED:20260510T120000Z
END:VEVENT
BEGIN:VEVENT
UID:event-2@example.com
SUMMARY:School holiday
DTSTART;VALUE=DATE:20260520
DTEND;VALUE=DATE:20260521
CLASS:PRIVATE
END:VEVENT
BEGIN:VEVENT
UID:event-3@example.com
SUMMARY:Folded
 line continuation
DTSTART:20260601T090000Z
DTEND:20260601T100000Z
END:VEVENT
END:VCALENDAR
`;

test("parseIcs extracts VEVENTs", () => {
  const events = parseIcs(SAMPLE);
  assert.equal(events.length, 3, "should parse three events");
});

test("parseIcs reads timed events with TZID", () => {
  const [e1] = parseIcs(SAMPLE);
  assert.equal(e1.id, "event-1@example.com");
  assert.equal(e1.summary, "Soccer practice");
  assert.deepEqual(e1.start, {
    dateTime: "2026-05-15T16:00:00",
    timeZone: "America/Los_Angeles",
  });
  assert.deepEqual(e1.end, {
    dateTime: "2026-05-15T17:30:00",
    timeZone: "America/Los_Angeles",
  });
  assert.equal(e1.location, "Field 3");
  assert.equal(e1.description, "Bring cleats\nand water");
  assert.equal(e1.transparency, "opaque");
  assert.ok(e1.updatedMs > 0, "LAST-MODIFIED should yield updatedMs");
});

test("parseIcs reads all-day events as { date }", () => {
  const e2 = parseIcs(SAMPLE)[1];
  assert.deepEqual(e2.start, { date: "2026-05-20" });
  assert.deepEqual(e2.end, { date: "2026-05-21" });
  assert.equal(e2.visibility, "private");
});

test("parseIcs unfolds continuation lines", () => {
  const e3 = parseIcs(SAMPLE)[2];
  assert.equal(e3.summary, "Foldedline continuation");
});

test("parseIcs assigns a stable id when UID missing", () => {
  const noUid = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No UID
DTSTART:20260101T100000Z
DTEND:20260101T110000Z
END:VEVENT
END:VCALENDAR
`;
  const [e] = parseIcs(noUid);
  assert.ok(e.id && e.id.length === 16, "fallback id should be 16 hex chars");
});
