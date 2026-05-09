import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, resetDbForTest } from '../db/client.mjs';
import { migrate } from '../db/migrate.mjs';
import initHandler from '../api/oauth/google/init.mjs';
import callbackHandler from '../api/oauth/google/callback.mjs';
import meHandler from '../api/auth/me.mjs';

const TEST_DB = 'file:./.test-calbridge.db';
const TEST_DEK = 'pIGMASb4YFZ3pmHMKWAUW80ovFesCqK2B8CoLo4wCfM=';
const TEST_SIGNING_KEY = 'O4czPqR7eT4Vkv2cxZrknBhKjGnBmb+Or/SvTg4CdGo=';

function mockReq({ method = 'GET', url = '/', headers = {}, cookie = '' } = {}) {
  return { method, url, headers: { ...headers, cookie } };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    _body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this._body = body;
    },
  };
  return res;
}

describe('Google OAuth', () => {
  let originalFetch;

  before(async () => {
    process.env.TURSO_DATABASE_URL = TEST_DB;
    process.env.CALBRIDGE_DEK = TEST_DEK;
    process.env.SESSION_SIGNING_KEY = TEST_SIGNING_KEY;
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mical.net/api/oauth/google/callback';
    process.env.APP_BASE_URL = 'https://mical.net';

    resetDbForTest();
    await migrate({ verbose: false });

    originalFetch = global.fetch;
  });

  after(async () => {
    global.fetch = originalFetch;
    const db = getDb();
    await db.execute('DELETE FROM oauth_states');
    await db.execute('DELETE FROM oauth_accounts');
    await db.execute('DELETE FROM calendars');
    await db.execute('DELETE FROM sync_flows');
    await db.execute('DELETE FROM event_types');
    await db.execute('DELETE FROM bookings');
    await db.execute('DELETE FROM sessions');
    await db.execute('DELETE FROM tenants');
    await db.execute('DELETE FROM users');
  });

  it('init redirects to Google with state param', async () => {
    const req = mockReq({ url: '/api/oauth/google/init?return_to=/dashboard' });
    const res = mockRes();

    await initHandler(req, res);

    assert.equal(res.statusCode, 302);
    const location = res.headers.location;
    assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));

    const locUrl = new URL(location);
    assert.equal(locUrl.searchParams.get('client_id'), 'test-client-id');
    assert.equal(locUrl.searchParams.get('redirect_uri'), 'https://mical.net/api/oauth/google/callback');
    assert.equal(locUrl.searchParams.get('response_type'), 'code');
    assert.ok(locUrl.searchParams.get('state'));
    assert.ok(locUrl.searchParams.get('scope').includes('calendar.events'));

    // Verify state stored in DB
    const db = getDb();
    const stateRows = await db.execute({
      sql: 'SELECT id, intent, provider, return_to FROM oauth_states WHERE id = ?',
      args: [locUrl.searchParams.get('state')],
    });
    assert.equal(stateRows.rows.length, 1);
    assert.equal(stateRows.rows[0].intent, 'link');
    assert.equal(stateRows.rows[0].provider, 'google');
    assert.equal(stateRows.rows[0].return_to, '/dashboard');
  });

  it('callback creates user, tenant, and oauth_account on first sign-in', async () => {
    // Insert a valid state
    const db = getDb();
    const state = 'test-state-123';
    const now = Date.now();
    await db.execute({
      sql: 'INSERT INTO oauth_states (id, intent, provider, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [state, 'link', 'google', '/dashboard', now, now + 10 * 60 * 1000],
    });

    // Mock Google APIs
    global.fetch = async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          async json() {
            return {
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              expires_in: 3600,
              scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
            };
          },
        };
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return {
          ok: true,
          async json() {
            return {
              id: 'google-user-123',
              email: 'test@example.com',
              name: 'Test User',
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const req = mockReq({ url: `/api/oauth/google/callback?code=test-code&state=${state}` });
    const res = mockRes();

    await callbackHandler(req, res);

    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/dashboard');
    assert.ok(res.headers['set-cookie']);

    // Verify user created
    const userRows = await db.execute({ sql: 'SELECT id, email, display_name FROM users WHERE email = ?', args: ['test@example.com'] });
    assert.equal(userRows.rows.length, 1);
    assert.equal(userRows.rows[0].display_name, 'Test User');

    // Verify tenant created
    const tenantRows = await db.execute({ sql: 'SELECT id, slug, owner_user_id FROM tenants WHERE owner_user_id = ?', args: [userRows.rows[0].id] });
    assert.equal(tenantRows.rows.length, 1);
    assert.equal(tenantRows.rows[0].slug, 'test');

    // Verify oauth_account created
    const acctRows = await db.execute({
      sql: 'SELECT provider, provider_account_id, email, tenant_id, user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?',
      args: ['google', 'google-user-123'],
    });
    assert.equal(acctRows.rows.length, 1);
    assert.equal(acctRows.rows[0].email, 'test@example.com');
  });

  it('callback updates existing account on re-auth', async () => {
    const db = getDb();
    const state = 'test-state-456';
    const now = Date.now();
    await db.execute({
      sql: 'INSERT INTO oauth_states (id, intent, provider, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [state, 'link', 'google', '/', now, now + 10 * 60 * 1000],
    });

    global.fetch = async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          async json() {
            return {
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
              scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
            };
          },
        };
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return {
          ok: true,
          async json() {
            return {
              id: 'google-user-123',
              email: 'test@example.com',
              name: 'Test User Updated',
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const req = mockReq({ url: `/api/oauth/google/callback?code=test-code&state=${state}` });
    const res = mockRes();

    await callbackHandler(req, res);

    assert.equal(res.statusCode, 302);

    // Should still be only one user and one account
    const userRows = await db.execute({ sql: 'SELECT COUNT(*) as c FROM users' });
    assert.equal(userRows.rows[0].c, 1);

    const acctRows = await db.execute({ sql: 'SELECT COUNT(*) as c FROM oauth_accounts' });
    assert.equal(acctRows.rows[0].c, 1);
  });

  it('me returns current user when session is valid', async () => {
    const db = getDb();
    const userRows = await db.execute({ sql: 'SELECT id, email FROM users WHERE email = ?', args: ['test@example.com'] });
    const userId = userRows.rows[0].id;

    const sessionId = 'test-session-' + Date.now();
    const now = Date.now();
    await db.execute({
      sql: 'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
      args: [sessionId, userId, now, now + 30 * 24 * 60 * 60 * 1000, now],
    });

    const { buildCookieValue } = await import('../lib/session.mjs');
    const cookie = `cb_session=${buildCookieValue(sessionId)}`;

    const req = mockReq({ cookie });
    const res = mockRes();

    await meHandler(req, res);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.email, 'test@example.com');
  });

  it('me returns 401 without session', async () => {
    const req = mockReq();
    const res = mockRes();

    await meHandler(req, res);

    assert.equal(res.statusCode, 401);
  });
});
