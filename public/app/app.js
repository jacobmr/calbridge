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

// Group context. When null, the dashboard shows the user's personal
// scope. When a group is selected (by clicking its sidebar entry),
// the group-scoped tabs (group-schedule, group-settings) and API calls
// use it as scope.
let groups = [];
let currentGroupId = null;

// Shared empty-state for the (rare) case where a group-scoped page is
// rendered without a current group — e.g. a user lands on group-schedule
// after their last group was deleted. Normal navigation always sets
// currentGroupId before showing these tabs.
function noGroupSelectedHtml(verb) {
  return `
    <div class="card empty-hero">
      <h2>No group selected</h2>
      <p>Pick a group from the sidebar to ${verb}.</p>
    </div>
  `;
}

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

// Empty-state illustration: a soft background blob in --cloud + brand-color
// foreground icon. Bigger and warmer than a plain icon — gives a state
// some shape without leaning on stock illustrations.
function illustration(name, size = 88) {
  const body = ICONS[name];
  if (!body) return "";
  // The 24×24 icon body draws from (0,0) to (24,24). To put it inside an
  // 88×88 frame centered, translate by (20,20) and scale 2× → footprint
  // becomes (20,20)–(68,68), centered around (44,44).
  return `
    <svg class="illust illust-${name}" width="${size}" height="${size}" viewBox="0 0 88 88" aria-hidden="true">
      <circle cx="44" cy="44" r="40" fill="rgba(0, 194, 168, 0.08)"/>
      <circle cx="44" cy="44" r="40" fill="none" stroke="rgba(0, 194, 168, 0.18)" stroke-width="1"/>
      <g transform="translate(20 20) scale(2)" fill="none" stroke="var(--bridge-blue)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        ${body}
      </g>
    </svg>
  `;
}

// Standard empty-state card. One illustration + headline + subhead + CTA.
function emptyState({
  illustrationName,
  headline,
  subhead,
  ctaLabel,
  ctaOnclick,
  ctaHref,
}) {
  const cta = ctaLabel
    ? ctaHref
      ? `<a class="btn btn-primary" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>`
      : `<button class="btn btn-primary" onclick="${ctaOnclick || ""}">${escapeHtml(ctaLabel)}</button>`
    : "";
  return `
    <div class="empty-state">
      ${illustration(illustrationName)}
      <h3>${escapeHtml(headline)}</h3>
      ${subhead ? `<p>${escapeHtml(subhead)}</p>` : ""}
      ${cta ? `<div class="empty-state-cta">${cta}</div>` : ""}
    </div>
  `;
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

// Clipboard helper shared across tabs (was previously defined inside
// renderEventTypes, which made it unavailable until that tab rendered once).
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showSuccess("Link copied.");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showSuccess("Link copied.");
  }
}

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

// ─── Groups sidebar ───
//
// Each group the user belongs to gets its own section in the sidebar
// with Schedule + Settings sub-entries. Zero groups: nothing renders
// (group creation lives in the "What's next" overview card). One or
// more: a divider, then a section per group, then a "+ Create group"
// link at the bottom.
async function loadGroups() {
  try {
    groups = (await api("/api/groups")) || [];
  } catch {
    groups = [];
  }
  renderGroupsSection();
}

function renderGroupsSection() {
  const el = $("#groups-section");
  if (!el) return;

  if (groups.length === 0) {
    el.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();

  const divider = document.createElement("div");
  divider.className = "sidebar-divider";
  frag.appendChild(divider);

  for (const g of groups) {
    const section = document.createElement("div");
    section.className =
      "sidebar-group" + (currentGroupId === g.id ? " active" : "");
    section.dataset.groupId = g.id;

    const header = document.createElement("div");
    header.className = "sidebar-group-name";
    header.textContent = g.name;
    section.appendChild(header);

    section.appendChild(makeGroupNavButton(g.id, "group-schedule", "Schedule"));
    section.appendChild(makeGroupNavButton(g.id, "group-settings", "Settings"));

    frag.appendChild(section);
  }

  const create = document.createElement("button");
  create.type = "button";
  create.className = "sidebar-create-group";
  create.textContent = "+ Create group";
  create.addEventListener("click", () => openCreateGroupDialog());
  frag.appendChild(create);

  el.replaceChildren(frag);
}

function makeGroupNavButton(groupId, tab, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-item nav-subitem";
  if (currentGroupId === groupId && currentTab === tab) {
    btn.classList.add("active");
  }
  btn.dataset.groupTab = `${groupId}:${tab}`;
  btn.textContent = label;
  btn.addEventListener("click", () => selectGroup(groupId, tab));
  return btn;
}

function selectGroup(groupId, tab) {
  currentGroupId = groupId;
  if (groupId == null) {
    // Caller cleared the active group (e.g. after deleting it). If the
    // current tab is a group-only one, fall back to Overview; otherwise
    // just re-render the sidebar and stay where we are.
    renderGroupsSection();
    if (currentTab === "group-schedule" || currentTab === "group-settings") {
      showTab("overview");
    }
    return;
  }
  renderGroupsSection();
  showTab(tab || "group-schedule");
}

// Real modal — replaces the v1 prompt/confirm pair, which was brittle on
// mobile Safari and confusing ("Cancel = Team" surprised people who hit
// Cancel meaning "abort").
function openCreateGroupDialog() {
  // On mobile the create button lives inside the slid-out sidebar — leaving
  // the sidebar open behind the modal looks like two stacked panels. Close
  // it so the modal stands alone.
  $(".sidebar")?.classList.remove("open");
  $(".sidebar-overlay")?.classList.remove("open");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog create-group-dialog">
      <div class="modal-header">
        <h3>Create a group</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <form id="create-group-form" class="modal-body">
        <div class="form-group">
          <label for="cg-name">Name</label>
          <input type="text" id="cg-name" placeholder="e.g. The Andersons, Client A Team" required maxlength="60" autofocus>
        </div>
        <div class="form-group">
          <label>Type</label>
          <div class="type-picker">
            <label class="type-option">
              <input type="radio" name="cg-type" value="family" checked>
              <div class="type-card">
                <strong>Family</strong>
                <span class="muted">Spouse + kids. Default to full sharing.</span>
              </div>
            </label>
            <label class="type-option">
              <input type="radio" name="cg-type" value="team">
              <div class="type-card">
                <strong>Team</strong>
                <span class="muted">Coworkers or clients. Default to free/busy.</span>
              </div>
            </label>
          </div>
        </div>
      </form>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" id="cg-cancel">Cancel</button>
        <button class="btn btn-primary" type="submit" form="create-group-form" id="cg-submit">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#cg-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  // Escape closes — small affordance, big quality-of-life
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);

  setTimeout(() => overlay.querySelector("#cg-name").focus(), 50);

  overlay
    .querySelector("#create-group-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = overlay.querySelector("#cg-name").value.trim();
      const type = overlay.querySelector('input[name="cg-type"]:checked').value;
      if (!name) return;
      const submitBtn = overlay.querySelector("#cg-submit");
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating…";
      try {
        const created = await api("/api/groups", {
          method: "POST",
          body: JSON.stringify({ name, type }),
        });
        groups = [...groups, created];
        close();
        document.removeEventListener("keydown", onKey);
        selectGroup(created.id);
        showSuccess(
          `${type === "family" ? "Family" : "Team"} "${created.name}" created.`,
        );
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create";
        showError(err.message);
      }
    });
}

// ─── Group settings page ───
//
// One screen, three jobs (one per card, ordered by frequency):
//   1. Members — invite, change role, remove (admin+)
//   2. My calendars in this group — add/remove/level
//   3. How I receive each member's events — per-sharer settings
// Owner-only "Delete group" lives at the bottom under a confirm button.
let groupSettingsState = { detail: null, sharesData: null };

async function loadGroupSettings() {
  const container = $("#group-settings-content");
  if (!currentGroupId) {
    container.innerHTML = noGroupSelectedHtml("manage it");
    return;
  }
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading…</div>';
  try {
    const [detail, sharesData, cals] = await Promise.all([
      api(`/api/groups/${currentGroupId}`),
      api(`/api/groups/${currentGroupId}/shares`),
      api("/api/calendars"),
    ]);
    groupSettingsState = { detail, sharesData };
    calendars = cals || [];
    renderGroupSettings();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function isAdmin(role) {
  return role === "owner" || role === "admin";
}

function renderGroupSettings() {
  const { detail, sharesData } = groupSettingsState;
  const container = $("#group-settings-content");
  if (!detail) return;

  const me = currentUser;
  const myRole = detail.my_role;
  const canAdmin = isAdmin(myRole);
  const isOwner = myRole === "owner";

  const activeMembers = (detail.members || []).filter(
    (m) => m.status === "active",
  );
  const pendingMembers = (detail.members || []).filter(
    (m) => m.status === "pending",
  );
  const otherMembers = activeMembers.filter((m) => m.user_id !== me?.id);

  // Build maps for quick lookup in the receive-settings card
  const myShareByCalId = new Map(
    (sharesData?.mine || []).map((s) => [s.calendar_id, s]),
  );
  const receiveBySharer = new Map(
    (sharesData?.receiveSettings || []).map((rs) => [rs.sharer_user_id, rs]),
  );

  // Calendars not yet shared in this group, eligible to add
  const shareableCals = calendars.filter(
    (c) => c.provider !== "ics" && !myShareByCalId.has(c.id),
  );

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${escapeHtml(detail.name)}</div>
          <div class="muted">${detail.type === "family" ? "Family" : "Team"} · ${activeMembers.length} member${activeMembers.length === 1 ? "" : "s"}</div>
        </div>
        ${isOwner ? `<button class="btn btn-secondary btn-sm" onclick="renameGroup()">Rename</button>` : ""}
      </div>
      ${detail.description ? `<p class="muted">${escapeHtml(detail.description)}</p>` : ""}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Members</div>
        ${canAdmin ? `<button class="btn btn-primary btn-sm" onclick="openInviteDialog()">${icon("plus", 14)} Invite</button>` : ""}
      </div>
      ${renderMembersList(activeMembers, pendingMembers, myRole, me?.id)}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">My calendars in this group</div>
        ${shareableCals.length ? `<button class="btn btn-secondary btn-sm" onclick="openShareDialog()">${icon("plus", 14)} Share a calendar</button>` : ""}
      </div>
      ${renderMyShares(sharesData?.mine || [])}
    </div>

    ${
      otherMembers.length
        ? `
      <div class="card">
        <div class="card-header"><div class="card-title">How you see each member</div></div>
        ${otherMembers.map((m) => renderReceiveRow(m, receiveBySharer.get(m.user_id))).join("")}
      </div>
    `
        : ""
    }

    ${
      isOwner
        ? `
      <div class="card danger-zone">
        <div class="card-title">Danger zone</div>
        <p class="muted">Deleting this group removes all sharing settings and group-scoped sync flows. Members keep their own calendars and personal data.</p>
        <button class="btn btn-danger btn-sm" onclick="deleteCurrentGroup()">Delete group</button>
      </div>
    `
        : ""
    }
  `;
}

function renderMembersList(active, pending, myRole, myUserId) {
  if (active.length + pending.length === 0) {
    return `<p class="muted">Just you so far.</p>`;
  }
  const canAdmin = isAdmin(myRole);
  const isOwner = myRole === "owner";

  const rows = [];
  for (const m of active) {
    const isSelf = m.user_id === myUserId;
    const canModify = canAdmin && !isSelf;
    const canChangeRole = isOwner && !isSelf;
    const display = m.display_name || (m.email || "").split("@")[0] || m.email;
    rows.push(`
      <div class="member-row" data-user-id="${escapeHtml(m.user_id)}">
        <div class="member-main">
          <div class="member-avatar">${escapeHtml(getInitials(display, m.email))}</div>
          <div class="member-text">
            <div class="member-name">${escapeHtml(display)}${isSelf ? ' <span class="muted">(you)</span>' : ""}</div>
            <div class="member-email muted">${escapeHtml(m.email || "")}</div>
          </div>
        </div>
        <div class="member-actions">
          ${
            canChangeRole
              ? `
            <select onchange="updateMemberRole('${escapeHtml(m.user_id)}', this.value)" class="role-select">
              <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
              <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
              <option value="owner" ${m.role === "owner" ? "selected" : ""}>Owner</option>
            </select>
          `
              : `<span class="role-badge">${escapeHtml(m.role)}</span>`
          }
          ${
            canModify || isSelf
              ? `<button class="icon-btn danger" title="${isSelf ? "Leave group" : "Remove member"}" onclick="removeMember('${escapeHtml(m.user_id)}', ${isSelf})">${icon("trash", 14)}</button>`
              : ""
          }
        </div>
      </div>
    `);
  }
  for (const m of pending) {
    const display = m.display_name || (m.email || "").split("@")[0] || m.email;
    rows.push(`
      <div class="member-row pending" data-user-id="${escapeHtml(m.user_id)}">
        <div class="member-main">
          <div class="member-avatar muted">${escapeHtml(getInitials(display, m.email))}</div>
          <div class="member-text">
            <div class="member-name">${escapeHtml(display)} <span class="role-badge muted">invited</span></div>
            <div class="member-email muted">${escapeHtml(m.email || "")}</div>
          </div>
        </div>
        <div class="member-actions">
          ${
            canAdmin
              ? `<button class="icon-btn danger" title="Cancel invite" onclick="removeMember('${escapeHtml(m.user_id)}', false)">${icon("trash", 14)}</button>`
              : ""
          }
        </div>
      </div>
    `);
  }
  return rows.join("");
}

function renderMyShares(shares) {
  if (shares.length === 0) {
    return `<p class="muted">You haven't shared any calendars with this group yet. Click "Share a calendar" above to get started.</p>`;
  }
  return shares
    .map(
      (s) => `
      <div class="member-row">
        <div class="member-main">
          ${providerIcon(s.calendar_provider)}
          <div class="member-text">
            <div class="member-name">${escapeHtml(s.calendar_label)}</div>
            <div class="member-email muted">${shareLevelDescription(s.share_level)}</div>
          </div>
        </div>
        <div class="member-actions">
          <select onchange="updateShareLevel('${escapeHtml(s.calendar_id)}', this.value)" class="role-select">
            <option value="full" ${s.share_level === "full" ? "selected" : ""}>Full detail</option>
            <option value="free_busy" ${s.share_level === "free_busy" ? "selected" : ""}>Free/busy only</option>
            <option value="none" ${s.share_level === "none" ? "selected" : ""}>Hidden</option>
          </select>
          <button class="icon-btn danger" title="Stop sharing" onclick="removeShare('${escapeHtml(s.calendar_id)}')">${icon("trash", 14)}</button>
        </div>
      </div>
    `,
    )
    .join("");
}

function shareLevelDescription(level) {
  if (level === "full") return "Full event detail visible to the group";
  if (level === "free_busy") return "Only busy/free shown — no titles";
  return "Hidden from the group for now";
}

function renderReceiveRow(member, settings) {
  const display =
    member.display_name || (member.email || "").split("@")[0] || member.email;
  const recv = settings?.receive_level || "full";
  const push = settings?.push_level || "none";
  const prefix = settings?.event_prefix || "";
  const targetCalId = settings?.target_calendar_id || "";

  // Calendars the user owns and could land pushed events into. ICS feeds
  // are excluded — they're read-only.
  const writableCalOptions = (calendars || [])
    .filter((c) => c.provider !== "ics")
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}" ${c.id === targetCalId ? "selected" : ""}>${escapeHtml(c.label)}</option>`,
    )
    .join("");

  // When push is on but no target calendar is set, surface a soft warning
  // so the user knows their setting isn't actually pushing yet.
  const needsTarget = push !== "none" && !targetCalId;

  return `
    <div class="receive-row" data-sharer-id="${escapeHtml(member.user_id)}">
      <div class="receive-header">
        <div class="member-avatar">${escapeHtml(getInitials(display, member.email))}</div>
        <div class="member-name">${escapeHtml(display)}</div>
      </div>
      <div class="receive-fields">
        <label class="field-inline">
          <span>What I see</span>
          <select onchange="updateReceiveSetting('${escapeHtml(member.user_id)}', 'receive_level', this.value)">
            <option value="full" ${recv === "full" ? "selected" : ""}>Full detail</option>
            <option value="free_busy" ${recv === "free_busy" ? "selected" : ""}>Free/busy</option>
            <option value="none" ${recv === "none" ? "selected" : ""}>Hidden</option>
          </select>
        </label>
        <label class="field-inline">
          <span>Add to my calendar</span>
          <select onchange="updateReceiveSetting('${escapeHtml(member.user_id)}', 'push_level', this.value)">
            <option value="none" ${push === "none" ? "selected" : ""}>Don't add</option>
            <option value="busy_only" ${push === "busy_only" ? "selected" : ""}>Busy only</option>
            <option value="full" ${push === "full" ? "selected" : ""}>Full detail</option>
          </select>
        </label>
        ${
          push !== "none"
            ? `
          <label class="field-inline">
            <span>Where they land</span>
            <select onchange="updateReceiveSetting('${escapeHtml(member.user_id)}', 'target_calendar_id', this.value)">
              <option value="">Pick a calendar…</option>
              ${writableCalOptions}
            </select>
          </label>
          <label class="field-inline">
            <span>Title prefix</span>
            <input type="text" value="${escapeHtml(prefix)}" placeholder="[${escapeHtml(display.split(" ")[0] || "Name")}] "
              onblur="updateReceiveSetting('${escapeHtml(member.user_id)}', 'event_prefix', this.value)">
          </label>
        `
            : ""
        }
      </div>
      ${needsTarget ? `<p class="muted" style="margin-top:8px;color:var(--warning)">Pick a target calendar to start receiving these events.</p>` : ""}
    </div>
  `;
}

// ─── Group settings handlers ───

// Modal-based invite. Replaces the v1 prompt(). When the invitee isn't on
// MiCal yet, the API returns invite_url (a token-bearing /login link) and
// we surface it for the inviter to copy and send themselves — no email
// infrastructure required for v1.
function openInviteDialog() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog invite-dialog">
      <div class="modal-header">
        <h3>Invite to this group</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <form id="invite-form" class="modal-body">
        <div class="form-group">
          <label for="inv-email">Email address</label>
          <input type="email" id="inv-email" placeholder="partner@example.com" required autofocus>
          <p class="form-hint">If they already have MiCal, they get a notification on next sign-in. Otherwise we'll give you a link to send them.</p>
        </div>
        <div class="form-group">
          <label for="inv-role">Role</label>
          <select id="inv-role">
            <option value="member" selected>Member — can see and share</option>
            <option value="admin">Admin — can also invite and remove</option>
          </select>
        </div>
      </form>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" id="inv-cancel">Cancel</button>
        <button class="btn btn-primary" type="submit" form="invite-form" id="inv-submit">Send invite</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#inv-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  overlay
    .querySelector("#invite-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = overlay.querySelector("#inv-email").value.trim();
      const role = overlay.querySelector("#inv-role").value;
      if (!email) return;
      const submit = overlay.querySelector("#inv-submit");
      submit.disabled = true;
      submit.textContent = "Sending…";
      try {
        const result = await api(`/api/groups/${currentGroupId}/invite`, {
          method: "POST",
          body: JSON.stringify({ email, role }),
        });
        if (result.invite_url) {
          // No MiCal account yet. Two paths:
          //   - email_sent: Resend delivered the invite → celebrate and close
          //   - else: surface the link as a fallback (Resend not configured,
          //     send failed, or inviter wants a backup channel)
          if (result.email_sent) {
            showSuccess(`Invitation emailed to ${email}.`);
            close();
            await loadGroupSettings();
          } else {
            showInviteLinkResult(
              overlay,
              email,
              result.invite_url,
              result.email_failure_reason,
            );
          }
        } else if (result.already_member) {
          showSuccess(`${email} is already a member.`);
          close();
          await loadGroupSettings();
        } else {
          showSuccess(`Invited ${email}.`);
          close();
          await loadGroupSettings();
        }
      } catch (err) {
        submit.disabled = false;
        submit.textContent = "Send invite";
        showError(err.message);
      }
    });
}

// Replace the form body with a copy-the-link state once we know the invitee
// isn't on MiCal yet. The link expires in 30 days; the dialog remembers
// what email it went to so the inviter can confirm.
function showInviteLinkResult(overlay, email, inviteUrl) {
  const dialog = overlay.querySelector(".invite-dialog");
  dialog.innerHTML = `
    <div class="modal-header">
      <h3>Invite ready to share</h3>
      <button class="modal-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <p><strong>${escapeHtml(email)}</strong> isn't on MiCal yet — that's fine. Send them this link:</p>
      <div class="invite-link-row">
        <input type="text" id="invite-link" readonly value="${escapeHtml(inviteUrl)}">
        <button class="btn btn-primary btn-sm" id="invite-copy">Copy</button>
      </div>
      <p class="form-hint">The link signs them in and joins them to the group automatically. Expires in 30 days.</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" type="button" id="invite-done">Done</button>
    </div>
  `;
  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    loadGroupSettings();
  };
  dialog.querySelector(".modal-close").addEventListener("click", close);
  dialog.querySelector("#invite-done").addEventListener("click", close);
  dialog.querySelector("#invite-copy").addEventListener("click", async () => {
    const input = dialog.querySelector("#invite-link");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
    }
    showSuccess("Link copied.");
  });
}

async function openShareDialog() {
  const shareableCals = calendars.filter(
    (c) =>
      c.provider !== "ics" &&
      !groupSettingsState.sharesData.mine.some((s) => s.calendar_id === c.id),
  );
  if (shareableCals.length === 0) {
    showError("All your calendars are already shared with this group.");
    return;
  }
  const labels = shareableCals.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
  const pick = prompt(`Pick a calendar to share:\n${labels}\n\nNumber:`);
  const idx = Number(pick) - 1;
  const cal = shareableCals[idx];
  if (!cal) return;
  try {
    await api(`/api/groups/${currentGroupId}/shares`, {
      method: "POST",
      body: JSON.stringify({ calendar_id: cal.id, share_level: "full" }),
    });
    showSuccess(`${cal.label} is now shared with the group.`);
    await loadGroupSettings();
  } catch (err) {
    showError(err.message);
  }
}

async function updateShareLevel(calendarId, level) {
  try {
    await api(`/api/groups/${currentGroupId}/shares/${calendarId}`, {
      method: "PATCH",
      body: JSON.stringify({ share_level: level }),
    });
    showSuccess("Share level updated.");
    await loadGroupSettings();
  } catch (err) {
    showError(err.message);
  }
}

async function removeShare(calendarId) {
  if (!confirm("Stop sharing this calendar with the group?")) return;
  try {
    await api(`/api/groups/${currentGroupId}/shares/${calendarId}`, {
      method: "DELETE",
    });
    await loadGroupSettings();
  } catch (err) {
    showError(err.message);
  }
}

async function updateReceiveSetting(sharerId, field, value) {
  try {
    await api(`/api/groups/${currentGroupId}/receive-settings/${sharerId}`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: value }),
    });
    // push_level toggles whole row of fields; target_calendar_id changes the
    // "needs target" warning. Both warrant a re-render.
    if (field === "push_level" || field === "target_calendar_id") {
      await loadGroupSettings();
    }
  } catch (err) {
    showError(err.message);
  }
}

async function updateMemberRole(userId, role) {
  try {
    await api(`/api/groups/${currentGroupId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    showSuccess("Role updated.");
    await loadGroupSettings();
  } catch (err) {
    showError(err.message);
    await loadGroupSettings(); // revert UI
  }
}

async function removeMember(userId, isSelf) {
  const msg = isSelf
    ? "Leave this group? You'll lose access to its shared calendars."
    : "Remove this member? They'll lose access immediately.";
  if (!confirm(msg)) return;
  try {
    await api(`/api/groups/${currentGroupId}/members/${userId}`, {
      method: "DELETE",
    });
    if (isSelf) {
      showSuccess("Left group.");
      currentGroupId = null;
      await loadGroups();
      showTab("overview");
    } else {
      showSuccess("Member removed.");
      await loadGroupSettings();
    }
  } catch (err) {
    showError(err.message);
  }
}

async function renameGroup() {
  const next = prompt("New group name:", groupSettingsState.detail.name);
  if (!next || !next.trim() || next === groupSettingsState.detail.name) return;
  try {
    await api(`/api/groups/${currentGroupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next.trim() }),
    });
    showSuccess("Renamed.");
    await loadGroups();
    await loadGroupSettings();
  } catch (err) {
    showError(err.message);
  }
}

// ─── Group schedule (merged view + availability widget) ───
//
// Two stacked sections:
//   1. Ask the family — quick what/when/duration → free or conflict
//   2. Agenda — events for the next 14 days, grouped by day, color-coded
//      by member. Free/busy events render as "Busy" rather than leaking
//      the title that the sharer didn't grant access to.
let groupScheduleState = {
  detail: null,
  events: [],
  availability: null, // { window, free, conflicts } from the most recent check
};

// Stable color per member id, pulled from a small palette and hashed by uuid.
const MEMBER_COLORS = [
  "#0F4C81",
  "#00C2A8",
  "#E07A5F",
  "#9B5DE5",
  "#3D5A80",
  "#EE6C4D",
  "#577590",
  "#E07856",
];
function colorForMember(userId) {
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MEMBER_COLORS[h % MEMBER_COLORS.length];
}

async function loadGroupSchedule() {
  const container = $("#group-schedule-content");
  if (!currentGroupId) {
    container.innerHTML = noGroupSelectedHtml("see its schedule");
    return;
  }
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading schedule…</div>';
  try {
    const [detail, eventsResp] = await Promise.all([
      api(`/api/groups/${currentGroupId}`),
      api(`/api/groups/${currentGroupId}/events`),
    ]);
    groupScheduleState.detail = detail;
    groupScheduleState.events = eventsResp.events || [];
    renderGroupSchedule();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderGroupSchedule() {
  const { detail, events, availability } = groupScheduleState;
  const container = $("#group-schedule-content");
  if (!detail) return;

  const memberLegend = (detail.members || [])
    .filter((m) => m.status === "active")
    .map((m) => {
      const display =
        m.display_name || (m.email || "").split("@")[0] || m.email;
      return `
        <span class="legend-chip">
          <span class="legend-dot" style="background:${colorForMember(m.user_id)}"></span>
          ${escapeHtml(display)}
        </span>
      `;
    })
    .join("");

  // Group events by local date for an agenda view. Headerless when empty
  // so we don't shout "Tuesday" with nothing under it.
  const buckets = bucketEventsByDay(events);
  const agendaHtml = buckets.length
    ? buckets.map(renderDayBucket).join("")
    : `
      <div class="card empty-hero">
        <h2>Nothing on the calendar</h2>
        <p>Nobody's shared an event in the next two weeks. ${
          detail.my_role === "owner" || detail.my_role === "admin"
            ? 'Need to <a href="#" onclick="showTab(\'group-settings\');return false;">change sharing settings</a>?'
            : "Check back later."
        }</p>
      </div>
    `;

  container.innerHTML = `
    <div class="card schedule-ask">
      <div class="card-header"><div class="card-title">Ask the ${detail.type === "family" ? "family" : "team"}</div></div>
      <p class="muted">Will it work? Pick a time and we'll check everyone's calendars.</p>
      <form id="ask-form" class="ask-form" onsubmit="checkAvailability(event)">
        <div class="ask-fields">
          <label class="field-inline">
            <span>What</span>
            <input type="text" id="ask-what" placeholder="Dinner with the Smiths" required>
          </label>
          <label class="field-inline">
            <span>When</span>
            <input type="datetime-local" id="ask-when" required>
          </label>
          <label class="field-inline">
            <span>Duration</span>
            <select id="ask-duration">
              <option value="30">30 min</option>
              <option value="60">1 hour</option>
              <option value="90">1.5 hours</option>
              <option value="120" selected>2 hours</option>
              <option value="180">3 hours</option>
            </select>
          </label>
          <button type="submit" class="btn btn-primary">Check</button>
        </div>
      </form>
      ${availability ? renderAvailabilityResult(availability, detail) : ""}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Next 14 days</div>
        <div class="schedule-actions">
          <button class="btn btn-secondary btn-sm" onclick="openScheduleSubscribe()" title="Subscribe in your calendar app">
            ${icon("calendar", 14)} Subscribe
          </button>
          <div class="member-legend">${memberLegend}</div>
        </div>
      </div>
      ${agendaHtml}
    </div>
  `;
}

// Subscribe modal — fetches the signed feed URL and shows webcal:// + https
// flavors with copy buttons. Subscribe URL opens calendar apps; download URL
// is the one-shot iCal download.
async function openScheduleSubscribe() {
  if (!currentGroupId) return;
  let urls;
  try {
    urls = await api(`/api/groups/${currentGroupId}/feed-url`);
  } catch (err) {
    showError(err.message);
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog booking-url-dialog">
      <div class="modal-header">
        <h3>Subscribe in your calendar</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p>One link, auto-updates as plans change. The events you can already see in this Schedule will appear in your usual calendar app — alongside everything else.</p>
        <p><strong>Open with your calendar app:</strong></p>
        <div class="invite-link-row">
          <a id="sub-link" class="btn btn-primary btn-block" href="">Subscribe now</a>
        </div>
        <p class="form-hint">Tapping the button opens Google Calendar / Apple Calendar / Outlook in subscribe mode. If your app doesn't open automatically, copy the link below and add it as a "calendar from URL".</p>
        <div class="invite-link-row" style="margin-top:16px">
          <input type="text" id="sub-url" readonly value="">
          <button class="btn btn-secondary btn-sm" id="sub-copy">Copy</button>
        </div>
        <p class="form-hint muted">Privacy: this link is unguessable but isn't password-protected. Anyone who has it can read what's on this Schedule. You can rotate it by removing yourself from the group and rejoining (rare but possible).</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" type="button" id="sub-done">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#sub-done").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector("#sub-link").href = urls.subscribe_url;
  overlay.querySelector("#sub-url").value = urls.subscribe_url;
  overlay.querySelector("#sub-copy").addEventListener("click", async () => {
    const input = overlay.querySelector("#sub-url");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
    }
    showSuccess("Link copied.");
  });
}

function bucketEventsByDay(events) {
  const map = new Map();
  for (const e of events) {
    const ms = e.start?.dateTime
      ? Date.parse(e.start.dateTime)
      : e.start?.date
        ? Date.parse(`${e.start.date}T00:00:00`)
        : null;
    if (!ms) continue;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { key, date: d, items: [] });
    map.get(key).items.push(e);
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function renderDayBucket({ date, items }) {
  const isToday = isSameDay(date, new Date());
  const isTomorrow = isSameDay(date, new Date(Date.now() + 24 * 3600 * 1000));
  const label = isToday
    ? "Today"
    : isTomorrow
      ? "Tomorrow"
      : date.toLocaleDateString(undefined, {
          weekday: "long",
          month: "short",
          day: "numeric",
        });

  return `
    <div class="day-bucket">
      <h3 class="day-header">${escapeHtml(label)}</h3>
      <div class="day-events">
        ${items.map(renderScheduleEvent).join("")}
      </div>
    </div>
  `;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function renderScheduleEvent(e) {
  const color = colorForMember(e.sharer_user_id);
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  const isAllDay = !!e.start?.date;
  const time = isAllDay
    ? "All day"
    : start
      ? `${formatTime(start)}${end ? ` – ${formatTime(end)}` : ""}`
      : "";
  const title = e.level === "free_busy" ? "Busy" : e.summary || "(Untitled)";
  const titleClass =
    e.level === "free_busy" ? "event-title muted" : "event-title";
  return `
    <div class="schedule-event" style="--member-color: ${color}">
      <span class="event-time">${escapeHtml(time)}</span>
      <span class="event-bar"></span>
      <div class="event-body">
        <div class="${titleClass}">${escapeHtml(title)}</div>
        <div class="event-meta">
          <span class="event-member">${escapeHtml(e.sharer_display)}</span>
          ${e.location ? ` · <span class="event-location">${escapeHtml(e.location)}</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderAvailabilityResult(av, detail) {
  if (av.free) {
    return `
      <div class="ask-result ask-ok">
        ${icon("check", 18)}
        <div>
          <strong>All free.</strong>
          <div class="muted">Nobody in the ${detail.type === "family" ? "family" : "team"} has a conflict for that time.</div>
        </div>
      </div>
    `;
  }
  // Find display names for busy members
  const memberById = new Map(
    (detail.members || []).map((m) => [
      m.user_id,
      m.display_name || (m.email || "").split("@")[0] || m.email,
    ]),
  );
  const busyNames = av.busyMemberIds.map(
    (id) => memberById.get(id) || "Someone",
  );
  return `
    <div class="ask-result ask-conflict">
      ${icon("trash", 18)}
      <div>
        <strong>${escapeHtml(busyNames.join(", "))} ${busyNames.length === 1 ? "has" : "have"} a conflict.</strong>
        <div class="muted">${av.conflicts.length} overlapping event${av.conflicts.length === 1 ? "" : "s"} in that window.</div>
      </div>
    </div>
  `;
}

async function checkAvailability(e) {
  e.preventDefault();
  const what = $("#ask-what").value.trim();
  const whenLocal = $("#ask-when").value;
  const duration = Number($("#ask-duration").value) || 60;
  if (!what || !whenLocal) return;
  // datetime-local has no timezone; treat as local time and convert to ISO.
  const start = new Date(whenLocal);
  if (Number.isNaN(start.getTime())) {
    showError("Invalid date/time.");
    return;
  }
  try {
    const result = await api(
      `/api/groups/${currentGroupId}/availability?start=${encodeURIComponent(start.toISOString())}&duration=${duration}`,
    );
    groupScheduleState.availability = result;
    renderGroupSchedule();
  } catch (err) {
    showError(err.message);
  }
}

async function deleteCurrentGroup() {
  const name = groupSettingsState.detail.name;
  const typed = prompt(
    `This permanently deletes "${name}" and all sharing settings.\nType the group name to confirm:`,
  );
  if (typed !== name) {
    if (typed != null) showError("Name didn't match — group not deleted.");
    return;
  }
  try {
    await api(`/api/groups/${currentGroupId}`, { method: "DELETE" });
    showSuccess(`"${name}" deleted.`);
    currentGroupId = null;
    await loadGroups();
    showTab("overview");
  } catch (err) {
    showError(err.message);
  }
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

  // Update nav active state. Per-group sub-items are tagged with
  // data-group-tab="<groupId>:<tab>"; the static items use data-tab.
  $$(".nav-item").forEach((btn) => {
    if (btn.dataset.groupTab) {
      btn.classList.toggle(
        "active",
        btn.dataset.groupTab === `${currentGroupId}:${tab}`,
      );
    } else {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
  });
  // Section-level highlight only when we're actually inside a group tab —
  // otherwise the highlight gives a misleading "you're in this group" cue
  // while the user is browsing personal Calendars/Bookings/etc.
  const isGroupTab = tab === "group-schedule" || tab === "group-settings";
  $$(".sidebar-group").forEach((s) => {
    s.classList.toggle(
      "active",
      isGroupTab && s.dataset.groupId === currentGroupId,
    );
  });

  // Hide all pages
  $$(".tab-page").forEach((page) => (page.style.display = "none"));

  // Show selected page
  const page = $(`#tab-${tab}`);
  if (page) page.style.display = "block";

  // Update page title. Group-scoped tabs prefix with the group name so the
  // top bar always tells you where you are — useful on mobile where the
  // sidebar is hidden, and when the user has multiple groups in the sidebar.
  const titles = {
    overview: "Dashboard",
    calendars: "Calendars",
    "sync-flows": "Sync Flows",
    "event-types": "Event Types",
    bookings: "Bookings",
    polls: "Polls",
    "group-settings": "Group settings",
    "group-schedule": "Schedule",
  };
  const titleEl = $("#page-title");
  if (titleEl) {
    let title = titles[tab] || "Dashboard";
    if (
      currentGroupId != null &&
      (tab === "group-schedule" || tab === "group-settings")
    ) {
      const g = (groups || []).find((g) => g.id === currentGroupId);
      if (g) title = `${g.name} · ${title}`;
    }
    titleEl.textContent = title;
  }

  // Close mobile sidebar
  $(".sidebar").classList.remove("open");
  $(".sidebar-overlay").classList.remove("open");

  // Load data
  if (tab === "overview") loadOverview();
  if (tab === "calendars") loadCalendars();
  if (tab === "sync-flows") loadSyncFlows();
  if (tab === "event-types") loadEventTypes();
  if (tab === "bookings") loadBookings();
  if (tab === "polls") loadPolls();
  if (tab === "group-settings") loadGroupSettings();
  if (tab === "group-schedule") loadGroupSchedule();
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
    maybeShowWelcomeModal(overview?.counts);
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
        ${illustration("calendar", 96)}
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

  // "What's next" guidance card. Shows once the user has connected something
  // but hasn't accumulated much else — disappears as they fill the boxes.
  // Designed as the secondary onboarding step after the welcome modal.
  const whatsNextHtml = renderWhatsNextCard(c);

  container.innerHTML = `
    <div class="stats-grid">${statusCards}</div>
    ${attentionHtml}
    ${whatsNextHtml}
    ${activityHtml}
    <div class="card">
      <div class="card-header"><div class="card-title">Quick actions</div></div>
      <div class="quick-actions">${quickActions.join("")}</div>
    </div>
  `;
}

// Returns the "What's next" guidance card, or "" if the user has progressed
// far enough that the card adds noise. The thresholds are deliberately
// permissive — somebody with 1 calendar and 3 sync flows but no group is
// still a candidate for the family pitch.
function renderWhatsNextCard(c) {
  if (!c || c.calendars === 0) return ""; // welcome modal or empty hero handles this
  const hasSyncFlows = c.syncFlows > 0;
  const hasGroup = (groups || []).length > 0;
  const hasEventTypes = c.eventTypes > 0;
  const moreThanOneCal = c.calendars > 1;

  // If the user already has a group AND sync flows AND event types, they're
  // past the "what's next" phase — go quiet.
  const itemsCount = [hasSyncFlows, hasGroup, hasEventTypes].filter(
    Boolean,
  ).length;
  if (itemsCount >= 2) return "";

  // Otherwise, surface the missing-piece options. Each links to its tab.
  const cards = [];
  if (!moreThanOneCal) {
    cards.push({
      illust: "calendar",
      title: "Connect another calendar",
      body: "Got Outlook on top of Google? Or a school ICS feed? Add them so MiCal can see the whole picture.",
      cta: "Add calendar",
      onclick: "showTab('calendars')",
    });
  }
  if (!hasSyncFlows) {
    cards.push({
      illust: "sync",
      title: "Bridge two calendars",
      body: 'Copy events from one calendar to another, with rules. "Push my Outlook events to my personal Google as busy blocks."',
      cta: "Create a sync flow",
      onclick: "showTab('sync-flows')",
    });
  }
  if (!hasGroup) {
    cards.push({
      illust: "home",
      title: "Share with your family or team",
      body: 'See everyone\'s schedule in one place — across providers. Unlocks the merged Schedule tab and "Ask the family" availability checks.',
      cta: "Create a group",
      onclick: "openCreateGroupDialog()",
    });
  }
  if (!hasEventTypes) {
    cards.push({
      illust: "list",
      title: "Set up a booking page",
      body: "Share a link. Clients pick a time. It lands on your calendar — no account needed for them.",
      cta: "Set up event type",
      onclick: "showTab('event-types')",
    });
  }
  if (cards.length === 0) return "";

  return `
    <div class="card whats-next-card">
      <div class="card-header"><div class="card-title">What's next?</div></div>
      <div class="whats-next-grid">
        ${cards
          .map(
            (c) => `
          <article class="whats-next-item">
            <div class="whats-next-illust">${illustration(c.illust, 56)}</div>
            <h4>${escapeHtml(c.title)}</h4>
            <p>${escapeHtml(c.body)}</p>
            <button class="btn btn-secondary btn-sm" onclick="${c.onclick}">${escapeHtml(c.cta)}</button>
          </article>
        `,
          )
          .join("")}
      </div>
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
        ${illustration("calendar", 96)}
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
      <!-- Single "Connect" dropdown collapses what was three separate buttons
           (+ Google / + Outlook / Discover). Discover lives inside the menu
           too — it's the path you'd take after connecting another Google
           account that has more calendars to import. -->
      <div class="connect-wrap">
        <button class="btn btn-primary btn-sm" type="button" id="connect-toggle" aria-haspopup="true" aria-expanded="false" onclick="toggleConnectMenu()">
          ${icon("plus", 14)} Connect another account
          <span class="dropdown-chevron">▾</span>
        </button>
        <div class="connect-menu" id="connect-menu" hidden>
          <a class="connect-item" href="/api/oauth/google/init">
            <span>Google</span>
            <span class="muted">Google Calendar / Workspace</span>
          </a>
          <a class="connect-item" href="/api/oauth/microsoft/init">
            <span>Microsoft</span>
            <span class="muted">Outlook / Office 365</span>
          </a>
          <button class="connect-item" type="button" onclick="closeConnectMenu(); toggleIcsForm(true)">
            <span>ICS feed</span>
            <span class="muted">Subscribe by URL (read-only)</span>
          </button>
          <div class="connect-sep"></div>
          <button class="connect-item" type="button" onclick="closeConnectMenu(); discoverCalendars()">
            <span>Browse calendars to import</span>
            <span class="muted">From accounts already connected</span>
          </button>
        </div>
      </div>
    </div>
    ${accountsHtml}
    ${icsHtml}
    ${renderIcsForm({ initiallyHidden: true })}
  `;
}

// Connect-account dropdown helpers. Click-outside closes; Escape too.
function toggleConnectMenu() {
  const menu = document.getElementById("connect-menu");
  const btn = document.getElementById("connect-toggle");
  if (!menu || !btn) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}
function closeConnectMenu() {
  const menu = document.getElementById("connect-menu");
  const btn = document.getElementById("connect-toggle");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}
document.addEventListener("click", (e) => {
  const wrap = e.target.closest?.(".connect-wrap");
  if (!wrap) closeConnectMenu();
});

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
    body.innerHTML = emptyState({
      illustrationName: "search",
      headline: "No calendars found",
      subhead:
        "Link a Google or Outlook account first, then come back to discover.",
    });
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
    listHtml = emptyState({
      illustrationName: "sync",
      headline: "Set up your first sync flow",
      subhead:
        "Tell MiCal to copy events from one calendar to another. Set rules once — they run automatically.",
    });
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
          <!-- Priority lives in Advanced now — most users never need it,
               and a number input next to the source/target dropdowns
               implied otherwise. Hidden field carries the value through
               for new flows; the Advanced block re-exposes it for editing. -->
          <input type="hidden" id="sf-ord" value="0">
        </div>

        <!-- Rule toggles. Replaces the v1 dual NL+toggle paradigm — the
             "type a sentence and watch toggles round-trip" flow looked
             clever and confused everyone in practice. Toggles are the
             source of truth; the saved-flow table still summarizes rules
             in plain English via optionsToNaturalLanguage() for skim
             reading. Essentials always visible; the buffer/work-hours
             group folds behind a single Advanced expand. -->
        <div class="rule-section">
          <div class="rule-section-title">When should this run?</div>
          <div class="rule-row">
            <label class="toggle-row">
              <span>Weekdays only</span>
              <span class="toggle">
                <input type="checkbox" id="sf-weekdays">
                <span class="toggle-slider"></span>
              </span>
            </label>
            <label class="toggle-row">
              <span>Only during work hours</span>
              <span class="toggle">
                <input type="checkbox" id="sf-workhours">
                <span class="toggle-slider"></span>
              </span>
            </label>
          </div>
        </div>

        <div class="rule-section">
          <div class="rule-section-title">What should land on the target?</div>
          <div class="rule-row">
            <label class="toggle-row">
              <span>Copy the event title</span>
              <span class="toggle">
                <input type="checkbox" id="sf-copy-title" checked>
                <span class="toggle-slider"></span>
              </span>
            </label>
            <label class="toggle-row">
              <span>Copy the description</span>
              <span class="toggle">
                <input type="checkbox" id="sf-copy-desc">
                <span class="toggle-slider"></span>
              </span>
            </label>
            <label class="toggle-row">
              <span>Mark as private</span>
              <span class="toggle">
                <input type="checkbox" id="sf-private">
                <span class="toggle-slider"></span>
              </span>
            </label>
          </div>
        </div>

        <button type="button" class="advanced-toggle" id="sf-adv-toggle" onclick="toggleAdvancedOptions()" aria-expanded="false">
          <span class="advanced-chevron" id="adv-toggle-icon">▸</span> Advanced timing
        </button>

        <div id="sf-advanced" class="advanced-fields" style="display:none;">
          <div class="form-row">
            <div class="form-group">
              <label for="sf-work-start">Work hours — from</label>
              <input type="time" id="sf-work-start" value="09:00">
            </div>
            <div class="form-group">
              <label for="sf-work-end">Work hours — to</label>
              <input type="time" id="sf-work-end" value="17:00">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="sf-buffer-before">Buffer before booking</label>
              <input type="number" id="sf-buffer-before" value="0" min="0"> <span class="form-suffix">min</span>
            </div>
            <div class="form-group">
              <label for="sf-buffer-after">Buffer after booking</label>
              <input type="number" id="sf-buffer-after" value="0" min="0"> <span class="form-suffix">min</span>
            </div>
          </div>
          <div class="form-group">
            <label for="sf-ord-visible">Priority</label>
            <input type="number" id="sf-ord-visible" value="0" min="0"
                   oninput="document.getElementById('sf-ord').value = this.value">
            <p class="form-hint">Lower runs first. Leave at 0 unless one flow needs to chain after another.</p>
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
    const ordVisible = $("#sf-ord-visible");
    if (ordVisible) ordVisible.value = editFlow.ord;
    // Auto-expand Advanced when editing a flow that has a non-default
    // priority — otherwise the user wonders where it went.
    if (Number(editFlow.ord) !== 0) toggleAdvancedOptions();
    $("#sf-enabled").checked = editFlow.enabled;
    const opts = editFlow.options_json ? JSON.parse(editFlow.options_json) : {};
    syncFormFromOptions(opts);
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
  const toggle = $("#sf-adv-toggle");
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  if (icon) icon.textContent = open ? "▸" : "▾";
  if (toggle) toggle.setAttribute("aria-expanded", String(!open));
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

// optionsToNaturalLanguage stays — it's used purely for display in the
// flows table to give a human-readable summary of saved rules. The bidi
// NL ↔ form parser was removed when we collapsed to a toggles-only form.
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
    // Two paths: a one-click "use the smart defaults" (25/50 with built-in
    // buffers per docnotes.net/why-i-schedule-25-minute-meetings/), and the
    // existing custom-create flow below the fold. Defaults need a writable
    // calendar — gate the CTA on that.
    const writableCal = (calendars || []).find(
      (c) => c.provider !== "ics" && c.enabled,
    );
    const defaultsCta = writableCal
      ? `<button class="btn btn-primary" onclick="seedDefaultEventTypes()">Use 25 + 50-minute defaults</button>`
      : "";
    listHtml = `
      <div class="empty-state">
        ${illustration("list")}
        <h3>Set up a booking page</h3>
        <p>We'll create two — 25 minutes and 50 minutes — with built-in buffers so back-to-back meetings actually leave room to breathe.</p>
        <div class="empty-state-cta" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
          ${defaultsCta}
        </div>
        <details class="rationale">
          <summary>Why 25 and 50, not 30 and 60?</summary>
          <div class="rationale-body">
            <p><strong>The 5-minute "between meetings" never actually materializes.</strong> A 30-minute meeting consumes 30 minutes — the host wraps up at the top of the hour, the next meeting starts immediately, the bathroom break never happens. By scheduling 25-minute meetings with a built-in 5-minute buffer (50-minute with 10), the recovery time is structural rather than aspirational.</p>
            <p><strong>The brain agrees.</strong> Microsoft's EEG research found that beta-wave stress accumulates linearly across back-to-back meetings; even short breaks between them flatten the curve. Focused-attention research also shows group conversations decline in productivity around the 20–30 minute mark — keeping discussions inside that "golden window" beats letting them sprawl to fill the hour.</p>
            <p><strong>And there's Parkinson's law.</strong> A 15-minute decision scheduled for 60 minutes will somehow consume the full hour. Tighter time constraints force sharper conversations.</p>
            <p class="muted">More: <a href="https://docnotes.net/2026/05/08/why-i-schedule-25-minute-meetings/" target="_blank" rel="noopener">Why I schedule 25-minute meetings</a>.</p>
          </div>
        </details>
        <p class="muted" style="margin-top:8px">Or scroll down to set up a custom one.</p>
      </div>
    `;
  } else {
    // Replaced "Slug" column with "Booking URL" — that's the answer to
    // "where do I send people?". Click-to-copy + new-tab open.
    const tenantSlug = currentUser?.tenant_slug || "";
    const baseOrigin = window.location.origin;
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Booking URL</th><th>Duration</th><th>Target</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${eventTypes
              .map((et) => {
                const url = tenantSlug
                  ? `${baseOrigin}/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(et.slug)}`
                  : "";
                return `
              <tr data-id="${escapeHtml(et.id)}">
                <td><strong>${escapeHtml(et.name)}</strong></td>
                <td>
                  ${
                    url
                      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="booking-url-cell" title="${escapeHtml(url)}">/b/${escapeHtml(tenantSlug)}/${escapeHtml(et.slug)}</a>
                       <button class="icon-btn" title="Copy URL" onclick="copyToClipboard('${escapeHtml(url)}')">${icon("check", 14)}</button>`
                      : `<span class="muted">—</span>`
                  }
                </td>
                <td>${et.duration_min} min</td>
                <td>${calendarLabel(et.target_calendar_id)}</td>
                <td>${et.enabled ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Disabled</span>'}</td>
                <td>
                  <div class="actions">
                    <button class="icon-btn" onclick="editEventType('${escapeHtml(et.id)}')" title="Edit">${icon("edit", 14)}</button>
                    <button class="icon-btn danger" onclick="deleteEventType('${escapeHtml(et.id)}')" title="Delete">${icon("trash", 14)}</button>
                  </div>
                </td>
              </tr>`;
              })
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

        <!-- Slug is auto-generated from the name and never user-editable.
             It's just a URL detail — exposing it as a "URL slug" field
             made users wonder what to type. We hide it entirely; the
             form-load handler still populates it for edits, and the
             submit handler reads it. -->
        <input type="hidden" id="et-slug" value="">

        <div class="advanced-fields" id="advanced-fields" style="display:none">
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

// Pre-seed 25 + 50 minute event types with built-in buffers, leveraging
// the back-to-back-meetings recovery argument from docnotes.net. Defaults:
//   - weekdays Mon–Fri, 9–5
//   - lead 0, horizon 25 days
//   - target = first writable calendar
//   - location = Google Meet
// The user lands on the populated list and can edit anything.
async function seedDefaultEventTypes() {
  const target = (calendars || []).find(
    (c) => c.provider !== "ics" && c.enabled,
  );
  if (!target) {
    showError("Connect a Google or Outlook calendar first.");
    return;
  }
  const common = {
    weekdays_mask: 31, // Mon–Fri (1+2+4+8+16)
    work_hours_json: JSON.stringify({ start: "09:00", end: "17:00" }),
    target_calendar_id: target.id,
    location_mode: "meet",
    lead_min: 0,
    horizon_days: 25,
    enabled: 1,
  };
  const defaults = [
    {
      ...common,
      slug: "25",
      name: "25-minute meeting",
      duration_min: 25,
      buffer_min: 5, // 5-min recovery between bookings
    },
    {
      ...common,
      slug: "50",
      name: "50-minute meeting",
      duration_min: 50,
      buffer_min: 10, // 10-min recovery
    },
  ];
  try {
    // POST sequentially so we surface a clear error on the second if the
    // first creates a conflict (slug uniqueness etc.).
    const created = [];
    for (const body of defaults) {
      const ev = await api("/api/event-types", {
        method: "POST",
        body: JSON.stringify(body),
      });
      created.push(ev);
    }
    eventTypes = await api("/api/event-types");
    renderEventTypes();
    showSuccess("Created 25-minute and 50-minute booking pages.");
    // Show the first URL prominently — user can grab the second from the list.
    if (created[0]) showBookingUrlModal(created[0]);
  } catch (err) {
    showError(err.message);
  }
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
      showSuccess("Booking page updated.");
    } else {
      const created = await api("/api/event-types", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // Surface the public URL prominently — the user just made one and
      // the next thing they want to know is "where is it?".
      showBookingUrlModal(created);
    }
    $("#event-type-form").reset();
    eventTypes = await api("/api/event-types");
    renderEventTypes();
  } catch (err) {
    showError(err.message);
  }
}

// Modal that shows the freshly-minted booking URL with a copy button.
// Called after POST /api/event-types succeeds. We compose the URL from the
// tenant slug (in /api/auth/me) and the event-type slug.
function showBookingUrlModal(eventType) {
  const tenantSlug = currentUser?.tenant_slug;
  if (!tenantSlug || !eventType?.slug) return;
  const base = window.location.origin;
  const url = `${base}/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(eventType.slug)}`;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog booking-url-dialog">
      <div class="modal-header">
        <h3>Your booking page is live</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p>Share this link with anyone who wants to book a <strong>${escapeHtml(eventType.name)}</strong> with you:</p>
        <div class="invite-link-row">
          <input type="text" id="bk-link" readonly value="${escapeHtml(url)}">
          <button class="btn btn-primary btn-sm" id="bk-copy">Copy</button>
        </div>
        <p class="form-hint">No account required for the person booking. They pick a time, fill out their details, and it lands on your calendar.</p>
      </div>
      <div class="modal-footer">
        <a class="btn btn-secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open page</a>
        <button class="btn btn-primary" type="button" id="bk-done">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#bk-done").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#bk-copy").addEventListener("click", async () => {
    const input = overlay.querySelector("#bk-link");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
    }
    showSuccess("Link copied.");
  });
}

function editEventType(id) {
  editingEventTypeId = id;
  renderEventTypes();
  // Form lives below the table — without scrolling, "edit" looked like a
  // no-op to anyone scrolled to the top of the list. requestAnimationFrame
  // gives the new DOM a beat to lay out before we measure.
  requestAnimationFrame(() => {
    const form = document.getElementById("event-type-form");
    if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
  });
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
    listHtml = emptyState({
      illustrationName: "book",
      headline: "Bookings show up here",
      subhead: "Share one of your event types and watch this fill up.",
    });
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

// ─── Polls ───
//
// Organizer-side: list of polls owned by the tenant + a create dialog + a
// per-poll detail view with a tally grid and a "Pick this slot" action that
// schedules a real calendar event with all responders as attendees.

let pollsList = [];
let viewingPollId = null;
let viewingPollDetail = null;

async function loadPolls() {
  // Reset detail view when re-entering the tab — the user expects the list.
  viewingPollId = null;
  viewingPollDetail = null;
  const container = $("#polls-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading polls…</div>';
  try {
    pollsList = await api("/api/polls");
    renderPollsList();
  } catch (err) {
    if (err.message !== "unauthorized") {
      container.innerHTML = `<div class="error-banner">Failed to load polls: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function viewPoll(id) {
  viewingPollId = id;
  const container = $("#polls-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading poll…</div>';
  try {
    viewingPollDetail = await api(`/api/polls/${id}`);
    renderPollDetail();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">Failed to load poll: ${escapeHtml(err.message)}</div>`;
  }
}

function backToPollsList() {
  viewingPollId = null;
  viewingPollDetail = null;
  renderPollsList();
}

function pollPublicUrl(token) {
  return `${window.location.origin}/poll/${token}`;
}

function renderPollsList() {
  const container = $("#polls-content");
  clearErrors(container);

  let body = "";
  if (pollsList.length === 0) {
    body = emptyState({
      illustrationName: "list",
      headline: "Run your first meeting poll",
      subhead:
        "Propose a few times, share the link, let everyone pick what works. Respondents who sign in see each slot pre-marked free or busy from their own calendar.",
      ctaLabel: "New poll",
      ctaOnclick: "openCreatePollDialog()",
    });
  } else {
    body = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Title</th><th>Status</th><th>Slots</th><th>Responses</th><th>Created</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${pollsList
              .map((p) => {
                const url = pollPublicUrl(p.token);
                return `
                <tr data-id="${escapeHtml(p.id)}">
                  <td><a href="#" onclick="viewPoll('${escapeHtml(p.id)}');return false;">${escapeHtml(p.title)}</a></td>
                  <td>${statusBadge(p.status)}</td>
                  <td>${p.option_count}</td>
                  <td>${p.response_count}</td>
                  <td>${formatDate(p.created_at)}</td>
                  <td class="actions">
                    <button class="btn btn-secondary btn-sm" onclick="viewPoll('${escapeHtml(p.id)}')" title="View responses">View</button>
                    <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${escapeHtml(url)}')" title="Copy share link">Copy link</button>
                    <button class="icon-btn danger" onclick="deletePoll('${escapeHtml(p.id)}', '${escapeHtml(p.title)}')" title="Delete">${icon("trash", 14)}</button>
                  </td>
                </tr>
              `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Polls</div>
        ${pollsList.length > 0 ? '<button class="btn btn-primary btn-sm" onclick="openCreatePollDialog()">New poll</button>' : ""}
      </div>
      ${body}
    </div>
  `;
}

async function deletePoll(id, title) {
  if (!confirm(`Delete poll "${title}"? This is permanent.`)) return;
  try {
    await api(`/api/polls/${id}`, { method: "DELETE" });
    showSuccess("Poll deleted.");
    await loadPolls();
  } catch (err) {
    showError(err.message);
  }
}

// Create-poll modal. Datetime rows let the organizer add as many candidate
// slots as they want; we ship a sensible default of three blank rows so the
// UI is usable immediately. The same modal pattern as create-group dialog.
function openCreatePollDialog() {
  $(".sidebar")?.classList.remove("open");
  $(".sidebar-overlay")?.classList.remove("open");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog create-poll-dialog">
      <div class="modal-header">
        <h3>New poll</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <form id="create-poll-form" class="modal-body">
        <div class="form-group">
          <label for="cp-title">Title</label>
          <input type="text" id="cp-title" placeholder="e.g. Q1 planning sync" required maxlength="120" autofocus>
        </div>
        <div class="form-group">
          <label for="cp-description">Description <span class="optional">(optional)</span></label>
          <textarea id="cp-description" rows="2" placeholder="What's this meeting for?" maxlength="500"></textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="cp-duration">Duration</label>
            <select id="cp-duration">
              <option value="15">15 min</option>
              <option value="25">25 min</option>
              <option value="30" selected>30 min</option>
              <option value="45">45 min</option>
              <option value="50">50 min</option>
              <option value="60">1 hour</option>
            </select>
          </div>
          <div class="form-group">
            <label for="cp-location">Location <span class="optional">(optional)</span></label>
            <input type="text" id="cp-location" placeholder="e.g. Zoom, our office, Meet" maxlength="200">
          </div>
        </div>
        <div class="form-group">
          <label class="toggle-label">
            <input type="checkbox" id="cp-require-email" checked>
            <span>Require respondents to provide an email</span>
          </label>
          <p class="muted" style="margin-top:4px">Off means anonymous votes are allowed. We can't notify them of the winner.</p>
        </div>
        <div class="form-group">
          <label>Candidate times</label>
          <div id="cp-options"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="cp-add-option" style="margin-top:8px">+ Add another time</button>
        </div>
      </form>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" id="cp-cancel">Cancel</button>
        <button class="btn btn-primary" type="submit" form="create-poll-form" id="cp-submit">Create poll</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const optsEl = overlay.querySelector("#cp-options");
  // Seed three rows for the default poll shape.
  for (let i = 0; i < 3; i++) appendOptionRow(optsEl);
  overlay
    .querySelector("#cp-add-option")
    .addEventListener("click", () => appendOptionRow(optsEl));

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#cp-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  overlay
    .querySelector("#create-poll-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = overlay.querySelector("#cp-submit");
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating…";

      const title = overlay.querySelector("#cp-title").value.trim();
      const description = overlay.querySelector("#cp-description").value.trim();
      const duration_min = Number(overlay.querySelector("#cp-duration").value);
      const location_text = overlay.querySelector("#cp-location").value.trim();
      const require_email = overlay.querySelector("#cp-require-email").checked;

      // Pull options. Empty rows are silently dropped — lets the user leave
      // extra blank rows without forcing them to delete each one.
      const options = [];
      for (const input of optsEl.querySelectorAll(
        "input[type=datetime-local]",
      )) {
        const v = input.value;
        if (!v) continue;
        const ms = new Date(v).getTime();
        if (Number.isFinite(ms)) options.push({ start_ms: ms });
      }

      if (options.length < 2) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create poll";
        showError("Pick at least two candidate times.");
        return;
      }

      try {
        const created = await api("/api/polls", {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            duration_min,
            location_text,
            require_email,
            options,
          }),
        });
        close();
        await loadPolls();
        const url = pollPublicUrl(created.poll.token);
        copyToClipboard(url);
        showSuccess(`Poll created. Share link copied to clipboard.`);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create poll";
        showError(err.message);
      }
    });
}

function appendOptionRow(optsEl) {
  const row = document.createElement("div");
  row.className = "poll-option-row";
  row.style.cssText =
    "display:flex;gap:8px;margin-bottom:6px;align-items:center";
  row.innerHTML = `
    <input type="datetime-local" style="flex:1">
    <button type="button" class="icon-btn" title="Remove">${icon("trash", 14)}</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  optsEl.appendChild(row);
}

// Detail view: tally grid (rows = respondents, columns = options) + a
// "Pick this slot" button per option that opens the schedule dialog.
function renderPollDetail() {
  const container = $("#polls-content");
  if (!viewingPollDetail) {
    container.innerHTML =
      '<div class="loading"><div class="spinner"></div>Loading poll…</div>';
    return;
  }
  const { poll, options, responses } = viewingPollDetail;
  const url = pollPublicUrl(poll.token);
  const isOpen = poll.status === "open" || poll.status === "closed";

  // Header bar
  const headerActions = `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${escapeHtml(url)}')">Copy share link</button>
      <a class="btn btn-secondary btn-sm" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open public page</a>
      ${
        poll.status === "open"
          ? `<button class="btn btn-secondary btn-sm" onclick="closePoll('${escapeHtml(poll.id)}')">Close voting</button>`
          : ""
      }
      <button class="icon-btn danger" onclick="deletePoll('${escapeHtml(poll.id)}','${escapeHtml(poll.title)}')" title="Delete">${icon("trash", 14)}</button>
    </div>
  `;

  // Tally grid: header row of options with vote counts and "Pick" buttons
  // when the poll is still pickable; body rows of respondents marking their
  // ✓ / ✗ on each option.
  let tally = "";
  if (options.length === 0) {
    tally = `<p class="muted">This poll has no options.</p>`;
  } else if (responses.length === 0) {
    tally = `<p class="muted">No responses yet. Share the link and check back.</p>`;
  } else {
    const optHeader = options
      .map((o) => {
        const isWinner = poll.selected_option_id === o.id;
        const pickBtn = isOpen
          ? `<button class="btn btn-primary btn-sm" style="margin-top:6px" onclick="openScheduleDialog('${escapeHtml(poll.id)}','${escapeHtml(o.id)}')">Pick this slot</button>`
          : isWinner
            ? `<div style="margin-top:6px"><span class="scheduled-pill">Scheduled</span></div>`
            : "";
        return `
        <th style="white-space:nowrap${isWinner ? ";background:rgba(56,161,105,0.06)" : ""}">
          <div>${escapeHtml(formatDate(o.start_ms))}</div>
          <div class="muted" style="font-size:0.8rem">${o.votes} of ${responses.length} say yes</div>
          ${pickBtn}
        </th>
      `;
      })
      .join("");
    const rows = responses
      .map((r) => {
        const who = escapeHtml(r.name || r.email || "Anonymous");
        const cells = options
          .map((o) => {
            const picked = r.picked_option_ids.includes(o.id);
            return `<td style="text-align:center;font-size:1.1rem">${picked ? "✓" : "—"}</td>`;
          })
          .join("");
        return `<tr><td>${who}${r.comment ? `<div class="muted" style="font-size:0.8rem">${escapeHtml(r.comment)}</div>` : ""}</td>${cells}</tr>`;
      })
      .join("");

    tally = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Respondent</th>${optHeader}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <button class="btn btn-secondary btn-sm" onclick="backToPollsList()" style="margin-right:8px">← Back</button>
        <div class="card-title" style="flex:1">${escapeHtml(poll.title)}</div>
        ${headerActions}
      </div>
      <p class="muted" style="margin-bottom:8px">
        ${statusBadge(poll.status)}
        · ${poll.duration_min} min
        ${poll.location_text ? `· ${escapeHtml(poll.location_text)}` : ""}
      </p>
      ${poll.description ? `<p style="margin-bottom:16px">${escapeHtml(poll.description)}</p>` : ""}
      ${tally}
    </div>
  `;
}

async function closePoll(id) {
  if (
    !confirm(
      "Close voting on this poll? Respondents won't be able to submit new answers.",
    )
  ) {
    return;
  }
  try {
    viewingPollDetail = await api(`/api/polls/${id}/close`, { method: "POST" });
    showSuccess("Poll closed.");
    renderPollDetail();
  } catch (err) {
    showError(err.message);
  }
}

// Pick-this-slot dialog. Asks which writable calendar to schedule on,
// confirms the responder count, and POSTs to /schedule.
async function openScheduleDialog(pollId, optionId) {
  // Need writable calendars. Cached calendars list is loaded by the
  // Calendars tab — we may not have it here, so fetch fresh.
  let cals;
  try {
    cals = await api("/api/calendars");
  } catch (err) {
    showError(`Couldn't load calendars: ${err.message}`);
    return;
  }
  const writable = (cals || []).filter(
    (c) => c.provider !== "ics" && c.enabled,
  );
  if (writable.length === 0) {
    showError("Connect a writable Google or Outlook calendar first.");
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">
        <h3>Schedule this slot</h3>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <form id="sch-form" class="modal-body">
        <p style="margin-bottom:12px">We'll create the event on the calendar you pick, with every responder added as an attendee. Anyone who provided an email will get a calendar invite.</p>
        <div class="form-group">
          <label for="sch-cal">Add the event to</label>
          <select id="sch-cal" required>
            ${writable
              .map(
                (c) =>
                  `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label || c.provider_calendar_id)} · ${escapeHtml(c.provider)}</option>`,
              )
              .join("")}
          </select>
        </div>
      </form>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" id="sch-cancel">Cancel</button>
        <button class="btn btn-primary" type="submit" form="sch-form" id="sch-submit">Schedule it</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#sch-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelector("#sch-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = overlay.querySelector("#sch-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Scheduling…";
    const calendar_id = overlay.querySelector("#sch-cal").value;
    try {
      const result = await api(`/api/polls/${pollId}/schedule`, {
        method: "POST",
        body: JSON.stringify({ option_id: optionId, calendar_id }),
      });
      close();
      const note =
        result.recipients > 0
          ? ` · ${result.emails_sent} email${result.emails_sent === 1 ? "" : "s"} sent`
          : "";
      showSuccess(`Scheduled.${note}`);
      // Refresh the detail view so the option highlights as the winner.
      viewingPollDetail = await api(`/api/polls/${pollId}`);
      renderPollDetail();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Schedule it";
      showError(err.message);
    }
  });
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

// ─── Onboarding ───
//
// Three pieces, each minimal:
//
//  1. Welcome modal — shown once for users who land on the dashboard with
//     zero calendars and haven't dismissed it before. Sets expectations,
//     ends with the connect-a-calendar action. Dismissal is tracked in
//     localStorage; we don't burn a DB column on a one-time UI nudge.
//
//  2. Post-OAuth toast — when the dashboard loads with ?connected=1
//     (or ?connected=google|microsoft), show a celebration toast and
//     strip the param from the URL so a refresh doesn't replay it.
//
//  3. "What's next" card on Overview — shown when the user has at least
//     one calendar but is missing the obvious follow-ups. Disappears as
//     state advances. Belongs to renderOverview, not this section.

const WELCOME_DISMISSED_KEY = "mical_welcome_dismissed";

function maybeShowWelcomeModal(counts) {
  if (counts?.calendars > 0) return;
  try {
    if (localStorage.getItem(WELCOME_DISMISSED_KEY)) return;
  } catch {
    // localStorage unavailable (e.g. private mode) — better to skip the
    // welcome than to nag forever.
    return;
  }
  renderWelcomeModal();
}

function renderWelcomeModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open welcome-overlay";
  overlay.innerHTML = `
    <div class="modal-dialog welcome-dialog">
      <div class="welcome-illust">${illustration("calendar", 96)}</div>
      <h2 class="welcome-title">Welcome to MiCal</h2>
      <p class="welcome-lead">
        Your calendars, finally talking to each other. Here's the path:
      </p>
      <ol class="welcome-steps">
        <li>
          <strong>Connect a calendar.</strong>
          <span class="muted">Google, Outlook, or any ICS feed.</span>
        </li>
        <li>
          <strong>Bridge them with sync rules.</strong>
          <span class="muted">Set up once, runs automatically.</span>
        </li>
        <li>
          <strong>Optionally — share with your family or team.</strong>
          <span class="muted">Cross-platform, with privacy you control.</span>
        </li>
      </ol>
      <div class="welcome-actions">
        <a class="btn btn-primary" href="/api/oauth/google/init">Connect Google</a>
        <a class="btn btn-secondary" href="/api/oauth/microsoft/init">Connect Outlook</a>
        <button class="btn btn-secondary" id="welcome-skip">Skip for now</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const dismiss = () => {
    try {
      localStorage.setItem(WELCOME_DISMISSED_KEY, String(Date.now()));
    } catch {}
    overlay.remove();
    document.body.style.overflow = "";
  };
  overlay.querySelector("#welcome-skip").addEventListener("click", dismiss);
  // OAuth links navigate the page anyway — set the dismissed flag so a
  // user who returns mid-flow doesn't see the modal again.
  overlay.querySelectorAll("a.btn").forEach((a) =>
    a.addEventListener("click", () => {
      try {
        localStorage.setItem(WELCOME_DISMISSED_KEY, String(Date.now()));
      } catch {}
    }),
  );
  // Click on the dim background dismisses (treat it as "skip").
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
}

function checkPostOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  if (!connected) return;
  // Strip the param so a reload doesn't replay the toast.
  params.delete("connected");
  const next = params.toString();
  history.replaceState(
    null,
    "",
    window.location.pathname + (next ? "?" + next : ""),
  );
  const provider =
    connected === "google"
      ? "Google Calendar"
      : connected === "microsoft"
        ? "Outlook"
        : "Calendar";
  showSuccess(`${provider} connected.`);
  // Mark welcome as done — they're past the welcome stage.
  try {
    localStorage.setItem(WELCOME_DISMISSED_KEY, String(Date.now()));
  } catch {}
}

// If the URL carries ?invite=<token>, redeem it now. Strips the param either
// way so a refresh doesn't replay. Login forwards invites through OAuth via
// return_to, so this fires the first time the user lands on /app/.
async function checkInviteRedeem() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("invite");
  if (!token) return;
  params.delete("invite");
  const next = params.toString();
  history.replaceState(
    null,
    "",
    window.location.pathname + (next ? "?" + next : ""),
  );
  try {
    const result = await api("/api/groups/redeem-invite", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    const noun = result.group_type === "family" ? "family" : "team";
    if (result.status === "already_member") {
      showSuccess(`Already in "${result.group_name}".`);
    } else {
      showSuccess(`Joined the ${noun} "${result.group_name}".`);
    }
    await loadGroups();
    selectGroup(result.group_id);
  } catch (err) {
    showError(`Couldn't redeem invite: ${err.message}`);
  }
}

// ─── Init ───
async function init() {
  try {
    currentUser = await api("/api/auth/me");
    renderUserInfo();
    // Kick off group load in parallel — sidebar groups section renders
    // itself when /api/groups returns.
    loadGroups();
    checkPostOAuthRedirect();
    // Fire-and-forget — redeem completes asynchronously and re-renders.
    checkInviteRedeem();
    showTab("overview");
  } catch (err) {
    // 401 handled by api()
  }
}

init();
