import { getDb } from '../../db/client.mjs';
import { requireUser } from '../../lib/session.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  try {
    const { user } = await requireUser(req);
    const db = getDb();

    const tenant = await db.execute({
      sql: 'SELECT id, slug FROM tenants WHERE owner_user_id = ? LIMIT 1',
      args: [user.id],
    });

    const t = tenant.rows[0];

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      tenant_id: t?.id || null,
      tenant_slug: t?.slug || null,
    }));
  } catch (err) {
    res.statusCode = err.statusCode || 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
}
