/* MiCal Dashboard App */

// ─── State ───
let currentUser = null;
let currentTab = 'overview';
let calendars = [];
let syncFlows = [];
let eventTypes = [];
let bookings = [];
let editingEventTypeId = null;
let editingSyncFlowId = null;

// ─── Helpers ───
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getInitials(name, email) {
  const str = name || email || '?';
  const parts = str.split(' ').filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return str.slice(0, 2).toUpperCase();
}

function showError(msg, container) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button onclick="this.parentElement.remove()">×</button>`;
  const target = typeof container === 'string' ? $(container) : container;
  if (target) target.prepend(el);
}

function clearErrors(container) {
  const target = typeof container === 'string' ? $(container) : container;
  if (target) target.querySelectorAll('.error-banner').forEach(el => el.remove());
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function providerIcon(provider) {
  const p = String(provider).toLowerCase();
  if (p === 'google') return '<span class="provider-google"></span>';
  if (p === 'microsoft' || p === 'outlook' || p === 'live') return '<span class="provider-microsoft"></span>';
  return '<span class="provider-ics"></span>';
}

function calendarLabel(id) {
  const cal = calendars.find(c => c.id === id);
  return cal ? `${escapeHtml(cal.label)} (${providerName(cal.provider)})` : escapeHtml(id);
}

function providerName(provider) {
  const p = String(provider).toLowerCase();
  if (p === 'google') return 'Google Calendar';
  if (p === 'microsoft' || p === 'outlook' || p === 'live') return 'Outlook';
  if (p === 'ics') return 'ICS Feed';
  return escapeHtml(provider);
}

function statusBadge(status) {
  const s = String(status).toLowerCase();
  if (s === 'confirmed') return '<span class="badge badge-success">Confirmed</span>';
  if (s === 'cancelled') return '<span class="badge badge-danger">Cancelled</span>';
  if (s === 'pending') return '<span class="badge badge-warning">Pending</span>';
  return `<span class="badge badge-info">${escapeHtml(status)}</span>`;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/api/oauth/google/init?return_to=${returnTo}`;
    throw new Error('unauthorized');
  }

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (res.status === 204) {
    data = null;
  } else if (contentType.includes('application/json')) {
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
  $$('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Hide all pages
  $$('.tab-page').forEach(page => page.style.display = 'none');

  // Show selected page
  const page = $(`#tab-${tab}`);
  if (page) page.style.display = 'block';

  // Update page title
  const titles = {
    overview: 'Dashboard',
    calendars: 'Calendars',
    'sync-flows': 'Sync Flows',
    'event-types': 'Event Types',
    bookings: 'Bookings',
  };
  const titleEl = $('#page-title');
  if (titleEl) titleEl.textContent = titles[tab] || 'Dashboard';

  // Close mobile sidebar
  $('.sidebar').classList.remove('open');
  $('.sidebar-overlay').classList.remove('open');

  // Load data
  if (tab === 'overview') loadOverview();
  if (tab === 'calendars') loadCalendars();
  if (tab === 'sync-flows') loadSyncFlows();
  if (tab === 'event-types') loadEventTypes();
  if (tab === 'bookings') loadBookings();
}

// ─── Overview ───
async function loadOverview() {
  const container = $('#overview-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  try {
    const [me, cals, flows, types, bks] = await Promise.all([
      api('/api/auth/me'),
      api('/api/calendars'),
      api('/api/sync-flows'),
      api('/api/event-types'),
      api('/api/bookings'),
    ]);

    currentUser = me;
    calendars = cals || [];
    syncFlows = flows || [];
    eventTypes = types || [];
    bookings = bks || [];

    renderUserInfo();
    renderOverview();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      container.innerHTML = `<div class="error-banner">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderUserInfo() {
  if (!currentUser) return;
  const name = currentUser.display_name || currentUser.email?.split('@')[0] || 'User';
  const email = currentUser.email || '';
  $('#user-name').textContent = name;
  $('#user-email').textContent = email;
  $('#user-avatar').textContent = getInitials(name, email);
}

function renderOverview() {
  const container = $('#overview-content');
  const name = currentUser?.display_name || currentUser?.email?.split('@')[0] || 'there';
  const tenantSlug = currentUser?.tenant_slug ? `Tenant: <strong>${escapeHtml(currentUser.tenant_slug)}</strong>` : '';

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
      ${tenantSlug ? `<p style="margin-top:8px;color:var(--stone);font-size:0.9rem">${tenantSlug}</p>` : ''}
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
  const container = $('#calendars-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading calendars…</div>';

  try {
    calendars = await api('/api/calendars');
    renderCalendars();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      container.innerHTML = `<div class="error-banner">Failed to load calendars: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderCalendars() {
  const container = $('#calendars-content');
  clearErrors(container);

  let listHtml = '';
  if (calendars.length === 0) {
    listHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <h3>No calendars connected</h3>
        <p>Sync from Google or add an ICS feed to get started.</p>
      </div>
    `;
  } else {
    listHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Provider</th><th>Label</th><th>Role</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${calendars.map(cal => `
              <tr>
                <td><div class="provider-icon">${providerIcon(cal.provider)} ${providerName(cal.provider)}</div></td>
                <td>${escapeHtml(cal.label)}</td>
                <td>${escapeHtml(cal.role)}</td>
                <td>${cal.enabled ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Disabled</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Connected Calendars</div>
        <button class="btn btn-primary btn-sm" onclick="syncFromGoogle()">
          <span>🔄</span> Sync from Google
        </button>
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

async function syncFromGoogle() {
  const btn = event.target.closest('button');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Syncing…';

  try {
    const synced = await api('/api/calendars/list');
    calendars = await api('/api/calendars');
    renderCalendars();
    const container = $('#calendars-content');
    const el = document.createElement('div');
    el.style.cssText = 'background:rgba(56,161,105,0.08);color:var(--success);padding:12px 16px;border-radius:8px;font-size:0.9rem;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;';
    el.innerHTML = `<span>Synced ${synced.length} calendar(s) from Google.</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;">×</button>`;
    container.prepend(el);
  } catch (err) {
    if (err.message !== 'unauthorized') showError(err.message, '#calendars-content');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function handleIcsSubmit(e) {
  e.preventDefault();
  clearErrors('#calendars-content');

  const body = {
    label: $('#ics-label').value.trim(),
    ics_url: $('#ics-url').value.trim(),
    role: $('#ics-role').value.trim(),
  };

  try {
    await api('/api/calendars', { method: 'POST', body: JSON.stringify(body) });
    $('#ics-form').reset();
    calendars = await api('/api/calendars');
    renderCalendars();
  } catch (err) {
    showError(err.message, '#calendars-content');
  }
}

// ─── Sync Flows ───
async function loadSyncFlows() {
  const container = $('#sync-flows-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading sync flows…</div>';

  try {
    const [cals, flows] = await Promise.all([
      api('/api/calendars'),
      api('/api/sync-flows'),
    ]);
    calendars = cals || [];
    syncFlows = flows || [];
    renderSyncFlows();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      container.innerHTML = `<div class="error-banner">Failed to load sync flows: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderSyncFlows() {
  const container = $('#sync-flows-content');
  clearErrors(container);

  const calOptions = calendars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)} (${providerName(c.provider)})</option>`).join('');

  let listHtml = '';
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
            ${syncFlows.map(flow => `
              <tr data-id="${escapeHtml(flow.id)}">
                <td>${escapeHtml(flow.source_calendar_label || flow.source_calendar_id)}</td>
                <td style="color:var(--flow-teal);font-weight:700">→</td>
                <td>${escapeHtml(flow.target_calendar_label || flow.target_calendar_id)}</td>
                <td><code style="font-size:0.8rem;background:var(--cloud);padding:2px 6px;border-radius:4px;">${escapeHtml(flow.options_json || '—')}</code></td>
                <td>
                  <label class="toggle">
                    <input type="checkbox" ${flow.enabled ? 'checked' : ''} onchange="toggleSyncFlow('${escapeHtml(flow.id)}', this.checked)">
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
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  const isEditing = editingSyncFlowId !== null;
  const editFlow = isEditing ? syncFlows.find(f => f.id === editingSyncFlowId) : null;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Sync Flows</div>
      </div>
      <div id="sync-flows-list">${listHtml}</div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:16px">${isEditing ? 'Edit Sync Flow' : 'Create Sync Flow'}</div>
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
          <label for="sf-options">Options JSON</label>
          <textarea id="sf-options" placeholder='{"privacy":"private","buffer_min":0}'></textarea>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:12px;">
          <label class="toggle" style="flex-shrink:0;">
            <input type="checkbox" id="sf-enabled" checked>
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:0.9rem;color:var(--stone)">Enabled</span>
        </div>
        <div style="display:flex;gap:10px;">
          <button type="submit" class="btn btn-primary">${isEditing ? 'Update Flow' : 'Create Flow'}</button>
          ${isEditing ? `<button type="button" class="btn btn-secondary" onclick="cancelEditSyncFlow()">Cancel</button>` : ''}
        </div>
      </form>
    </div>
  `;

  if (editFlow) {
    $('#sf-source').value = editFlow.source_calendar_id;
    $('#sf-target').value = editFlow.target_calendar_id;
    $('#sf-ord').value = editFlow.ord;
    $('#sf-options').value = editFlow.options_json || '';
    $('#sf-enabled').checked = editFlow.enabled;
  }
}

async function handleSyncFlowSubmit(e) {
  e.preventDefault();
  clearErrors('#sync-flows-content');

  let optionsJson = null;
  const raw = $('#sf-options').value.trim();
  if (raw) {
    try { optionsJson = JSON.parse(raw); }
    catch { showError('Options JSON is invalid.', '#sync-flows-content'); return; }
  }

  const body = {
    source_calendar_id: $('#sf-source').value,
    target_calendar_id: $('#sf-target').value,
    options_json: optionsJson,
    enabled: $('#sf-enabled').checked,
    ord: Number($('#sf-ord').value) || 0,
  };

  try {
    if (editingSyncFlowId) {
      await api(`/api/sync-flows/${editingSyncFlowId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      editingSyncFlowId = null;
    } else {
      await api('/api/sync-flows', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#sync-flow-form').reset();
    syncFlows = await api('/api/sync-flows');
    renderSyncFlows();
  } catch (err) {
    showError(err.message, '#sync-flows-content');
  }
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
  clearErrors('#sync-flows-content');
  try {
    await api(`/api/sync-flows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    syncFlows = await api('/api/sync-flows');
    renderSyncFlows();
  } catch (err) {
    showError(err.message, '#sync-flows-content');
    renderSyncFlows();
  }
}

async function deleteSyncFlow(id) {
  if (!confirm('Delete this sync flow?')) return;
  clearErrors('#sync-flows-content');
  try {
    await api(`/api/sync-flows/${id}`, { method: 'DELETE' });
    syncFlows = await api('/api/sync-flows');
    renderSyncFlows();
  } catch (err) {
    showError(err.message, '#sync-flows-content');
  }
}

// ─── Event Types ───
async function loadEventTypes() {
  const container = $('#event-types-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading event types…</div>';

  try {
    const [cals, types] = await Promise.all([
      api('/api/calendars'),
      api('/api/event-types'),
    ]);
    calendars = cals || [];
    eventTypes = types || [];
    renderEventTypes();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      container.innerHTML = `<div class="error-banner">Failed to load event types: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderEventTypes() {
  const container = $('#event-types-content');
  clearErrors(container);

  const calOptions = calendars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');

  let listHtml = '';
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
            ${eventTypes.map(et => `
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
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  const isEditing = editingEventTypeId !== null;
  const editEt = isEditing ? eventTypes.find(e => e.id === editingEventTypeId) : null;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Event Types</div>
      </div>
      <div id="event-types-list">${listHtml}</div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:16px">${isEditing ? 'Edit Event Type' : 'Create Event Type'}</div>
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
            <label for="et-weekdays">Weekdays Mask</label>
            <input type="number" id="et-weekdays" value="31" min="0" max="127" title="Bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64">
          </div>
          <div class="form-group">
            <label for="et-location">Location Mode</label>
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
          <label for="et-work-hours">Work Hours JSON</label>
          <textarea id="et-work-hours" placeholder='{"start":"09:00","end":"17:00"}' required></textarea>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:12px;">
          <label class="toggle" style="flex-shrink:0;">
            <input type="checkbox" id="et-enabled" checked>
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:0.9rem;color:var(--stone)">Enabled</span>
        </div>
        <div style="display:flex;gap:10px;">
          <button type="submit" class="btn btn-primary">${isEditing ? 'Update' : 'Create'}</button>
          ${isEditing ? `<button type="button" class="btn btn-secondary" onclick="cancelEditEventType()">Cancel</button>` : ''}
        </div>
      </form>
    </div>
  `;

  if (editEt) {
    $('#et-slug').value = editEt.slug;
    $('#et-name').value = editEt.name;
    $('#et-duration').value = editEt.duration_min;
    $('#et-buffer').value = editEt.buffer_min;
    $('#et-lead').value = editEt.lead_min;
    $('#et-horizon').value = editEt.horizon_days;
    $('#et-weekdays').value = editEt.weekdays_mask;
    $('#et-location').value = editEt.location_mode;
    $('#et-target').value = editEt.target_calendar_id;
    $('#et-work-hours').value = editEt.work_hours_json;
    $('#et-enabled').checked = editEt.enabled;
  }
}

async function handleEventTypeSubmit(e) {
  e.preventDefault();
  clearErrors('#event-types-content');

  let workHours = null;
  try { workHours = JSON.parse($('#et-work-hours').value.trim()); }
  catch { showError('Work Hours JSON is invalid.', '#event-types-content'); return; }

  const body = {
    slug: $('#et-slug').value.trim(),
    name: $('#et-name').value.trim(),
    duration_min: Number($('#et-duration').value),
    buffer_min: Number($('#et-buffer').value) || 0,
    lead_min: Number($('#et-lead').value) || 0,
    horizon_days: Number($('#et-horizon').value) || 25,
    weekdays_mask: Number($('#et-weekdays').value) || 31,
    work_hours_json: JSON.stringify(workHours),
    target_calendar_id: $('#et-target').value,
    location_mode: $('#et-location').value,
    enabled: $('#et-enabled').checked ? 1 : 0,
  };

  try {
    if (editingEventTypeId) {
      // Only send changed fields for PATCH
      const original = eventTypes.find(e => e.id === editingEventTypeId);
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
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
      editingEventTypeId = null;
    } else {
      await api('/api/event-types', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#event-type-form').reset();
    eventTypes = await api('/api/event-types');
    renderEventTypes();
  } catch (err) {
    showError(err.message, '#event-types-content');
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
  if (!confirm('Delete this event type?')) return;
  clearErrors('#event-types-content');
  try {
    await api(`/api/event-types/${id}`, { method: 'DELETE' });
    eventTypes = await api('/api/event-types');
    renderEventTypes();
  } catch (err) {
    showError(err.message, '#event-types-content');
  }
}

// ─── Bookings ───
async function loadBookings() {
  const container = $('#bookings-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading bookings…</div>';

  try {
    bookings = await api('/api/bookings');
    renderBookings();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      container.innerHTML = `<div class="error-banner">Failed to load bookings: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderBookings() {
  const container = $('#bookings-content');
  clearErrors(container);

  let listHtml = '';
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
            ${bookings.map(b => `
              <tr>
                <td>${escapeHtml(b.subject || '—')}</td>
                <td>${escapeHtml(b.attendee_name || '')} ${b.attendee_email ? `&lt;${escapeHtml(b.attendee_email)}&gt;` : '—'}</td>
                <td>${formatDate(b.start_ms)}</td>
                <td>${formatDate(b.end_ms)}</td>
                <td>${statusBadge(b.status)}</td>
              </tr>
            `).join('')}
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
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  window.location.href = '/';
}

// ─── Mobile Menu ───
function toggleSidebar() {
  $('.sidebar').classList.toggle('open');
  $('.sidebar-overlay').classList.toggle('open');
}

// ─── Init ───
async function init() {
  try {
    currentUser = await api('/api/auth/me');
    renderUserInfo();
    showTab('overview');
  } catch (err) {
    // 401 handled by api()
  }
}

init();
