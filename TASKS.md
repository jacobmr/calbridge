# MiCal Implementation Tasks

> Agent-ready task breakdown of `PLAN.md`. Each task has: scope, files, acceptance criteria, dependencies, and effort.
> Status legend: 🟦 ready · 🟨 in-progress · 🟩 done · 🟧 blocked

**UX gate for every task**: Verify the change against the 8 Guiding UX Principles in `PLAN.md` §1.5 before marking done. If a task adds clutter for users who don't use that feature, redesign.

---

## Phase 1 — UX Critical Fixes (parallelizable, can start immediately)

### T1.1 — Mobile hamburger nav on landing 🟦

- **Files**: `public/index.html`, `public/style.css`
- **Scope**: At ≤640px, replace the `display: none` hide with a hamburger button that toggles a dropdown containing the existing nav links + "Get Started".
- **Acceptance**: On a 375px viewport, "Get Started" is reachable in ≤2 taps. No layout shift on desktop.
- **Effort**: 30 min · **Dependencies**: none

### T1.2 — Replace emoji icons with inline SVG 🟦

- **Files**: `public/index.html`, `public/login.html`, `public/app/index.html`, `public/app/app.css`, `public/app/app.js`
- **Scope**: Audit every emoji used as UI iconography (sidebar nav, problem/feature/step cards, ICS badge, mobile menu button, empty states). Replace with inline SVG (Lucide-style stroke icons, 24×24, `currentColor`). Keep emoji ONLY where intentional content (e.g., a celebration in copy).
- **Acceptance**: No emoji in any chrome/UI element. Icons render identically across macOS, Windows, Linux. Color follows theme.
- **Effort**: 2 hr · **Dependencies**: none

### T1.3 — Cursor + hover affordances 🟦

- **Files**: `public/app/app.css`, `public/style.css`
- **Scope**: Add `cursor: pointer` to every clickable non-button element (table rows that act as links, preview-modal items, stat cards if clickable). Add subtle `tbody tr:hover { background: rgba(15,76,129,0.03); }` to all data tables.
- **Acceptance**: Hover state visible on every clickable element. No unintended pointer cursors on plain text.
- **Effort**: 30 min · **Dependencies**: none

### T1.4 — Weekday checkboxes (replace bitmask) 🟦

- **Files**: `public/app/app.js`, `api/event-types/index.mjs`
- **Scope**: Render 7 checkboxes (Mon–Sun) in event-type form. On submit, compute bitmask client-side. Server accepts either bitmask integer OR `weekdays: ["mon","tue",...]` array.
- **Acceptance**: Form has no "31" or "bitmask" string visible to user. Existing event types load with correct boxes checked.
- **Effort**: 1 hr · **Dependencies**: none

### T1.5 — Time inputs (replace work_hours JSON) 🟦

- **Files**: `public/app/app.js`, `api/event-types/index.mjs`
- **Scope**: Two `<input type="time">` fields ("from" / "to"). JSON-encode for API. Server accepts JSON string or `{start, end}` object.
- **Acceptance**: User never sees `{"start":"09:00",...}`. Existing values populate correctly.
- **Effort**: 30 min · **Dependencies**: none

### T1.6 — Toast notification system 🟦

- **Files**: `public/app/app.js`, `public/app/app.css`
- **Scope**: Replace inline error/success banners with top-right toast stack. Auto-dismiss after 4s for success, 8s for errors. Closeable. Stack vertically. Replace ALL current `showError` and inline success-banner DOM hacks.
- **Acceptance**: No success banner persists after navigation. Errors are obvious but non-blocking. Multiple toasts stack cleanly.
- **Effort**: 2 hr · **Dependencies**: none

---

## Phase 2 — Dashboard Health (depends on T1.6 for toasts)

### T2.1 — Sync runs table is wired (MOVED from P2.1) 🟧

- **Note**: This is now T3.5.7. Listed here for visibility — the Overview redesign depends on it.

### T2.2 — Overview command center 🟦

- **Files**: `public/app/app.js`, `public/app/app.css`, `api/auth/me.mjs` (or new `/api/overview` aggregate)
- **Scope**: Replace welcome message + 4 inventory cards with:
  1. **Status row** — 4 cards (Calendars, Sync Flows, Event Types, Bookings). Each shows count + a health pill (`✓ Healthy` / `⚠ Stale` / `⛔ Error` / `—`).
  2. **Recent Activity** feed — last 5 items from `sync_runs` + recent bookings (use `audit_log` if present).
  3. **Needs Attention** — sync flows that haven't run in 24h or had errors on last run. Hidden if empty.
  4. **Quick Actions** — keep the 3 buttons but only show actions relevant to current state (e.g., hide "Create Sync Flow" if zero calendars).
- **Health rules**: Healthy = last run <24h, ok=1. Stale = 24h–7d. Warning = >7d or last run had errors. Error = last run failed.
- **Acceptance**: First paint answers "is my sync working?". User with 0 calendars sees a single onboarding CTA, not 4 zeros.
- **Effort**: 4 hr · **Dependencies**: T3.5.7 (`sync_runs` populated)

### T2.3 — Calendars-by-account restructure 🟦

- **Files**: `public/app/app.js`, `public/app/app.css`, possibly `api/calendars/index.mjs` (group by `oauth_account_id`)
- **Scope**: Replace flat table with sections grouped by oauth account. Each section shows account email + provider icon + per-calendar toggle + settings. ICS feeds in a separate "Other Feeds" section. ICS form behind `[+ Add Manual ICS Feed]` button (collapsed by default).
- **Acceptance**: User with 2 Google accounts + 1 Outlook + 1 ICS sees 3 account cards + 1 feed section. ICS form is invisible until clicked.
- **Effort**: 3 hr · **Dependencies**: none

### T2.4 — Sidebar polish 🟦

- **Files**: `public/app/app.css`
- **Scope**: Active nav item gets a 3px left border in `--flow-teal`. Inactive items have slightly muted text. Bookings nav gets a count badge (filled if `bookings.length > 0` and there are unread; otherwise hidden).
- **Acceptance**: Active page is obvious at a glance. Bookings badge does not show "0".
- **Effort**: 1 hr · **Dependencies**: none

### T2.5 — Hide tabs that have no relevance for a new user 🟦

- **Files**: `public/app/index.html`, `public/app/app.js`
- **Scope**: A user with 0 calendars sees only Overview + Calendars in the sidebar. Sync Flows / Event Types / Bookings unhide as the user creates state. (Implementation: render sidebar based on counts after first `/api/auth/me` aggregate.)
- **Acceptance**: New user is not overwhelmed. Tabs appear naturally as they earn their place.
- **Effort**: 2 hr · **Dependencies**: T2.2 (overview aggregate API)

---

## Phase 3 — Forms & Power UX

### T3.1 — Event Types progressive disclosure 🟦

- **Files**: `public/app/app.js`, `public/app/app.css`
- **Scope**: Form has two sections: **Essentials** (name, slug, duration, target calendar) always visible. **Advanced** (buffer, lead, horizon, weekdays, work hours, location, password) behind a single `[Show Advanced ▾]` toggle. Smart defaults pre-fill. Slug auto-generates from name unless edited.
- **Acceptance**: Creating an event type takes <30 seconds for the default case. The form fits in one screen on a laptop.
- **Effort**: 3 hr · **Dependencies**: T1.4, T1.5

### T3.2 — Sync Flow "Order" → "Priority" with explanation 🟦

- **Files**: `public/app/app.js`
- **Scope**: Rename column to "Priority". Show `—` if all flows have ord=0. Add small `?` tooltip: "Lower runs first. Use this to chain flows."
- **Acceptance**: Column meaning is clear without external docs.
- **Effort**: 30 min · **Dependencies**: none

### T3.3 — Keyboard shortcuts (deferred) 🟦

- **Files**: `public/app/app.js`
- **Scope**: `?` opens help modal. `g c` → Calendars. `g s` → Sync Flows. `g e` → Event Types. `g b` → Bookings. `g o` → Overview.
- **Acceptance**: Shortcuts work, help modal lists them.
- **Effort**: 1 hr · **Dependencies**: none. Defer if time-pressed.

---

## Phase 3.5 — Provider Parity (PREREQUISITE for Phase 4) 🟧

This unblocks the merged family view, the Alexa push case, and the consultant busy-pushback case. Sequence the subtasks; some can parallel.

### T3.5.1 — Define `ProviderClient` interface 🟦

- **Files**: new `lib/providers/types.mjs` (JSDoc interface) + `lib/providers/index.mjs` (factory)
- **Scope**: Document the contract: `listEvents(timeMin, timeMax, calendarId)`, `createEvent(calendarId, event)`, `updateEvent(calendarId, eventId, patch)`, `deleteEvent(calendarId, eventId)`, `listCalendars()`. Common event shape (normalize Google + MS Graph + ICS into one structure).
- **Acceptance**: Interface document committed. Factory `getProviderClient(provider, oauthAccountRow)` returns the right implementation.
- **Effort**: 1 hr · **Dependencies**: none

### T3.5.2 — Google client implements ProviderClient 🟦

- **Files**: `lib/google.mjs` → `lib/providers/google.mjs`
- **Scope**: Wrap existing functions in the new interface. Add `updateEvent` and `deleteEvent`.
- **Acceptance**: Existing sync flows still work. Update + delete callable.
- **Effort**: 2 hr · **Dependencies**: T3.5.1

### T3.5.3 — Microsoft Graph client 🟦

- **Files**: new `lib/providers/microsoft.mjs`
- **Scope**: Implement all five interface methods against MS Graph `/me/calendars/{id}/events`. Reuse OAuth refresh logic from existing `lib/microsoft.mjs`. Normalize event shape.
- **Acceptance**: Manual test creates an event in Outlook from a Node REPL. Field mapping (subject↔summary, body↔description, start.dateTime↔start) is documented.
- **Effort**: 4 hr · **Dependencies**: T3.5.1

### T3.5.4 — ICS read-only client 🟦

- **Files**: new `lib/providers/ics.mjs`
- **Scope**: Implement `listEvents` (only). Fetch from stored encrypted URL, parse with `ical.js` or a minimal parser, normalize event shape. Cache parse result in `kv_cache` for 15 min. `createEvent`/`updateEvent`/`deleteEvent` throw "ICS is read-only".
- **Acceptance**: An ICS feed shows up as readable events. Cache hits under 15min.
- **Effort**: 3 hr · **Dependencies**: T3.5.1, dependency check before adding `ical.js`

### T3.5.5 — Sync engine refactor 🟦

- **Files**: `lib/sync-engine.mjs`
- **Scope**: Replace direct Google calls with `getProviderClient(sourceProvider).listEvents(...)` + `getProviderClient(targetProvider).createEvent(...)`. Source can be Google/MS/ICS. Target can be Google/MS (not ICS).
- **Acceptance**: Outlook→Google sync works. ICS→Google sync works. Existing Google→Google still works.
- **Effort**: 3 hr · **Dependencies**: T3.5.2, T3.5.3, T3.5.4

### T3.5.6 — Update + delete propagation 🟦

- **Files**: `lib/sync-engine.mjs`
- **Scope**: When source event has changed (compare via etag/updated timestamp), call `updateEvent` on target. When source event is gone, call `deleteEvent` on synced target events. Track sync state via the existing `[MiCal Sync] Source: <id>` marker pattern.
- **Acceptance**: Edit a source event title → target reflects change on next sync. Delete source → target deleted.
- **Effort**: 4 hr · **Dependencies**: T3.5.5

### T3.5.7 — Wire `sync_runs` 🟦

- **Files**: `lib/sync-engine.mjs`
- **Scope**: At start of `runSyncFlow`, INSERT a row in `sync_runs` with `started_at`. At end, UPDATE with `finished_at`, `ok`, `totals_json`, `errors_json`.
- **Acceptance**: After cron run, `SELECT * FROM sync_runs` shows new rows.
- **Effort**: 1 hr · **Dependencies**: T3.5.5

### T3.5.8 — Surface run status in API 🟦

- **Files**: `api/sync-flows/index.mjs`, `api/calendars/index.mjs`
- **Scope**: Augment list responses with `last_run_at`, `last_run_ok`, `last_run_totals` derived from `sync_runs`. (No schema change.)
- **Acceptance**: Overview command center reads health from these.
- **Effort**: 1 hr · **Dependencies**: T3.5.7

---

## Phase 4 — Groups (Families & Teams)

### T4.0 — Groups schema 🟦

- **Files**: new `db/migrations/0002_groups.sql`
- **Scope**: Tables `groups`, `group_memberships`, `group_calendar_shares`, `group_receive_settings` per PLAN.md §6.3. Add `group_id` (nullable) to `sync_flows`, `event_types`, `bookings`. Add `last_viewed_bookings_at` to `users`.
- **Acceptance**: Migration applies cleanly to a fresh DB and to a populated dev DB.
- **Effort**: 1 hr · **Dependencies**: none

### T4.1 — Groups CRUD API 🟦

- **Files**: new `api/groups/*.mjs`
- **Scope**: `GET /api/groups`, `POST /api/groups`, `GET/PATCH/DELETE /api/groups/:id`. Owner-only for delete. Slug uniqueness check.
- **Acceptance**: Curl tests for happy path. Auth required on all routes.
- **Effort**: 3 hr · **Dependencies**: T4.0

### T4.2 — Membership + invite API 🟦

- **Files**: new `api/groups/[id]/members/*.mjs`, new `api/groups/[id]/invite.mjs`, `api/groups/[id]/join.mjs`
- **Scope**: Invite by email (creates pending membership). Accept (status → active). Remove (admin only). Roles: owner, admin, member.
- **Acceptance**: Two-user invite/accept flow tested manually.
- **Effort**: 3 hr · **Dependencies**: T4.1

### T4.3 — Sharer + receiver settings API 🟦

- **Files**: `api/groups/[id]/shares.mjs`, `api/groups/[id]/receive-settings.mjs`
- **Scope**: Sharer chooses which of their calendars to expose at what level (`full`/`free_busy`/`none`). Receiver chooses how each sharer's events show in their merged view + whether to push (and prefix, accept mode).
- **Acceptance**: Settings persist; merged view honors them.
- **Effort**: 4 hr · **Dependencies**: T4.0

### T4.4 — Group switcher (top bar) 🟦

- **Files**: `public/app/index.html`, `public/app/app.js`, `public/app/app.css`
- **Scope**: A dropdown in the top bar showing "Personal" + each group the user is a member of, with `+ Create Group` at the bottom. **Hidden entirely if user is in zero groups.** Selecting a group filters the dashboard to that group's context.
- **Acceptance**: User with no groups sees no switcher (per UX principle 2). User in a family sees a clean dropdown.
- **Effort**: 3 hr · **Dependencies**: T4.1

### T4.5 — Merged calendar view 🟦

- **Files**: new `public/app/views/merged.mjs` (or inline in app.js), new `api/groups/[id]/events.mjs`
- **Scope**: Week view showing all members' visible events in colored lanes. Click event → detail panel. Pull events live from each member's provider via `ProviderClient` (Phase 3.5 dependency).
- **Acceptance**: Family with 2 parents + 1 ICS school cal renders correctly. Event prefixes (`[Alex]`) appear. No flash of empty content.
- **Effort**: 8 hr · **Dependencies**: T3.5.5, T4.3

### T4.6 — Member management UI 🟦

- **Files**: new `public/app/views/group-settings.mjs`
- **Scope**: List members, invite, remove, change role. Per-member share/receive settings.
- **Acceptance**: Invite flow works end-to-end. UI is calm — uses cards and progressive disclosure, not 20 toggles in a row.
- **Effort**: 4 hr · **Dependencies**: T4.2, T4.3

### T4.7 — Cross-tenant sync flow 🟦

- **Files**: `lib/sync-engine.mjs`, `api/sync-flows/index.mjs`
- **Scope**: Allow `sync_flow.target_calendar_id` to belong to a different tenant when both are in the same group AND the target's `group_receive_settings.push_level` allows it. Apply prefix from receive settings.
- **Acceptance**: Alex creates a flow that pushes "[Alex]" busy blocks to Jordan's Outlook. Jordan sees them. Jordan toggles `push_level=none` and they stop appearing.
- **Effort**: 5 hr · **Dependencies**: T3.5.6, T4.3

### T4.8 — "Ask the family" availability widget 🟦

- **Files**: new `public/app/views/availability-check.mjs`, new `api/groups/[id]/availability.mjs`
- **Scope**: Form: what + when + duration. Server checks availability across all members. Returns "all free" / "X has conflict" / suggestions. NO push needed in v1 — just answer the question.
- **Acceptance**: "Dinner with Smiths May 15 6pm 2h" returns yes/no. Visible on group home.
- **Effort**: 3 hr · **Dependencies**: T3.5.5, T4.3

---

## Phase 5 — Polish & Launch

### T5.1 — Landing page family/team copy 🟦

- **Files**: `public/index.html`, `public/style.css`
- **Scope**: New section: "For families. For teams." With the dinner scenario as illustrated copy.
- **Effort**: 2 hr · **Dependencies**: T4.5 visible

### T5.2 — Onboarding flow 🟦

- **Files**: `public/app/onboarding.mjs`
- **Scope**: First-run wizard: connect first calendar → optionally create or join a group. Skip-able. Don't show again once first calendar exists.
- **Effort**: 4 hr · **Dependencies**: T4.1

### T5.3 — Empty states 🟦

- **Files**: `public/app/app.js`, `public/app/app.css`
- **Scope**: Audit every empty state. Each should have an SVG illustration + headline + one action button.
- **Effort**: 3 hr · **Dependencies**: T1.2

### T5.4 — Performance pass 🟦

- **Scope**: Test with 5 calendars, 3 group members, 30-day window. Identify N+1 queries. Add indices where needed. Cache provider responses.
- **Effort**: 4 hr · **Dependencies**: T4.5

---

## Quick start order (recommended)

**Day 1**: Run T1.1, T1.3, T1.4, T1.5 in parallel (all small, independent). Ship.
**Day 2**: T1.2 (icons), T1.6 (toasts), T3.5.1 (provider interface).
**Day 3**: T3.5.2 + T3.5.3 + T3.5.4 in parallel (3 separate provider implementations).
**Day 4**: T3.5.5 (sync engine refactor) + T3.5.7 (sync_runs wiring).
**Day 5**: T2.2 (Overview command center) — now possible because sync_runs is live.
**Day 6+**: T2.3, T3.1, then T4.0 onwards.

---

## Open product decisions (block schema work)

These need answers before T4.0 ships:

- **Billing**: Per-user, per-group, or family plan? Affects landing copy + schema.
- **Group size limits**: Soft cap? Hard cap? Affects pricing tier design.
- **Conflict resolution in merged view**: Visual only, or block creation?
- **Notifications**: Email + in-app? Push? Affects new `notifications` table.

Park these in a decisions log; revisit before Phase 4 starts.
