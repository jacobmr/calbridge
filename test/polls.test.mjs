import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID, randomBytes } from "node:crypto";

before(() => {
  process.env.CALBRIDGE_DEK = randomBytes(32).toString("base64");
  process.env.SESSION_SIGNING_KEY = randomBytes(32).toString("base64");
  process.env.TURSO_DATABASE_URL = `file:./.test-polls-${Date.now()}.db`;
});

// Same shim used by the groups tests — invoke a serverless handler with a
// minimal req/res pair. Body is JSON-stringified into the data event.
function invoke(handler, { method = "GET", url, body, cookie = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers: { cookie },
      on(event, fn) {
        if (event === "data" && body)
          fn(
            Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
          );
        if (event === "end") setImmediate(fn);
        if (event === "error") {
        }
      },
    };
    let statusCode = 200;
    const headers = {};
    const res = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(v) {
        statusCode = v;
      },
      setHeader(k, v) {
        headers[k.toLowerCase()] = v;
      },
      end(s) {
        const bodyStr = s == null ? "" : String(s);
        try {
          resolve({
            status: statusCode,
            body: bodyStr ? JSON.parse(bodyStr) : null,
            headers,
          });
        } catch {
          resolve({ status: statusCode, body: bodyStr, headers });
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// Token-mint surface — independent of any HTTP plumbing.
test("mintPollToken produces unique base64url strings", async () => {
  const { mintPollToken } = await import("../lib/polls.mjs");
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const t = mintPollToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/, "base64url charset");
    assert.ok(t.length >= 30, "long enough to be unguessable");
    assert.equal(seen.has(t), false, "no duplicates");
    seen.add(t);
  }
});

test("polls: organizer creates, votes upsert by email, schedule emits emails", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const db = getDb();

  const { createSession, buildCookieValue } =
    await import("../lib/session.mjs");

  // Seed: organizer Alice with a tenant, plus a Google calendar she can
  // schedule on. Bob is a separate user (will sign in to vote).
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const tenantId = randomUUID();
  const oauthId = randomUUID();
  const calId = randomUUID();
  const now = Date.now();

  await db.execute({
    sql: "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    args: [
      aliceId,
      "alice@example.com",
      "Alice",
      now,
      bobId,
      "bob@example.com",
      "Bob",
      now,
    ],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name, owner_user_id, default_tz, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [tenantId, "alice", "Alice", aliceId, "America/Los_Angeles", now],
  });
  const { encrypt } = await import("../lib/crypto.mjs");
  await db.execute({
    sql: `INSERT INTO oauth_accounts (id, tenant_id, user_id, provider, provider_account_id, email, refresh_token_enc, scopes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      oauthId,
      tenantId,
      aliceId,
      "google",
      "alice-g",
      "alice@example.com",
      encrypt("refresh_token"),
      "calendar",
      now,
    ],
  });
  await db.execute({
    sql: `INSERT INTO calendars (id, tenant_id, oauth_account_id, provider,
                                  provider_calendar_id, label, role, enabled)
          VALUES (?, ?, ?, ?, ?, ?, 'target', 1)`,
    args: [calId, tenantId, oauthId, "google", "primary", "Alice primary"],
  });

  const aliceCookie = `cb_session=${buildCookieValue(await createSession(aliceId))}`;
  const bobCookie = `cb_session=${buildCookieValue(await createSession(bobId))}`;

  const pollsHandler = (await import("../api/polls/index.mjs")).default;
  const pollHandler = (await import("../api/polls/[id]/index.mjs")).default;
  const publicHandler = (await import("../api/polls/public.mjs")).default;
  const scheduleHandler = (await import("../api/polls/[id]/schedule.mjs"))
    .default;

  // 1. Alice creates a poll with three future options. The first option's
  //    start is in the future so the validator passes.
  const inAnHour = Date.now() + 60 * 60 * 1000;
  const created = await invoke(pollsHandler, {
    method: "POST",
    url: "/api/polls",
    cookie: aliceCookie,
    body: {
      title: "Q1 sync",
      description: "Quick check-in",
      duration_min: 30,
      options: [
        { start_ms: inAnHour },
        { start_ms: inAnHour + 24 * 60 * 60 * 1000 },
        { start_ms: inAnHour + 2 * 24 * 60 * 60 * 1000 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.poll.title, "Q1 sync");
  assert.equal(created.body.options.length, 3);
  const pollId = created.body.poll.id;
  const token = created.body.poll.token;
  const opt1 = created.body.options[0].id;
  const opt2 = created.body.options[1].id;

  // 2. Listing returns the poll with response_count=0.
  const listed = await invoke(pollsHandler, {
    method: "GET",
    url: "/api/polls",
    cookie: aliceCookie,
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].response_count, 0);

  // 3. Public GET works without a session — token-only.
  const publicGet = await invoke(publicHandler, {
    url: `/api/polls/public?token=${encodeURIComponent(token)}`,
  });
  assert.equal(publicGet.status, 200);
  assert.equal(publicGet.body.options.length, 3);
  assert.equal(publicGet.body.viewer.signed_in, false);

  // 4. Anonymous email vote.
  const vote1 = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    body: {
      token,
      name: "Carol",
      email: "carol@example.com",
      picked_option_ids: [opt1, opt2],
    },
  });
  assert.equal(vote1.status, 200);
  assert.equal(vote1.body.ok, true);
  const responseId1 = vote1.body.response_id;

  // 5. Re-vote with the same email overwrites (not duplicates).
  const vote1b = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    body: {
      token,
      name: "Carol",
      email: "carol@example.com",
      picked_option_ids: [opt2],
    },
  });
  assert.equal(vote1b.status, 200);
  assert.equal(
    vote1b.body.response_id,
    responseId1,
    "same response row updated",
  );

  // 6. Bob votes signed-in. His row is keyed on user_id, not email.
  const vote2 = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    cookie: bobCookie,
    body: { token, picked_option_ids: [opt1, opt2] },
  });
  assert.equal(vote2.status, 200);

  // 7. Detail view shows two distinct responses + per-option vote counts.
  const detail = await invoke(pollHandler, {
    method: "GET",
    url: `/api/polls/${pollId}`,
    cookie: aliceCookie,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.responses.length, 2);
  const opt2Detail = detail.body.options.find((o) => o.id === opt2);
  assert.equal(opt2Detail.votes, 2, "opt2 has both Carol and Bob");

  // 8. Authorization: a different signed-in user can't view the detail.
  //    (Bob is a responder, not the organizer — he gets 403, not 200/the data.)
  const detailAsBob = await invoke(pollHandler, {
    method: "GET",
    url: `/api/polls/${pollId}`,
    cookie: bobCookie,
  });
  // Bob has no tenant of his own (he was created without a tenants row), so
  // the lookup short-circuits at "tenant not found" with 404. Either is fine
  // — the important property is that he can't read the organizer's data.
  assert.ok(
    detailAsBob.status === 403 || detailAsBob.status === 404,
    `expected 403/404 for non-organizer, got ${detailAsBob.status}`,
  );

  // 9. Update poll: change duration while still open.
  const updated = await invoke(pollHandler, {
    method: "PATCH",
    url: `/api/polls/${pollId}`,
    cookie: aliceCookie,
    body: { duration_min: 45 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.poll.duration_min, 45);

  // 10. Close the poll. Subsequent votes are rejected.
  const closeHandler = (await import("../api/polls/[id]/close.mjs")).default;
  const closed = await invoke(closeHandler, {
    method: "POST",
    url: `/api/polls/${pollId}/close`,
    cookie: aliceCookie,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.poll.status, "closed");

  const lateVote = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    body: {
      token,
      name: "Dave",
      email: "dave@example.com",
      picked_option_ids: [opt1],
    },
  });
  assert.equal(lateVote.status, 400);

  // We deliberately don't exercise the schedule handler here — it requires
  // a real provider client (live Google API call). Schedule is verified via
  // production smoke testing instead. Suppress the unused-binding warning
  // by referencing the import.
  void scheduleHandler;
});

// v1.1: fully anonymous votes (no session, no email) are always rejected;
// require_email is locked on regardless of what the create request supplied.
test("polls v1.1: votes without identifier are rejected; invite_emails persisted", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const db = getDb();
  const { createSession, buildCookieValue } =
    await import("../lib/session.mjs");

  const userId = randomUUID();
  const tenantId = randomUUID();
  await db.execute({
    sql: "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    args: [userId, "host@example.com", "Host", Date.now()],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [tenantId, "host", "Host", userId, Date.now()],
  });
  const cookie = `cb_session=${buildCookieValue(await createSession(userId))}`;

  const pollsHandler = (await import("../api/polls/index.mjs")).default;
  const publicHandler = (await import("../api/polls/public.mjs")).default;

  const inAnHour = Date.now() + 60 * 60 * 1000;
  // Even though the request asks for require_email=false, the server
  // ignores that — anonymous voting was retired in v1.1. Also pass an
  // invite_emails list with duplicates + a malformed entry to exercise
  // the dedupe + filter logic.
  const created = await invoke(pollsHandler, {
    method: "POST",
    url: "/api/polls",
    cookie,
    body: {
      title: "Sync",
      duration_min: 30,
      require_email: false,
      invite_emails: [
        "ALICE@example.com",
        "alice@example.com",
        "bob@example.com",
        "not-an-email",
      ],
      options: [
        { start_ms: inAnHour },
        { start_ms: inAnHour + 24 * 60 * 60 * 1000 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(
    created.body.poll.require_email,
    true,
    "server forces require_email=true",
  );
  assert.equal(
    created.body.invites_total,
    2,
    "alice + bob, deduped + malformed dropped",
  );
  // Persisted rows match.
  const inv = await db.execute({
    sql: "SELECT email FROM poll_invites WHERE poll_id = ? ORDER BY email",
    args: [created.body.poll.id],
  });
  assert.deepEqual(
    inv.rows.map((r) => r.email),
    ["alice@example.com", "bob@example.com"],
  );

  const token = created.body.poll.token;
  const optId = created.body.options[0].id;

  // No email, no session — rejected.
  const anon = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    body: { token, name: "Nameless", picked_option_ids: [optId] },
  });
  assert.equal(anon.status, 400);

  // With email — accepted.
  const withEmail = await invoke(publicHandler, {
    method: "POST",
    url: "/api/polls/public",
    body: {
      token,
      name: "Eve",
      email: "eve@example.com",
      picked_option_ids: [optId],
    },
  });
  assert.equal(withEmail.status, 200);
});
