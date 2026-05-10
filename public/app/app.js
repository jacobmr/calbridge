/* MiCal Dashboard App */

// ─── State ───
let currentUser = null;
let currentTab = "overview";
let calendars = [];
let syncFlows = [];
let eventTypes = [];
let bookings = [];
let editingEventTypeId = null;
let editingSyncFlowId = null;

// ─── Helpers ───
function $(sel) {
  return document.querySelector(sel);
}
function $$(sel) {
  return document.querySelectorAll(sel);
}

// ─── Icons (Lucide-style stroke SVG, 24x24, currentColor) ───
const ICONS = {
  home: '<path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5z"/>',
  calendar:
    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>',
  sync: '<path d="M21 12a9 9 0 0 0-15.7-6"/><path d="M3 4v5h5"/><path d="M3 12a9 9 0 0 0 15.7 6"/><path d="M21 20v-5h-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  book: '<path d="M4 4.5v15a1.5 1.5 0 0 0 1.5 1.5H20V3H6.5A2.5 2.5 0 0 0 4 5.5v0z"/><path d="M8 7h9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  arrowRight: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  empty:
    '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9 15c.5-.7 1.7-1 3-1s2.5.3 3 1"/>',
};

function icon(name, size = 18) {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="icon icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function formatDate(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name, email) {
  const str = name || email || "?";
  const parts = str.split(" ").filter(Boolean);
  if (parts.length > 1)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return str.slice(0, 2).toUpperCase();
}

// ─── Toast notifications ───
// Top-right stack. Auto-dismiss: 4s success, 8s error. Closeable.
function ensureToastStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function showToast(msg, type = "info") {
  const stack = ensureToastStack();
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  const span = document.createElement("span");
  span.className = "toast-msg";
  span.textContent = String(msg);
  const btn = document.createElement("button");
  btn.className = "toast-close";
  btn.setAttribute("aria-label", "Dismiss");
  btn.textContent = "×";
  btn.addEventListener("click", () => dismissToast(el));
  el.appendChild(span);
  el.appendChild(btn);
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast-in"));
  const timeout = type === "error" ? 8000 : 4000;
  el._dismissTimer = setTimeout(() => dismissToast(el), timeout);
  return el;
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  if (el._dismissTimer) clearTimeout(el._dismissTimer);
  el.classList.remove("toast-in");
  el.classList.add("toast-out");
  setTimeout(() => el.remove(), 200);
}

function showSuccess(msg) {
  return showToast(msg, "success");
}
function showError(msg /*, container (kept for backwards-compat) */) {
  return showToast(msg, "error");
}
// No-op now that errors are non-blocking toasts; kept callable for existing code paths.
function clearErrors(/* container */) {}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function providerIcon(provider) {
  const p = String(provider).toLowerCase();
  if (p === "google") return '<span class="provider-google"></span>';
  if (p === "microsoft" || p === "outlook" || p === "live")
    return '<span class="provider-microsoft"></span>';
  return '<span class="provider-ics"></span>';
}

function calendarLabel(id) {
  const cal = calendars.find((c) => c.id === id);
  return cal
    ? `${escapeHtml(cal.label)} (${providerName(cal.provider)})`
    : escapeHtml(id);
}

function providerName(provider) {
  const p = String(provider).toLowerCase();
  if (p === "google") return "Google Calendar";
  if (p === "microsoft" || p === "outlook" || p === "live") return "Outlook";
  if (p === "ics") return "ICS Feed";
  return escapeHtml(provider);
}

function statusBadge(status) {
  const s = String(status).toLowerCase();
  if (s === "confirmed")
    return '<span class="badge badge-success">Confirmed</span>';
  if (s === "cancelled")
    return '<span class="badge badge-danger">Cancelled</span>';
  if (s === "pending")
    return '<span class="badge badge-warning">Pending</span>';
  return `<span class="badge badge-info">${escapeHtml(status)}</span>`;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  if (res.status === 401) {
    const returnTo = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = "/login";
    throw new Error("unauthorized");
  }

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 204) {
    data = null;
  } else if (contentType.includes("application/json")) {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } else {
    const text = await res.text();
    data = { error: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

// ─── Navigation ───
//
// Hide tabs that don't yet apply to the user's state (UX principle 2).
//   * 0 calendars → only Overview + Calendars visible
//   * ≥1 calendar → Sync Flows + Event Types appear
//   * ≥1 event type → Bookings appears
// Bookings count badge appears when bookingsNew > 0.
function applyNavVisibility(counts) {
  if (!counts) return;
  const show = {
    overview: true,
    calendars: true,
    "sync-flows": counts.calendars > 0,
    "event-types": counts.calendars > 0,
    bookings: counts.eventTypes > 0 || counts.bookings > 0,
  };
  $$(".nav-item").forEach((btn) => {
    const t = btn.dataset.tab;
    btn.style.display = show[t] === false ? "none" : "";
  });

  // Bookings "new" badge (purely informational)
  const bookingsBtn = document.querySelector('.nav-item[data-tab="bookings"]');
  if (bookingsBtn) {
    let badge = bookingsBtn.querySelector(".nav-badge");
    if (counts.bookingsNew > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-badge";
        bookingsBtn.appendChild(badge);
      }
      badge.textContent = String(counts.bookingsNew);
    } else if (badge) {
      badge.remove();
    }
  }
}

function showTab(tab) {
  currentTab = tab;

  // Update nav active state
  $$(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  // Hide all pages
  $$(".tab-page").forEach((page) => (page.style.display = "none"));

  // Show selected page
  const page = $(`#tab-${tab}`);
  if (page) page.style.display = "block";

  // Update page title
  const titles = {
    overview: "Dashboard",
    calendars: "Calendars",
    "sync-flows": "Sync Flows",
    "event-types": "Event Types",
    bookings: "Bookings",
  };
  const titleEl = $("#page-title");
  if (titleEl) titleEl.textContent = titles[tab] || "Dashboard";

  // Close mobile sidebar
  $(".sidebar").classList.remove("open");
  $(".sidebar-overlay").classList.remove("open");

  // Load data
  if (tab === "overview") loadOverview();
  if (tab === "calendars") loadCalendars();
  if (tab === "sync-flows") loadSyncFlows();
  if (tab === "event-types") loadEventTypes();
  if (tab === "bookings") loadBookings();
}

// ─── Overview / Command Center ───
async function loadOverview() {
  const container = $("#overview-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading…</div>';

  try {
    const [me, overview] = await Promise.all([
      api("/api/auth/me"),
      api("/api/overview"),
    ]);
    currentUser = me;
    renderUserInfo();
    applyNavVisibility(overview?.counts);
    renderOverview(overview);
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderUserInfo() {
  if (!currentUser) return;
  const name =
    currentUser.display_name || currentUser.email?.split("@")[0] || "User";
  const email = currentUser.email || "";
  $("#user-name").textContent = name;
  $("#user-email").textContent = email;
  $("#user-avatar").textContent = getInitials(name, email);
}

// Format ms-since-epoch as a relative phrase ("2 min ago", "3 hr ago", "May 4")
function relTime(ms) {
  if (ms == null) return "";
  const diff = Date.now() - Number(ms);
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000)
    return `${Math.floor(diff / (60 * 60_000))} hr ago`;
  if (diff < 7 * 24 * 60 * 60_000)
    return `${Math.floor(diff / (24 * 60 * 60_000))} d ago`;
  return new Date(Number(ms)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Build a single status card. `count` is required; `health` is one of
// "healthy" | "stale" | "warning" | "error" | "neverRun" | null.
function statusCard({ label, count, health, hint, onClick }) {
  let pill = "";
  if (health === "healthy")
    pill = `<span class="health-pill health-healthy">${icon("check", 12)} Healthy</span>`;
  else if (health === "stale")
    pill = `<span class="health-pill health-stale">Stale</span>`;
  else if (health === "warning")
    pill = `<span class="health-pill health-warning">Needs attention</span>`;
  else if (health === "error")
    pill = `<span class="health-pill health-error">Error</span>`;
  else if (health === "neverRun")
    pill = `<span class="health-pill health-muted">Never run</span>`;
  else if (hint)
    pill = `<span class="health-pill health-muted">${escapeHtml(hint)}</span>`;
  else pill = `<span class="health-pill health-muted">—</span>`;

  const onClickAttr = onClick ? `onclick="${onClick}"` : "";
  const cls = onClick ? "stat-card clickable" : "stat-card";
  return `
    <div class="${cls}" ${onClickAttr}>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${Number(count) || 0}</div>
      <div class="stat-pill-row">${pill}</div>
    </div>
  `;
}

// Pick the dominant health bucket for the Sync Flows card from a syncHealth
// breakdown. Order matters: error > warning > neverRun > stale > healthy.
function dominantSyncHealth(h) {
  if (!h) return null;
  if (h.error > 0) return "error";
  if (h.warning > 0) return "warning";
  if (h.healthy > 0) return "healthy";
  if (h.stale > 0) return "stale";
  if (h.neverRun > 0) return "neverRun";
  return null;
}

function renderActivityItem(item) {
  if (item.kind === "sync_run") {
    const totals = item.totals || {};
    const dot = item.ok ? "activity-ok" : "activity-err";
    const label = `${item.source || "?"} → ${item.target || "?"}`;
    const detail = item.ok
      ? `${totals.created || 0} created · ${totals.skipped || 0} skipped`
      : `failed (${totals.errors || "?"} errors)`;
    return `
      <li class="activity-item">
        <span class="activity-dot ${dot}"></span>
        <span class="activity-when">${escapeHtml(relTime(item.at))}</span>
        <span class="activity-text"><strong>Sync</strong> ${escapeHtml(label)} · ${escapeHtml(detail)}</span>
      </li>
    `;
  }
  if (item.kind === "booking") {
    const subj = item.subject || item.eventTypeName || "Booking";
    return `
      <li class="activity-item">
        <span class="activity-dot activity-info"></span>
        <span class="activity-when">${escapeHtml(relTime(item.at))}</span>
        <span class="activity-text"><strong>New booking</strong> · ${escapeHtml(subj)}</span>
      </li>
    `;
  }
  return "";
}

function renderOverview(data) {
  const container = $("#overview-content");
  const c = data?.counts || {};
  const sh = data?.syncHealth || {};
  const recent = data?.recentActivity || [];
  const attention = data?.needsAttention || [];

  const calendarsHint = c.calendars === 0 ? "Add one to start" : null;
  const eventTypesHint = c.eventTypes === 0 ? "Optional" : null;
  const bookingsHint = c.bookingsNew > 0 ? `${c.bookingsNew} new` : null;

  // First-run empty state: zero calendars → big single CTA, hide the rest.
  if (c.calendars === 0) {
    container.innerHTML = `
      <div class="card empty-hero">
        <div class="empty-state-icon">${icon("calendar", 48)}</div>
        <h2>Connect your first calendar</h2>
        <p>MiCal needs at least one calendar before it can sync anything. Pick a provider to get started.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/api/oauth/google/init">Connect Google</a>
          <a class="btn btn-secondary" href="/api/oauth/microsoft/init">Connect Outlook</a>
          <button class="btn btn-secondary" onclick="showTab('calendars')">Or add an ICS feed</button>
        </div>
      </div>
    `;
    return;
  }

  const statusCards = [
    statusCard({
      label: "Calendars",
      count: c.calendars,
      health: c.calendars > 0 ? "healthy" : null,
      hint: calendarsHint,
      onClick: "showTab('calendars')",
    }),
    statusCard({
      label: "Sync Flows",
      count: c.syncFlows,
      health: c.syncFlows > 0 ? dominantSyncHealth(sh) : null,
      onClick: "showTab('sync-flows')",
    }),
    statusCard({
      label: "Event Types",
      count: c.eventTypes,
      health: null,
      hint: eventTypesHint,
      onClick: "showTab('event-types')",
    }),
    statusCard({
      label: "Bookings",
      count: c.bookings,
      health: null,
      hint: bookingsHint,
      onClick: "showTab('bookings')",
    }),
  ].join("");

  // "Needs attention" is hidden when empty — never a section just to say "all good"
  let attentionHtml = "";
  if (attention.length > 0) {
    attentionHtml = `
      <div class="card attention-card">
        <div class="card-header"><div class="card-title">Needs attention</div></div>
        <ul class="attention-list">
          ${attention
            .map((a) => {
              const ago = a.lastRunAt ? `${relTime(a.lastRunAt)}` : "never run";
              const sev = a.severity === "error" ? "error" : "warning";
              return `
                <li class="attention-item severity-${sev}" onclick="showTab('sync-flows')">
                  <span class="attention-icon">${icon(a.severity === "error" ? "trash" : "sync", 16)}</span>
                  <span class="attention-text">
                    <strong>${escapeHtml(a.source || "?")} → ${escapeHtml(a.target || "?")}</strong>
                    <span class="attention-detail">${a.severity === "error" ? "Last run failed" : "No recent runs"} · ${escapeHtml(ago)}</span>
                  </span>
                </li>
              `;
            })
            .join("")}
        </ul>
      </div>
    `;
  }

  let activityHtml = "";
  if (recent.length > 0) {
    activityHtml = `
      <div class="card">
        <div class="card-header"><div class="card-title">Recent activity</div></div>
        <ul class="activity-list">
          ${recent.map(renderActivityItem).join("")}
        </ul>
      </div>
    `;
  }

  // Quick actions: only show what's relevant given current state
  const quickActions = [];
  if (c.syncFlows === 0)
    quickActions.push(
      `<button class="btn btn-primary" onclick="showTab('sync-flows')">Create your first sync flow</button>`,
    );
  else
    quickActions.push(
      `<button class="btn btn-secondary" onclick="showTab('sync-flows')">Create sync flow</button>`,
    );
  quickActions.push(
    `<button class="btn btn-secondary" onclick="showTab('calendars')">Add calendar</button>`,
  );
  if (c.calendars > 0)
    quickActions.push(
      `<button class="btn btn-secondary" onclick="showTab('event-types')">${c.eventTypes === 0 ? "Set up booking page" : "New event type"}</button>`,
    );

  container.innerHTML = `
    <div class="stats-grid">${statusCards}</div>
    ${attentionHtml}
    ${activityHtml}
    <div class="card">
      <div class="card-header"><div class="card-title">Quick actions</div></div>
      <div class="quick-actions">${quickActions.join("")}</div>
    </div>
  `;
}

// ─── Calendars ───
async function loadCalendars() {
  const container = $("#calendars-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading calendars…</div>';

  try {
    calendars = await api("/api/calendars");
    renderCalendars();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load calendars: ${escapeHtml(err.message)}</div>`;
    }
  }
}

// Render a single calendar row inside an account section. Compact: label,
// role chip, enabled toggle, remove button. No provider column — context
// already provides that.
function renderCalendarRow(cal) {
  return `
    <div class="calendar-row" data-id="${escapeHtml(cal.id)}">
      <div class="calendar-row-main">
        <span class="calendar-label">${escapeHtml(cal.label)}</span>
        ${cal.role ? `<span class="calendar-role">${escapeHtml(cal.role)}</span>` : ""}
      </div>
      <div class="calendar-row-actions">
        <label class="toggle" title="${cal.enabled ? "Active" : "Disabled"}">
          <input type="checkbox" ${cal.enabled ? "checked" : ""} onchange="toggleCalendar('${escapeHtml(cal.id)}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button class="icon-btn danger" onclick="deleteCalendar('${escapeHtml(cal.id)}')" title="Remove this calendar">${icon("trash", 14)}</button>
      </div>
    </div>
  `;
}

function renderCalendars() {
  const container = $("#calendars-content");
  clearErrors(container);

  // Group: connected accounts (Google/Outlook) by oauth_account_id;
  // ICS feeds in their own section.
  const accountGroups = new Map(); // key = oauth_account_id
  const icsFeeds = [];
  for (const cal of calendars) {
    const provider = String(cal.provider).toLowerCase();
    if (provider === "ics") {
      icsFeeds.push(cal);
    } else if (cal.oauth_account_id) {
      if (!accountGroups.has(cal.oauth_account_id)) {
        accountGroups.set(cal.oauth_account_id, {
          accountId: cal.oauth_account_id,
          provider: cal.provider,
          email: cal.account_email || "Unknown account",
          calendars: [],
        });
      }
      accountGroups.get(cal.oauth_account_id).calendars.push(cal);
    }
  }

  // Empty state: no accounts AND no feeds
  if (accountGroups.size === 0 && icsFeeds.length === 0) {
    container.innerHTML = `
      <div class="card empty-hero">
        <div class="empty-state-icon">${icon("calendar", 48)}</div>
        <h2>Connect a calendar</h2>
        <p>Pick a provider to link your calendars, or add an ICS feed by URL.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/api/oauth/google/init">Connect Google</a>
          <a class="btn btn-secondary" href="/api/oauth/microsoft/init">Connect Outlook</a>
          <button class="btn btn-secondary" onclick="toggleIcsForm()">Add ICS feed</button>
        </div>
      </div>
      ${renderIcsForm({ initiallyHidden: true })}
    `;
    return;
  }

  const accountsHtml = [...accountGroups.values()]
    .map(
      (group) => `
        <section class="account-card" data-account-id="${escapeHtml(group.accountId)}">
          <header class="account-header">
            <span class="account-provider">${providerIcon(group.provider)}</span>
            <span class="account-email">${escapeHtml(group.email)}</span>
            <span class="account-meta">${group.calendars.length} calendar${group.calendars.length === 1 ? "" : "s"}</span>
          </header>
          <div class="calendar-rows">
            ${group.calendars.map(renderCalendarRow).join("")}
          </div>
        </section>
      `,
    )
    .join("");

  const icsHtml = icsFeeds.length
    ? `
        <section class="account-card">
          <header class="account-header">
            <span class="account-provider">${providerIcon("ics")}</span>
            <span class="account-email">Other feeds</span>
            <span class="account-meta">${icsFeeds.length} ICS feed${icsFeeds.length === 1 ? "" : "s"}</span>
          </header>
          <div class="calendar-rows">
            ${icsFeeds.map(renderCalendarRow).join("")}
          </div>
        </section>
      `
    : "";

  container.innerHTML = `
    <div class="account-toolbar">
      <div class="btn-group">
        <a class="btn btn-secondary btn-sm" href="/api/oauth/google/init">+ Google</a>
        <a class="btn btn-secondary btn-sm" href="/api/oauth/microsoft/init">+ Outlook</a>
        <button class="btn btn-primary btn-sm" onclick="discoverCalendars()">
          ${icon("search", 14)} Discover
        </button>
      </div>
    </div>
    ${accountsHtml}
    ${icsHtml}
    <div class="ics-add-row">
      <button class="btn btn-secondary btn-sm" onclick="toggleIcsForm()">
        ${icon("plus", 14)} Add ICS feed
      </button>
    </div>
    ${renderIcsForm({ initiallyHidden: true })}
  `;
}

// The ICS-feed form is collapsed by default; revealed via toggleIcsForm().
function renderIcsForm({ initiallyHidden = true } = {}) {
  return `
    <div class="card ics-form-card" id="ics-form-card" style="${initiallyHidden ? "display:none" : ""}">
      <div class="card-header">
        <div class="card-title">Add ICS feed</div>
        <button class="icon-btn" onclick="toggleIcsForm(false)" title="Close">×</button>
      </div>
      <form id="ics-form" onsubmit="handleIcsSubmit(event)">
        <div class="form-row">
          <div class="form-group">
            <label for="ics-label">Label</label>
            <input type="text" id="ics-label" placeholder="My team calendar" required>
          </div>
          <div class="form-group">
            <label for="ics-url">ICS URL</label>
            <input type="url" id="ics-url" placeholder="https://example.com/calendar.ics" required>
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Add feed</button>
      </form>
    </div>
  `;
}

function toggleIcsForm(force) {
  const card = $("#ics-form-card");
  if (!card) return;
  const isHidden = card.style.display === "none" || !card.style.display;
  const next = typeof force === "boolean" ? force : isHidden;
  card.style.display = next ? "" : "none";
  if (next) {
    const labelInput = $("#ics-label");
    if (labelInput) labelInput.focus();
  }
}

async function discoverCalendars() {
  openPreviewModal();
  const body = $("#preview-modal-body");
  body.innerHTML =
    '<div class="loading"><div class="spinner"></div>Discovering calendars…</div>';

  try {
    const data = await api("/api/calendars/preview");
    renderPreview(data.discovered || []);
  } catch (err) {
    if (err.message !== "unauthorized") {
      body.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }
}

function openPreviewModal() {
  $("#preview-modal").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closePreviewModal() {
  $("#preview-modal").classList.remove("open");
  document.body.style.overflow = "";
}

function renderPreview(discovered) {
  const body = $("#preview-modal-body");

  if (discovered.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon("search", 40)}</div>
        <h3>No calendars found</h3>
        <p>Make sure you have linked a Google or Outlook account.</p>
      </div>
    `;
    return;
  }

  // Group by account
  const byAccount = {};
  for (const item of discovered) {
    const key = `${item.provider}:${item.accountEmail || "unknown"}`;
    if (!byAccount[key])
      byAccount[key] = {
        provider: item.provider,
        email: item.accountEmail,
        items: [],
      };
    byAccount[key].items.push(item);
  }

  let html = "";
  for (const [key, group] of Object.entries(byAccount)) {
    html += `
      <div class="preview-account">
        <div class="preview-account-title">
          ${providerIcon(group.provider)} ${escapeHtml(group.email || "Unknown account")}
        </div>
    `;
    for (const item of group.items) {
      if (item.error) {
        html += `<div class="preview-item" style="border-color:rgba(229,62,62,0.2);background:rgba(229,62,62,0.04);"><span style="color:var(--danger);font-size:0.85rem;">Error: ${escapeHtml(item.error)}</span></div>`;
        continue;
      }
      const checked = item.alreadyImported ? "" : "checked";
      const disabled = item.alreadyImported ? "disabled" : "";
      const cssClass = item.alreadyImported
        ? "preview-item disabled"
        : "preview-item";
      const importedTag = item.alreadyImported
        ? `<span class="already-imported">${icon("check", 14)} Imported</span>`
        : "";
      html += `
        <div class="${cssClass}">
          <input type="checkbox" id="chk-${escapeHtml(item.providerCalendarId)}" value="${escapeHtml(JSON.stringify(item))}" ${checked} ${disabled}>
          <label for="chk-${escapeHtml(item.providerCalendarId)}">
            <strong>${escapeHtml(item.summary || "Untitled")}</strong>
            ${item.primary ? '<span class="badge badge-info">Primary</span>' : ""}
          </label>
          ${importedTag}
        </div>
      `;
    }
    html += "</div>";
  }

  body.innerHTML = html;
}

async function importSelectedCalendars() {
  const checkboxes = $$(
    '#preview-modal-body input[type="checkbox"]:checked:not([disabled])',
  );
  if (checkboxes.length === 0) {
    closePreviewModal();
    return;
  }

  const selections = [];
  for (const cb of checkboxes) {
    try {
      selections.push(JSON.parse(cb.value));
    } catch {
      /* ignore malformed */
    }
  }

  const btn = $("#preview-import-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML =
    '<div class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></div> Importing…';

  try {
    await api("/api/calendars/import", {
      method: "POST",
      body: JSON.stringify({ selections }),
    });
    closePreviewModal();
    calendars = await api("/api/calendars");
    renderCalendars();
    showSuccess(`Imported ${selections.length} calendar(s).`);
  } catch (err) {
    if (err.message !== "unauthorized") {
      showError(err.message);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function toggleCalendar(id, enabled) {
  clearErrors("#calendars-content");
  try {
    await api(`/api/calendars/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    const cal = calendars.find((c) => c.id === id);
    if (cal) cal.enabled = enabled ? 1 : 0;
  } catch (err) {
    showError(err.message, "#calendars-content");
    renderCalendars();
  }
}

async function deleteCalendar(id) {
  if (!confirm("Remove this calendar? Sync flows using it will break.")) return;
  clearErrors("#calendars-content");
  try {
    await api(`/api/calendars/${id}`, { method: "DELETE" });
    calendars = calendars.filter((c) => c.id !== id);
    renderCalendars();
  } catch (err) {
    showError(err.message, "#calendars-content");
  }
}

async function handleIcsSubmit(e) {
  e.preventDefault();
  clearErrors("#calendars-content");

  const body = {
    label: $("#ics-label").value.trim(),
    ics_url: $("#ics-url").value.trim(),
    // ICS feeds are inherently read-only; the user shouldn't have to pick a role.
    role: "reader",
  };

  try {
    await api("/api/calendars", { method: "POST", body: JSON.stringify(body) });
    $("#ics-form").reset();
    calendars = await api("/api/calendars");
    renderCalendars();
    showSuccess("ICS feed added.");
  } catch (err) {
    showError(err.message);
  }
}

// ─── Sync Flows ───
async function loadSyncFlows() {
  const container = $("#sync-flows-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading sync flows…</div>';

  try {
    const [cals, flows] = await Promise.all([
      api("/api/calendars"),
      api("/api/sync-flows"),
    ]);
    calendars = cals || [];
    syncFlows = flows || [];
    renderSyncFlows();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load sync flows: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderSyncFlows() {
  const container = $("#sync-flows-content");
  clearErrors(container);

  const calOptions = calendars
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)} (${providerName(c.provider)})</option>`,
    )
    .join("");

  let listHtml = "";
  if (syncFlows.length === 0) {
    listHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon("sync", 40)}</div>
        <h3>No sync flows yet</h3>
        <p>Create a flow to automatically sync events between calendars.</p>
      </div>
    `;
  } else {
    // Hide Priority column entirely if every flow has the default ord=0 —
    // a column of identical zeros is pure noise. It reappears as soon as the
    // user sets a non-zero priority on any flow.
    const showPriority = syncFlows.some((f) => Number(f.ord) !== 0);
    const priorityHeader = showPriority
      ? '<th title="Lower runs first. Use this when one flow should run before another.">Priority</th>'
      : "";
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Source</th><th></th><th>Target</th><th>Options</th><th>Enabled</th>${priorityHeader}<th>Actions</th></tr>
          </thead>
          <tbody>
            ${syncFlows
              .map(
                (flow) => `
              <tr data-id="${escapeHtml(flow.id)}">
                <td>${escapeHtml(flow.source_calendar_label || flow.source_calendar_id)}</td>
                <td style="color:var(--flow-teal);font-weight:700">→</td>
                <td>${escapeHtml(flow.target_calendar_label || flow.target_calendar_id)}</td>
                <td>${flow.options_json ? escapeHtml(optionsToNaturalLanguage(JSON.parse(flow.options_json))) : '<span style="color:var(--stone)">Default rules</span>'}</td>
                <td>
                  <label class="toggle">
                    <input type="checkbox" ${flow.enabled ? "checked" : ""} onchange="toggleSyncFlow('${escapeHtml(flow.id)}', this.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </td>
                ${showPriority ? `<td>${flow.ord}</td>` : ""}
                <td>
                  <div class="actions">
                    <button class="icon-btn" onclick="editSyncFlow('${escapeHtml(flow.id)}')" title="Edit">${icon("edit", 14)}</button>
                    <button class="icon-btn danger" onclick="deleteSyncFlow('${escapeHtml(flow.id)}')" title="Delete">${icon("trash", 14)}</button>
                  </div>
                </td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  const isEditing = editingSyncFlowId !== null;
  const editFlow = isEditing
    ? syncFlows.find((f) => f.id === editingSyncFlowId)
    : null;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Sync Flows</div>
      </div>
      <div id="sync-flows-list">${listHtml}</div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:16px">${isEditing ? "Edit Sync Flow" : "Create Sync Flow"}</div>
      <form id="sync-flow-form" onsubmit="handleSyncFlowSubmit(event)">
        <div class="form-row">
          <div class="form-group">
            <label for="sf-source">Source Calendar</label>
            <select id="sf-source" required>
              <option value="">Select source…</option>
              ${calOptions}
            </select>
          </div>
          <div class="form-group">
            <label for="sf-target">Target Calendar</label>
            <select id="sf-target" required>
              <option value="">Select target…</option>
              ${calOptions}
            </select>
          </div>
          <div class="form-group">
            <label for="sf-ord">Priority</label>
            <input type="number" id="sf-ord" value="0" min="0">
            <p class="form-hint">Lower runs first. Leave at 0 unless flows need to chain.</p>
          </div>
        </div>

        <div class="form-group">
          <label for="sf-nl">Rule Description <span style="font-weight:400;color:var(--stone)">— describe what should happen in plain English</span></label>
          <textarea id="sf-nl" placeholder="Example: Only sync weekdays during work hours. Hide the original title and mark events as private. Add a 15-minute buffer before each event." oninput="handleNaturalLanguageInput()"></textarea>
        </div>

        <div style="margin-bottom:16px;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="toggleAdvancedOptions()">
            <span id="adv-toggle-icon">▼</span> Advanced Options
          </button>
        </div>

        <div id="sf-advanced" style="display:none;">
          <div class="form-row">
            <div class="form-group" style="display:flex;align-items:center;gap:12px;">
              <label class="toggle" style="flex-shrink:0;">
                <input type="checkbox" id="sf-weekdays" onchange="syncNaturalLanguageFromForm()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:0.9rem">Weekdays only</span>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:12px;">
              <label class="toggle" style="flex-shrink:0;">
                <input type="checkbox" id="sf-workhours" onchange="syncNaturalLanguageFromForm()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:0.9rem">Only during work hours</span>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:12px;">
              <label class="toggle" style="flex-shrink:0;">
                <input type="checkbox" id="sf-private" onchange="syncNaturalLanguageFromForm()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:0.9rem">Mark as private</span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group" style="display:flex;align-items:center;gap:12px;">
              <label class="toggle" style="flex-shrink:0;">
                <input type="checkbox" id="sf-copy-title" checked onchange="syncNaturalLanguageFromForm()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:0.9rem">Copy original title</span>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:12px;">
              <label class="toggle" style="flex-shrink:0;">
                <input type="checkbox" id="sf-copy-desc" onchange="syncNaturalLanguageFromForm()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:0.9rem">Copy description</span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="sf-work-start">Work Hours Start</label>
              <input type="time" id="sf-work-start" value="09:00" onchange="syncNaturalLanguageFromForm()">
            </div>
            <div class="form-group">
              <label for="sf-work-end">Work Hours End</label>
              <input type="time" id="sf-work-end" value="17:00" onchange="syncNaturalLanguageFromForm()">
            </div>
            <div class="form-group">
              <label for="sf-buffer-before">Buffer Before (min)</label>
              <input type="number" id="sf-buffer-before" value="0" min="0" onchange="syncNaturalLanguageFromForm()">
            </div>
            <div class="form-group">
              <label for="sf-buffer-after">Buffer After (min)</label>
              <input type="number" id="sf-buffer-after" value="0" min="0" onchange="syncNaturalLanguageFromForm()">
            </div>
          </div>
        </div>

        <div class="form-group" style="display:flex;align-items:center;gap:12px;margin-top:16px;">
          <label class="toggle" style="flex-shrink:0;">
            <input type="checkbox" id="sf-enabled" checked>
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:0.9rem;color:var(--stone)">Enabled</span>
        </div>
        <div style="display:flex;gap:10px;">
          <button type="submit" class="btn btn-primary">${isEditing ? "Update Flow" : "Create Flow"}</button>
          ${isEditing ? `<button type="button" class="btn btn-secondary" onclick="cancelEditSyncFlow()">Cancel</button>` : ""}
        </div>
      </form>
    </div>
  `;

  if (editFlow) {
    $("#sf-source").value = editFlow.source_calendar_id;
    $("#sf-target").value = editFlow.target_calendar_id;
    $("#sf-ord").value = editFlow.ord;
    $("#sf-enabled").checked = editFlow.enabled;
    const opts = editFlow.options_json ? JSON.parse(editFlow.options_json) : {};
    syncFormFromOptions(opts);
    $("#sf-nl").value = optionsToNaturalLanguage(opts);
  }
}

async function handleSyncFlowSubmit(e) {
  e.preventDefault();
  clearErrors("#sync-flows-content");

  const optionsJson = buildOptionsFromForm();

  const body = {
    source_calendar_id: $("#sf-source").value,
    target_calendar_id: $("#sf-target").value,
    options_json: optionsJson,
    enabled: $("#sf-enabled").checked,
    ord: Number($("#sf-ord").value) || 0,
  };

  try {
    if (editingSyncFlowId) {
      await api(`/api/sync-flows/${editingSyncFlowId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      editingSyncFlowId = null;
    } else {
      await api("/api/sync-flows", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    $("#sync-flow-form").reset();
    syncFlows = await api("/api/sync-flows");
    renderSyncFlows();
  } catch (err) {
    showError(err.message, "#sync-flows-content");
  }
}

function toggleAdvancedOptions() {
  const el = $("#sf-advanced");
  const icon = $("#adv-toggle-icon");
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  icon.textContent = open ? "▼" : "▲";
}

function buildOptionsFromForm() {
  const opts = {};
  if ($("#sf-weekdays").checked) opts.weekdays_only = true;
  if ($("#sf-workhours").checked) {
    opts.only_work_hours = true;
    opts.work_hours = {
      start: $("#sf-work-start").value,
      end: $("#sf-work-end").value,
    };
  }
  if ($("#sf-private").checked) opts.mark_private = true;
  if (!$("#sf-copy-title").checked) opts.copy_title = false;
  if ($("#sf-copy-desc").checked) opts.copy_description = true;
  const before = Number($("#sf-buffer-before").value) || 0;
  const after = Number($("#sf-buffer-after").value) || 0;
  if (before > 0) opts.buffer_min_before = before;
  if (after > 0) opts.buffer_min_after = after;
  return Object.keys(opts).length ? opts : null;
}

function syncFormFromOptions(opts) {
  opts = opts || {};
  $("#sf-weekdays").checked = !!opts.weekdays_only;
  $("#sf-workhours").checked = !!opts.only_work_hours;
  $("#sf-private").checked = !!opts.mark_private;
  $("#sf-copy-title").checked = opts.copy_title !== false;
  $("#sf-copy-desc").checked = !!opts.copy_description;
  $("#sf-work-start").value = opts.work_hours?.start || "09:00";
  $("#sf-work-end").value = opts.work_hours?.end || "17:00";
  $("#sf-buffer-before").value = opts.buffer_min_before || 0;
  $("#sf-buffer-after").value = opts.buffer_min_after || 0;
}

function handleNaturalLanguageInput() {
  const text = $("#sf-nl").value.trim();
  if (!text) return;
  const opts = parseNaturalLanguage(text);
  syncFormFromOptions(opts);
}

function syncNaturalLanguageFromForm() {
  const opts = buildOptionsFromForm();
  $("#sf-nl").value = optionsToNaturalLanguage(opts);
}

function parseNaturalLanguage(text) {
  const opts = {};
  const t = text.toLowerCase();

  if (
    /weekdays? only|monday through friday|business days?|week days? only/.test(
      t,
    )
  ) {
    opts.weekdays_only = true;
  }
  if (
    /work hours|business hours|working hours|9 to 5|9-5|during office hours/.test(
      t,
    )
  ) {
    opts.only_work_hours = true;
  }
  if (/mark as private|make private|set private|privacy/.test(t)) {
    opts.mark_private = true;
  }
  if (
    /hide title|block time|show as busy|busy only|do not copy title|don't copy title/.test(
      t,
    )
  ) {
    opts.copy_title = false;
  }
  if (
    /copy title|keep title|original title/.test(t) &&
    opts.copy_title !== false
  ) {
    opts.copy_title = true;
  }
  if (/copy description|keep description|include description/.test(t)) {
    opts.copy_description = true;
  }

  const beforeMatch = t.match(
    /(\d+)\s*(min|minute)s?\s*buffer\s*(before|prior|ahead)/,
  );
  if (beforeMatch) opts.buffer_min_before = Number(beforeMatch[1]);

  const afterMatch = t.match(
    /(\d+)\s*(min|minute)s?\s*buffer\s*(after|following)/,
  );
  if (afterMatch) opts.buffer_min_after = Number(afterMatch[1]);

  const genericBuffer = t.match(/(\d+)\s*(min|minute)s?\s*buffer/);
  if (genericBuffer && !beforeMatch && !afterMatch) {
    opts.buffer_min_before = Number(genericBuffer[1]);
  }

  const timeRange = t.match(
    /(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*to\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/,
  );
  if (timeRange) {
    opts.work_hours = {
      start: formatTime(timeRange[1], timeRange[2], timeRange[3]),
      end: formatTime(timeRange[4], timeRange[5], timeRange[6]),
    };
  }

  return opts;
}

function formatTime(h, m, meridiem) {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function optionsToNaturalLanguage(opts) {
  if (!opts || Object.keys(opts).length === 0) return "";
  const parts = [];

  if (opts.weekdays_only) parts.push("Only sync weekdays");
  if (opts.only_work_hours) {
    const wh = opts.work_hours || { start: "09:00", end: "17:00" };
    parts.push(`only during work hours (${wh.start}–${wh.end})`);
  }

  if (opts.copy_title === false) {
    parts.push("hide the original title (show as blocked)");
  } else {
    parts.push("copy the original title");
  }

  if (opts.copy_description) parts.push("copy the description");
  if (opts.mark_private) parts.push("mark events as private");

  if (opts.buffer_min_before && opts.buffer_min_after) {
    parts.push(
      `add a ${opts.buffer_min_before}-minute buffer before and ${opts.buffer_min_after}-minute buffer after each event`,
    );
  } else if (opts.buffer_min_before) {
    parts.push(
      `add a ${opts.buffer_min_before}-minute buffer before each event`,
    );
  } else if (opts.buffer_min_after) {
    parts.push(`add a ${opts.buffer_min_after}-minute buffer after each event`);
  }

  if (parts.length === 0) return "";
  let sentence = parts.join(". ");
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  if (!sentence.endsWith(".")) sentence += ".";
  return sentence;
}

function editSyncFlow(id) {
  editingSyncFlowId = id;
  renderSyncFlows();
}

function cancelEditSyncFlow() {
  editingSyncFlowId = null;
  renderSyncFlows();
}

async function toggleSyncFlow(id, enabled) {
  clearErrors("#sync-flows-content");
  try {
    await api(`/api/sync-flows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    syncFlows = await api("/api/sync-flows");
    renderSyncFlows();
  } catch (err) {
    showError(err.message, "#sync-flows-content");
    renderSyncFlows();
  }
}

async function deleteSyncFlow(id) {
  if (!confirm("Delete this sync flow?")) return;
  clearErrors("#sync-flows-content");
  try {
    await api(`/api/sync-flows/${id}`, { method: "DELETE" });
    syncFlows = await api("/api/sync-flows");
    renderSyncFlows();
  } catch (err) {
    showError(err.message, "#sync-flows-content");
  }
}

// ─── Event Types ───
async function loadEventTypes() {
  const container = $("#event-types-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading event types…</div>';

  try {
    const [cals, types] = await Promise.all([
      api("/api/calendars"),
      api("/api/event-types"),
    ]);
    calendars = cals || [];
    eventTypes = types || [];
    renderEventTypes();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load event types: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderEventTypes() {
  const container = $("#event-types-content");
  clearErrors(container);

  const calOptions = calendars
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`,
    )
    .join("");

  let listHtml = "";
  if (eventTypes.length === 0) {
    listHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon("list", 40)}</div>
        <h3>No event types yet</h3>
        <p>Create event types to share public booking pages.</p>
      </div>
    `;
  } else {
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Slug</th><th>Duration</th><th>Target</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${eventTypes
              .map(
                (et) => `
              <tr data-id="${escapeHtml(et.id)}">
                <td><strong>${escapeHtml(et.name)}</strong></td>
                <td><code style="font-size:0.8rem;background:var(--cloud);padding:2px 6px;border-radius:4px;">${escapeHtml(et.slug)}</code></td>
                <td>${et.duration_min} min</td>
                <td>${calendarLabel(et.target_calendar_id)}</td>
                <td>${et.enabled ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Disabled</span>'}</td>
                <td>
                  <div class="actions">
                    <button class="icon-btn" onclick="editEventType('${escapeHtml(et.id)}')" title="Edit">${icon("edit", 14)}</button>
                    <button class="icon-btn danger" onclick="deleteEventType('${escapeHtml(et.id)}')" title="Delete">${icon("trash", 14)}</button>
                  </div>
                </td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  const isEditing = editingEventTypeId !== null;
  const editEt = isEditing
    ? eventTypes.find((e) => e.id === editingEventTypeId)
    : null;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Event Types</div>
      </div>
      <div id="event-types-list">${listHtml}</div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:16px">${isEditing ? "Edit Event Type" : "Create Event Type"}</div>
      <form id="event-type-form" onsubmit="handleEventTypeSubmit(event)">
        <!-- Essentials: always visible. Smart defaults pre-fill — most users
             create an event type just by typing a name and hitting Create. -->
        <div class="form-row">
          <div class="form-group">
            <label for="et-name">Name</label>
            <input type="text" id="et-name" placeholder="30 Minute Meeting" required oninput="autoSlugFromName()">
          </div>
          <div class="form-group">
            <label for="et-duration">Duration</label>
            <select id="et-duration" required>
              <option value="15">15 minutes</option>
              <option value="30" selected>30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">60 minutes</option>
              <option value="90">90 minutes</option>
              <option value="custom">Custom…</option>
            </select>
            <input type="number" id="et-duration-custom" min="1" placeholder="minutes" style="margin-top:8px;display:none">
          </div>
        </div>
        <div class="form-group">
          <label for="et-target">Calendar</label>
          <select id="et-target" required>
            <option value="">Select calendar…</option>
            ${calOptions}
          </select>
        </div>

        <button type="button" class="advanced-toggle" id="advanced-toggle" onclick="toggleAdvancedFields()" aria-expanded="false">
          <span class="advanced-chevron">▸</span> Advanced options
        </button>

        <div class="advanced-fields" id="advanced-fields" style="display:none">
          <div class="form-group">
            <label for="et-slug">URL slug</label>
            <input type="text" id="et-slug" placeholder="30min-meeting" required pattern="[a-zA-Z0-9_-]+">
            <p class="form-hint">Used in the public booking URL. Auto-generated from the name.</p>
          </div>

          <div class="form-group">
            <label>Available days</label>
            <div class="weekday-group" id="et-weekdays-group">
              ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                .map(
                  (d, i) => `
                <label class="weekday-check">
                  <input type="checkbox" data-day="${i}" ${i < 5 ? "checked" : ""}>
                  <span>${d}</span>
                </label>
              `,
                )
                .join("")}
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="et-work-start">Hours — from</label>
              <input type="time" id="et-work-start" value="09:00" required>
            </div>
            <div class="form-group">
              <label for="et-work-end">Hours — to</label>
              <input type="time" id="et-work-end" value="17:00" required>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="et-buffer">Buffer between bookings</label>
              <input type="number" id="et-buffer" value="0" min="0"> <span class="form-suffix">min</span>
            </div>
            <div class="form-group">
              <label for="et-lead">Min lead time</label>
              <input type="number" id="et-lead" value="0" min="0"> <span class="form-suffix">min</span>
            </div>
            <div class="form-group">
              <label for="et-horizon">Booking window</label>
              <input type="number" id="et-horizon" value="25" min="1"> <span class="form-suffix">days ahead</span>
            </div>
          </div>

          <div class="form-group">
            <label for="et-location">Where you'll meet</label>
            <select id="et-location">
              <option value="meet">Google Meet</option>
              <option value="zoom">Zoom</option>
              <option value="phone">Phone</option>
              <option value="in_person">In person</option>
              <option value="ask">Ask the attendee</option>
            </select>
          </div>

          <div class="form-group" style="display:flex;align-items:center;gap:12px;">
            <label class="toggle" style="flex-shrink:0;">
              <input type="checkbox" id="et-enabled" checked>
              <span class="toggle-slider"></span>
            </label>
            <span style="font-size:0.9rem;color:var(--stone)">Enabled (visible on the booking page)</span>
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:16px;">
          <button type="submit" class="btn btn-primary">${isEditing ? "Save changes" : "Create"}</button>
          ${isEditing ? `<button type="button" class="btn btn-secondary" onclick="cancelEditEventType()">Cancel</button>` : ""}
        </div>
      </form>
    </div>
  `;

  // When editing, expand the advanced section so the user can see what they
  // already had set — they shouldn't have to hunt for fields they configured.
  if (editEt) {
    toggleAdvancedFields(true);
    $("#et-slug").value = editEt.slug;
    $("#et-name").value = editEt.name;
    setDurationValue(editEt.duration_min);
    $("#et-buffer").value = editEt.buffer_min;
    $("#et-lead").value = editEt.lead_min;
    $("#et-horizon").value = editEt.horizon_days;
    // Weekdays: bitmask -> checkboxes (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64)
    const mask = Number(editEt.weekdays_mask) || 0;
    $$('#et-weekdays-group input[type="checkbox"]').forEach((cb) => {
      const day = Number(cb.dataset.day);
      cb.checked = (mask & (1 << day)) !== 0;
    });
    // Work hours: JSON -> two time inputs
    try {
      const wh = editEt.work_hours_json
        ? JSON.parse(editEt.work_hours_json)
        : { start: "09:00", end: "17:00" };
      $("#et-work-start").value = wh.start || "09:00";
      $("#et-work-end").value = wh.end || "17:00";
    } catch {
      $("#et-work-start").value = "09:00";
      $("#et-work-end").value = "17:00";
    }
    $("#et-location").value = editEt.location_mode;
    $("#et-target").value = editEt.target_calendar_id;
    $("#et-enabled").checked = editEt.enabled;
  }
}

// Convert "Quick chat" → "quick-chat". Strips diacritics and non-word chars.
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

// Auto-fill the slug field from the name unless the user has already edited it.
function autoSlugFromName() {
  const slugEl = $("#et-slug");
  const nameEl = $("#et-name");
  if (!slugEl || !nameEl) return;
  if (slugEl.dataset.userEdited === "true") return;
  slugEl.value = slugify(nameEl.value);
}

// Track manual slug edits so we stop overwriting from the name field.
document.addEventListener("input", (e) => {
  if (e.target?.id === "et-slug") e.target.dataset.userEdited = "true";
});

// Show/hide the advanced section. force=true|false to set explicitly.
function toggleAdvancedFields(force) {
  const fields = $("#advanced-fields");
  const toggle = $("#advanced-toggle");
  if (!fields || !toggle) return;
  const wasHidden = fields.style.display === "none" || !fields.style.display;
  const next = typeof force === "boolean" ? force : wasHidden;
  fields.style.display = next ? "" : "none";
  toggle.setAttribute("aria-expanded", String(next));
  const chev = toggle.querySelector(".advanced-chevron");
  if (chev) chev.textContent = next ? "▾" : "▸";
}

// Duration is a select with preset minutes + a "custom" escape hatch.
function readDurationValue() {
  const sel = $("#et-duration");
  if (!sel) return 30;
  if (sel.value === "custom")
    return Number($("#et-duration-custom").value) || 30;
  return Number(sel.value) || 30;
}

function setDurationValue(minutes) {
  const sel = $("#et-duration");
  const custom = $("#et-duration-custom");
  if (!sel) return;
  const presets = ["15", "30", "45", "60", "90"];
  const m = String(minutes);
  if (presets.includes(m)) {
    sel.value = m;
    if (custom) custom.style.display = "none";
  } else {
    sel.value = "custom";
    if (custom) {
      custom.style.display = "";
      custom.value = m;
    }
  }
}

// Wire the duration select to reveal the custom input when chosen.
document.addEventListener("change", (e) => {
  if (e.target?.id === "et-duration") {
    const custom = $("#et-duration-custom");
    if (!custom) return;
    custom.style.display = e.target.value === "custom" ? "" : "none";
    if (e.target.value === "custom" && !custom.value) custom.value = "30";
  }
});

function readWeekdaysMask() {
  let mask = 0;
  $$('#et-weekdays-group input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) mask |= 1 << Number(cb.dataset.day);
  });
  return mask;
}

async function handleEventTypeSubmit(e) {
  e.preventDefault();
  clearErrors("#event-types-content");

  const mask = readWeekdaysMask();
  if (mask === 0) {
    showError("Pick at least one available day.", "#event-types-content");
    return;
  }

  const workStart = $("#et-work-start").value || "09:00";
  const workEnd = $("#et-work-end").value || "17:00";
  if (workStart >= workEnd) {
    showError(
      "Work hours: 'from' must be earlier than 'to'.",
      "#event-types-content",
    );
    return;
  }

  // Slug auto-generates from name if not edited; require non-empty.
  let slug = $("#et-slug").value.trim();
  if (!slug) slug = slugify($("#et-name").value);
  if (!slug) {
    showError("Please give the event type a name.");
    return;
  }

  const body = {
    slug,
    name: $("#et-name").value.trim(),
    duration_min: readDurationValue(),
    buffer_min: Number($("#et-buffer").value) || 0,
    lead_min: Number($("#et-lead").value) || 0,
    horizon_days: Number($("#et-horizon").value) || 25,
    weekdays_mask: mask,
    work_hours_json: JSON.stringify({ start: workStart, end: workEnd }),
    target_calendar_id: $("#et-target").value,
    location_mode: $("#et-location").value,
    enabled: $("#et-enabled").checked ? 1 : 0,
  };

  try {
    if (editingEventTypeId) {
      // Only send changed fields for PATCH
      const original = eventTypes.find((e) => e.id === editingEventTypeId);
      const patchBody = {};
      for (const key of Object.keys(body)) {
        if (body[key] !== original[key]) patchBody[key] = body[key];
      }
      if (Object.keys(patchBody).length === 0) {
        editingEventTypeId = null;
        renderEventTypes();
        return;
      }
      await api(`/api/event-types/${editingEventTypeId}`, {
        method: "PATCH",
        body: JSON.stringify(patchBody),
      });
      editingEventTypeId = null;
    } else {
      await api("/api/event-types", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    $("#event-type-form").reset();
    eventTypes = await api("/api/event-types");
    renderEventTypes();
  } catch (err) {
    showError(err.message, "#event-types-content");
  }
}

function editEventType(id) {
  editingEventTypeId = id;
  renderEventTypes();
}

function cancelEditEventType() {
  editingEventTypeId = null;
  renderEventTypes();
}

async function deleteEventType(id) {
  if (!confirm("Delete this event type?")) return;
  clearErrors("#event-types-content");
  try {
    await api(`/api/event-types/${id}`, { method: "DELETE" });
    eventTypes = await api("/api/event-types");
    renderEventTypes();
  } catch (err) {
    showError(err.message, "#event-types-content");
  }
}

// ─── Bookings ───
async function loadBookings() {
  const container = $("#bookings-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading bookings…</div>';

  try {
    bookings = await api("/api/bookings");
    renderBookings();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load bookings: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderBookings() {
  const container = $("#bookings-content");
  clearErrors(container);

  let listHtml = "";
  if (bookings.length === 0) {
    listHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon("book", 40)}</div>
        <h3>No bookings yet</h3>
        <p>Bookings will appear here when people schedule through your public pages.</p>
      </div>
    `;
  } else {
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Subject</th><th>Attendee</th><th>Start</th><th>End</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${bookings
              .map(
                (b) => `
              <tr>
                <td>${escapeHtml(b.subject || "—")}</td>
                <td>${escapeHtml(b.attendee_name || "")} ${b.attendee_email ? `&lt;${escapeHtml(b.attendee_email)}&gt;` : "—"}</td>
                <td>${formatDate(b.start_ms)}</td>
                <td>${formatDate(b.end_ms)}</td>
                <td>${statusBadge(b.status)}</td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Recent Bookings</div>
      </div>
      ${listHtml}
    </div>
  `;
}

// ─── Auth ───
async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  window.location.href = "/login";
}

// ─── Mobile Menu ───
function toggleSidebar() {
  $(".sidebar").classList.toggle("open");
  $(".sidebar-overlay").classList.toggle("open");
}

// ─── Init ───
async function init() {
  try {
    currentUser = await api("/api/auth/me");
    renderUserInfo();
    showTab("overview");
  } catch (err) {
    // 401 handled by api()
  }
}

init();
