# MiCal UX & Product Plan

> Synthesized from two UX expert skill audits + product vision discussion.
> Created: 2026-05-09
> Status: Planning — ready for implementation sprint

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [User Research: The Family Use Case](#2-user-research-the-family-use-case)
3. [UX Audit Findings (Combined)](#3-ux-audit-findings-combined)
4. [Product Vision: Teams & Families](#4-product-vision-teams--families)
5. [Priority Roadmap](#5-priority-roadmap)
6. [Design Specs by Phase](#6-design-specs-by-phase)
7. [Data Model Changes](#7-data-model-changes)
8. [API Changes](#8-api-changes)
9. [Open Questions](#9-open-questions)

---

## 1. Executive Summary

MiCal is a calendar bridge that connects Google Calendar, Outlook, and ICS feeds into one synchronized system. Currently it serves individual professionals. The key unlock is expanding into **shared contexts** — families and teams — where multiple people's calendars must be visible to each other, with configurable sync rules.

The core insight: *nobody in the industry solves cross-platform family calendar sharing well*. Google Family Sharing requires everyone on Google. Outlook families require everyone on Microsoft. MiCal's cross-provider architecture makes it uniquely positioned to own this use case.

This plan covers:
- Critical UX fixes from two expert audits
- The family/team use case fully spec'd
- A phased build roadmap

---

## 2. User Research: The Family Use Case

### 2.1 The Scenario

**The Anderson Family**
- **Parent A (Alex)**: Consultant, works with 5 companies. Uses Google Workspace for personal, Outlook for Client A, another Google for Client B.
- **Parent B (Jordan)**: Marketing director. Uses Outlook for work, Google personal.
- **Kid 1**: Soccer team calendar (ICS feed from league website).
- **Kid 2**: School calendar (ICS feed from school website).
- **Friend**: "Can you come over on the 15th for dinner?"

**The Pain**: Alex can't answer immediately. Jordan's work Outlook isn't visible. The kids' calendars are buried in ICS feeds Alex subscribed to in their own Google, but Jordan doesn't see them. Alex texts Jordan. Jordan is in a meeting. Two hours later Jordan replies. The window closes.

**The Dream**: Alex opens MiCal, sees the merged family view, and says "Yes, we're free" with confidence.

### 2.2 The Alexa Use Case (Alex's Story)

Alex has an Amazon Echo in the kitchen. "Alexa, what's on my calendar today?" Alexa reads Alex's personal Google calendar. But Alex's work events live in 5 different workspaces.

Alex configures MiCal: *"Push all events from all my work calendars to my personal Gmail calendar, with full detail, so Alexa can read them."*

### 2.3 The Consultant Use Case (Alex's Work Story)

Alex works for 5 companies. Each has their own Google Workspace or Office 365. Alex wants to:
1. See ALL events in ONE calendar (their personal Google)
2. Push "busy" blocks BACK to each company's calendar so they don't get double-booked
3. Occasionally push full event details (with a `[Client A]` prefix) so meeting prep links are available

---

## 3. UX Audit Findings (Combined)

### 3.1 Critical (Fix Before Release)

| # | Finding | Source Skill | Impact |
|---|---------|-------------|--------|
| C1 | **Landing page mobile nav is broken** — links vanish at ≤640px with no hamburger menu | UI/UX Pro Max | Mobile users cannot sign up |
| C2 | **Event Types form uses programmer concepts** — "Weekdays Mask" (bitmask 31) and "Work Hours JSON" | UX Expert | Users cannot create event types without programming knowledge |

### 3.2 Major (Fix in Current Sprint)

| # | Finding | Source Skill | Impact |
|---|---------|-------------|--------|
| M1 | **Overview tab is decorative, not actionable** — stats show counts, not health/status | UX Expert | Users land on a page that answers no questions |
| M2 | **No system health indicators** — no "last synced", "last run", or sync status anywhere | UX Expert | Users can't tell if sync is working |
| M3 | **Calendars tab conflates 3 mental models** — account linking, calendar curation, ICS addition | UX Expert | Users must hunt for the right action |
| M4 | **Event Types form has 10+ ungrouped fields** | UX Expert | Overwhelming cognitive load |
| M5 | **Stats cards show isolated numbers** — "3 sync flows" without context | UX Expert | Numbers are meaningless without status |
| M6 | **Sidebar nav gives equal weight to all tabs** | UX Expert | No visual signal for primary vs. secondary |
| M7 | **Emoji icons throughout** — landing page cards, dashboard sidebar, ICS badge | UI/UX Pro Max | Looks unprofessional, breaks on some systems |
| M8 | **No cursor feedback on interactive elements** — tables, cards, preview items | UI/UX Pro Max | Users don't know what's clickable |

### 3.3 Minor / Polish

| # | Finding | Source Skill |
|---|---------|-------------|
| m1 | Tables lack hover row highlighting | UX Expert |
| m2 | ICS feed form always visible on Calendars tab | UX Expert |
| m3 | "Order" column in Sync Flows unexplained | UX Expert |
| m4 | No keyboard shortcuts for power users | UX Expert |
| m5 | Success banners are inline DOM hacks with manual close | UI/UX Pro Max |
| m6 | Toggle switch "off" state is generic gray (#ccc) | UI/UX Pro Max |
| m7 | Dashboard sidebar has no active indicator beyond text color | UI/UX Pro Max |

---

## 4. Product Vision: Teams & Families

### 4.1 Core Concept: The "Group"

A **Group** is a shared calendar context. It has:
- A name ("The Andersons", "Client A Team")
- A type: `family` or `team` (affects default settings, copy, and empty states)
- Members (users who can see each other's calendars)
- A "core" calendar per member (the one calendar they want everything synced TO)
- Sync rules between members' calendars
- Booking pages scoped to the group

**Key insight**: Family and Team are the *same feature* with different defaults and copy. A user can be in multiple groups (family + multiple teams).

### 4.2 The User Model

```
User (Alex)
├── Personal Tenant (existing)
│   ├── Own calendars (Google personal, Outlook personal)
│   └── Own sync flows
│
├── Group: "The Andersons" (type: family)
│   ├── Role: member
│   ├── Core calendar: Google personal
│   ├── Can see: Jordan's Outlook work, Kid 1 soccer, Kid 2 school
│   ├── Can push to: Jordan's Outlook work (busy only, with [Alex] prefix)
│   └── Group booking page: "Book time with the Andersons"
│
├── Group: "Client A Team" (type: team)
│   ├── Role: member
│   ├── Core calendar: Google personal
│   ├── Can see: teammate calendars
│   └── Can push to: team calendar (full detail)
│
└── Group: "Client B Team" (type: team)
    └── ...
```

### 4.3 Visibility Levels (Receiver Configures)

When Alex joins a group and shares calendars, Jordan (the receiver) configures:

| Setting | Options | Default (Family) | Default (Team) |
|---------|---------|-----------------|----------------|
| **What they see** | Full detail · Free/busy only · Nothing | Full detail | Free/busy |
| **What gets pushed** | Full detail · Busy only · Nothing | Full detail | Busy only |
| **Event prefix** | Custom text (e.g., "[Alex] ") | "[Alex] " | "[Alex · Client A] " |
| **Acceptance mode** | Auto-accept · Invite (must accept) · Block | Auto-accept | Invite |

**The prefix prevents "who put this on my calendar?"**

### 4.4 The Merged View

When Alex opens MiCal and selects "The Andersons" group:

```
┌─────────────────────────────────────────────────────────────┐
│  The Andersons · Family                        [Switch ▾]   │
├─────────────────────────────────────────────────────────────┤
│  Today · May 15                                             │
│                                                             │
│  07:00  ├─ [Alex] Gym                                       │
│  09:00  ├─ [Jordan] Standup (Outlook)                       │
│  10:00  ├─ Alex · Client A kickoff                          │
│  12:00  ├─ [Kid 2] School play (early dismissal)            │
│  14:00  ├─ [Kid 1] Soccer practice                          │
│  15:00  ├─ Alex · Client B review                           │
│  18:00  ├─ [Jordan] Dinner with Smiths ← CONFIDENCE         │
│  20:00  ├─ [Alex] Date night                                │
│                                                             │
│  [+] Ask the family: "Can we do dinner with Smiths on 15th?"│
└─────────────────────────────────────────────────────────────┘
```

Alex sees Jordan's 6pm dinner. Alex can answer immediately.

### 4.5 The Alexa Use Case (Push to Core)

Alex configures: *"Push all events from all my calendars to my personal Gmail calendar."*

This is just a sync flow:
- Source: All of Alex's calendars (work + personal)
- Target: Alex's personal Gmail calendar
- Rule: Copy full detail
- Result: Alexa reads one calendar, sees everything

### 4.6 The Consultant Use Case (Busy Pushback)

Alex configures for Client A:
- Source: Alex's personal calendar
- Target: Client A's shared team calendar
- Rule: Push busy blocks only (no titles), prefix "[Alex · Busy]"
- Result: Client A sees Alex is unavailable, but not why

---

## 5. Priority Roadmap

### Phase 1: Foundation (Week 1)
Fix critical UX issues. No new features.

| # | Task | Effort |
|---|------|--------|
| P1.1 | Fix landing page mobile hamburger nav | Small |
| P1.2 | Replace emoji icons with SVG/CSS icons | Medium |
| P1.3 | Add `cursor: pointer` and hover states to interactive elements | Small |
| P1.4 | Replace Event Types "Weekdays Mask" with 7 checkboxes | Small |
| P1.5 | Replace Event Types "Work Hours JSON" with time inputs | Small |
| P1.6 | Auto-dismissing toast notifications (replace inline banners) | Medium |

### Phase 2: Dashboard Health (Week 2)
Make the dashboard useful.

| # | Task | Effort |
|---|------|--------|
| P2.1 | Add `last_synced_at` to calendars, `last_run_at` + `last_run_status` to sync_flows | Small |
| P2.2 | Redesign Overview tab as command center (status cards + activity feed) | Medium |
| P2.3 | Add hover row highlighting to all tables | Small |
| P2.4 | Improve sidebar active state (left border indicator) | Small |
| P2.5 | Restructure Calendars tab by account (grouped table) | Medium |
| P2.6 | Move ICS feed form behind "Add Manual Feed" button | Small |

### Phase 3: Forms & Flows (Week 3)
Polish the creation flows.

| # | Task | Effort |
|---|------|--------|
| P3.1 | Progressive disclosure for Event Types form (Essential + Advanced) | Medium |
| P3.2 | Clarify "Order" column in Sync Flows (rename or tooltip) | Small |
| P3.3 | Add booking count badge to sidebar nav | Small |
| P3.4 | Add keyboard shortcuts for power users | Small |

### Phase 4: Groups (Week 4–5)
The big feature: families and teams.

| # | Task | Effort |
|---|------|--------|
| P4.1 | Database: `groups`, `group_memberships`, `group_calendar_shares` tables | Medium |
| P4.2 | API: CRUD for groups, invite members, accept/reject | Medium |
| P4.3 | API: Visibility settings (what I see of you, what you push to me) | Medium |
| P4.4 | Dashboard: Group switcher (sidebar or top bar) | Medium |
| P4.5 | Dashboard: Merged calendar view for a group | Large |
| P4.6 | Dashboard: Member management (invite, roles, visibility settings) | Medium |
| P4.7 | Sync engine: Support cross-tenant sync flows (push to member's calendar) | Large |
| P4.8 | Dashboard: "Ask the family" quick poll | Medium |

### Phase 5: Polish & Launch (Week 6)

| # | Task | Effort |
|---|------|--------|
| P5.1 | Landing page: Add family/team use case to messaging | Small |
| P5.2 | Landing page: Family testimonial / scenario | Small |
| P5.3 | Onboarding: Group creation flow for new users | Medium |
| P5.4 | Empty states: Family-specific illustrations and copy | Medium |
| P5.5 | Performance: Test with 5+ calendars, 3+ members | Medium |

---

## 6. Design Specs by Phase

### 6.1 Phase 1: Critical Fixes

#### P1.2 — Replace Emoji Icons

**Landing page cards**: Replace emoji with inline SVG icons.

```html
<!-- Before -->
<div class="icon">🔄</div>

<!-- After -->
<div class="icon">
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
    <path d="M3 3v5h5"/>
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
    <path d="M16 16h5v5"/>
  </svg>
</div>
```

**Dashboard sidebar**: Replace emoji nav icons with CSS-generated or SVG icons.

**ICS provider badge**: Replace `📅` with a simple calendar SVG.

#### P1.4 — Weekdays as Checkboxes

```html
<div class="weekdays-group">
  <label class="weekday-check">
    <input type="checkbox" checked> Mon
  </label>
  <label class="weekday-check">
    <input type="checkbox" checked> Tue
  </label>
  <!-- ... -->
</div>
```

Client-side: compute bitmask from checked boxes. Server-side: accept either bitmask or array.

#### P1.5 — Work Hours as Time Inputs

```html
<div class="work-hours-group">
  <input type="time" value="09:00">
  <span>to</span>
  <input type="time" value="17:00">
</div>
```

Client-side: JSON-stringify for API. Server-side: accept JSON or `{start, end}` object.

---

### 6.2 Phase 2: Dashboard Health

#### P2.2 — Overview as Command Center

**ASCII wireframe:**

```
┌─────────────────────────────────────────────────────────────┐
│  MiCal Dashboard                              [Alex ▾]      │
├─────────────────────────────────────────────────────────────┤
│  SYSTEM HEALTH                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────┐ │
│  │ Calendars  │  │ Sync Flows │  │ Event Types│  │Booking │ │
│  │     5      │  │     3      │  │     2      │  │   12   │ │
│  │ ✓ Healthy  │  │ ⚠ 1 stale  │  │ —          │  │ 2 new  │ │
│  └────────────┘  └────────────┘  └────────────┘  └────────┘ │
├─────────────────────────────────────────────────────────────┤
│  RECENT ACTIVITY                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ • 2 min ago  ·  Sync "Work→Personal" ran  ·  4 events │   │
│  │ • 1 hr ago   ·  New booking: "30min Meeting"         │   │
│  │ • 3 hr ago   ·  Google account re-authorized         │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  NEEDS ATTENTION                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ⚠  Sync flow "Outlook→Google" hasn't run in 3 days   │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  QUICK ACTIONS                                              │
│  [+ Add Calendar]  [+ Create Sync Flow]  [+ New Event Type] │
└─────────────────────────────────────────────────────────────┘
```

**Health rules:**
- **Healthy**: Last sync/run within 24h
- **Stale**: Last sync/run > 24h but < 7 days
- **Warning**: Last sync/run > 7 days or last run had errors
- **Error**: Last run failed

**"New" badge on Bookings**: Count of bookings created since last view (track `last_viewed_at` on user).

#### P2.5 — Calendars by Account

**ASCII wireframe:**

```
┌─────────────────────────────────────────────────────────────┐
│  Connected Accounts                           [+ Add Account]│
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐   │
│  │  G  alex@gmail.com                     [Disconnect]   │   │
│  │                                                       │   │
│  │  ☑ Work Calendar (Primary)              [Settings ⚙] │   │
│  │  ☑ Personal Calendar                    [Settings ⚙] │   │
│  │  ☐ Team Calendar (read-only)            [Settings ⚙] │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  M  alex@client-a.com                  [Disconnect]   │   │
│  │                                                       │   │
│  │  ☑ Outlook Calendar                     [Settings ⚙] │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Other Feeds                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ☑ Soccer Team ICS                      [Settings ⚙] │   │
│  │  ☑ Lincoln Elementary                   [Settings ⚙] │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  [+ Add Manual ICS Feed]                                    │
└─────────────────────────────────────────────────────────────┘
```

---

### 6.3 Phase 4: Groups (Families & Teams)

#### P4.1 — Database Schema

```sql
-- Groups table
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('family', 'team')),
  description TEXT,
  avatar_url TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Group memberships
CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'removed')),
  invited_by_user_id TEXT REFERENCES users(id),
  joined_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);

-- What calendars I share with this group
CREATE TABLE group_calendar_shares (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  share_level TEXT NOT NULL DEFAULT 'full' CHECK(share_level IN ('full', 'free_busy', 'none')),
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id, calendar_id)
);

-- What I receive from other members (receiver config)
CREATE TABLE group_receive_settings (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  receiver_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sharer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receive_level TEXT NOT NULL DEFAULT 'full' CHECK(receive_level IN ('full', 'free_busy', 'none')),
  push_level TEXT NOT NULL DEFAULT 'none' CHECK(push_level IN ('full', 'busy_only', 'none')),
  event_prefix TEXT,
  acceptance_mode TEXT NOT NULL DEFAULT 'auto' CHECK(acceptance_mode IN ('auto', 'invite', 'block')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(group_id, receiver_user_id, sharer_user_id)
);
```

#### P4.4 — Group Switcher

**In sidebar (desktop) or top bar (mobile):**

```
┌──────────────────────────────┐
│  MiCal                       │
│  ┌────────────────────────┐  │
│  │ 👤 Personal      ▾     │  │  ← When no group selected
│  │ 👨‍👩‍👧 The Andersons       │  │
│  │ 👥 Client A Team       │  │
│  │ + Create Group         │  │
│  └────────────────────────┘  │
│                              │
│  [🏠 Overview]               │
│  [📅 Calendars]              │
│  ...                         │
└──────────────────────────────┘
```

**Top bar when in a group:**

```
┌─────────────────────────────────────────────────────────────┐
│  ☰  The Andersons · Family              [Alex ▾]  [⚙]     │
└─────────────────────────────────────────────────────────────┘
```

#### P4.5 — Merged Calendar View

When viewing a group, the main content becomes a calendar view (week or month) showing all members' events.

```
┌─────────────────────────────────────────────────────────────┐
│  The Andersons · Family                        [Week ▾]     │
├─────────────────────────────────────────────────────────────┤
│           Alex      Jordan      Kid 1      Kid 2            │
│  Mon 12                                                            │
│  ├─ 09:00  Work mtg  Standup     ──        School           │
│  ├─ 12:00  Lunch     ──          ──        ──              │
│  ├─ 15:00  ──        Client call Soccer     ──              │
│  └─ 18:00  Gym       ──          ──        ──              │
│                                                              │
│  Tue 13                                                            │
│  ├─ 09:00  ──        Standup     ──        ──              │
│  └─ 14:00  ──        ──          ──        Field trip       │
│                                                              │
│  [◀ Prev]  [Today]  [Next ▶]                                │
└─────────────────────────────────────────────────────────────┘
```

Color coding by member. Clicking an event shows detail panel.

**"Ask the family" button**: Opens a quick form:

```
┌─────────────────────────────────┐
│  Ask The Andersons              │
├─────────────────────────────────┤
│  What: [Dinner with Smiths    ] │
│  When: [May 15 · 6:00 PM ▾]   │
│  Duration: [2] hours            │
│                                  │
│  [Check Availability]           │
│                                  │
│  Result: ✅ All free            │
│  [Send to Family]               │
└─────────────────────────────────┘
```

#### P4.7 — Cross-Tenant Sync Flows

A sync flow where source and target are in different tenants (group members):

```
Source: Alex's Google · Work Calendar
Target: Jordan's Outlook · Work Calendar
Rule: Push busy blocks only
Prefix: [Alex]
Acceptance: Auto-accept
```

Implementation: The sync engine needs to:
1. Read from Alex's calendar (Alex's OAuth token)
2. Write to Jordan's calendar (Jordan's OAuth token)
3. Apply prefix and visibility rules

This is the same sync engine, but the target calendar belongs to a different user/tenant.

---

## 7. Data Model Changes

### New Tables

1. `groups` — group definition
2. `group_memberships` — who is in which group
3. `group_calendar_shares` — which calendars a user shares with a group
4. `group_receive_settings` — how a user receives events from another group member
5. `group_invites` — pending invitations (optional, can reuse memberships with `status='pending'`)

### Modified Tables

1. `calendars` — add `group_id` (nullable, for group-level calendars?)
2. `sync_flows` — add `group_id` (nullable, for cross-member flows)
3. `event_types` — add `group_id` (nullable, for group booking pages)
4. `bookings` — add `group_id` (nullable)
5. `users` — add `last_viewed_bookings_at` (for "new" badge count)

---

## 8. API Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/groups` | List my groups |
| POST | `/api/groups` | Create a group |
| GET | `/api/groups/:id` | Get group details |
| PATCH | `/api/groups/:id` | Update group |
| DELETE | `/api/groups/:id` | Delete group (owner only) |
| POST | `/api/groups/:id/invite` | Invite user by email |
| POST | `/api/groups/:id/join` | Accept invitation |
| DELETE | `/api/groups/:id/members/:userId` | Remove member |
| GET | `/api/groups/:id/calendars` | List shared calendars in group |
| GET | `/api/groups/:id/availability` | Check group availability for a time range |
| POST | `/api/groups/:id/poll` | Create an "ask the family" poll |

### Modified Endpoints

| Method | Path | Change |
|--------|------|--------|
| GET | `/api/auth/me` | Include `groups` array in response |
| GET | `/api/calendars` | Accept `?group_id=` parameter |
| POST | `/api/sync-flows` | Accept `group_id` for cross-member flows |
| GET | `/api/sync-flows` | Include group-scoped flows |
| POST | `/api/event-types` | Accept `group_id` for group booking pages |

---

## 9. Open Questions

1. **Billing**: Do groups need separate billing, or is it per-user? A family of 4 — does each member pay, or is there a family plan?
2. **Group limits**: How many groups can a user be in? How many members per group?
3. **Guest access**: Can non-members view a group's merged calendar (e.g., a grandparent who just wants to see when the kids have events)?
4. **Mobile app**: The merged calendar view would be especially useful on mobile. Is there a PWA or native app plan?
5. **Real-time sync**: Should group calendar changes push via WebSocket/SSE, or is polling sufficient?
6. **Conflict resolution**: If two members schedule conflicting events on the group, who wins?
7. **Notifications**: Email? Push? In-app? For what events (new booking, sync failure, poll response)?

---

## Appendix: Copy Guidelines

Use **family** or **team** language based on group type. Never generic "group" in user-facing copy.

| Context | Family Copy | Team Copy |
|---------|------------|-----------|
| Create flow | "Create a Family" | "Create a Team" |
| Invite | "Invite your partner" | "Invite a teammate" |
| Share calendars | "Share calendars with family" | "Share calendars with team" |
| Merged view | "Family Schedule" | "Team Schedule" |
| Booking page | "Let friends book time with your family" | "Let clients book time with your team" |
| Poll | "Ask the family" | "Check team availability" |
| Prefix default | "[Alex] " | "[Alex · Client A] " |

---

*End of plan. Ready for implementation sprint.*
