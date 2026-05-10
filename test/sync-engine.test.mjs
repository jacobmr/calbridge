import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID, randomBytes } from "node:crypto";

before(() => {
  process.env.CALBRIDGE_DEK = randomBytes(32).toString("base64");
  process.env.SESSION_SIGNING_KEY = randomBytes(32).toString("base64");
  process.env.TURSO_DATABASE_URL = `file:./.test-sync-${Date.now()}.db`;
});

test("sync engine writes sync_runs row and uses provider abstraction", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const db = getDb();

  // Seed: user + tenant + two google calendars + flow
  const userId = randomUUID();
  const tenantId = randomUUID();
  const sourceCalId = randomUUID();
  const targetCalId = randomUUID();
  const oauthId = randomUUID();
  const flowId = randomUUID();
  const now = Date.now();

  await db.execute({
    sql: "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
    args: [userId, "test@example.com", now],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [tenantId, "test", "Test", userId, now],
  });
  // Stub oauth row — provider client will be replaced via mock below
  const { encrypt } = await import("../lib/crypto.mjs");
  await db.execute({
    sql: `INSERT INTO oauth_accounts (id, tenant_id, user_id, provider, provider_account_id, email, refresh_token_enc, scopes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      oauthId,
      tenantId,
      userId,
      "google",
      "acct1",
      "t@e.com",
      encrypt("rt"),
      "",
      now,
    ],
  });
  await db.execute({
    sql: `INSERT INTO calendars (id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role)
          VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sourceCalId,
      tenantId,
      oauthId,
      "google",
      "src@cal",
      "Source",
      "owner",
      targetCalId,
      tenantId,
      oauthId,
      "google",
      "tgt@cal",
      "Target",
      "owner",
    ],
  });
  await db.execute({
    sql: `INSERT INTO sync_flows (id, tenant_id, source_calendar_id, target_calendar_id, options_json, enabled)
          VALUES (?, ?, ?, ?, ?, 1)`,
    args: [flowId, tenantId, sourceCalId, targetCalId, JSON.stringify({})],
  });

  // Mock the provider factory: source returns one event, target returns nothing,
  // createEvent on target is recorded.
  const created = [];
  const mockClient = (kind) => ({
    provider: "google",
    capabilities: { canWrite: true, canUpdate: true, canDelete: true },
    async listCalendars() {
      return [];
    },
    async listEvents() {
      if (kind === "source") {
        return [
          {
            id: "evt-1",
            summary: "Test event",
            start: { dateTime: new Date(Date.now() + 86400000).toISOString() },
            end: { dateTime: new Date(Date.now() + 90000000).toISOString() },
          },
        ];
      }
      return [];
    },
    async createEvent(_calId, evt) {
      created.push(evt);
      return { id: `created-${created.length}` };
    },
    async updateEvent() {},
    async deleteEvent() {},
  });

  const { runSyncFlow } = await import("../lib/sync-engine.mjs");
  const result = await runSyncFlow(flowId, {
    getProviderClient: async (cal) =>
      cal.id === sourceCalId ? mockClient("source") : mockClient("target"),
  });

  {
    assert.equal(result.created, 1, "should create exactly one target event");
    assert.equal(result.errors, 0);
    assert.ok(result.runId, "result includes runId");
    assert.equal(created.length, 1);
    assert.match(created[0].description, /MiCal Sync/, "marker present");

    // sync_runs row recorded
    const r = await db.execute({
      sql: "SELECT * FROM sync_runs WHERE sync_flow_id = ?",
      args: [flowId],
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].ok, 1);
    assert.ok(r.rows[0].finished_at, "finished_at populated");
  }
});

test("sync engine creates → updates → deletes across runs", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const { encrypt } = await import("../lib/crypto.mjs");
  const { runSyncFlow } = await import("../lib/sync-engine.mjs");
  const db = getDb();

  // Seed
  const userId = randomUUID();
  const tenantId = randomUUID();
  const sourceCalId = randomUUID();
  const targetCalId = randomUUID();
  const oauthId = randomUUID();
  const flowId = randomUUID();
  const now = Date.now();

  await db.execute({
    sql: "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
    args: [userId, `lifecycle-${now}@x.com`, now],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [tenantId, `t-${now}`, "Lifecycle", userId, now],
  });
  await db.execute({
    sql: `INSERT INTO oauth_accounts (id, tenant_id, user_id, provider, provider_account_id, email, refresh_token_enc, scopes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [oauthId, tenantId, userId, "google", "acct-l", "l@e.com", encrypt("rt"), "", now],
  });
  await db.execute({
    sql: `INSERT INTO calendars (id, tenant_id, oauth_account_id, provider, provider_calendar_id, label, role)
          VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sourceCalId, tenantId, oauthId, "google", "src@l", "Source", "owner",
      targetCalId, tenantId, oauthId, "google", "tgt@l", "Target", "owner",
    ],
  });
  await db.execute({
    sql: `INSERT INTO sync_flows (id, tenant_id, source_calendar_id, target_calendar_id, options_json, enabled)
          VALUES (?, ?, ?, ?, ?, 1)`,
    args: [flowId, tenantId, sourceCalId, targetCalId, JSON.stringify({})],
  });

  // Stateful mock: source events change between calls, target stores what
  // was created/updated/deleted so we can simulate persistent target state.
  let sourceEvents = [
    {
      id: "evt-A",
      summary: "Original title",
      start: { dateTime: "2026-06-01T10:00:00Z" },
      end:   { dateTime: "2026-06-01T11:00:00Z" },
    },
  ];
  // Target state — keyed by target id, value is the stored event payload.
  const targetState = new Map();
  let nextTargetId = 1;

  const sourceClient = {
    provider: "google",
    capabilities: { canWrite: true, canUpdate: true, canDelete: true },
    async listCalendars() { return []; },
    async listEvents() { return sourceEvents.map((e) => ({ ...e })); },
    async createEvent() { throw new Error("source createEvent should not be called"); },
    async updateEvent() {},
    async deleteEvent() {},
  };
  const targetClient = {
    provider: "google",
    capabilities: { canWrite: true, canUpdate: true, canDelete: true },
    async listCalendars() { return []; },
    async listEvents() {
      // Echo stored events back as if read from the provider.
      return [...targetState.entries()].map(([id, evt]) => ({ id, ...evt }));
    },
    async createEvent(_calId, evt) {
      const id = `tgt-${nextTargetId++}`;
      targetState.set(id, evt);
      return { id };
    },
    async updateEvent(_calId, eventId, patch) {
      const prev = targetState.get(eventId) || {};
      targetState.set(eventId, { ...prev, ...patch });
      return { id: eventId };
    },
    async deleteEvent(_calId, eventId) {
      targetState.delete(eventId);
    },
  };
  const factory = async (cal) =>
    cal.id === sourceCalId ? sourceClient : targetClient;

  // Run 1: create
  const r1 = await runSyncFlow(flowId, { getProviderClient: factory });
  assert.equal(r1.created, 1);
  assert.equal(r1.updated, 0);
  assert.equal(r1.deleted, 0);
  assert.equal(targetState.size, 1);

  // Run 2: same source — should detect no change (skipped)
  const r2 = await runSyncFlow(flowId, { getProviderClient: factory });
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.skipped, 1, "unchanged source should be skipped");

  // Run 3: source title changes — should patch the existing target
  sourceEvents[0] = { ...sourceEvents[0], summary: "New title" };
  const r3 = await runSyncFlow(flowId, { getProviderClient: factory });
  assert.equal(r3.created, 0);
  assert.equal(r3.updated, 1, "changed source should trigger update");
  assert.equal(targetState.size, 1, "still one target — patched, not duplicated");
  const onlyTarget = [...targetState.values()][0];
  assert.equal(onlyTarget.summary, "New title");

  // Run 4: source deleted — target should be GC'd
  sourceEvents = [];
  const r4 = await runSyncFlow(flowId, { getProviderClient: factory });
  assert.equal(r4.deleted, 1, "missing source should trigger delete");
  assert.equal(targetState.size, 0);
});
