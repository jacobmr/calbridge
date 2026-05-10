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
