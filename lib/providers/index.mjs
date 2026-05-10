/**
 * Provider client factory.
 *
 * Given an oauth_accounts row (or an ICS calendar row), returns a
 * {@link ProviderClient} that the sync engine can use without caring which
 * vendor it's talking to.
 *
 * Usage:
 *   import { getProviderClientForCalendar } from './providers/index.mjs';
 *   const client = await getProviderClientForCalendar(calendarRow);
 *   const events = await client.listEvents(calendarRow.provider_calendar_id, timeMin, timeMax);
 */

import { createGoogleProvider } from "./google.mjs";
import { createMicrosoftProvider } from "./microsoft.mjs";
import { createIcsProvider } from "./ics.mjs";
import { getDb } from "../../db/client.mjs";

/**
 * Build a provider client from a calendars row. Handles oauth-account lookup
 * for Google/Microsoft and the encrypted URL for ICS.
 *
 * @param {object} calendarRow  Row from `calendars` table
 * @returns {Promise<import('./types.mjs').ProviderClient>}
 */
export async function getProviderClientForCalendar(calendarRow) {
  const provider = String(calendarRow.provider || "").toLowerCase();

  if (provider === "ics") {
    return createIcsProvider({ icsUrlEnc: calendarRow.ics_url_enc });
  }

  if (provider === "google" || provider === "microsoft") {
    if (!calendarRow.oauth_account_id) {
      const err = new Error(
        `calendar ${calendarRow.id} has provider ${provider} but no oauth_account_id`,
      );
      err.statusCode = 400;
      throw err;
    }
    const db = getDb();
    const r = await db.execute({
      sql: "SELECT * FROM oauth_accounts WHERE id = ?",
      args: [calendarRow.oauth_account_id],
    });
    const oauthRow = r.rows[0];
    if (!oauthRow) {
      const err = new Error(
        `oauth account not found: ${calendarRow.oauth_account_id}`,
      );
      err.statusCode = 404;
      throw err;
    }
    return provider === "google"
      ? createGoogleProvider({ oauthAccountRow: oauthRow })
      : createMicrosoftProvider({ oauthAccountRow: oauthRow });
  }

  const err = new Error(`unknown provider: ${provider}`);
  err.statusCode = 400;
  throw err;
}

/**
 * Lower-level helper: build a provider client when you already have an
 * oauth_accounts row in hand (e.g. during OAuth callback or calendar discovery).
 */
export function getProviderClientForOAuth(oauthAccountRow) {
  const provider = String(oauthAccountRow.provider || "").toLowerCase();
  if (provider === "google") return createGoogleProvider({ oauthAccountRow });
  if (provider === "microsoft")
    return createMicrosoftProvider({ oauthAccountRow });
  const err = new Error(`unknown oauth provider: ${provider}`);
  err.statusCode = 400;
  throw err;
}
