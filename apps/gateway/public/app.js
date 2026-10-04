// laun web UI — vanilla ESM, no bundler, no dependencies.
//
// Everything talks to the same-origin gateway. The agent key lives in localStorage and is sent
// as `Authorization: Bearer <key>` on every request. Streaming uses fetch() + ReadableStream
// because EventSource cannot set an Authorization header; SSE frames are parsed by hand
// (`data:` lines carry JSON, lines starting with `:` are heartbeat comments).

const KEY_STORAGE = "laun.key";
const TERMINAL_STATUSES = new Set(["done", "error"]);
const FOLLOW_THRESHOLD_PX = 64; // "at the bottom" tolerance for auto-scroll

/** Mutable view state.
 *  `seen` counts gateway bus events already applied: every SSE (re)connect replays the whole
 *  bus from index 0, so that many frames are skipped to avoid duplicating what /log returned. */
const state = {
  key: "", sessions: [], currentId: null, current: null,
  seen: 0, replayRemaining: 0, terminal: false, streaming: false,
  streamToken: null, streamAbort: null, reconnectTimer: null, reconnectAttempts: 0,
  streamState: "idle", // idle | connecting | live | reconnecting
  follow: true, openBubble: null, approvalIds: new Set(),
};
// ----------------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
/** Create an element; text always goes through textContent so agent output stays inert. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** "3s ago" / "5m ago" / "2h ago" for sidebar rows. */
function timeAgo(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`;
}
/** Tool output and args must never blow up the transcript. */
function clamp(text, max = 500) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}
/** Pretty-print tool args (arbitrary JSON) with a hard size cap. */
function formatArgs(args) {
  try { return clamp(typeof args === "string" ? args : (JSON.stringify(args, null, 2) ?? String(args)), 500); }
  catch { return clamp(String(args), 500); }
}
/** A run is over after done/error events and after terminal status events. */
function isTerminalEvent(ev) {
  if (!ev) return false;
  return ev.type === "done" || ev.type === "error" || (ev.type === "status" && TERMINAL_STATUSES.has(ev.status));
}
// localStorage throws in some privacy modes; the UI still works for the current tab.
const loadKey = () => { try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; } };
const saveKey = (key) => { try { localStorage.setItem(KEY_STORAGE, key); } catch { /* ignore */ } };
const clearKey = () => { try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ } };
// -------------------------------------------------------------------------- HTTP
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
/** One request helper: injects the bearer key, reads JSON, normalizes errors. */
async function api(path, { method = "GET", body } = {}) {
  const headers = { authorization: `Bearer ${state.key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    forgetKey("Agent key invalid or revoked — paste a fresh key to reconnect.");
    throw new ApiError("unauthorized", 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status);
  return data;
}
// -------------------------------------------------------------------- transcript
/** Append a transcript node; keep the tail in view unless the user scrolled up. */
function appendNode(node) {
  const transcript = $("transcript");
  transcript.append(node);
  if (state.follow) transcript.scrollTop = transcript.scrollHeight;
}
/** Subtle system line: statuses, tool failures, run completion. */
function appendSystem(text, kind = "info") {
  appendNode(el("div", `sys sys-${kind}`, text));
  state.openBubble = null; // the next text delta starts a fresh bubble
}
/** Append a text delta to the current assistant bubble. */
function appendDelta(delta) {
  if (!state.openBubble) appendNode((state.openBubble = el("div", "bubble")));
  state.openBubble.textContent += delta;
  if (state.follow) $("transcript").scrollTop = $("transcript").scrollHeight;
}
/** Collapsed "🔧 name" line with formatted args (capped at ~500 chars by formatArgs). */
function appendToolCall(name, args) {
  const details = el("details", "tool");
  details.append(el("summary", "", `🔧 ${name}`), el("pre", "", formatArgs(args)));
  appendNode(details);
  state.openBubble = null;
}
/** Tool failures are surfaced; successes stay quiet. */
function appendToolFailure(name, output) {
  const text = typeof output === "string" && output.trim() ? clamp(output.trim(), 500) : "(no output)";
  appendSystem(`⚠️ ${name} failed: ${text}`, "warn");
}
/** One compact accounting line; unknown/absent fields render, never crash. */
function usageLine(e) {
  const parts = [];
  for (const [k, label] of [["inputTokens", "in"], ["outputTokens", "out"], ["totalTokens", "total"]]) {
    if (typeof e[k] === "number") parts.push(`${label} ${e[k]}`);
  }
  if (typeof e.costUsd === "number") parts.push(`$${e.costUsd.toFixed(4)}`);
  return parts.length ? `📊 usage: ${parts.join(", ")}` : `📊 usage`;
}
/** Keep sidebar badges and the session header in sync with streamed status events. */
function setSessionStatus(sessionId, status) {
  const rec = state.sessions.find((s) => s.id === sessionId);
  if (rec) rec.status = status;
  if (state.current?.id === sessionId) { state.current.status = status; renderHeader(); }
  renderSessionList();
}
/**
 * Render one gateway AgentEvent into the transcript.
 * Returns "terminal" once the run is over so the caller can stop the stream.
 */
function applyEvent(ev) {
  switch (ev.type) {
    case "text": appendDelta(ev.delta ?? ""); return "continue";
    case "tool_call": appendToolCall(ev.name, ev.args); return "continue";
    case "tool_result": if (ev.ok === false) appendToolFailure(ev.name, ev.output); return "continue";
    case "approval_request": addApprovalCard(ev, $("approvals")); return "continue";
    case "thinking": if (typeof ev.delta === "string" && ev.delta) appendSystem(`💭 ${ev.delta}`, "info"); return "continue";
    case "usage": appendSystem(usageLine(ev), "info"); return "continue";
    case "status": {
      setSessionStatus(ev.sessionId, ev.status);
      // The gateway pings a bare "running" at the start of every run; the badge already shows it.
      const label = ev.status.replace("_", " ");
      if (!(ev.status === "running" && !ev.message)) {
        const kind = ev.status === "error" ? "error" : ev.status === "done" ? "ok" : "info";
        appendSystem(ev.message ? `${label}: ${ev.message}` : label, kind);
      }
      return isTerminalEvent(ev) ? "terminal" : "continue";
    }
    case "done": setSessionStatus(ev.sessionId, "done"); appendSystem(ev.summary ? `✅ done: ${ev.summary}` : "✅ done", "ok"); return "terminal";
    case "error": setSessionStatus(ev.sessionId, "error"); appendSystem(`⛔ ${ev.message}`, "error"); return "terminal";
    default: return "continue";
  }
}
// --------------------------------------------------------------------- approvals
/** One card per requestId; fed by GET /sessions/:id and by live approval_request events. */
function addApprovalCard(ev, container) {
  if (state.approvalIds.has(ev.requestId)) return;
  state.approvalIds.add(ev.requestId);
  const card = el("div", "approval");
  card.append(el("div", "approval-head", `🔐 approval needed · ${ev.requestId}`), el("p", "", ev.reason));
  if (ev.detail) card.append(el("pre", "", clamp(String(ev.detail), 800)));
  const actions = el("div", "row");
  const error = el("p", "error");
  for (const decision of ["approve", "deny"]) {
    const btn = el("button", decision === "approve" ? "primary" : "danger", decision === "approve" ? "Approve" : "Deny");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api(`/sessions/${state.currentId}/approvals`, { method: "POST", body: { requestId: ev.requestId, decision } });
        await refreshCurrentSession(); // the server drops the request, so the card disappears
      } catch (err) {
        if (err.status === 401) return;
        error.textContent = `decision failed: ${err.message}`;
        actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
    actions.append(btn);
  }
  card.append(actions, error);
  container.append(card);
  container.hidden = false;
}
/** Rebuild the strip from the server's pending list (source of truth after a decision). */
function renderApprovals(pending) {
  const box = $("approvals");
  box.textContent = "";
  box.hidden = true;
  state.approvalIds = new Set();
  for (const ev of pending) addApprovalCard(ev, box);
}
// --------------------------------------------------------------------- rendering
function renderHeader() {
  const rec = state.current;
  $("session-header").hidden = !rec;
  if (!rec) return;
  $("sh-id").textContent = rec.id;
  $("sh-status").textContent = rec.status.replace("_", " ");
  $("sh-status").className = `badge badge-${rec.status}`;
  $("sh-model").textContent = `${rec.model} · ${rec.runtime}`; $("sh-goal").textContent = rec.goal;
}
function renderSessionList() {
  const list = $("session-list");
  list.textContent = "";
  if (!state.key) return;
  if (state.sessions.length === 0) { list.append(el("p", "si-meta muted", "No sessions yet — start one above.")); return; }
  for (const s of state.sessions) {
    const item = el("button", `session-item${s.id === state.currentId ? " active" : ""}`);
    item.type = "button";
    const goal = el("span", "si-goal", s.goal);
    goal.title = s.goal; // full goal on hover, ellipsised in the row
    const top = el("span", "si-top");
    top.append(goal, el("span", `badge badge-${s.status}`, s.status.replace("_", " ")));
    item.append(top, el("span", "si-meta muted mono", `${s.id} · ${timeAgo(s.createdAt)}`));
    item.addEventListener("click", () => void openSession(s.id));
    list.append(item);
  }
}
function renderConnChip() {
  const labels = { idle: "idle", connecting: "connecting…", live: "live", reconnecting: "reconnecting…" };
  const chip = $("conn-chip");
  chip.textContent = `${location.origin} · ${state.key ? (labels[state.streamState] ?? state.streamState) : "no key"}`;
  const tone = state.streamState === "live" ? " chip-ok" : state.streamState === "connecting" || state.streamState === "reconnecting" ? " chip-warn" : "";
  chip.className = `chip${tone}`;
}
function setStreamState(next) { state.streamState = next; renderConnChip(); }
/** Auto-scroll indicator: "live" follows the tail, "paused" keeps the user's place. */
function renderFollowChip() {
  $("follow-chip").textContent = state.follow ? "● live" : "⏸ paused";
  $("follow-chip").className = `chip ${state.follow ? "chip-ok" : "chip-warn"}`;
  $("jump-btn").hidden = state.follow || !state.currentId;
}
function setComposerNote(text) { $("composer-note").textContent = text; }
// ----------------------------------------------------------------------- session
function upsertSession(rec) {
  const i = state.sessions.findIndex((s) => s.id === rec.id);
  if (i === -1) state.sessions.unshift(rec);
  else state.sessions[i] = rec;
}
async function loadSessions() {
  try {
    const data = await api("/sessions");
    state.sessions = data.sessions ?? [];
    renderSessionList();
  } catch (err) {
    if (err.status === 401) return;
    if (state.currentId) setComposerNote(`refresh failed: ${err.message}`);
    else console.warn("loadSessions failed:", err);
  }
}
function resetSessionView() {
  stopStream();
  state.currentId = null; state.current = null; state.seen = 0; state.replayRemaining = 0;
  state.terminal = false; state.openBubble = null; state.approvalIds = new Set(); state.follow = true;
  $("transcript").textContent = ""; $("transcript").hidden = true;
  $("empty-state").hidden = false; $("session-header").hidden = true;
  $("approvals").textContent = ""; $("approvals").hidden = true;
  $("composer").hidden = true;
  setComposerNote("");
  renderFollowChip();
}
/** Open a session: backfill from GET /log, then follow the live SSE stream. */
async function openSession(id) {
  if (state.currentId === id) { await refreshCurrentSession(); return; }
  resetSessionView();
  state.currentId = id;
  renderSessionList();
  setStreamState("connecting");
  try {
    const [detail, log] = await Promise.all([api(`/sessions/${id}`), api(`/sessions/${id}/log?since=0`)]);
    if (state.currentId !== id) return; // another session was opened while loading
    const events = log.events ?? [];
    state.current = detail.session;
    state.seen = log.next ?? events.length; // event count already applied
    $("transcript").hidden = false; $("empty-state").hidden = true; $("composer").hidden = false;
    renderHeader();
    renderApprovals(detail.pendingApprovals ?? []);
    for (const ev of events) applyEvent(ev);
    // Only stay on the stream while there may be more to come; a finished session re-opens
    // its stream when a new message is sent (sendMessage -> ensureStream).
    state.terminal = events.length > 0 ? isTerminalEvent(events[events.length - 1]) : TERMINAL_STATUSES.has(detail.session.status);
    state.follow = true; $("transcript").scrollTop = $("transcript").scrollHeight; renderFollowChip();
    if (state.terminal) setStreamState("idle");
    else void openStream(id);
  } catch (err) {
    if (err.status === 401) return;
    appendSystem(`failed to load session ${id}: ${err.message}`, "error");
    setStreamState("idle");
  }
}
/** Re-read the session record + pending approvals (after decisions, sends, refresh). */
async function refreshCurrentSession() {
  if (!state.currentId) return;
  try {
    const detail = await api(`/sessions/${state.currentId}`);
    state.current = detail.session;
    upsertSession(detail.session);
    renderHeader();
    renderSessionList();
    renderApprovals(detail.pendingApprovals ?? []);
    if (TERMINAL_STATUSES.has(detail.session.status) && !state.terminal) {
      state.terminal = true;
      stopStream();
      setStreamState("idle");
    }
  } catch (err) {
    if (err.status !== 401) console.warn("refresh failed:", err);
  }
}
// ------------------------------------------------------------------------ stream
/** Parse one SSE frame and apply it, skipping the server's replay of already-seen events. */
function consumeFrame(frame, sessionId) {
  const payload = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
  if (!payload) return; // heartbeat comment or empty frame
  let ev;
  try { ev = JSON.parse(payload); } catch { return; }
  if (!ev || typeof ev.type !== "string" || state.currentId !== sessionId) return;
  // The server replays its whole bus on connect: drop the frames /log already gave us.
  if (state.replayRemaining > 0) { state.replayRemaining -= 1; return; }
  state.seen += 1;
  if (applyEvent(ev) === "terminal") {
    state.terminal = true;
    setStreamState("idle");
    state.streamAbort?.abort(); // stop reading; the finally block decides on reconnect
  }
}
/** Open the SSE stream once (GET /sessions/:id/events). */
async function openStream(id) {
  if (state.streaming || state.currentId !== id) return;
  if (state.terminal) { setStreamState("idle"); return; }
  stopReconnectTimer();
  state.streaming = true;
  const token = Symbol("stream");
  state.streamToken = token;
  const ctrl = new AbortController();
  state.streamAbort = ctrl;
  setStreamState(state.reconnectAttempts > 0 ? "reconnecting" : "connecting");
  let dropped = false;
  try {
    const res = await fetch(`/sessions/${id}/events`, { headers: { authorization: `Bearer ${state.key}` }, signal: ctrl.signal });
    if (res.status === 401) { forgetKey("Agent key invalid or revoked — paste a fresh key to reconnect."); return; }
    if (!res.ok || !res.body) throw new Error(`stream failed (HTTP ${res.status})`);
    state.reconnectAttempts = 0;
    state.replayRemaining = state.seen; // skip what /log already backfilled
    setStreamState("live");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!state.terminal) {
      const { value, done } = await reader.read();
      if (done) { dropped = true; break; } // gateway closed the stream before the run finished
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        consumeFrame(buffer.slice(0, sep), id);
        buffer = buffer.slice(sep + 2);
      }
    }
  } catch {
    dropped = !ctrl.signal.aborted && !state.terminal;
  } finally {
    if (state.streamToken === token) {
      state.streaming = false;
      state.streamAbort = null;
      if (state.currentId !== id || state.terminal || !dropped) setStreamState("idle");
      else scheduleReconnect(id);
    }
  }
}
/** Capped exponential backoff: 500ms, 1s, 2s, 4s, then 5s. */
function scheduleReconnect(id) {
  state.reconnectAttempts += 1;
  const delay = Math.min(500 * 2 ** (state.reconnectAttempts - 1), 5000);
  setStreamState("reconnecting");
  state.reconnectTimer = setTimeout(() => void openStream(id), delay);
}
function stopReconnectTimer() {
  if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}
function stopStream() {
  stopReconnectTimer();
  state.streaming = false;
  state.streamToken = null;
  state.streamAbort?.abort();
  state.streamAbort = null;
  state.reconnectAttempts = 0;
}
/** Re-open the stream after a new run starts on a session we had stopped following. */
function ensureStream() {
  if (state.currentId && !state.streaming && !state.terminal) void openStream(state.currentId);
}
// ------------------------------------------------------------------------ actions
async function sendMessage() {
  const input = $("message-input");
  const text = input.value.trim();
  if (!text || !state.currentId) return;
  setComposerNote("");
  $("send-btn").disabled = true;
  try {
    await api(`/sessions/${state.currentId}/messages`, { method: "POST", body: { text } });
    input.value = ""; // only clear on success; a failed send keeps the typed text
    state.terminal = false; // a new run may start on a session we stopped following
    ensureStream();
    await refreshCurrentSession();
  } catch (err) {
    if (err.status === 409) setComposerNote("session is busy — wait for the current run to finish, then send again.");
    else if (err.status !== 401) setComposerNote(`send failed: ${err.message}`);
  } finally {
    $("send-btn").disabled = false;
    input.focus();
  }
}
/** Validate the key with the cheapest authenticated round-trip, then load sessions. */
async function connect(key) {
  state.key = key;
  $("login-error").textContent = ""; $("login-btn").disabled = true;
  try {
    const data = await api("/sessions"); // cheapest authenticated round-trip: validates the key
    saveKey(key);
    state.sessions = data.sessions ?? [];
    $("login").hidden = true; $("app").hidden = false;
    setStreamState("idle");
    renderSessionList();
  } catch (err) {
    if (err.status !== 401) {
      state.key = "";
      $("login-error").textContent = `Could not reach the gateway: ${err.message}`;
    }
  } finally {
    $("login-btn").disabled = false;
  }
}
/** Clear the stored key, stop streaming and return to the login panel. */
function forgetKey(message) {
  clearKey();
  state.key = ""; state.sessions = [];
  resetSessionView();
  renderSessionList();
  $("key-input").value = ""; $("login-error").textContent = message;
  $("login").hidden = false; $("app").hidden = true;
  renderConnChip();
  $("key-input").focus();
}
// ------------------------------------------------------------------------- wiring
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("key-input").value.trim();
  if (key) void connect(key);
  else $("login-error").textContent = "Paste an agent key first.";
});
$("disconnect-btn").addEventListener("click", () => forgetKey("Disconnected — paste a key to reconnect."));
$("refresh-btn").addEventListener("click", () => void loadSessions());
$("new-session-btn").addEventListener("click", () => {
  const form = $("new-session-form");
  form.hidden = !form.hidden;
  if (!form.hidden) $("goal-input").focus();
});
$("new-session-cancel").addEventListener("click", () => {
  $("new-session-form").hidden = true;
  $("new-session-error").textContent = "";
});
$("new-session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = $("goal-input").value.trim();
  if (!goal) return;
  $("new-session-error").textContent = "";
  try {
    const model = $("model-input").value.trim(); // blank = server default
    const rec = await api("/sessions", { method: "POST", body: model ? { goal, model } : { goal } });
    $("new-session-form").hidden = true;
    $("goal-input").value = ""; $("model-input").value = "";
    await loadSessions();
    await openSession(rec.id);
  } catch (err) {
    if (err.status !== 401) $("new-session-error").textContent = `could not create session: ${err.message}`;
  }
});
// Ctrl/Cmd+Enter submits the new-session form.
$("goal-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("new-session-form").requestSubmit(); }
});
// Enter sends a message, Shift+Enter adds a newline.
$("message-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("message-input").addEventListener("input", () => setComposerNote(""));
$("composer").addEventListener("submit", (e) => { e.preventDefault(); void sendMessage(); });
// Auto-scroll: follow the tail until the user scrolls up, then offer "jump to latest".
$("transcript").addEventListener("scroll", () => {
  const t = $("transcript");
  state.follow = t.scrollHeight - t.scrollTop - t.clientHeight < FOLLOW_THRESHOLD_PX;
  renderFollowChip();
});
$("jump-btn").addEventListener("click", () => {
  state.follow = true;
  $("transcript").scrollTop = $("transcript").scrollHeight;
  renderFollowChip();
});
window.addEventListener("beforeunload", () => stopStream());
// ---------------------------------------------------------------------------- boot
(function boot() {
  renderConnChip();
  renderFollowChip();
  const key = loadKey();
  if (key) void connect(key); // validate the stored key before showing the app
})();
