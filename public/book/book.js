/* MiCal Public Booking Page */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function getParams() {
  const u = new URL(window.location.href);
  return {
    tenant: u.searchParams.get("tenant") || "",
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
  const { tenant, event } = getParams();
  if (!tenant || !event) {
    throw new Error("Missing tenant or event in URL");
  }
  const res = await fetch(
    `/api/book/public?tenant=${encodeURIComponent(tenant)}&event=${encodeURIComponent(event)}`,
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

function generateSlots(date, durationMin, workHours) {
  const slots = [];
  const [sh, sm] = workHours.start.split(":").map(Number);
  const [eh, em] = workHours.end.split(":").map(Number);
  let cursor = new Date(date);
  cursor.setHours(sh, sm, 0, 0);
  const end = new Date(date);
  end.setHours(eh, em, 0, 0);
  while (cursor < end) {
    const slotEnd = new Date(cursor.getTime() + durationMin * 60000);
    if (slotEnd > end) break;
    slots.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 30 * 60000);
  }
  return slots;
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
  const slots = generateSlots(date, config.duration_min, wh);

  hide($("#step-date"));
  show($("#step-time"));
  $("#selected-date-label").textContent = fmtDate(date);

  const container = $("#time-slots");
  container.innerHTML = "";

  if (slots.length === 0) {
    container.innerHTML =
      '<p class="text-muted">No available times for this date.</p>';
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

  const { tenant, event } = getParams();
  const body = {
    tenant_slug: tenant,
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
