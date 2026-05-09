import { randomUUID, randomBytes } from 'node:crypto';
import { getDb } from '../../db/client.mjs';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function dayBit(date) {
  // JS getDay: 0=Sun, 1=Mon... mask bits: 0=Mon, 1=Tue...6=Sun
  return 1 << ((date.getDay() + 6) % 7);
}

function isWithinWorkHours(date, workHoursJson) {
  try {
    const wh = JSON.parse(workHoursJson);
    if (!wh.start || !wh.end) return true;
    const hm = (d) => d.getHours() * 60 + d.getMinutes();
    const parse = (s) => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    const t = hm(date);
    return t >= parse(wh.start) && t <= parse(wh.end);
  } catch {
    return true;
  }
}

async function getPublicEventType(req, res) {
  const tenantSlug = req.query.tenant;
  const eventSlug = req.query.event;

  if (!tenantSlug || !eventSlug) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'missing tenant or event' }));
    return;
  }

  const db = getDb();
  const tenantRow = await db.execute({
    sql: 'SELECT id FROM tenants WHERE slug = ? AND enabled = 1',
    args: [tenantSlug],
  });
  if (!tenantRow.rows[0]) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const evRow = await db.execute({
    sql: 'SELECT * FROM event_types WHERE tenant_id = ? AND slug = ? AND enabled = 1',
    args: [tenantRow.rows[0].id, eventSlug],
  });
  if (!evRow.rows[0]) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const ev = evRow.rows[0];
  const out = {
    name: ev.name,
    duration_min: ev.duration_min,
    buffer_min: ev.buffer_min,
    lead_min: ev.lead_min,
    horizon_days: ev.horizon_days,
    weekdays_mask: ev.weekdays_mask,
    work_hours_json: ev.work_hours_json,
    location_mode: ev.location_mode,
    require_email: ev.require_email,
  };

  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}

async function createPublicBooking(req, res) {
  const body = await readBody(req);
  const {
    tenant_slug, event_slug, start_ms,
    attendee_email, attendee_name, subject, notes, pass,
  } = body;

  if (!tenant_slug || !event_slug || start_ms == null) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'missing required fields' }));
    return;
  }

  const db = getDb();
  const tenantRow = await db.execute({
    sql: 'SELECT id FROM tenants WHERE slug = ? AND enabled = 1',
    args: [tenant_slug],
  });
  if (!tenantRow.rows[0]) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const tenantId = tenantRow.rows[0].id;

  const evRow = await db.execute({
    sql: 'SELECT * FROM event_types WHERE tenant_id = ? AND slug = ? AND enabled = 1',
    args: [tenantId, event_slug],
  });
  if (!evRow.rows[0]) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const ev = evRow.rows[0];

  if (ev.require_email && !attendee_email) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'attendee_email required' }));
    return;
  }

  if (ev.pass_required) {
    if (!pass || pass !== ev.pass_hash) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid pass' }));
      return;
    }
  }

  const startDate = new Date(Number(start_ms));
  const now = Date.now();

  // lead_min check
  const earliestStart = now + Number(ev.lead_min || 0) * 60000;
  if (Number(start_ms) < earliestStart) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'booking too soon' }));
    return;
  }

  // horizon_days check
  const latestStart = now + Number(ev.horizon_days || 25) * 86400000;
  if (Number(start_ms) > latestStart) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'booking too far in the future' }));
    return;
  }

  // weekdays_mask check
  const mask = Number(ev.weekdays_mask || 31);
  if ((mask & dayBit(startDate)) === 0) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'day not available' }));
    return;
  }

  // work_hours check
  if (!isWithinWorkHours(startDate, ev.work_hours_json)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'time not within work hours' }));
    return;
  }

  const id = randomUUID();
  const cancelToken = randomBytes(16).toString('base64url');
  const durationMin = Number(ev.duration_min);
  const endMs = Number(start_ms) + durationMin * 60000;

  await db.execute({
    sql: `INSERT INTO bookings (
      id, tenant_id, event_type_id, cancel_token, provider_event_id,
      attendee_email, attendee_name, subject, notes,
      start_ms, end_ms, status, created_at, cancelled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, tenantId, ev.id, cancelToken, null,
      attendee_email || null, attendee_name || null, subject || null, notes || null,
      Number(start_ms), endMs, 'pending', now, null,
    ],
  });

  res.statusCode = 201;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ booking_id: id, cancel_token: cancelToken, status: 'pending' }));
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await getPublicEventType(req, res);
      return;
    }
    if (req.method === 'POST') {
      await createPublicBooking(req, res);
      return;
    }
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
}
