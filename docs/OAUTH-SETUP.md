# OAuth Setup — Google + Microsoft

> Last updated: 2026-05-10

This doc captures the exact scopes MiCal requests, how to declare them
in each provider's developer console, and what to do about the
"unverified app" warning at production launch.

The scope lists live in the runtime code, not in the consoles:
- `api/oauth/google/init.mjs` — Google scope array
- `api/oauth/microsoft/init.mjs` — Microsoft scope array

The consoles are where you **document** those scopes for verification
and the consent screen — they don't enforce anything at runtime. Google
will issue tokens for whatever scopes the auth URL requests, subject to
verification rules described below.

---

## What MiCal asks for, and why

### Google

| Scope | Why we need it |
|---|---|
| `openid` | Standard OIDC identity assertion. |
| `https://www.googleapis.com/auth/userinfo.email` | Identify the signed-in user by email. |
| `https://www.googleapis.com/auth/userinfo.profile` | Display name + avatar in the dashboard. |
| `https://www.googleapis.com/auth/calendar.readonly` | List calendars and read events for the merged Schedule view, sync flows, poll free/busy pre-check, and group availability. |
| `https://www.googleapis.com/auth/calendar.events` | Create / update / delete events when a booking comes in or a poll winner is scheduled. Also writes the sync-target events. |

Both calendar scopes are classified by Google as **sensitive** (the
middle tier, between non-sensitive identity scopes and the heaviest
"restricted" tier reserved for Gmail and Drive). Sensitive scopes
trigger the unverified-app warning until verification, but the
verification bar is far lighter than restricted — see below.

We do **not** request the broader `auth/calendar` scope. `readonly` +
`events` together cover everything we do and avoid the "manage all your
calendars" phrasing on the consent screen.

### Microsoft

| Scope | Why we need it |
|---|---|
| `openid` | OIDC identity assertion. |
| `email` | Identify the signed-in user by email. |
| `profile` | Display name. |
| `offline_access` | Required to receive a refresh token (Microsoft equivalent of Google's `access_type=offline`). |
| `Calendars.Read` | Same as Google's `calendar.readonly`. |
| `Calendars.ReadWrite` | Same as Google's `calendar.events`. |

Microsoft classifies `Calendars.ReadWrite` as a **delegated permission
requiring admin consent in some organizational tenants**. For personal
accounts and consumer Microsoft accounts, a user can grant it directly.

---

## Google Cloud Console setup

Console: <https://console.cloud.google.com>

### 1. OAuth consent screen

**APIs & Services → OAuth consent screen**

- **User type**: External (we want anyone with a Google account, not
  just a single Workspace org)
- **App name**: MiCal
- **Support email**: jacob@reider.us
- **App logo**: optional but recommended for verification (eases the
  "do you trust this?" decision for users)
- **Application home page**: <https://www.mical.net>
- **Application privacy policy**: <https://www.mical.net/privacy>
- **Application terms of service**: <https://www.mical.net/terms>
- **Authorized domains**: `mical.net`
- **Developer contact**: jacob@reider.us

### 2. Data access (scopes)

**APIs & Services → OAuth consent screen → Data Access → Add or remove scopes**

Search for and add each of these:

- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`
- `openid`
- `.../auth/calendar.readonly`
- `.../auth/calendar.events`

For each restricted scope (`calendar.readonly`, `calendar.events`)
Google will ask you to describe the data-handling justification:

> MiCal reads the user's calendar to display a merged view across
> providers, run user-configured sync flows that copy events to other
> calendars they own, check availability for meeting polls the user
> creates, and surface group/family schedules. MiCal writes events to
> create bookings made through the user's public booking page and to
> create the winning event when a poll is scheduled. All tokens are
> encrypted at rest with AES-256-GCM; data is never shared with third
> parties and not used to train models.

### 3. Credentials

**APIs & Services → Credentials → OAuth 2.0 Client IDs → MiCal (web)**

- **Authorized JavaScript origins**: `https://www.mical.net`
- **Authorized redirect URIs**: `https://www.mical.net/api/oauth/google/callback`

The same client ID + secret end up in Vercel as `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`, and the redirect URI as `GOOGLE_REDIRECT_URI`.

### 4. Publishing status

**APIs & Services → OAuth consent screen**

States:
- **Testing**: only test users (allowlisted by email) can OAuth at all.
  Cap of 100 test users. Sensitive scopes can be requested without
  verification. Tokens expire after 7 days, forcing re-auth.
- **In production**: anyone with a Google account can OAuth. Without
  verification on sensitive scopes, users see the "Google hasn't
  verified this app" warning and there's a hard 100-token-per-week
  issuance cap.

We're in **production** right now. The user who owns the GCP project
(jacob@reider.us) will not see the warning when signing in with that
same Google account — that's a Google quirk, not verification status.
Other users should be seeing the warning until verification completes.

### 5. Verification (production-only)

**APIs & Services → OAuth consent screen → Prepare for verification**

For our sensitive scopes (contacts.readonly, calendar.readonly,
calendar.events), this requires:

- App home page, privacy policy, ToS pages reachable on
  `mical.net` (already in place)
- Domain verification of `mical.net` in Google Search Console
  (TXT record on DNS — one-time)
- An unlisted YouTube demo video (~90 s for contacts only, up to
  ~3 min if covering all three sensitive scopes in one recording)

There is **no CASA security assessment** in our path. CASA is only
required for *restricted* scopes (Gmail, Drive, Chat), and we don't
use any of those.

Without verification:
- The "unverified app" screen scares away most non-technical users
- We hit the 100-tokens-per-week cap once we have any volume

Verification is a real but manageable step — domain TXT + a short
video + the submission form. Worth doing once the contacts feature is
live so the video can show real usage. No external vendors, no
multi-thousand-dollar security assessment, no months-long review.

### Scope classifications and what each demands

Google sorts scopes into tiers, and each tier has a different
verification ceremony. As shown in the Cloud Console's Data Access
view, the classification for our scope set is:

| Tier | What we use here | What verification requires |
|---|---|---|
| Non-sensitive (`openid`, `userinfo.email`, `userinfo.profile`) | Identity scopes | Nothing |
| Sensitive (`contacts.readonly`, `calendar.readonly`, `calendar.events`) | Contacts + both calendar scopes | Domain verification (Search Console TXT record on `mical.net`) + privacy policy & ToS reachable on the same domain + an unlisted YouTube demo |
| Restricted (none for us) | Reserved for Gmail/Drive/Chat scopes; we don't use any | All of the sensitive bar plus a CASA Tier 2/3 security assessment |

We sit entirely in the sensitive tier. **There is no CASA assessment
in our path.** The "scary" verification cost (~$500-1500 + months of
back-and-forth) is the restricted-tier bar — not ours.

In practice Google triggered the verification flow when
`contacts.readonly` was declared. The video can be focused on contacts
alone, OR it can cover all three sensitive scopes in one recording —
your call. A combined video is slightly more work but means one
submission instead of two if Google ever asks for one on the calendar
scopes later.

### Verification YouTube demo (contacts) — shot list

Goal: prove that `contacts.readonly` does what the data-handling
justification said. ~90 seconds. Use a clean demo Google account with
sanitized contacts and events — reviewers see whatever's on screen.

**Recording order matters**: build the contacts autocomplete feature
in code first, ship to prod, then record on prod. Don't film a
pre-feature mockup — that's a verification-rejection trigger.

| Time  | What's on screen | Narration |
|---|---|---|
| 0:00  | Browser at mical.net, signed-in dashboard, URL bar visible | "MiCal is a calendar coordination tool at mical.net. From here, users send meeting polls and event-type invitations." |
| 0:10  | Click "New poll" → create-poll modal opens; scroll to "Send invitations to" field | "When sending invitations, the user types email addresses one at a time." |
| 0:25  | Focus the field, type two letters (e.g. "ja") | "We use `contacts.readonly` to suggest matching contacts from the user's Google address book…" |
| 0:35  | Suggestion dropdown appears with 2-3 contacts whose names start with "ja" | "…showing matching names and email addresses inline." |
| 0:45  | Click one to add as a recipient chip | "User picks one to add to the invitation list." |
| 0:55  | Show the same autocomplete on a group-invite or event-type form | "The same autocomplete is used everywhere the user is sending email — group invitations, booking-page guests, and so on." |
| 1:10  | Optional final shot — privacy policy line about contacts handling | "Contacts are read into the user's session for autocomplete only — not stored on MiCal servers, not shared with third parties, not used to train models." |

Rejection-avoiding details:
- **1080p+.** Lower will get rejected for "can't read text."
- **Slow, deliberate.** Don't fast-forward — reviewers want to see
  the actual interaction.
- **Sign in with the same Google account that owns the OAuth client.**
  Side effect: no unverified-app warning shows, which is fine.
- **No background music, no fancy editing.** Production value is not
  what's being graded.
- **Upload as Unlisted** (not Private — Private requires YouTube
  auth, which the reviewer doesn't have).
- **Match wording.** Whatever you said in the data-handling
  justification needs to be borne out in the video. If the
  justification said "in-memory cache" but the video shows persisted
  contacts in a Contacts page, that's the kind of mismatch that
  trips rejections.

If Google ever asks for a video for the calendar scopes too (they
might, especially if usage patterns change), the structure is the
same: open with branding + privacy/ToS, show OAuth flow, demonstrate
each scope's usage in turn.

---

## Microsoft / Azure AD setup

Console: <https://entra.microsoft.com>

### 1. App registration

**Microsoft Entra ID → App registrations → MiCal**

- **Supported account types**: Accounts in any organizational
  directory + personal Microsoft accounts (this is what lets
  hotmail.com / outlook.com users sign in)
- **Redirect URI**: `Web` →
  `https://www.mical.net/api/oauth/microsoft/callback`
- **Branding**: name, logo, publisher domain (set to `mical.net` once
  the domain ownership is verified — Microsoft has its own DNS TXT
  verification step)

The application (client) ID and the client secret (created under
**Certificates & secrets**) end up in Vercel as `MS_CLIENT_ID` and
`MS_CLIENT_SECRET`, redirect URI as `MS_REDIRECT_URI`.

### 2. API permissions

**MiCal → API permissions → Add a permission → Microsoft Graph →
Delegated permissions**

Add each of these:
- `openid`
- `email`
- `profile`
- `offline_access`
- `Calendars.Read`
- `Calendars.ReadWrite`

For personal-account users these are user-consentable. For org-tenant
users, the admin may need to grant `Calendars.ReadWrite` once on
behalf of the org.

### 3. Publisher verification

Microsoft has a separate "Publisher verified" badge that's much
lighter-weight than Google's verification. Worth doing once the
domain TXT verification is in place; reduces the "MiCal is asking
for…" cautionary phrasing on the consent screen.

---

## Contacts scopes — declared in console, code activation imminent

- Google: `https://www.googleapis.com/auth/contacts.readonly`
- Microsoft: `Contacts.Read`

These are **declared in both consoles** so they're already approved by
the time the autocomplete feature lands, but **not yet requested by
the runtime code**. Declaring ahead is fine here because (a) we know
we're shipping the feature in days, not weeks, and (b) the console
list is supposed to mirror what the runtime requests — by the time any
verification reviewer looks at the declared set, the code will match.

When the autocomplete feature lands, add both scopes to the runtime
arrays in `api/oauth/{google,microsoft}/init.mjs`. Existing users will
silently get the new scope added to their grant (Google) or re-consent
once on their next sign-in (Microsoft) thanks to
`include_granted_scopes=true` and the `offline_access` scope we
already request.

Google data-handling justification used when declaring:

> MiCal uses contacts to auto-suggest email addresses when the user
> is sending invitations — for meeting polls, family/team group
> invites, and booking-page recipients. Contacts are read into the
> user's MiCal session for autocomplete only; they are not stored on
> MiCal servers beyond an in-memory cache, never shared with third
> parties, and never used to train models.

If our actual implementation ends up caching contacts in the DB for
performance, this wording needs to be revised before verification —
mismatched wording is one of the more common verification rejections.

### Calendar (full) scope

We use `calendar.readonly` + `calendar.events` rather than the broader
`auth/calendar`. Same capability, friendlier consent text.

### Mail / Drive scopes

We have no need. Don't add them.

---

## Re-consent flow for users who already authorized

When we change the scope list, Google and Microsoft handle existing
users differently:

- **Google**: with `include_granted_scopes=true` (which we set in
  `api/oauth/google/init.mjs`), Google adds the new scopes to the
  existing token grant silently — no re-consent screen — *as long as*
  the new scopes aren't in a more-sensitive category than the old
  ones. Adding sensitive scopes does force re-consent.
- **Microsoft**: if the requested scope list differs from the granted
  set, the consent screen reappears next sign-in. The user clicks
  Accept once.

If we need to force a re-consent for a specific user (e.g. their
refresh token went stale), append `?force_consent=1` to the OAuth init
URL. The `api/oauth/google/init.mjs` and `api/oauth/microsoft/init.mjs`
handlers honor that flag and set `prompt=consent`.

---

## Quick verification of "is OAuth working right now?"

Local environment:
```
eval "$(sops -d /data/dev/inventory/secrets/calbridge.enc.env | sed 's/^/export /')"
vercel dev
```

Then open `http://localhost:3000/api/oauth/google/init` in a browser
that's not signed into any Google account. You should land on Google's
consent screen showing exactly the 5 scopes listed above. Reject; you
should be returned to the dashboard with no session. Accept; you
should land at `/app/?connected=google` and a dashboard session should
exist.

For Microsoft, swap `/google/` for `/microsoft/` in the URL.
