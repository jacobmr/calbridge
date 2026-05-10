import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID, randomBytes } from "node:crypto";

before(() => {
  process.env.CALBRIDGE_DEK = randomBytes(32).toString("base64");
  process.env.SESSION_SIGNING_KEY = randomBytes(32).toString("base64");
  process.env.TURSO_DATABASE_URL = `file:./.test-groups-${Date.now()}.db`;
});

// Helper: invoke a serverless handler with a minimal req/res shim.
// `cookie` is the full cookie header (signed cb_session=… built via the
// real session.mjs primitives — see authCookieFor below).
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

test("groups CRUD + invite + join + remove flow", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const db = getDb();

  const { createSession, buildCookieValue } =
    await import("../lib/session.mjs");
  const aliceId = randomUUID();
  const bobId = randomUUID();
  await db.execute({
    sql: "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    args: [
      aliceId,
      "alice@example.com",
      "Alice",
      Date.now(),
      bobId,
      "bob@example.com",
      "Bob",
      Date.now(),
    ],
  });
  // Build real signed cookies via the production primitives.
  const aliceSession = await createSession(aliceId);
  const bobSession = await createSession(bobId);
  const aliceCookie = `cb_session=${buildCookieValue(aliceSession)}`;
  const bobCookie = `cb_session=${buildCookieValue(bobSession)}`;

  {
    const groupsHandler = (await import("../api/groups/index.mjs")).default;
    const groupHandler = (await import("../api/groups/[id].mjs")).default;
    const inviteHandler = (await import("../api/groups/[id]/invite.mjs"))
      .default;
    const joinHandler = (await import("../api/groups/[id]/join.mjs")).default;
    const memberHandler = (
      await import("../api/groups/[id]/members/[userId].mjs")
    ).default;

    // Alice creates a family
    const created = await invoke(groupsHandler, {
      method: "POST",
      url: "/api/groups",
      body: { name: "The Andersons", type: "family" },
      cookie: aliceCookie,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.type, "family");
    assert.equal(created.body.my_role, "owner");
    assert.equal(created.body.member_count, 1);
    const groupId = created.body.id;

    // Alice lists — should see one group
    const listed = await invoke(groupsHandler, {
      method: "GET",
      url: "/api/groups",
      cookie: aliceCookie,
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);

    // Bob lists — should see zero
    const bobList = await invoke(groupsHandler, {
      method: "GET",
      url: "/api/groups",
      cookie: bobCookie,
    });
    assert.equal(bobList.body.length, 0);

    // Alice invites Bob
    const invited = await invoke(inviteHandler, {
      method: "POST",
      url: `/api/groups/${groupId}/invite`,
      body: { email: "bob@example.com" },
      cookie: aliceCookie,
    });
    assert.equal(invited.status, 201);
    assert.equal(invited.body.status, "pending");

    // Bob joins
    const joined = await invoke(joinHandler, {
      method: "POST",
      url: `/api/groups/${groupId}/join`,
      cookie: bobCookie,
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.ok, true);

    // Bob now sees the group
    const bobList2 = await invoke(groupsHandler, {
      method: "GET",
      url: "/api/groups",
      cookie: bobCookie,
    });
    assert.equal(bobList2.body.length, 1);
    assert.equal(bobList2.body[0].my_role, "member");
    assert.equal(bobList2.body[0].member_count, 2);

    // Bob views detail with members
    const detail = await invoke(groupHandler, {
      method: "GET",
      url: `/api/groups/${groupId}`,
      cookie: bobCookie,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.members.length, 2);

    // Non-member can't see details
    const charlieId = randomUUID();
    await db.execute({
      sql: "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
      args: [charlieId, "charlie@example.com", Date.now()],
    });
    const charlieSession = await createSession(charlieId);
    const charlieCookie = `cb_session=${buildCookieValue(charlieSession)}`;
    const denied = await invoke(groupHandler, {
      method: "GET",
      url: `/api/groups/${groupId}`,
      cookie: charlieCookie,
    });
    assert.equal(
      denied.status,
      404,
      "non-members get 404, not 403, to avoid leaking existence",
    );

    // Bob (member, not admin) can't delete
    const bobDelete = await invoke(groupHandler, {
      method: "DELETE",
      url: `/api/groups/${groupId}`,
      cookie: bobCookie,
    });
    assert.equal(bobDelete.status, 403);

    // Alice removes Bob
    const removed = await invoke(memberHandler, {
      method: "DELETE",
      url: `/api/groups/${groupId}/members/${bobId}`,
      cookie: aliceCookie,
    });
    assert.equal(removed.status, 204);

    // Bob no longer in group list
    const bobList3 = await invoke(groupsHandler, {
      method: "GET",
      url: "/api/groups",
      cookie: bobCookie,
    });
    assert.equal(bobList3.body.length, 0);

    // Alice (last owner) can't remove herself
    const selfNuke = await invoke(memberHandler, {
      method: "DELETE",
      url: `/api/groups/${groupId}/members/${aliceId}`,
      cookie: aliceCookie,
    });
    assert.equal(selfNuke.status, 400, "last owner can't leave");
  }
});

test("group shares + receive settings", async () => {
  const { migrate } = await import("../db/migrate.mjs");
  await migrate({ verbose: false });

  const { getDb } = await import("../db/client.mjs");
  const db = getDb();
  const { createSession, buildCookieValue } =
    await import("../lib/session.mjs");

  // Two users with a tenant + calendar each, joined to one group.
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const aliceTenantId = randomUUID();
  const aliceCalId = randomUUID();
  const groupId = randomUUID();
  const aliceMembershipId = randomUUID();
  const bobMembershipId = randomUUID();
  const now = Date.now();

  await db.execute({
    sql: "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?), (?, ?, ?)",
    args: [aliceId, `a-${now}@x.com`, now, bobId, `b-${now}@x.com`, now],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [aliceTenantId, `at-${now}`, "Alice", aliceId, now],
  });
  await db.execute({
    sql: `INSERT INTO calendars (id, tenant_id, provider, provider_calendar_id, label, role)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      aliceCalId,
      aliceTenantId,
      "google",
      "alice-cal",
      "Alice Personal",
      "owner",
    ],
  });
  await db.execute({
    sql: `INSERT INTO groups (id, name, slug, type, created_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [groupId, "Test Family", `tf-${now}`, "family", aliceId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_memberships (id, group_id, user_id, role, status, joined_at, created_at)
          VALUES (?, ?, ?, 'owner', 'active', ?, ?), (?, ?, ?, 'member', 'active', ?, ?)`,
    args: [
      aliceMembershipId,
      groupId,
      aliceId,
      now,
      now,
      bobMembershipId,
      groupId,
      bobId,
      now,
      now,
    ],
  });

  const aliceCookie = `cb_session=${buildCookieValue(await createSession(aliceId))}`;
  const bobCookie = `cb_session=${buildCookieValue(await createSession(bobId))}`;

  const sharesHandler = (await import("../api/groups/[id]/shares.mjs")).default;
  const shareItemHandler = (
    await import("../api/groups/[id]/shares/[calendarId].mjs")
  ).default;
  const receiveHandler = (
    await import("../api/groups/[id]/receive-settings/[sharerId].mjs")
  ).default;

  // Alice shares her calendar at full
  const added = await invoke(sharesHandler, {
    method: "POST",
    url: `/api/groups/${groupId}/shares`,
    body: { calendar_id: aliceCalId, share_level: "full" },
    cookie: aliceCookie,
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.share_level, "full");

  // Repeat POST with different level — idempotent upsert
  const reAdd = await invoke(sharesHandler, {
    method: "POST",
    url: `/api/groups/${groupId}/shares`,
    body: { calendar_id: aliceCalId, share_level: "free_busy" },
    cookie: aliceCookie,
  });
  assert.equal(reAdd.status, 200);
  assert.equal(reAdd.body.already_existed, true);
  assert.equal(reAdd.body.share_level, "free_busy");

  // GET reflects the change
  const list = await invoke(sharesHandler, {
    method: "GET",
    url: `/api/groups/${groupId}/shares`,
    cookie: aliceCookie,
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.mine.length, 1);
  assert.equal(list.body.mine[0].share_level, "free_busy");

  // Alice can't share Bob's calendar (she doesn't own one)
  const notMine = await invoke(sharesHandler, {
    method: "POST",
    url: `/api/groups/${groupId}/shares`,
    body: { calendar_id: randomUUID(), share_level: "full" },
    cookie: aliceCookie,
  });
  assert.equal(notMine.status, 404);

  // PATCH the level
  const patched = await invoke(shareItemHandler, {
    method: "PATCH",
    url: `/api/groups/${groupId}/shares/${aliceCalId}`,
    body: { share_level: "full" },
    cookie: aliceCookie,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.share_level, "full");

  // Bob upserts how he receives events from Alice — full view + busy_only push + prefix
  const recv = await invoke(receiveHandler, {
    method: "PATCH",
    url: `/api/groups/${groupId}/receive-settings/${aliceId}`,
    body: {
      receive_level: "full",
      push_level: "busy_only",
      event_prefix: "[Alex] ",
    },
    cookie: bobCookie,
  });
  assert.equal(recv.status, 201);
  assert.equal(recv.body.receive_level, "full");
  assert.equal(recv.body.push_level, "busy_only");
  assert.equal(recv.body.event_prefix, "[Alex] ");

  // Second PATCH — partial update; unset fields should retain their prior value
  const recv2 = await invoke(receiveHandler, {
    method: "PATCH",
    url: `/api/groups/${groupId}/receive-settings/${aliceId}`,
    body: { receive_level: "free_busy" },
    cookie: bobCookie,
  });
  assert.equal(recv2.status, 200);
  assert.equal(recv2.body.receive_level, "free_busy");
  assert.equal(
    recv2.body.push_level,
    "busy_only",
    "push_level should persist across partial PATCH",
  );
  assert.equal(recv2.body.event_prefix, "[Alex] ");

  // Bob's GET on shares should now show the receive-settings entry
  const bobList = await invoke(sharesHandler, {
    method: "GET",
    url: `/api/groups/${groupId}/shares`,
    cookie: bobCookie,
  });
  assert.equal(bobList.body.mine.length, 0, "Bob hasn't shared anything");
  assert.equal(bobList.body.receiveSettings.length, 1);
  assert.equal(bobList.body.receiveSettings[0].sharer_user_id, aliceId);

  // You can't have receive settings with yourself as sharer
  const selfRecv = await invoke(receiveHandler, {
    method: "PATCH",
    url: `/api/groups/${groupId}/receive-settings/${bobId}`,
    body: { receive_level: "full" },
    cookie: bobCookie,
  });
  assert.equal(selfRecv.status, 400);

  // DELETE the share
  const deleted = await invoke(shareItemHandler, {
    method: "DELETE",
    url: `/api/groups/${groupId}/shares/${aliceCalId}`,
    cookie: aliceCookie,
  });
  assert.equal(deleted.status, 204);
  const afterDelete = await invoke(sharesHandler, {
    method: "GET",
    url: `/api/groups/${groupId}/shares`,
    cookie: aliceCookie,
  });
  assert.equal(afterDelete.body.mine.length, 0);
});
