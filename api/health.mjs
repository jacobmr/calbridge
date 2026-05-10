import { getDb } from "../db/client.mjs";

export default async function handler(req, res) {
  const out = { ok: true, ts: Date.now() };
  try {
    const db = getDb();
    const r = await db.execute("SELECT 1 AS ok");
    out.db = r.rows[0]?.ok === 1 ? "up" : "unknown";
  } catch (e) {
    out.ok = false;
    out.db = "down";
    out.error = e.message;
    res.statusCode = 503;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
