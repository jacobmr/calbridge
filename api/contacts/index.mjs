/**
 * GET /api/contacts
 *
 * Returns the calling user's contact suggestions, merged from three sources:
 *
 *   1. Google People API (every connected Google OAuth account, in parallel)
 *   2. Microsoft Graph /me/contacts (every connected Microsoft OAuth account)
 *   3. MiCal-internal email history — addresses we already store from
 *      poll_invites, group_memberships, and bookings owned by this tenant.
 *      This is just reusing data we already hold, not new collection.
 *
 * Output:
 *   { contacts: [{ name, email, source: "google"|"microsoft"|"internal" }] }
 *
 * Deduplicated on lowercased email; when the same address appears in
 * multiple sources we keep the first by source priority (google >
 * microsoft > internal — provider contacts have richer names).
 *
 * No on-server caching. Each call hits the provider APIs fresh. The
 * intent is that the browser caches the response per modal-open and
 * does the autocomplete filtering locally, so we make at most one
 * call per "user opens the recipient field" interaction.
 */

import { getDb } from "../../db/client.mjs";
import { requireUser } from "../../lib/session.mjs";
import { sendError } from "../../lib/groups.mjs";
import {
  getValidAccessToken as getGoogleToken,
  listGoogleContacts,
} from "../../lib/google.mjs";
import {
  getValidMicrosoftAccessToken as getMsToken,
  listMicrosoftContacts,
} from "../../lib/microsoft.mjs";

const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${label} timed out after ${ms}ms`), {
            statusCode: 504,
          }),
        ),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function fetchInternalContacts(db, userId) {
  // Tenant for this user. Anything keyed to a tenant the user owns
  // contributes to "people I've emailed via MiCal."
  const tRes = await db.execute({
    sql: "SELECT id FROM tenants WHERE owner_user_id = ? LIMIT 1",
    args: [userId],
  });
  if (!tRes.rows[0]) return [];
  const tenantId = tRes.rows[0].id;

  // Three lightweight queries — much cheaper than denormalizing. Each
  // contributes a name + email to the merge. NULL names are fine.
  const [pollRes, groupRes, bookingRes] = await Promise.all([
    db.execute({
      sql: `SELECT DISTINCT pi.email AS email, NULL AS name
              FROM poll_invites pi
              JOIN polls p ON p.id = pi.poll_id
             WHERE p.tenant_id = ? AND pi.email IS NOT NULL AND pi.email != ''`,
      args: [tenantId],
    }),
    db.execute({
      sql: `SELECT DISTINCT u.email AS email, u.display_name AS name
              FROM group_memberships gm
              JOIN groups g ON g.id = gm.group_id
              JOIN users u ON u.id = gm.user_id
             WHERE g.created_by_user_id = ? AND u.email IS NOT NULL`,
      args: [userId],
    }),
    db.execute({
      sql: `SELECT DISTINCT b.attendee_email AS email, b.attendee_name AS name
              FROM bookings b
             WHERE b.tenant_id = ?
               AND b.attendee_email IS NOT NULL AND b.attendee_email != ''`,
      args: [tenantId],
    }),
  ]);

  const rows = [...pollRes.rows, ...groupRes.rows, ...bookingRes.rows];
  // Dedupe on lowercased email; prefer the first non-null name we saw.
  const map = new Map();
  for (const r of rows) {
    const email = String(r.email || "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    if (!map.has(email)) {
      map.set(email, { email, name: r.name || null, source: "internal" });
    } else if (!map.get(email).name && r.name) {
      map.get(email).name = r.name;
    }
  }
  return [...map.values()];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { user } = await requireUser(req);
    const db = getDb();

    // Pull every OAuth account the user has connected. We fan out a
    // contacts-list request to each in parallel; a single per-account
    // failure shouldn't tank the merged result (e.g. one Google account
    // with a revoked refresh token shouldn't blank Microsoft contacts).
    const accountsRes = await db.execute({
      sql: `SELECT id, provider, email, access_token_enc, access_token_expires_at,
                   refresh_token_enc, scopes
              FROM oauth_accounts
             WHERE user_id = ?`,
      args: [user.id],
    });

    // Per-source error log surfaced back to the client. Bug-shaped failures
    // (People API not enabled, revoked refresh token, etc.) used to swallow
    // silently and look identical to "no contacts" — log them in-band so
    // the UI can show a hint.
    const sourceErrors = [];

    const providerFetches = accountsRes.rows.map(async (acct) => {
      const provider = String(acct.provider || "").toLowerCase();
      try {
        if (provider === "google") {
          // Skip accounts whose granted scopes don't include contacts —
          // calling People API without the scope returns 403 and would
          // poison the merge. The scopes column is a space-separated
          // string from the original consent.
          if (!String(acct.scopes || "").includes("contacts.readonly")) {
            sourceErrors.push({
              source: "google",
              email: acct.email || null,
              reason:
                "contacts.readonly scope not granted — sign out and back in to re-consent",
            });
            return [];
          }
          const token = await withTimeout(
            getGoogleToken(acct),
            PROVIDER_TIMEOUT_MS,
            "google token refresh",
          );
          const contacts = await withTimeout(
            listGoogleContacts(token),
            PROVIDER_TIMEOUT_MS,
            "google contacts list",
          );
          return contacts.map((c) => ({ ...c, source: "google" }));
        }
        if (provider === "microsoft") {
          if (
            !String(acct.scopes || "")
              .toLowerCase()
              .includes("contacts.read")
          ) {
            sourceErrors.push({
              source: "microsoft",
              email: acct.email || null,
              reason:
                "Contacts.Read scope not granted — sign out and back in to re-consent",
            });
            return [];
          }
          const token = await withTimeout(
            getMsToken(acct),
            PROVIDER_TIMEOUT_MS,
            "microsoft token refresh",
          );
          const contacts = await withTimeout(
            listMicrosoftContacts(token),
            PROVIDER_TIMEOUT_MS,
            "microsoft contacts list",
          );
          return contacts.map((c) => ({ ...c, source: "microsoft" }));
        }
        return [];
      } catch (err) {
        const msg = err.message || String(err);
        console.error("contacts: per-account fetch failed", provider, msg);
        // Map common Google "API not enabled" 403 to actionable copy so
        // the user/operator sees the fix in the UI instead of staring at
        // an empty popup.
        let reason = msg.slice(0, 240);
        if (
          provider === "google" &&
          /People API .*has not been used|People API .*disabled/i.test(msg)
        ) {
          reason =
            "Google People API not enabled for the MiCal project. Enable it at https://console.cloud.google.com/apis/library/people.googleapis.com";
        }
        sourceErrors.push({
          source: provider,
          email: acct.email || null,
          reason,
        });
        return [];
      }
    });

    const [providerLists, internal] = await Promise.all([
      Promise.all(providerFetches),
      fetchInternalContacts(db, user.id).catch((err) => {
        console.error("contacts: internal fetch failed", err.message);
        return [];
      }),
    ]);

    // Merge with source-priority dedup: google > microsoft > internal.
    // Google contacts most often have the best display names, so they
    // win when an email appears in multiple sources.
    const order = ["google", "microsoft", "internal"];
    const merged = new Map();
    for (const src of order) {
      const list =
        src === "internal"
          ? internal
          : providerLists.flat().filter((c) => c.source === src);
      for (const c of list) {
        const email = String(c.email || "")
          .trim()
          .toLowerCase();
        if (!email || merged.has(email)) continue;
        merged.set(email, { name: c.name || null, email, source: c.source });
      }
    }

    // Sort: contacts that have a display name first (better autocomplete
    // experience), then alphabetical by name, then by email.
    const result = [...merged.values()].sort((a, b) => {
      if (!!a.name !== !!b.name) return a.name ? -1 : 1;
      const an = (a.name || a.email).toLowerCase();
      const bn = (b.name || b.email).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    res.setHeader("content-type", "application/json");
    // Brief cache hint so a fast double-open of the picker doesn't pay
    // for two People API round-trips. Private — never share across users.
    res.setHeader("cache-control", "private, max-age=30");
    res.end(JSON.stringify({ contacts: result, source_errors: sourceErrors }));
  } catch (err) {
    sendError(res, err);
  }
}
