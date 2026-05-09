import { createClient as createClientWeb } from '@libsql/client/web';
import { createClient as createClientNode } from '@libsql/client';

let _client;

function createClientForUrl(url) {
  // Use the Node client for local file-based DBs (testing)
  // Use the Web client for remote Turso URLs (Vercel serverless)
  const isFile = url.startsWith('file:');
  const factory = isFile ? createClientNode : createClientWeb;
  return factory({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

export function getDb() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is required');
  _client = createClientForUrl(url);
  return _client;
}

export function resetDbForTest() {
  _client = undefined;
}
