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

function showError(msg, container) {
  const el = document.createElement("div");
  el.className = "error-banner";
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button onclick="this.parentElement.remove()">×</button>`;
  const target = typeof container === "string" ? $(container) : container;
  if (target) target.prepend(el);
}

function clearErrors(container) {
  const target = typeof container === "string" ? $(container) : container;
  if (target)
    target.querySelectorAll(".error-banner").forEach((el) => el.remove());
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

// ─── Navigation ───
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

// ─── Overview ───
async function loadOverview() {
  const container = $("#overview-content");
  container.innerHTML =
    '<div class="loading"><div class="spinner"></div>Loading…</div>';

  try {
    const [me, cals, flows, types, bks] = await Promise.all([
      api("/api/auth/me"),
      api("/api/calendars"),
      api("/api/sync-flows"),
      api("/api/event-types"),
      api("/api/bookings"),
    ]);

    currentUser = me;
    calendars = cals || [];
    syncFlows = flows || [];
    eventTypes = types || [];
    bookings = bks || [];

    renderUserInfo();
    renderOverview();
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

function renderOverview() {
  const container = $("#overview-content");
  const name =
    currentUser?.display_name || currentUser?.email?.split("@")[0] || "there";
  const tenantSlug = currentUser?.tenant_slug
    ? `Tenant: <strong>${escapeHtml(currentUser.tenant_slug)}</strong>`
    : "";

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${calendars.length}</div>
        <div class="stat-label">Connected Calendars</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${syncFlows.length}</div>
        <div class="stat-label">Sync Flows</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${eventTypes.length}</div>
        <div class="stat-label">Event Types</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${bookings.length}</div>
        <div class="stat-label">Bookings</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Welcome back, ${escapeHtml(name)}!</div>
      </div>
      <p style="color:var(--stone)">This is your MiCal dashboard. Use the sidebar to manage calendars, sync flows, event types, and bookings.</p>
      ${tenantSlug ? `<p style="margin-top:8px;color:var(--stone);font-size:0.9rem">${tenantSlug}</p>` : ""}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Quick Actions</div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="showTab('calendars')">Add Calendar</button>
        <button class="btn btn-secondary" onclick="showTab('sync-flows')">Create Sync Flow</button>
        <button class="btn btn-secondary" onclick="showTab('event-types')">New Event Type</button>
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

function renderCalendars() {
  const container = $("#calendars-content");
  clearErrors(container);

  let listHtml = "";
  if (calendars.length === 0) {
    listHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <h3>No calendars connected</h3>
        <p>Discover calendars from your accounts or add an ICS feed to get started.</p>
      </div>
    `;
  } else {
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Provider</th><th>Label</th><th>Role</th><th>Status</th><th style="width:100px;text-align:right">Actions</th></tr>
          </thead>
          <tbody>
            ${calendars
              .map(
                (cal) => `
              <tr data-id="${escapeHtml(cal.id)}">
                <td><div class="provider-icon">${providerIcon(cal.provider)} ${providerName(cal.provider)}</div></td>
                <td>${escapeHtml(cal.label)}</td>
                <td>${escapeHtml(cal.role)}</td>
                <td>
                  <label class="toggle" title="${cal.enabled ? "Active" : "Disabled"}">
                    <input type="checkbox" ${cal.enabled ? "checked" : ""} onchange="toggleCalendar('${escapeHtml(cal.id)}', this.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </td>
                <td style="text-align:right">
                  <button class="btn btn-danger btn-sm" onclick="deleteCalendar('${escapeHtml(cal.id)}')" title="Remove this calendar">🗑️ Remove</button>
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

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Connected Calendars</div>
        <div class="btn-group">
          <a class="btn btn-secondary btn-sm" href="/api/oauth/google/init">+ Google</a>
          <a class="btn btn-secondary btn-sm" href="/api/oauth/microsoft/init">+ Outlook</a>
          <button class="btn btn-primary btn-sm" onclick="discoverCalendars()">
            <span>🔍</span> Discover
          </button>
        </div>
      </div>
      <div id="calendars-list">${listHtml}</div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:16px">Add ICS Feed</div>
      <form id="ics-form" onsubmit="handleIcsSubmit(event)">
        <div class="form-row">
          <div class="form-group">
            <label for="ics-label">Label</label>
            <input type="text" id="ics-label" placeholder="My Team Calendar" required>
          </div>
          <div class="form-group">
            <label for="ics-url">ICS URL</label>
            <input type="url" id="ics-url" placeholder="https://example.com/calendar.ics" required>
          </div>
          <div class="form-group">
            <label for="ics-role">Role</label>
            <input type="text" id="ics-role" placeholder="reader" required>
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Add ICS Feed</button>
      </form>
    </div>
  `;
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
        <div class="empty-state-icon">🔭</div>
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
        ? '<span class="already-imported">✓ Imported</span>'
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
    const container = $("#calendars-content");
    const el = document.createElement("div");
    el.style.cssText =
      "background:rgba(56,161,105,0.08);color:var(--success);padding:12px 16px;border-radius:8px;font-size:0.9rem;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;";
    el.innerHTML = `<span>Imported ${selections.length} calendar(s).</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;">×</button>`;
    container.prepend(el);
  } catch (err) {
    if (err.message !== "unauthorized") {
      $("#preview-modal-body").prepend(
        `<div class="error-banner">${escapeHtml(err.message)}</div>`,
      );
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
    role: $("#ics-role").value.trim(),
  };

  try {
    await api("/api/calendars", { method: "POST", body: JSON.stringify(body) });
    $("#ics-form").reset();
    calendars = await api("/api/calendars");
    renderCalendars();
  } catch (err) {
    showError(err.message, "#calendars-content");
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
        <div class="empty-state-icon">🔄</div>
        <h3>No sync flows yet</h3>
        <p>Create a flow to automatically sync events between calendars.</p>
      </div>
    `;
  } else {
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Source</th><th></th><th>Target</th><th>Options</th><th>Enabled</th><th>Order</th><th>Actions</th></tr>
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
                <td>${flow.ord}</td>
                <td>
                  <div class="actions">
                    <button class="icon-btn" onclick="editSyncFlow('${escapeHtml(flow.id)}')" title="Edit">✏️</button>
                    <button class="icon-btn danger" onclick="deleteSyncFlow('${escapeHtml(flow.id)}')" title="Delete">🗑️</button>
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
            <label for="sf-ord">Order</label>
            <input type="number" id="sf-ord" value="0" min="0">
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
        <div class="empty-state-icon">📋</div>
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
                    <button class="icon-btn" onclick="editEventType('${escapeHtml(et.id)}')" title="Edit">✏️</button>
                    <button class="icon-btn danger" onclick="deleteEventType('${escapeHtml(et.id)}')" title="Delete">🗑️</button>
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
        <div class="form-row">
          <div class="form-group">
            <label for="et-slug">Slug</label>
            <input type="text" id="et-slug" placeholder="30min-meeting" required pattern="[a-zA-Z0-9_-]+">
          </div>
          <div class="form-group">
            <label for="et-name">Name</label>
            <input type="text" id="et-name" placeholder="30 Minute Meeting" required>
          </div>
          <div class="form-group">
            <label for="et-duration">Duration (min)</label>
            <input type="number" id="et-duration" value="30" min="1" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="et-buffer">Buffer (min)</label>
            <input type="number" id="et-buffer" value="0" min="0">
          </div>
          <div class="form-group">
            <label for="et-lead">Lead Time (min)</label>
            <input type="number" id="et-lead" value="0" min="0">
          </div>
          <div class="form-group">
            <label for="et-horizon">Horizon (days)</label>
            <input type="number" id="et-horizon" value="25" min="1">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="et-location">Location</label>
            <select id="et-location">
              <option value="meet">Google Meet</option>
              <option value="zoom">Zoom</option>
              <option value="phone">Phone</option>
              <option value="in_person">In Person</option>
              <option value="ask">Ask Attendee</option>
            </select>
          </div>
          <div class="form-group">
            <label for="et-target">Target Calendar</label>
            <select id="et-target" required>
              <option value="">Select calendar…</option>
              ${calOptions}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Available Days</label>
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
            <label for="et-work-start">Work Hours — From</label>
            <input type="time" id="et-work-start" value="09:00" required>
          </div>
          <div class="form-group">
            <label for="et-work-end">Work Hours — To</label>
            <input type="time" id="et-work-end" value="17:00" required>
          </div>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:12px;">
          <label class="toggle" style="flex-shrink:0;">
            <input type="checkbox" id="et-enabled" checked>
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:0.9rem;color:var(--stone)">Enabled</span>
        </div>
        <div style="display:flex;gap:10px;">
          <button type="submit" class="btn btn-primary">${isEditing ? "Update" : "Create"}</button>
          ${isEditing ? `<button type="button" class="btn btn-secondary" onclick="cancelEditEventType()">Cancel</button>` : ""}
        </div>
      </form>
    </div>
  `;

  if (editEt) {
    $("#et-slug").value = editEt.slug;
    $("#et-name").value = editEt.name;
    $("#et-duration").value = editEt.duration_min;
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

  const body = {
    slug: $("#et-slug").value.trim(),
    name: $("#et-name").value.trim(),
    duration_min: Number($("#et-duration").value),
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
        <div class="empty-state-icon">📖</div>
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
