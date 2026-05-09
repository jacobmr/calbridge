import { createClient } from '@libsql/client/web';

let _client;

export function getDb() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is required');
  _client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  return _client;
}

export function resetDbForTest() {
  _client = undefined;
}
