import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.mjs";
import { getProviderClientForCalendar } from "./providers/index.mjs";

const SYNC_MARKER_PREFIX = "[MiCal Sync] Source:";

function buildSyncMarker(sourceEventId) {
  return `${SYNC_MARKER_PREFIX} ${sourceEventId}`;
}

function extractSourceEventId(description) {
  if (!description) return null;
  const idx = description.indexOf(SYNC_MARKER_PREFIX);
  if (idx === -1) return null;
  const after = description.slice(idx + SYNC_MARKER_PREFIX.length).trim();
  return after.split("\n")[0].trim();
}

function getEventStartDate(event) {
  if (event.start?.dateTime) {
    return new Date(event.start.dateTime);
  }
  if (event.start?.date) {
    return new Date(event.start.date);
  }
  return null;
}

function getEventEndDate(event) {
  if (event.end?.dateTime) {
    return new Date(event.end.dateTime);
  }
  if (event.end?.date) {
    return new Date(event.end.date);
  }
  return null;
}

function parseTime(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return { h, m };
}

function isWithinWorkHours(date, workHours) {
  const { h: startH, m: startM } = parseTime(workHours.start);
  const { h: endH, m: endM } = parseTime(workHours.end);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  return minutes >= startMinutes && minutes < endMinutes;
}

function applyBuffers(start, end, bufferMinBefore, bufferMinAfter) {
  const newStart = new Date(start.getTime() - bufferMinBefore * 60000);
  const newEnd = new Date(end.getTime() + bufferMinAfter * 60000);
  return { start: newStart, end: newEnd };
}

function formatDateTimeISO(date) {
  return date.toISOString();
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

function shouldSkipEvent(event, options) {
  const start = getEventStartDate(event);
  if (!start) return true;

  if (options.weekdays_only) {
    const day = start.getDay();
    if (day === 0 || day === 6) return true;
  }

  if (options.only_work_hours && options.work_hours) {
    if (event.start?.date) return true;
    if (!isWithinWorkHours(start, options.work_hours)) return true;
  }

  return false;
}

function buildTargetEvent(sourceEvent, options) {
  const copyTitle = options.copy_title !== false;
  const copyDescription = options.copy_description === true;
  const markPrivate = options.mark_private === true;
  const bufferMinBefore = options.buffer_min_before || 0;
  const bufferMinAfter = options.buffer_min_after || 0;

  const start = getEventStartDate(sourceEvent);
  const end = getEventEndDate(sourceEvent);
  const isAllDay = !!sourceEvent.start?.date;

  let eventStart = start;
  let eventEnd = end;
  if (!isAllDay && (bufferMinBefore > 0 || bufferMinAfter > 0)) {
    const buffered = applyBuffers(start, end, bufferMinBefore, bufferMinAfter);
    eventStart = buffered.start;
    eventEnd = buffered.end;
  }

  const marker = buildSyncMarker(sourceEvent.id);

  let description = "";
  if (copyDescription && sourceEvent.description) {
    description = sourceEvent.description + "\n\n" + marker;
  } else {
    description = marker;
  }

  const targetEvent = {
    summary: copyTitle ? sourceEvent.summary || "(No title)" : "(Blocked)",
    description,
  };

  if (isAllDay) {
    targetEvent.start = { date: formatDateISO(eventStart) };
    targetEvent.end = { date: formatDateISO(eventEnd) };
  } else {
    targetEvent.start = { dateTime: formatDateTimeISO(eventStart) };
    if (sourceEvent.start?.timeZone) {
      targetEvent.start.timeZone = sourceEvent.start.timeZone;
    }
    targetEvent.end = { dateTime: formatDateTimeISO(eventEnd) };
    if (sourceEvent.end?.timeZone) {
      targetEvent.end.timeZone = sourceEvent.end.timeZone;
    }
  }

  if (markPrivate) {
    targetEvent.visibility = "private";
  }

  if (sourceEvent.location) {
    targetEvent.location = sourceEvent.location;
  }

  if (sourceEvent.transparency) {
    targetEvent.transparency = sourceEvent.transparency;
  }

  return targetEvent;
}

/**
 * Look up a calendar row by id and validate it for sync use. The "side"
 * argument is just for error messages ("source" or "target").
 */
async function loadCalendar(calendarId, side) {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM calendars WHERE id = ?",
    args: [calendarId],
  });
  const row = r.rows[0];
  if (!row) {
    const err = new Error(`${side} calendar not found: ${calendarId}`);
    err.statusCode = 404;
    throw err;
  }
  return row;
}

/**
 * The provider_calendar_id we hand to the ProviderClient. ICS feeds use a
 * synthetic id since one feed == one calendar from the consumer's POV.
 */
function providerCalIdFor(calendarRow) {
  if (String(calendarRow.provider).toLowerCase() === "ics") return "ics-feed";
  return calendarRow.provider_calendar_id;
}

/**
 * Insert a sync_runs row at the start of a run. Returns its id so we can
 * close it out in finishRun().
 */
async function startRun(tenantId, syncFlowId) {
  const db = getDb();
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO sync_runs (id, tenant_id, sync_flow_id, started_at) VALUES (?, ?, ?, ?)",
    args: [id, tenantId, syncFlowId, Date.now()],
  });
  return id;
}

async function finishRun(runId, ok, totals, errors) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE sync_runs
            SET finished_at = ?, ok = ?, totals_json = ?, errors_json = ?
          WHERE id = ?`,
    args: [
      Date.now(),
      ok ? 1 : 0,
      JSON.stringify(totals || {}),
      errors && errors.length ? JSON.stringify(errors) : null,
      runId,
    ],
  });
}

/**
 * @param {string} syncFlowId
 * @param {object} [options]
 * @param {(calendarRow: object) => Promise<object>} [options.getProviderClient]
 *   Optional override for the provider factory. Defaults to
 *   getProviderClientForCalendar. Used by tests, and later by the Phase 4
 *   cross-tenant sync where the source/target may belong to different users.
 */
export async function runSyncFlow(syncFlowId, options = {}) {
  const getClient = options.getProviderClient || getProviderClientForCalendar;
  const db = getDb();

  const flowRes = await db.execute({
    sql: "SELECT * FROM sync_flows WHERE id = ?",
    args: [syncFlowId],
  });
  const flow = flowRes.rows[0];
  if (!flow) {
    const err = new Error(`sync flow not found: ${syncFlowId}`);
    err.statusCode = 404;
    throw err;
  }
  if (!flow.enabled) {
    return {
      flowId: syncFlowId,
      created: 0,
      skipped: 0,
      errors: 0,
      message: "flow disabled",
    };
  }

  const sourceCal = await loadCalendar(flow.source_calendar_id, "source");
  const targetCal = await loadCalendar(flow.target_calendar_id, "target");

  // Build provider clients (each handles its own OAuth refresh / decrypt).
  const sourceClient = await getClient(sourceCal);
  const targetClient = await getClient(targetCal);

  if (!targetClient.capabilities.canWrite) {
    const err = new Error(
      `target calendar provider "${targetClient.provider}" is read-only and cannot be a sync target`,
    );
    err.statusCode = 400;
    throw err;
  }

  const sourceProviderCalId = providerCalIdFor(sourceCal);
  const targetProviderCalId = providerCalIdFor(targetCal);

  const runId = await startRun(flow.tenant_id, flow.id);
  const stats = { created: 0, skipped: 0, errors: 0 };
  const errorMessages = [];

  try {
    const now = new Date();
    const timeMin = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const timeMax = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [sourceEvents, targetEvents] = await Promise.all([
      sourceClient.listEvents(sourceProviderCalId, timeMin, timeMax),
      targetClient.listEvents(targetProviderCalId, timeMin, timeMax),
    ]);

    const syncedSourceIds = new Set();
    for (const evt of targetEvents) {
      const sourceId = extractSourceEventId(evt.description);
      if (sourceId) syncedSourceIds.add(sourceId);
    }

    const options = flow.options_json ? JSON.parse(flow.options_json) : {};

    for (const sourceEvent of sourceEvents) {
      try {
        if (shouldSkipEvent(sourceEvent, options)) {
          stats.skipped++;
          continue;
        }
        if (syncedSourceIds.has(sourceEvent.id)) {
          stats.skipped++;
          continue;
        }
        const targetEvent = buildTargetEvent(sourceEvent, options);
        await targetClient.createEvent(targetProviderCalId, targetEvent);
        stats.created++;
      } catch (e) {
        stats.errors++;
        errorMessages.push(
          `event ${sourceEvent.id || "?"}: ${e.message || String(e)}`,
        );
      }
    }

    await finishRun(runId, stats.errors === 0, stats, errorMessages);
    return { flowId: syncFlowId, runId, ...stats };
  } catch (e) {
    // Whole-run failure (e.g. listEvents threw). Record and re-throw.
    await finishRun(runId, false, stats, [
      `run failed: ${e.message || String(e)}`,
    ]);
    throw e;
  }
}

export async function runAllSyncs() {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT id FROM sync_flows WHERE enabled = 1",
  });

  const runs = [];
  const totals = { created: 0, skipped: 0, errors: 0 };

  for (const row of res.rows) {
    try {
      const result = await runSyncFlow(row.id);
      runs.push(result);
      totals.created += result.created || 0;
      totals.skipped += result.skipped || 0;
      totals.errors += result.errors || 0;
    } catch (e) {
      runs.push({
        flowId: row.id,
        error: e.message,
        created: 0,
        skipped: 0,
        errors: 1,
      });
      totals.errors += 1;
    }
  }

  return { runs, totals };
}
