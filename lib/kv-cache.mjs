/**
 * Tiny TTL cache backed by the existing kv_cache table.
 *
 * Used for short-lived response caching where exact freshness doesn't
 * matter (merged group events, ICS feed parses). Don't use this for
 * anything that needs strong consistency — there's no invalidation,
 * just expiry.
 */

import { getDb } from "../db/client.mjs";

/**
 * @param {string} key  Caller is responsible for namespacing keys
 *                      (e.g. "group-events:<groupId>:<userId>:<min>:<max>")
 * @returns {Promise<any|null>}  Parsed JSON value, or null on miss/expired/parse-error
 */
export async function kvGet(key) {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT value, expires_at FROM kv_cache WHERE key = ?",
    args: [key],
  });
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Store a JSON-serializable value with a TTL. Caller's responsibility to
 * not store secrets here — kv_cache is plaintext.
 */
export async function kvSet(key, value, ttlMs) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO kv_cache (key, value, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE
            SET value = excluded.value, expires_at = excluded.expires_at`,
    args: [key, JSON.stringify(value), Date.now() + ttlMs],
  });
}

/** Invalidate a single key. */
export async function kvDelete(key) {
  const db = getDb();
  await db.execute({
    sql: "DELETE FROM kv_cache WHERE key = ?",
    args: [key],
  });
}

/**
 * Wrap an async producer in cache-or-recompute semantics. Misses run
 * the producer and store its result.
 */
export async function kvMemoize(key, ttlMs, producer) {
  const cached = await kvGet(key);
  if (cached !== null) return cached;
  const fresh = await producer();
  // Don't poison the cache with undefined.
  if (fresh !== undefined) await kvSet(key, fresh, ttlMs);
  return fresh;
}
