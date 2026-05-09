import { getDb } from '../db/client.mjs';
import { getValidAccessToken, listGoogleEvents, createGoogleEvent } from './google.mjs';

const SYNC_MARKER_PREFIX = '[MiCal Sync] Source:';

function buildSyncMarker(sourceEventId) {
  return `${SYNC_MARKER_PREFIX} ${sourceEventId}`;
}

function extractSourceEventId(description) {
  if (!description) return null;
  const idx = description.indexOf(SYNC_MARKER_PREFIX);
  if (idx === -1) return null;
  const after = description.slice(idx + SYNC_MARKER_PREFIX.length).trim();
  return after.split('\n')[0].trim();
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
  const [h, m] = timeStr.split(':').map(Number);
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

  let description = '';
  if (copyDescription && sourceEvent.description) {
    description = sourceEvent.description + '\n\n' + marker;
  } else {
    description = marker;
  }

  const targetEvent = {
    summary: copyTitle ? (sourceEvent.summary || '(No title)') : '(Blocked)',
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
    targetEvent.visibility = 'private';
  }

  if (sourceEvent.location) {
    targetEvent.location = sourceEvent.location;
  }

  if (sourceEvent.transparency) {
    targetEvent.transparency = sourceEvent.transparency;
  }

  return targetEvent;
}

export async function runSyncFlow(syncFlowId) {
  const db = getDb();

  const flowRes = await db.execute({
    sql: 'SELECT * FROM sync_flows WHERE id = ?',
    args: [syncFlowId],
  });
  const flow = flowRes.rows[0];
  if (!flow) {
    const err = new Error(`sync flow not found: ${syncFlowId}`);
    err.statusCode = 404;
    throw err;
  }
  if (!flow.enabled) {
    return { flowId: syncFlowId, created: 0, skipped: 0, errors: 0, message: 'flow disabled' };
  }

  const sourceCalRes = await db.execute({
    sql: 'SELECT * FROM calendars WHERE id = ?',
    args: [flow.source_calendar_id],
  });
  const sourceCal = sourceCalRes.rows[0];
  if (!sourceCal) {
    const err = new Error(`source calendar not found: ${flow.source_calendar_id}`);
    err.statusCode = 404;
    throw err;
  }

  const targetCalRes = await db.execute({
    sql: 'SELECT * FROM calendars WHERE id = ?',
    args: [flow.target_calendar_id],
  });
  const targetCal = targetCalRes.rows[0];
  if (!targetCal) {
    const err = new Error(`target calendar not found: ${flow.target_calendar_id}`);
    err.statusCode = 404;
    throw err;
  }

  if (!sourceCal.provider_calendar_id) {
    const err = new Error(`source calendar missing provider_calendar_id: ${sourceCal.id}`);
    err.statusCode = 400;
    throw err;
  }
  if (!targetCal.provider_calendar_id) {
    const err = new Error(`target calendar missing provider_calendar_id: ${targetCal.id}`);
    err.statusCode = 400;
    throw err;
  }

  const sourceOAuthRes = await db.execute({
    sql: 'SELECT * FROM oauth_accounts WHERE id = ?',
    args: [sourceCal.oauth_account_id],
  });
  const sourceOAuth = sourceOAuthRes.rows[0];
  if (!sourceOAuth) {
    const err = new Error(`source oauth account not found: ${sourceCal.oauth_account_id}`);
    err.statusCode = 404;
    throw err;
  }

  const targetOAuthRes = await db.execute({
    sql: 'SELECT * FROM oauth_accounts WHERE id = ?',
    args: [targetCal.oauth_account_id],
  });
  const targetOAuth = targetOAuthRes.rows[0];
  if (!targetOAuth) {
    const err = new Error(`target oauth account not found: ${targetCal.oauth_account_id}`);
    err.statusCode = 404;
    throw err;
  }

  const sourceAccessToken = await getValidAccessToken(sourceOAuth);
  const targetAccessToken = await getValidAccessToken(targetOAuth);

  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const [sourceEvents, targetEvents] = await Promise.all([
    listGoogleEvents(sourceAccessToken, sourceCal.provider_calendar_id, timeMin, timeMax),
    listGoogleEvents(targetAccessToken, targetCal.provider_calendar_id, timeMin, timeMax),
  ]);

  const syncedSourceIds = new Set();
  for (const evt of targetEvents) {
    const sourceId = extractSourceEventId(evt.description);
    if (sourceId) syncedSourceIds.add(sourceId);
  }

  const options = flow.options_json ? JSON.parse(flow.options_json) : {};
  const stats = { created: 0, skipped: 0, errors: 0 };

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
      await createGoogleEvent(targetAccessToken, targetCal.provider_calendar_id, targetEvent);
      stats.created++;
    } catch (e) {
      stats.errors++;
    }
  }

  return { flowId: syncFlowId, ...stats };
}

export async function runAllSyncs() {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT id FROM sync_flows WHERE enabled = 1',
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
      runs.push({ flowId: row.id, error: e.message, created: 0, skipped: 0, errors: 1 });
      totals.errors += 1;
    }
  }

  return { runs, totals };
}
