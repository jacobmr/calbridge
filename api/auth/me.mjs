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
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    }));
  } catch (err) {
    res.statusCode = err.statusCode || 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
}
