/* MiCal Public Poll Page */

const $ = (sel) => document.querySelector(sel);

function getToken() {
  const u = new URL(window.location.href);
  return (
    u.searchParams.get("token") ||
    // Support /poll/<token> URLs that haven't been rewritten yet (or mistakes
    // where someone hits the path directly without the rewrite).
    (u.pathname.match(/\/poll\/([^/?#]+)/) || [])[1] ||
    ""
  );
}

function show(el) {
  el?.classList.remove("hidden");
}
function hide(el) {
  el?.classList.add("hidden");
}

function fmtDateTime(ms) {
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

let state = {
  token: "",
  poll: null,
  options: [],
  viewer: { signed_in: false },
  myResponse: null,
};

async function loadPoll() {
  const token = state.token;
  const res = await fetch(
    `/api/polls/public?token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return await res.json();
}

function renderHeader() {
  $("#organizer-name").textContent = state.poll.organizer_name || "MiCal";
  $("#poll-title").textContent = state.poll.title;
  $("#poll-duration").textContent = `${state.poll.duration_min} min`;
  if (state.poll.location_text) {
    const loc = $("#poll-location");
    loc.textContent = state.poll.location_text;
    show(loc);
  }
  if (state.poll.description) {
    const desc = $("#poll-desc");
    desc.textContent = state.poll.description;
    show(desc);
  }
}

function renderViewerBox() {
  const pitch = $("#signin-pitch");
  const signedAs = $("#signed-in-as");
  const anonFields = $("#anon-fields");
  const emailReq = $("#email-required");

  if (state.viewer.signed_in) {
    hide(pitch);
    signedAs.textContent = `Signed in as ${state.viewer.email}`;
    show(signedAs);
    // No need for the name/email fields — we have them from the session.
    // Critically, clear the `required` attrs too: browsers refuse to submit
    // a form when a required input is in a display:none subtree, and the
    // failure is silent (the click does nothing — no toast, no console).
    hide(anonFields);
    $("#name").required = false;
    $("#email").required = false;
  } else {
    // Anchor the OAuth links to bring the user back here after sign-in.
    const here = `/poll/${encodeURIComponent(state.token)}`;
    $("#signin-google").href =
      `/api/oauth/google/init?return_to=${encodeURIComponent(here)}`;
    $("#signin-microsoft").href =
      `/api/oauth/microsoft/init?return_to=${encodeURIComponent(here)}`;
    show(pitch);
    show(anonFields);
    if (state.poll.require_email) {
      $("#email").required = true;
      show(emailReq);
    }
  }
}

// Build a single poll-option row. Uses createElement + textContent throughout
// so values from the server (option IDs, formatted dates) can never inject
// markup. The shape is fully static — a checkbox, a date span, optional pill.
function buildOptionRow(opt, isPicked, scheduledId) {
  const row = document.createElement("label");
  row.className = "poll-option";

  const isScheduled = scheduledId && opt.id === scheduledId;
  if (opt.busy === true) row.classList.add("is-busy");
  if (isScheduled) row.classList.add("is-scheduled");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.value = opt.id;
  cb.checked = isPicked;
  row.appendChild(cb);

  const when = document.createElement("span");
  when.className = "poll-option-when";
  when.textContent = fmtDateTime(opt.start_ms);
  row.appendChild(when);

  // Free/busy pill — only render when we actually have the signal. Anonymous
  // viewers see no pill at all, never a misleading "free" claim from a
  // calendar we don't hold credentials for.
  let pillClass = null;
  let pillText = null;
  if (isScheduled) {
    pillClass = "scheduled-pill";
    pillText = "Scheduled";
  } else if (opt.busy === true) {
    pillClass = "busy-pill";
    pillText = "Busy";
  } else if (opt.busy === false) {
    pillClass = "free-pill";
    pillText = "Free";
  }
  if (pillClass) {
    const pill = document.createElement("span");
    pill.className = pillClass;
    pill.textContent = pillText;
    row.appendChild(pill);
  }
  return row;
}

function renderOptions() {
  const container = $("#poll-options");
  container.replaceChildren();
  const myPicked = new Set(state.myResponse?.picked_option_ids || []);
  const scheduledId = state.poll.scheduled_option_id;
  for (const opt of state.options) {
    container.appendChild(
      buildOptionRow(opt, myPicked.has(opt.id), scheduledId),
    );
  }
}

function renderMyResponseBanner() {
  if (!state.myResponse) return;
  const banner = $("#my-response-banner");
  const when = new Date(state.myResponse.updated_at).toLocaleString();
  banner.textContent = `You've responded already (last updated ${when}). Submitting again will overwrite your previous answer.`;
  show(banner);
}

function renderStatusBanner() {
  if (state.poll.status === "open") return;
  const banner = $("#status-banner");
  if (state.poll.status === "closed") {
    banner.textContent =
      "This poll is closed — the organizer is no longer accepting responses.";
  } else if (state.poll.status === "scheduled") {
    banner.textContent =
      "The organizer has picked a time. See the highlighted slot below.";
  } else if (state.poll.status === "cancelled") {
    banner.textContent = "This poll was cancelled.";
  }
  show(banner);
  // Disable the submit button when the poll is no longer accepting votes.
  if (state.poll.status !== "open") {
    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = "Voting closed";
  }
}

function renderConfirmation() {
  hide($("#step-vote"));
  show($("#step-confirm"));
}

async function submitVote(e) {
  e.preventDefault();
  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  hide($("#form-error"));

  const picked = Array.from(
    document.querySelectorAll("#poll-options input[type=checkbox]:checked"),
  ).map((cb) => cb.value);

  // Anonymous viewers must supply name + (if required) email; signed-in
  // viewers' info is derived server-side from the session, so name/email
  // can be omitted on the wire.
  const body = {
    token: state.token,
    picked_option_ids: picked,
    comment: $("#comment").value.trim() || null,
  };
  if (!state.viewer.signed_in) {
    body.name = $("#name").value.trim() || null;
    body.email = $("#email").value.trim() || null;
  }

  try {
    const res = await fetch("/api/polls/public", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Submission failed");
    renderConfirmation();
  } catch (err) {
    show($("#form-error"));
    $("#form-error").textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Submit response";
  }
}

async function init() {
  state.token = getToken();
  if (!state.token) {
    hide($("#loading"));
    show($("#error"));
    $("#error-message").textContent = "Missing poll token in URL.";
    return;
  }
  try {
    const data = await loadPoll();
    state.poll = data.poll;
    state.options = data.options;
    state.viewer = data.viewer || { signed_in: false };
    state.myResponse = data.my_response;

    hide($("#loading"));
    show($("#poll-card"));

    renderHeader();
    renderViewerBox();
    renderOptions();
    renderMyResponseBanner();
    renderStatusBanner();

    $("#vote-form").addEventListener("submit", submitVote);
    $("#edit-response-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      hide($("#step-confirm"));
      show($("#step-vote"));
    });
  } catch (err) {
    hide($("#loading"));
    show($("#error"));
    $("#error-message").textContent = err.message;
  }
}

init();
