/* MiCal Public Booking Page */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Accept either ?host= (new, what we now generate) or ?tenant= (legacy —
// any link minted before the rename still works forever).
function getParams() {
  const u = new URL(window.location.href);
  return {
    host: u.searchParams.get("host") || u.searchParams.get("tenant") || "",
    event: u.searchParams.get("event") || "",
  };
}

function show(el) {
  el?.classList.remove("hidden");
}
function hide(el) {
  el?.classList.add("hidden");
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function fmtTime(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtDateTime(d) {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

let config = null;
let selectedDate = null;
let selectedSlot = null;

async function loadConfig() {
  const { host, event } = getParams();
  if (!host || !event) {
    throw new Error("Missing host or event in URL");
  }
  const res = await fetch(
    `/api/book/public?host=${encodeURIComponent(host)}&event=${encodeURIComponent(event)}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Unable to load event");
  }
  return await res.json();
}

function parseWorkHours(json) {
  try {
    return JSON.parse(json);
  } catch {
    return { start: "09:00", end: "17:00" };
  }
}

function dayBit(d) {
  return 1 << ((d.getDay() + 6) % 7);
}

function isDayAllowed(d, mask) {
  return (mask & dayBit(d)) !== 0;
}

// ─── Cross-TZ aware slot generation ────────────────────────────────────────
//
// The booking page lives in two timezones at once:
//   - Visitor local TZ — what the booker sees ("9am" means their 9am)
//   - Host TZ          — what the event-type's work hours mean ("9am" means
//                        the host's 9am, regardless of where the booker is)
//
// Without this awareness, a visitor in PT booking with a host in ET would
// be offered slots like "9am PT" (= noon ET) for a host whose 9-5 ET means
// 6am-2pm PT — slots that the server then rejected as outside work hours.
// Now: the slot grid walks the host's work-hour wall clock, produces UTC
// instants, and the page displays each in the visitor's local TZ.

const VISITOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Convert a wall-clock time in `tz` to a UTC ms instant. Works by computing
 * what `naiveUTC` looks like when re-interpreted in `tz`, measuring the
 * delta against the desired wall clock, and applying that as the offset.
 * Fine for non-DST-transition wall times; transitions are rare and the
 * server validates anyway.
 */
function tzWallToUtc(year, month, day, hour, minute, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(naive));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  let h = get("hour");
  if (h === 24) h = 0;
  const tzWall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    h,
    get("minute"),
    0,
  );
  const offset = tzWall - naive;
  return naive - offset;
}

/**
 * Produce 30-minute booking slots for `calendarDate` (a JS Date with the
 * desired host calendar day in its y/m/d), using the host's work hours
 * in `hostTz`. Returns an array of Date objects (UTC instants); the caller
 * displays them in visitor-local time.
 */
function generateSlots(calendarDate, durationMin, workHours, hostTz) {
  const slots = [];
  const [sh, sm] = workHours.start.split(":").map(Number);
  const [eh, em] = workHours.end.split(":").map(Number);
  const y = calendarDate.getFullYear();
  const mo = calendarDate.getMonth() + 1;
  const d = calendarDate.getDate();

  const startMs = tzWallToUtc(y, mo, d, sh, sm, hostTz);
  const endMs = tzWallToUtc(y, mo, d, eh, em, hostTz);

  let cursor = startMs;
  while (cursor < endMs) {
    if (cursor + durationMin * 60000 > endMs) break;
    // Drop slots already in the past — a visitor seeing today's calendar
    // shouldn't be offered 9am host-time when it's already 11am host-time.
    if (cursor > Date.now()) slots.push(new Date(cursor));
    cursor += 30 * 60000;
  }
  return slots;
}

/**
 * Friendly TZ label like "Eastern Time" or "Pacific Time" for the banner.
 * Falls back to the IANA name if the long name isn't available.
 */
function friendlyTzLabel(tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "long",
    });
    const parts = fmt.formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value || tz;
  } catch {
    return tz;
  }
}

function renderCalendar() {
  const wh = parseWorkHours(config.work_hours_json);
  const mask = Number(config.weekdays_mask || 31);
  const horizon = Number(config.horizon_days || 25);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today.getTime() + horizon * 86400000);

  let viewDate = new Date(today);

  function build() {
    $("#cal-month-year").textContent = viewDate.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    const grid = $("#cal-days");
    grid.innerHTML = "";

    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(
      viewDate.getFullYear(),
      viewDate.getMonth() + 1,
      0,
    ).getDate();

    for (let i = 0; i < startDay; i++) {
      const pad = document.createElement("div");
      pad.className = "cal-day cal-day--empty";
      grid.appendChild(pad);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(viewDate.getFullYear(), viewDate.getMonth(), d);
      const el = document.createElement("button");
      el.className = "cal-day";
      el.textContent = d;

      const disabled =
        date < today || date > maxDate || !isDayAllowed(date, mask);
      if (disabled) {
        el.classList.add("cal-day--disabled");
        el.disabled = true;
      } else {
        el.onclick = () => pickDate(date);
      }
      grid.appendChild(el);
    }
  }

  $("#cal-prev").onclick = () => {
    viewDate.setMonth(viewDate.getMonth() - 1);
    build();
  };
  $("#cal-next").onclick = () => {
    viewDate.setMonth(viewDate.getMonth() + 1);
    build();
  };

  build();
}

function pickDate(date) {
  selectedDate = date;
  const wh = parseWorkHours(config.work_hours_json);
  const hostTz = config.host_tz || VISITOR_TZ;
  const slots = generateSlots(date, config.duration_min, wh, hostTz);

  hide($("#step-date"));
  show($("#step-time"));
  $("#selected-date-label").textContent = fmtDate(date);

  // TZ banner — only when visitor and host are in different zones. We hide
  // the banner entirely in same-tz so it doesn't add noise to the most
  // common case. Banner explains which times the slots represent.
  const banner = $("#tz-banner");
  if (banner) {
    if (hostTz && hostTz !== VISITOR_TZ) {
      const hostLabel = friendlyTzLabel(hostTz);
      const visitorLabel = friendlyTzLabel(VISITOR_TZ);
      banner.textContent = `Times shown in your timezone (${visitorLabel}). Host's calendar is in ${hostLabel}.`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  const container = $("#time-slots");
  container.replaceChildren();

  if (slots.length === 0) {
    const p = document.createElement("p");
    p.className = "text-muted";
    p.textContent = "No available times for this date.";
    container.appendChild(p);
    return;
  }

  slots.forEach((slot) => {
    const btn = document.createElement("button");
    btn.className = "time-slot";
    btn.textContent = fmtTime(slot);
    btn.onclick = () => pickTime(slot);
    container.appendChild(btn);
  });
}

function pickTime(slot) {
  selectedSlot = slot;
  hide($("#step-time"));
  show($("#step-form"));
  $("#selected-datetime-label").textContent = fmtDateTime(slot);

  if (config.require_email) {
    $("#email-required").classList.remove("hidden");
    $("#email").required = true;
  } else {
    $("#email-required").classList.add("hidden");
    $("#email").required = false;
  }
}

$("#back-to-date").onclick = () => {
  hide($("#step-time"));
  show($("#step-date"));
  selectedSlot = null;
};

$("#back-to-time").onclick = () => {
  hide($("#step-form"));
  show($("#step-time"));
};

$("#booking-form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Booking…";
  hide($("#form-error"));

  const { host, event } = getParams();
  const body = {
    host_slug: host,
    event_slug: event,
    start_ms: selectedSlot.getTime(),
    attendee_name: $("#name").value.trim() || null,
    attendee_email: $("#email").value.trim() || null,
    subject: `${config.name} with ${$("#name").value.trim()}`,
    notes: $("#notes").value.trim() || null,
  };

  try {
    const res = await fetch("/api/book/public", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Booking failed");
    }
    showConfirmation(data);
  } catch (err) {
    show($("#form-error"));
    $("#form-error").textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Confirm Booking";
  }
};

function showConfirmation(data) {
  hide($("#step-form"));
  show($("#step-confirm"));
  $("#confirm-event").textContent = config.name;
  $("#confirm-when").textContent = fmtDateTime(selectedSlot);
  // Cancel URL composed by the API. We never expose the raw token to the
  // attendee — they get an opaque link and the cancel page handles the
  // POST. Falls back gracefully if the API didn't include the URL.
  const cancelLink = $("#confirm-cancel-link");
  if (cancelLink && data.cancel_url) {
    cancelLink.href = data.cancel_url;
  }
}

async function init() {
  try {
    config = await loadConfig();
    // Replace the hardcoded "MiCal" host label with the actual host's
    // tenant name (returned as host_name from /api/book/public). Falls
    // back to a friendly default if older API versions don't include it.
    const hostEl = document.querySelector(".event-host");
    if (hostEl) hostEl.textContent = config.host_name || "Book a meeting";
    $("#event-name").textContent = config.name;
    $("#event-duration").textContent = `${config.duration_min} min`;
    if (config.location_mode && config.location_mode !== "meet") {
      const labels = {
        zoom: "Zoom",
        phone: "Phone",
        in_person: "In person",
        ask: "Ask attendee",
      };
      $("#event-location").textContent =
        labels[config.location_mode] || config.location_mode;
      show($("#event-location"));
    }

    hide($("#loading"));
    show($("#booking-flow"));
    renderCalendar();
  } catch (err) {
    hide($("#loading"));
    show($("#error"));
    $("#error-message").textContent = err.message;
  }
}

init();
