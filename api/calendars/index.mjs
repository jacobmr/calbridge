import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/client.mjs';
import { requireUser } from '../../lib/session.mjs';
import { encrypt } from '../../lib/crypto.mjs';

async function getTenantForUser(db, userId) {
  const r = await db.execute({
    sql: 'SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1',
    args: [userId],
  });
  return r.rows[0] || null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { user } = await requireUser(req);
      const db = getDb();
      const tenant = await getTenantForUser(db, user.id);
      if (!tenant) {
        const err = new Error('tenant not found');
        err.statusCode = 404;
        throw err;
      }

      const r = await db.execute({
        sql: 'SELECT id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled FROM calendars WHERE tenant_id = ?',
        args: [tenant.id],
      });

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.rows));
    } catch (err) {
      res.statusCode = err.statusCode || 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const { user } = await requireUser(req);
      const db = getDb();
      const tenant = await getTenantForUser(db, user.id);
      if (!tenant) {
        const err = new Error('tenant not found');
        err.statusCode = 404;
        throw err;
      }

      const body = await readJson(req);
      const { label, ics_url, role } = body;
      if (!label || !ics_url || !role) {
        const err = new Error('missing required fields: label, ics_url, role');
        err.statusCode = 400;
        throw err;
      }

      const id = randomUUID();
      await db.execute({
        sql: `INSERT INTO calendars
          (id, tenant_id, provider, provider_calendar_id, ics_url_enc, label, role, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, tenant.id, 'ics', null, encrypt(ics_url), label, role, 1],
      });

      const r = await db.execute({
        sql: 'SELECT id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role, enabled FROM calendars WHERE id = ?',
        args: [id],
      });

      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.rows[0]));
    } catch (err) {
      res.statusCode = err.statusCode || 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.statusCode = 405;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'method not allowed' }));
}
