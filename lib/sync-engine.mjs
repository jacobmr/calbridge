import { randomUUID, createHash } from "node:crypto";
import { getDb } from "../db/client.mjs";
import { getProviderClientForCalendar } from "./providers/index.mjs";

/*
 * Sync marker format:
 *   [MiCal Sync] Source: [<ns>:]<sourceEventId> v:<contentHash>
 *
 * The optional <ns>: prefix lets multiple independent push origins target
 * the same calendar without their deletion passes stomping each other.
 * Regular sync_flows omit it (back-compat). Group cross-tenant pushes
 * use ns="g-<sharerUserId>" so each sharer only touches the targets they
 * created.
 *
 * The 8-char content hash lets the engine detect source changes (title,
 * time, location). Hash matches → skip; differs → patch; sourceId vanishes
 * from the source listing within the namespace → delete.
 */
const SYNC_MARKER_PREFIX = "[MiCal Sync] Source:";

function contentHash(sourceEvent, options = {}) {
  // Hash the fields a user would notice changing. Excludes description/markers
  // because pure description edits aren't worth a target rewrite by default.
  // Include sync-side options that change the rendered target (prefix, busy-only)
  // so toggling them re-syncs everything.
  const parts = [
    sourceEvent.summary || "",
    sourceEvent.start?.dateTime || sourceEvent.start?.date || "",
    sourceEvent.start?.timeZone || "",
    sourceEvent.end?.dateTime || sourceEvent.end?.date || "",
    sourceEvent.end?.timeZone || "",
    sourceEvent.location || "",
    options.event_prefix || "",
    options.copy_title === false ? "busy" : "title",
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 8);
}

function buildSyncMarker(sourceEventId, hash, namespace) {
  const id = namespace ? `${namespace}:${sourceEventId}` : sourceEventId;
  return `${SYNC_MARKER_PREFIX} ${id} v:${hash}`;
}

/**
 * Extract sync marker info from an event description.
 * @returns {{ namespace: string|null, sourceId: string, hash: string|null } | null}
 */
function extractMarkerInfo(description) {
  if (!description) return null;
  const idx = description.indexOf(SYNC_MARKER_PREFIX);
  if (idx === -1) return null;
  const after = description.slice(idx + SYNC_MARKER_PREFIX.length).trim();
  const firstLine = after.split("\n")[0].trim();
  const m = firstLine.match(/^(\S+?)(?:\s+v:([a-f0-9]+))?$/);
  if (!m) return null;
  // Split optional "ns:" prefix from sourceId. Our namespaces look like
  // "g-<uuid>" — letters, digits, and dashes only. Microsoft Graph event
  // ids contain colons but never start with this shape (they use base64+
  // and aren't lowercase-only), so we use a conservative regex match.
  const idPart = m[1];
  const colon = idPart.indexOf(":");
  if (colon > 0 && /^[a-z0-9-]{1,80}$/.test(idPart.slice(0, colon))) {
    return {
      namespace: idPart.slice(0, colon),
      sourceId: idPart.slice(colon + 1),
      hash: m[2] || null,
    };
  }
  return { namespace: null, sourceId: idPart, hash: m[2] || null };
}

// Back-compat shim for any callers still using the old name internally.
function extractSourceEventId(description) {
  return extractMarkerInfo(description)?.sourceId || null;
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
  const eventPrefix = options.event_prefix || "";
  const namespace = options.marker_namespace || null;

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

  const marker = buildSyncMarker(
    sourceEvent.id,
    contentHash(sourceEvent, options),
    namespace,
  );

  let description = "";
  if (copyDescription && sourceEvent.description) {
    description = sourceEvent.description + "\n\n" + marker;
  } else {
    description = marker;
  }

  // Compose the title: an optional prefix ("[Alex] ") then either the source
  // title or a generic placeholder (busy-only sync).
  const baseTitle = copyTitle ? sourceEvent.summary || "(No title)" : "Busy";
  const targetEvent = {
    summary: eventPrefix + baseTitle,
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
  const stats = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
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

    const options = flow.options_json ? JSON.parse(flow.options_json) : {};
    await runOneWayPush({
      sourceEvents,
      targetEvents,
      targetClient,
      targetProviderCalId,
      options,
      stats,
      errorMessages,
    });

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

/**
 * The core sync loop, factored out so both regular sync_flows and group
 * cross-tenant pushes share it. Mutates `stats` in place and pushes any
 * per-event error strings into `errorMessages`.
 *
 * Honors options.marker_namespace so multiple push origins targeting the
 * same calendar don't garbage-collect each other's events.
 *
 * @param {object} args
 * @param {Array}  args.sourceEvents          Already-fetched normalized events
 * @param {Array}  args.targetEvents          Already-fetched events on target
 * @param {object} args.targetClient          ProviderClient for the target side
 * @param {string} args.targetProviderCalId   Provider-native target calendar id
 * @param {object} args.options               Sync options (incl. marker_namespace)
 * @param {object} args.stats                 { created, updated, deleted, skipped, errors }
 * @param {string[]} args.errorMessages       Mutable list of per-event errors
 */
async function runOneWayPush({
  sourceEvents,
  targetEvents,
  targetClient,
  targetProviderCalId,
  options,
  stats,
  errorMessages,
}) {
  const namespace = options.marker_namespace || null;

  // Index target events by sourceId, BUT only those whose marker namespace
  // matches ours. A target event written by a different push origin is
  // off-limits (we won't update or delete it).
  const syncedTargets = new Map();
  for (const evt of targetEvents) {
    const info = extractMarkerInfo(evt.description);
    if (!info) continue;
    if ((info.namespace || null) !== namespace) continue;
    syncedTargets.set(info.sourceId, {
      targetId: evt.id,
      hash: info.hash,
    });
  }

  const seenSourceIds = new Set();

  for (const sourceEvent of sourceEvents) {
    try {
      if (shouldSkipEvent(sourceEvent, options)) {
        stats.skipped++;
        continue;
      }

      seenSourceIds.add(sourceEvent.id);
      const existing = syncedTargets.get(sourceEvent.id);
      const newHash = contentHash(sourceEvent, options);

      if (!existing) {
        const targetEvent = buildTargetEvent(sourceEvent, options);
        await targetClient.createEvent(targetProviderCalId, targetEvent);
        stats.created++;
      } else if (existing.hash === newHash) {
        stats.skipped++;
      } else {
        const targetEvent = buildTargetEvent(sourceEvent, options);
        await targetClient.updateEvent(
          targetProviderCalId,
          existing.targetId,
          targetEvent,
        );
        stats.updated++;
      }
    } catch (e) {
      stats.errors++;
      errorMessages.push(
        `event ${sourceEvent.id || "?"}: ${e.message || String(e)}`,
      );
    }
  }

  // GC pass: delete targets whose marker source isn't in the source listing.
  // Only operates on rows whose namespace matched ours (filtered above).
  for (const [sourceId, info] of syncedTargets) {
    if (seenSourceIds.has(sourceId)) continue;
    try {
      await targetClient.deleteEvent(targetProviderCalId, info.targetId);
      stats.deleted++;
    } catch (e) {
      stats.errors++;
      errorMessages.push(`delete ${info.targetId}: ${e.message || String(e)}`);
    }
  }

  return stats;
}

/**
 * Run all eligible group cross-tenant pushes for a single group.
 *
 * For each (sharer, receiver) pair where:
 *   - acceptance_mode = 'auto'  (invite/block are honored — block skips,
 *                                invite is logged as pending until we
 *                                build the approval flow)
 *   - push_level     != 'none'
 *   - target_calendar_id IS set
 *
 * we fetch every calendar the sharer has shared with the group at a
 * non-'none' level, pull events, and apply runOneWayPush to the receiver's
 * target calendar. Each (sharer → receiver) push uses marker namespace
 * "g-<sharer_user_id>" so multiple sharers writing to the same receiver
 * target stay isolated.
 */
export async function runGroupPushes(
  groupId,
  { getProviderClient = getProviderClientForCalendar } = {},
) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT rs.sharer_user_id, rs.receiver_user_id, rs.push_level,
                 rs.event_prefix, rs.acceptance_mode, rs.target_calendar_id
            FROM group_receive_settings rs
            JOIN group_memberships ms
              ON ms.group_id = rs.group_id AND ms.user_id = rs.sharer_user_id
             AND ms.status = 'active'
            JOIN group_memberships mr
              ON mr.group_id = rs.group_id AND mr.user_id = rs.receiver_user_id
             AND mr.status = 'active'
           WHERE rs.group_id = ?
             AND rs.push_level != 'none'
             AND rs.target_calendar_id IS NOT NULL
             AND rs.acceptance_mode = 'auto'`,
    args: [groupId],
  });

  const totals = {
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    pairs: 0,
    skippedNoTarget: 0,
  };
  const allErrors = [];

  for (const row of r.rows) {
    totals.pairs++;
    try {
      // Sharer's calendars in this group at non-'none' share level
      const sharedCals = await db.execute({
        sql: `SELECT s.calendar_id, c.*
                FROM group_calendar_shares s
                JOIN calendars c ON c.id = s.calendar_id
               WHERE s.group_id = ? AND s.user_id = ? AND s.share_level != 'none'`,
        args: [groupId, row.sharer_user_id],
      });

      // Target calendar (the receiver's chosen landing spot)
      const tc = await db.execute({
        sql: "SELECT * FROM calendars WHERE id = ?",
        args: [row.target_calendar_id],
      });
      const targetCal = tc.rows[0];
      if (!targetCal) {
        totals.skippedNoTarget++;
        continue;
      }
      const targetClient = await getProviderClient(targetCal);
      if (!targetClient.capabilities.canWrite) {
        allErrors.push(
          `pair ${row.sharer_user_id}→${row.receiver_user_id}: target calendar is read-only`,
        );
        continue;
      }
      const targetProviderCalId =
        String(targetCal.provider).toLowerCase() === "ics"
          ? "ics-feed"
          : targetCal.provider_calendar_id;

      const now = Date.now();
      const timeMin = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch the target window once; we'll filter per-marker-namespace inside.
      const targetEvents = await targetClient.listEvents(
        targetProviderCalId,
        timeMin,
        timeMax,
      );

      // For busy_only pushes, drop the source title; otherwise copy it.
      // Prefix from receive settings always applies to the title.
      const options = {
        copy_title: row.push_level !== "busy_only",
        copy_description: false,
        event_prefix: row.event_prefix || "",
        marker_namespace: `g-${row.sharer_user_id}`,
      };

      // Fan out across the sharer's calendars; aggregate stats.
      const stats = {
        created: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        errors: 0,
      };
      const errs = [];
      for (const calRow of sharedCals.rows) {
        try {
          const sourceClient = await getProviderClient(calRow);
          const sourceProviderCalId =
            String(calRow.provider).toLowerCase() === "ics"
              ? "ics-feed"
              : calRow.provider_calendar_id;
          const sourceEvents = await sourceClient.listEvents(
            sourceProviderCalId,
            timeMin,
            timeMax,
          );
          await runOneWayPush({
            sourceEvents,
            targetEvents,
            targetClient,
            targetProviderCalId,
            options,
            stats,
            errorMessages: errs,
          });
        } catch (e) {
          stats.errors++;
          errs.push(`cal ${calRow.id}: ${e.message || String(e)}`);
        }
      }

      totals.created += stats.created;
      totals.updated += stats.updated;
      totals.deleted += stats.deleted;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
      if (errs.length) allErrors.push(...errs);
    } catch (e) {
      totals.errors++;
      allErrors.push(
        `pair ${row.sharer_user_id}→${row.receiver_user_id}: ${e.message || String(e)}`,
      );
    }
  }

  return { groupId, totals, errors: allErrors };
}

export async function runAllSyncs() {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT id FROM sync_flows WHERE enabled = 1",
  });

  const runs = [];
  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };

  for (const row of res.rows) {
    try {
      const result = await runSyncFlow(row.id);
      runs.push(result);
      totals.created += result.created || 0;
      totals.updated += result.updated || 0;
      totals.deleted += result.deleted || 0;
      totals.skipped += result.skipped || 0;
      totals.errors += result.errors || 0;
    } catch (e) {
      runs.push({
        flowId: row.id,
        error: e.message,
        created: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        errors: 1,
      });
      totals.errors += 1;
    }
  }

  // Group cross-tenant pushes. We iterate every group with at least one
  // active push setting, run them, and roll the totals into the same bag.
  // Group pushes don't write to sync_runs (which is per sync_flow); they
  // surface in the cron response payload only. If we want history we'll
  // add a parallel table later.
  const groupsWithPushes = await db.execute({
    sql: `SELECT DISTINCT group_id FROM group_receive_settings
           WHERE push_level != 'none'
             AND target_calendar_id IS NOT NULL
             AND acceptance_mode = 'auto'`,
  });
  const groupRuns = [];
  for (const g of groupsWithPushes.rows) {
    try {
      const result = await runGroupPushes(g.group_id);
      groupRuns.push(result);
      totals.created += result.totals.created || 0;
      totals.updated += result.totals.updated || 0;
      totals.deleted += result.totals.deleted || 0;
      totals.skipped += result.totals.skipped || 0;
      totals.errors += result.totals.errors || 0;
    } catch (e) {
      groupRuns.push({ groupId: g.group_id, error: e.message });
      totals.errors += 1;
    }
  }

  return { runs, groupRuns, totals };
}
