const $ = (id) => document.getElementById(id);
const API_ROOT = "/api/v2";
const ACTIVE_RUNS = new Set(["queued", "running", "waiting_permission"]);
const OPERATIONS = [
  "workspace.read",
  "workspace.write",
  "process.execute",
  "network.connect",
  "mcp.invoke",
  "connector.send",
  "mower.spawn",
  "task.handoff",
];
const emptyServer = () => ({
  mowers: [],
  threads: [],
  runs: [],
  profiles: [],
  workers: [],
  tasks: [],
  approvals: [],
  connections: [],
  readiness: {
    runtime: false,
    mode: "unconfigured",
    message: "The runtime has not been configured.",
  },
});
const state = {
  key: "",
  server: emptyServer(),
  currentThreadId: null,
  selectedMowerId: null,
  inspectorTab: "overview",
  events: new Map(),
  cursors: new Map(),
  follow: true,
  pollTimer: null,
  polling: false,
  generation: 0,
  failures: 0,
  modalAction: null,
  modalBusy: false,
  sending: false,
  filter: "",
  pendingRequest: null,
  models: [],
  announcedStatus: "",
  advice: new Map(),
  adviceLoading: new Set(),
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function button(text, className, action) {
  const node = element("button", className, text);
  node.type = "button";
  if (action) node.addEventListener("click", action);
  return node;
}
function shortId(id) {
  return String(id || "").slice(0, 10);
}
function initials(name) {
  return String(name || "M")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => [...p][0])
    .join("")
    .toUpperCase();
}
function labelStatus(status) {
  return String(status || "idle").replaceAll("_", " ");
}
function pill(status, label = labelStatus(status)) {
  return element("span", `state-pill ${status || "idle"}`, label);
}
function timeAgo(date) {
  const elapsed = Date.now() - Date.parse(date || "");
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
function formatTime(date) {
  return date && Number.isFinite(Date.parse(date))
    ? new Date(date).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
function currentThread() {
  return state.server.threads.find((t) => t.id === state.currentThreadId);
}
function mowerById(id) {
  return state.server.mowers.find((m) => m.id === id);
}
function selectedMower() {
  return mowerById(currentThread()?.mowerId || state.selectedMowerId);
}
function profileById(id, version) {
  return state.server.profiles.find(
    (p) => p.id === id && p.version === version,
  );
}
function runsForThread(id) {
  return state.server.runs.filter((run) => run.threadId === id);
}
function newestRun(id) {
  return runsForThread(id).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  )[0];
}
function activeRun(id) {
  return runsForThread(id).find((run) => ACTIVE_RUNS.has(run.status));
}
function pendingApprovals(id = null) {
  return state.server.approvals.filter(
    (a) => a.status === "pending" && (!id || a.action.threadId === id),
  );
}
function avatar(mower, extra = "") {
  return element(
    "span",
    `avatar ${mower?.role === "director" ? "avatar-director" : ""} ${extra}`,
    initials(mower?.name || "Mower"),
  );
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function toast(text, error = false) {
  const node = element("div", `toast${error ? " error" : ""}`, text);
  $("toast-region").replaceChildren(node);
  setTimeout(() => node.remove(), error ? 7500 : 4200);
}
function setConnection(connected, text) {
  $("connection-dot").className = `status-dot${connected ? "" : " offline"}`;
  $("connection-label").textContent =
    text || (connected ? "Connected to your yard" : "Reconnecting…");
  document.querySelector(".live-label").lastChild.textContent = connected
    ? " Live"
    : " Reconnecting";
}
function saveKey(key) {
  try {
    sessionStorage.setItem("laun.v2.key", key);
  } catch {
    /* In-memory auth works if storage is disabled. */
  }
}
function loadKey() {
  try {
    return sessionStorage.getItem("laun.v2.key") || "";
  } catch {
    return "";
  }
}
function clearKey() {
  try {
    sessionStorage.removeItem("laun.v2.key");
  } catch {}
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${state.key}`);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal || controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(
      error?.name === "AbortError"
        ? "The server took too long to respond. Your input has been kept."
        : "Could not reach this installation. Check that the control server is running.",
    );
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(
      data.error || `The server returned HTTP ${response.status}.`,
    );
    error.status = response.status;
    if (response.status === 401 && !$("workspace").hidden)
      disconnect("This key is invalid or revoked. Connect with a current key.");
    throw error;
  }
  return data;
}
function normalizeServer(data) {
  if (!data || typeof data !== "object")
    throw new Error("The control server returned an invalid workspace.");
  const result = emptyServer();
  for (const key of [
    "mowers",
    "threads",
    "runs",
    "profiles",
    "workers",
    "tasks",
    "approvals",
    "connections",
  ])
    result[key] = Array.isArray(data[key]) ? data[key] : [];
  result.readiness = data.readiness || result.readiness;
  return result;
}
async function connect(key) {
  $("login-error").textContent = "";
  $("connect-button").disabled = true;
  state.key = key;
  try {
    state.server = normalizeServer(await api("/state"));
    saveKey(key);
    $("login-view").hidden = true;
    $("workspace").hidden = false;
    $("auth-key").value = "";
    state.failures = 0;
    void loadModels();
    setConnection(true);
    chooseInitialThread();
    renderWorkspace();
    if (state.currentThreadId) await loadEvents(state.currentThreadId, true);
    schedulePoll(500);
  } catch (error) {
    state.key = "";
    $("login-error").textContent = errorMessage(error);
  } finally {
    $("connect-button").disabled = false;
  }
}
function disconnect(
  message = "Disconnected. Connect again whenever you’re ready.",
) {
  state.generation++;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.key = "";
  clearKey();
  state.server = emptyServer();
  state.events.clear();
  state.cursors.clear();
  state.advice.clear();
  state.adviceLoading.clear();
  state.currentThreadId = null;
  closeModal();
  $("workspace").hidden = true;
  $("login-view").hidden = false;
  $("login-error").textContent = message;
  $("auth-key").focus();
}
function chooseInitialThread() {
  const id = threadFromHash();
  if (id && state.server.threads.some((t) => t.id === id))
    state.currentThreadId = id;
  else if (
    state.currentThreadId &&
    !state.server.threads.some((t) => t.id === state.currentThreadId)
  )
    state.currentThreadId = null;
  state.selectedMowerId ||=
    state.server.mowers.find((m) => m.role === "director")?.id ||
    state.server.mowers[0]?.id ||
    null;
}
function schedulePoll(delay = 1600) {
  clearTimeout(state.pollTimer);
  if (state.key) state.pollTimer = setTimeout(() => void poll(), delay);
}
async function poll() {
  if (!state.key) return;
  if (state.polling) {
    schedulePoll(500);
    return;
  }
  state.polling = true;
  const generation = state.generation;
  try {
    const data = await api("/state");
    if (generation !== state.generation) return;
    state.server = normalizeServer(data);
    state.failures = 0;
    setConnection(true);
    chooseInitialThread();
    renderWorkspace();
    if (state.currentThreadId) await loadEvents(state.currentThreadId);
  } catch (error) {
    if (generation !== state.generation || !state.key) return;
    state.failures++;
    setConnection(
      false,
      state.failures > 3 ? "Connection interrupted" : "Reconnecting…",
    );
    if (state.failures === 1) toast(errorMessage(error), true);
  } finally {
    state.polling = false;
    if (state.key && generation === state.generation)
      schedulePoll(Math.min(1600 * Math.max(1, state.failures), 12_000));
  }
}
async function refresh() {
  const generation = state.generation;
  const data = await api("/state");
  if (!state.key || generation !== state.generation) return;
  state.server = normalizeServer(data);
  chooseInitialThread();
  renderWorkspace();
  setConnection(true);
  if (state.currentThreadId) await loadEvents(state.currentThreadId);
}
async function loadModels() {
  const generation = state.generation;
  try {
    const data = await api("/models");
    if (!state.key || generation !== state.generation) return;
    state.models = (Array.isArray(data) ? data : data.models || []).filter(
      (model) => model && typeof model.id === "string",
    );
    const list = $("runtime-models");
    list.replaceChildren();
    for (const model of [...state.models]
      .sort(
        (a, b) =>
          Number(b.configured) - Number(a.configured) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 600)) {
      const option = element(
        "option",
        "",
        `${model.name || model.id}${model.configured ? " · configured" : " · credentials needed"}`,
      );
      option.value = model.id;
      list.append(option);
    }
  } catch {
    /* Custom provider/model entry remains available if a catalog is unavailable. */
  }
}
async function loadEvents(threadId, reset = false) {
  const generation = state.generation;
  const cursor = reset ? 0 : state.cursors.get(threadId) || 0;
  const data = await api(
    `/threads/${encodeURIComponent(threadId)}/events?after=${cursor}`,
  );
  if (!state.key || generation !== state.generation) return;
  const incoming = Array.isArray(data.events) ? data.events : [];
  const events = reset ? [] : state.events.get(threadId) || [];
  const seen = new Set(events.map((e) => e.sequence));
  for (const entry of incoming)
    if (!seen.has(entry.sequence)) {
      events.push(entry);
      seen.add(entry.sequence);
    }
  events.sort((a, b) => a.sequence - b.sequence);
  state.events.set(threadId, events);
  state.cursors.set(
    threadId,
    Number.isSafeInteger(data.nextCursor)
      ? data.nextCursor
      : events.at(-1)?.sequence || cursor,
  );
  if (state.currentThreadId === threadId && (incoming.length || reset))
    renderTranscript();
  await loadThreadAdvice(threadId);
}
function isAdviceRun(runId) {
  if (state.advice.has(runId)) return true;
  const run = state.server.runs.find((item) => item.id === runId);
  const thread = state.server.threads.find((item) => item.id === run?.threadId);
  return (
    mowerById(thread?.mowerId)?.role === "adviser" &&
    run?.requestId?.startsWith("advice:")
  );
}
async function loadThreadAdvice(threadId) {
  const references = new Set();
  for (const event of state.events.get(threadId) || []) {
    if (event.payload?.adviserRunId) references.add(event.payload.adviserRunId);
    if (event.payload?.adviceRunId) references.add(event.payload.adviceRunId);
  }
  for (const run of runsForThread(threadId))
    if (isAdviceRun(run.id)) references.add(run.id);
  const generation = state.generation;
  await Promise.all(
    [...references].map(async (runId) => {
      const current = state.advice.get(runId);
      if (
        state.adviceLoading.has(runId) ||
        (current && !["queued", "running"].includes(current.status))
      )
        return;
      state.adviceLoading.add(runId);
      try {
        const result = await api(`/advice/${encodeURIComponent(runId)}`);
        if (state.key && generation === state.generation)
          state.advice.set(runId, result);
      } catch {
        // Advice inspection is optional; a failed fetch never makes a draft actionable.
      } finally {
        state.adviceLoading.delete(runId);
      }
    }),
  );
  if (generation === state.generation && state.currentThreadId === threadId)
    renderTranscript();
}
async function openThread(id, updateHash = true) {
  if (!state.server.threads.some((t) => t.id === id)) return;
  state.currentThreadId = id;
  state.selectedMowerId = currentThread().mowerId;
  state.follow = true;
  if (updateHash)
    history.replaceState(
      null,
      "",
      `${location.pathname}#/threads/${encodeURIComponent(id)}`,
    );
  $("workspace").classList.remove("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", "false");
  state.pendingRequest = null;
  $("message-input").value = "";
  composerNote();
  renderWorkspace();
  renderTranscript();
  try {
    await loadEvents(id, !state.events.has(id));
  } catch (error) {
    toast(errorMessage(error), true);
  }
  $("message-input").focus();
}
function threadFromHash() {
  return location.hash.match(/^#\/threads\/([A-Za-z0-9_-]+)$/)?.[1] || null;
}

function renderWorkspace() {
  renderSidebar();
  renderHeader();
  renderReadiness();
  renderApprovalsStrip();
  renderInspector();
}
function renderSidebar() {
  const mowers = $("mower-list");
  mowers.replaceChildren();
  const activeMowerId = currentThread()?.mowerId || state.selectedMowerId;
  for (const mower of [...state.server.mowers]
    .filter((m) => !m.archivedAt)
    .sort(
      (a, b) =>
        (a.role === "director" ? -1 : 0) - (b.role === "director" ? -1 : 0) ||
        a.name.localeCompare(b.name),
    )) {
    const item = button(
      "",
      `mower-item${mower.id === activeMowerId ? " active" : ""}`,
      () => {
        state.selectedMowerId = mower.id;
        const latest = state.server.threads
          .filter((t) => t.mowerId === mower.id && !t.archivedAt)
          .sort((a, b) =>
            String(b.updatedAt).localeCompare(String(a.updatedAt)),
          )[0];
        if (latest) void openThread(latest.id);
        else {
          state.currentThreadId = null;
          history.replaceState(null, "", location.pathname);
          renderWorkspace();
        }
      },
    );
    const info = element("span", "mower-info");
    info.append(
      element("strong", "", mower.name),
      element(
        "small",
        "",
        mower.role === "director"
          ? "Groundskeeper · Director"
          : mower.role === "adviser"
            ? "Permission adviser"
            : "Mower",
      ),
    );
    const running = state.server.threads.some(
      (t) => t.mowerId === mower.id && activeRun(t.id),
    );
    item.append(
      avatar(mower),
      info,
      element("span", `mower-status${running ? " running" : ""}`),
    );
    item.title = mower.name;
    item.setAttribute(
      "aria-current",
      mower.id === activeMowerId ? "true" : "false",
    );
    mowers.append(item);
  }
  if (!mowers.children.length)
    mowers.append(
      element(
        "p",
        "sidebar-empty",
        "Your crew starts here. Add a mower to give your first agent a name.",
      ),
    );
  const threads = $("thread-list");
  threads.replaceChildren();
  const query = state.filter.toLocaleLowerCase();
  const visible = state.server.threads
    .filter(
      (t) =>
        !t.archivedAt &&
        (!query ||
          `${t.title} ${mowerById(t.mowerId)?.name || ""}`
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  $("thread-count").textContent = state.server.threads.filter(
    (t) => !t.archivedAt,
  ).length;
  for (const thread of visible) {
    const item = button(
      "",
      `thread-item${thread.id === state.currentThreadId ? " active" : ""}`,
      () => void openThread(thread.id),
    );
    const name = element("span", "thread-label");
    name.append(
      element("strong", "", thread.title),
      element(
        "small",
        "",
        `${mowerById(thread.mowerId)?.name || "Mower"} · ${timeAgo(thread.updatedAt)}`,
      ),
    );
    item.append(
      element("span", "thread-glyph", thread.parentThreadId ? "↳" : "◇"),
      name,
    );
    item.title = thread.title;
    if (thread.id === state.currentThreadId)
      item.setAttribute("aria-current", "page");
    threads.append(item);
  }
  if (!visible.length)
    threads.append(
      element(
        "p",
        "sidebar-empty",
        query
          ? "No threads match your search."
          : "A fresh patch. Start a thread when you’re ready.",
      ),
    );
  $("new-thread-button").disabled = state.server.mowers.length === 0;
  const local = state.server.workers.find((w) => w.local);
  $("installation-location").textContent = local
    ? `${local.name} · ${location.hostname}`
    : location.host;
}
function renderHeader() {
  const thread = currentThread();
  const mower = selectedMower();
  $("empty-state").hidden = !!thread;
  $("thread-view").hidden = !thread;
  $("thread-title").textContent =
    thread?.title ||
    (mower ? `A new patch for ${mower.name}.` : "Room to grow.");
  $("thread-breadcrumb").replaceChildren(
    document.createTextNode(mower?.name || "Your workspace"),
    element("span", "", "/"),
    document.createTextNode(thread ? "Thread" : "Threads"),
  );
  $("thread-menu-button").hidden = !thread;
  const run = thread ? activeRun(thread.id) || newestRun(thread.id) : null;
  $("thread-status").hidden = !thread;
  $("thread-status").textContent = run ? labelStatus(run.status) : "Ready";
  $("thread-status").className = `state-pill ${run?.status || "idle"}`;
  const interrupted =
    thread &&
    runsForThread(thread.id).find((item) => item.status === "interrupted");
  const recovery = $("recovery-strip");
  recovery.replaceChildren();
  recovery.hidden = !interrupted;
  if (interrupted) {
    const text = element("p");
    text.append(
      element("strong", "", "This thread needs reconciliation"),
      document.createTextNode(
        "A worker stopped reporting. Later messages stay queued until you review the interrupted work.",
      ),
    );
    recovery.append(
      text,
      button(
        "Review interrupted work",
        "button button-quiet button-small",
        () => showResumeForm(interrupted),
      ),
    );
  }
  const announcement = thread
    ? `${mower?.name || "Mower"}: ${run ? labelStatus(run.status) : "ready"} in ${thread.title}.`
    : "";
  if (announcement !== state.announcedStatus) {
    $("thread-announcement").textContent = announcement;
    state.announcedStatus = announcement;
  }
  $("cancel-run-button").hidden = !thread || !activeRun(thread.id);
  $("composer-mower").textContent = mower ? `✳ ${mower.name}` : "Mower";
  $("message-input").placeholder = mower
    ? `Message ${mower.name}…`
    : "Give your mower something to work on…";
  $("send-button").disabled = state.sending;
  $("send-button").title = state.server.readiness.runtime
    ? "Send message"
    : "Save a message in the durable queue while workers are unavailable";
  const steer = $("delivery-mode").querySelector('option[value="steer"]');
  // The durable runtime advertises steering through readiness.capabilities when available.
  steer.disabled = !state.server.readiness.capabilities?.includes("steer");
  if (steer.disabled && $("delivery-mode").value === "steer")
    $("delivery-mode").value = "queue";
  const parent =
    thread?.parentThreadId &&
    state.server.threads.find((t) => t.id === thread.parentThreadId);
  $("thread-context").replaceChildren();
  $("thread-context").hidden = !parent;
  if (parent)
    $("thread-context").append(
      document.createTextNode("Delegated from "),
      button(parent.title, "text-button", () => void openThread(parent.id)),
    );
  const emptyStart = $("empty-start-button");
  emptyStart.textContent = state.server.mowers.length
    ? "Start a new thread ↗"
    : "Name your first mower ↗";
  renderUsage();
}
function renderReadiness() {
  const readiness = state.server.readiness;
  const banner = $("readiness-banner");
  banner.replaceChildren();
  banner.hidden = readiness.runtime && readiness.mode === "isolated";
  if (banner.hidden) return;
  const text = element("div");
  text.append(
    element(
      "strong",
      "",
      readiness.runtime
        ? "Trusted local mode. "
        : "Finish setting up your runtime. ",
    ),
    document.createTextNode(
      readiness.message ||
        (readiness.runtime
          ? "Work runs with your local user’s access. Configure OpenShell for isolated execution."
          : "The server is connected, but no runtime is ready to accept work."),
    ),
  );
  banner.append(element("span", "", readiness.runtime ? "◌" : "i"), text);
}
function renderApprovalsStrip() {
  const pending = pendingApprovals(state.currentThreadId);
  const strip = $("approval-strip");
  strip.replaceChildren();
  strip.hidden = !currentThread() || !pending.length;
  if (strip.hidden) return;
  const p = element("p");
  p.append(
    element(
      "strong",
      "",
      `${pending.length === 1 ? "A permission request needs you" : `${pending.length} permission requests need you`}`,
    ),
    document.createTextNode(
      "Review the exact action before allowing it. Other work can continue.",
    ),
  );
  strip.append(
    p,
    button("Review request ↗", "button", () => {
      selectInspector("permissions");
      openInspector();
    }),
  );
}
function renderUsage() {
  const events = state.events.get(state.currentThreadId) || [];
  let tokens = 0;
  let cost = 0;
  for (const item of events) {
    const e = item.payload?.event;
    if (e?.type !== "usage") continue;
    tokens += e.totalTokens ?? (e.inputTokens || 0) + (e.outputTokens || 0);
    cost += e.costUsd || 0;
  }
  $("thread-usage").textContent =
    tokens || cost
      ? `${tokens.toLocaleString()} tokens${cost ? ` · $${cost.toFixed(3)}` : ""}`
      : "";
}

function groupTranscript(events) {
  const groups = [];
  for (const item of events) {
    const payload = item.payload || {};
    const e = payload.event;
    if (item.kind === "message") {
      groups.push({
        key: item.sequence,
        type: payload.role === "assistant" ? "assistant" : "user",
        text: payload.text || "",
        createdAt: item.createdAt,
        runId: item.runId,
      });
      continue;
    }
    if (e?.type === "text") {
      const previous = groups.at(-1);
      if (previous?.type === "assistant" && previous.runId === item.runId)
        previous.text += e.delta;
      else
        groups.push({
          key: item.sequence,
          type: "assistant",
          text: e.delta,
          createdAt: item.createdAt,
          runId: item.runId,
        });
    } else if (e?.type === "thinking") {
      const previous = groups.at(-1);
      if (previous?.type === "thinking" && previous.runId === item.runId)
        previous.text += e.delta;
      else
        groups.push({
          key: item.sequence,
          type: "thinking",
          text: e.delta,
          createdAt: item.createdAt,
          runId: item.runId,
        });
    } else if (e?.type === "tool_call") {
      groups.push({
        key: item.sequence,
        type: "tool",
        name: e.name,
        arguments: e.args,
        createdAt: item.createdAt,
        runId: item.runId,
      });
    } else if (e?.type === "tool_result") {
      const call = [...groups]
        .reverse()
        .find(
          (g) =>
            g.type === "tool" &&
            g.name === e.name &&
            g.runId === item.runId &&
            g.result === undefined,
        );
      if (call) {
        call.result =
          e.output || (e.ok ? "Completed" : "The tool did not complete.");
        call.ok = e.ok;
      } else
        groups.push({
          key: item.sequence,
          type: "tool",
          name: e.name,
          result: e.output || "",
          ok: e.ok,
          createdAt: item.createdAt,
          runId: item.runId,
        });
    } else if (e?.type === "error")
      groups.push({
        key: item.sequence,
        type: "error",
        text: e.message,
        createdAt: item.createdAt,
      });
    else if (
      e?.type === "done" &&
      e.summary &&
      !groups.some((g) => g.type === "assistant" && g.runId === item.runId)
    )
      groups.push({
        key: item.sequence,
        type: "assistant",
        text: e.summary,
        createdAt: item.createdAt,
        runId: item.runId,
      });
    else if (e?.type === "status" && e.message)
      groups.push({
        key: item.sequence,
        type: "system",
        text: e.message,
        createdAt: item.createdAt,
      });
    else if (
      payload.text &&
      item.kind !== "approval" &&
      !(
        payload.status === "done" &&
        groups.some(
          (g) =>
            g.type === "assistant" &&
            g.runId === item.runId &&
            g.text.trim() === payload.text.trim(),
        )
      )
    )
      groups.push({
        key: item.sequence,
        type: "system",
        text: payload.text,
        createdAt: item.createdAt,
        adviserThreadId: payload.adviserThreadId,
      });
  }
  return groups;
}
function richText(text) {
  const fragment = document.createDocumentFragment();
  const pieces = String(text).split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  for (const part of pieces) {
    if (!part) continue;
    if (part.startsWith("```")) {
      const newline = part.indexOf("\n");
      const language = part.slice(3, newline).trim();
      const wrapper = element("div", "code-block");
      const head = element("div", "code-heading");
      const code = part
        .slice(newline + 1)
        .replace(/```$/, "")
        .trimEnd();
      head.append(
        element("span", "", language || "code"),
        button("Copy", "text-button", () => void copyText(code)),
      );
      const pre = element("pre");
      pre.append(element("code", "", code));
      wrapper.append(head, pre);
      fragment.append(wrapper);
    } else fragment.append(document.createTextNode(part));
  }
  return fragment;
}
function renderTranscript() {
  const viewport = $("messages");
  const previousHeight = viewport.scrollHeight;
  const previousTop = viewport.scrollTop;
  const openTools = new Set(
    [...viewport.querySelectorAll("details[open][data-event]")].map(
      (d) => d.dataset.event,
    ),
  );
  viewport.replaceChildren();
  const thread = currentThread();
  if (!thread) return;
  const mower = mowerById(thread.mowerId);
  const renderedAdvice = new Set();
  for (const group of groupTranscript(state.events.get(thread.id) || [])) {
    if (group.type === "assistant" && isAdviceRun(group.runId)) {
      if (renderedAdvice.has(group.runId)) continue;
      renderedAdvice.add(group.runId);
    }
    const article = element(
      "article",
      `message ${group.type === "error" ? "system error" : group.type === "system" ? "system" : group.type === "thinking" ? "tool" : group.type}`,
    );
    article.dataset.event = String(group.key);
    if (group.type === "tool") {
      const details = element("details", "tool-card");
      details.dataset.event = String(group.key);
      details.open = openTools.has(String(group.key));
      const summary = element("summary");
      summary.append(
        element("span", "tool-name", group.name || "Tool"),
        pill(
          group.result === undefined ? "running" : group.ok ? "done" : "error",
          group.result === undefined
            ? "Working"
            : group.ok
              ? "Completed"
              : "Failed",
        ),
      );
      details.append(summary);
      if (group.arguments !== undefined)
        details.append(
          element("pre", "", JSON.stringify(group.arguments, null, 2)),
        );
      if (group.result !== undefined)
        details.append(element("pre", "", group.result));
      article.append(details);
    } else if (group.type === "thinking") {
      const details = element("details", "thinking-card");
      details.dataset.event = String(group.key);
      details.open = openTools.has(String(group.key));
      details.append(
        element("summary", "", "Reasoning"),
        element("pre", "", group.text),
      );
      article.append(details);
    } else {
      if (group.type === "user")
        article.append(element("span", "avatar message-avatar", "Y"));
      else if (group.type === "assistant")
        article.append(avatar(mower, "message-avatar"));
      const body = element("div", "message-body");
      const meta = element("div", "message-meta");
      meta.append(
        element(
          "strong",
          "",
          group.type === "user" ? "You" : mower?.name || "Mower",
        ),
        element("time", "", formatTime(group.createdAt)),
      );
      const content = element("div", "message-content");
      if (group.type === "assistant" && isAdviceRun(group.runId))
        renderAdviceContent(content, group, openTools);
      else if (group.type === "assistant") content.append(richText(group.text));
      else content.textContent = group.text;
      if (group.adviserThreadId)
        content.append(
          button(
            "Open Gatekeeper discussion ↗",
            "text-button",
            () => void openThread(group.adviserThreadId),
          ),
        );
      body.append(meta, content);
      article.append(body);
    }
    viewport.append(article);
  }
  if (!viewport.children.length) {
    const welcome = element("div", "thread-welcome");
    welcome.append(
      avatar(mower),
      element("h2", "", `A fresh thread with ${mower?.name || "your mower"}.`),
      element(
        "p",
        "",
        "Share a goal, ask a question, or give this thread a task. Your conversation will stay here between runs.",
      ),
    );
    viewport.append(welcome);
  }
  if (activeRun(thread.id)?.status === "running") {
    const indicator = element("div", "message assistant");
    indicator.append(avatar(mower, "message-avatar"));
    const typing = element("div", "typing-indicator");
    typing.setAttribute("aria-label", `${mower?.name || "Mower"} is working`);
    typing.append(element("span"), element("span"), element("span"));
    indicator.append(typing);
    viewport.append(indicator);
  }
  if (state.follow) viewport.scrollTop = viewport.scrollHeight;
  else
    viewport.scrollTop = Math.max(
      0,
      previousTop + Math.min(0, viewport.scrollHeight - previousHeight),
    );
  $("jump-latest").hidden = state.follow;
  renderUsage();
}
function renderAdviceContent(content, group, openTools) {
  const result = state.advice.get(group.runId);
  const raw = groupTranscript(state.events.get(state.currentThreadId) || [])
    .filter((item) => item.type === "assistant" && item.runId === group.runId)
    .map((item) => item.text)
    .join("");
  let draft;
  try {
    const parsed = JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
    if (
      typeof parsed.explanation === "string" &&
      typeof parsed.question === "string"
    )
      draft = parsed;
  } catch {
    /* Partial or invalid model output remains non-actionable. */
  }
  const proposal = result?.status === "proposed" ? result.proposal : null;
  content.append(
    element(
      "strong",
      "",
      proposal
        ? "A guardrail proposal is ready for your review."
        : ["invalid", "failed"].includes(result?.status)
          ? "This discussion did not produce a validated proposal."
          : "Gatekeeper is considering this permission request.",
    ),
  );
  if (proposal || draft) {
    content.append(
      element("p", "", proposal?.explanation || draft.explanation),
    );
    content.append(element("p", "", proposal?.question || draft.question));
  }
  if (result?.discussion?.question)
    content.append(note("Gatekeeper asks", result.discussion.question));
  if (result?.error)
    content.append(note("No changes were made", result.error, true));
  if (proposal) {
    const profile = profileById(
      proposal.baseProfileId,
      proposal.baseProfileVersion,
    );
    const review = button(
      "Review guardrail proposal",
      "button button-primary button-small",
      () => showProposal(profile, proposal),
    );
    review.disabled = !profile || !!profile.revokedAt;
    content.append(review);
  }
  content.append(
    element(
      "p",
      "field-hint",
      proposal
        ? "No action has been approved and no profile changed. Creating a revision requires your separate review."
        : "Model advice is a discussion, not permission. A server-validated proposal is required before review.",
    ),
  );
  const source =
    result &&
    state.server.approvals.find(
      (approval) => approval.id === result.approvalId,
    );
  if (source)
    content.append(
      button("Return to original request ↗", "text-button", () => {
        state.inspectorTab = "permissions";
        void openThread(source.action.threadId);
      }),
    );
  const details = element("details", "thinking-card");
  details.dataset.event = `advice:${group.runId}`;
  details.open = openTools.has(details.dataset.event);
  details.append(
    element("summary", "", "Advanced: model response"),
    element("pre", "", raw),
  );
  content.append(details);
}

function section(title, action) {
  const wrapper = element("section", "inspector-section");
  const head = element("div", "inspector-section-header");
  head.append(element("h3", "", title));
  if (action) head.append(action);
  wrapper.append(head);
  return wrapper;
}
function note(title, text, warning = false) {
  const node = element("div", `note-card${warning ? " warning" : ""}`);
  if (title) node.append(element("strong", "", title));
  if (text) node.append(element("p", "", text));
  return node;
}
function detailsGrid(entries) {
  const grid = element("dl", "detail-grid");
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    const term = element("dt", "", name);
    const description = element("dd");
    description.append(
      value instanceof Node ? value : document.createTextNode(String(value)),
    );
    grid.append(term, description);
  }
  return grid;
}
function card(title, status, text) {
  const node = element("div", "item-card");
  const top = element("div", "item-card-top");
  top.append(element("strong", "", title));
  if (status) top.append(pill(status));
  node.append(top);
  if (text) node.append(element("p", "", text));
  return node;
}
function selectInspector(tab) {
  state.inspectorTab = tab;
  $("inspector-content").setAttribute("aria-labelledby", `details-tab-${tab}`);
  document.querySelectorAll("[data-tab]").forEach((b) => {
    const selected = b.dataset.tab === tab;
    b.setAttribute("aria-selected", String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  renderInspector();
}
function openInspector() {
  $("workspace").classList.remove("inspector-hidden");
  $("inspector-toggle").setAttribute("aria-expanded", "true");
}
function renderInspector() {
  const content = $("inspector-content");
  const previousScroll = content.scrollTop;
  const openDetails = new Set(
    [...content.querySelectorAll("details[open][data-id]")].map(
      (d) => d.dataset.id,
    ),
  );
  content.replaceChildren();
  const pending = pendingApprovals();
  $("approval-count").textContent = pending.length;
  $("approval-count").hidden = !pending.length;
  const renderers = {
    overview: renderOverview,
    tasks: renderTasks,
    permissions: renderPermissions,
    yards: renderYards,
    connections: renderConnections,
  };
  (renderers[state.inspectorTab] || renderOverview)(content);
  content.querySelectorAll("details[data-id]").forEach((d) => {
    if (openDetails.has(d.dataset.id)) d.open = true;
  });
  content.scrollTop = previousScroll;
}
function renderOverview(content) {
  const mower = selectedMower();
  const thread = currentThread();
  if (mower) {
    const detail = section(
      "Your mower",
      button("···", "icon-button", () => showMowerForm(mower)),
    );
    const heading = element("div", "mower-detail");
    const text = element("div");
    text.append(
      element("strong", "", mower.name),
      element(
        "p",
        "",
        mower.role === "director"
          ? "Groundskeeper · Director"
          : mower.role === "adviser"
            ? "Gatekeeper · Permission adviser"
            : "Part of your crew",
      ),
    );
    heading.append(avatar(mower), text);
    detail.append(heading);
    const profile = profileById(
      thread?.profileId || mower.profileId,
      thread?.profileVersion || mower.profileVersion,
    );
    const worker = state.server.workers.find((w) => w.id === mower.workerId);
    detail.append(
      detailsGrid([
        ["Model", mower.model],
        [
          "Profile",
          profile
            ? `${profile.name} · v${profile.version}`
            : "Profile unavailable",
        ],
        ["Permission mode", profile?.mode || "Unconfigured"],
        ["Yard", worker?.name || "Automatic placement"],
        ["Created", timeAgo(mower.createdAt)],
      ]),
    );
    if (
      thread &&
      (thread.profileId !== mower.profileId ||
        thread.profileVersion !== mower.profileVersion)
    )
      detail.append(
        note(
          "Thread profile is pinned",
          "This thread keeps its original permission revision. The mower’s new default applies to new threads.",
        ),
      );
    content.append(detail);
  }
  const workspace = section(thread ? "This thread" : "Workspace at a glance");
  const stats = element("div", "mini-stat-grid");
  for (const [value, label] of [
    [
      thread
        ? runsForThread(thread.id).filter((r) => ACTIVE_RUNS.has(r.status))
            .length
        : state.server.runs.filter((r) => ACTIVE_RUNS.has(r.status)).length,
      "Active & queued runs",
    ],
    [
      thread
        ? state.server.tasks.filter((t) => t.parentThreadId === thread.id)
            .length
        : state.server.tasks.length,
      "Delegated tasks",
    ],
  ]) {
    const stat = element("div", "mini-stat");
    stat.append(element("strong", "", value), element("span", "", label));
    stats.append(stat);
  }
  workspace.append(stats);
  if (thread) {
    workspace.append(
      detailsGrid([
        ["Thread", shortId(thread.id)],
        ["Started", timeAgo(thread.createdAt)],
        ["Last activity", timeAgo(thread.updatedAt)],
      ]),
    );
    workspace.lastChild.style.marginTop = "17px";
  }
  content.append(workspace);
  const queue = thread
    ? runsForThread(thread.id)
        .filter((r) => ACTIVE_RUNS.has(r.status))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  if (queue.length) {
    const block = section("Work in progress");
    for (const run of queue) {
      const node = card(
        isAdviceRun(run.id) ? "Permission discussion" : run.prompt || "Run",
        run.status,
      );
      node.querySelector("strong").className = "line-clamp";
      node.append(
        element(
          "p",
          "",
          `Accepted ${timeAgo(run.createdAt)} · ${shortId(run.id)}`,
        ),
      );
      block.append(node);
    }
    content.append(block);
  }
  const interrupted = thread
    ? runsForThread(thread.id).filter((run) => run.status === "interrupted")
    : [];
  if (interrupted.length) {
    const block = section("Needs reconciliation");
    for (const run of interrupted) {
      const node = card(
        "Interrupted work",
        "interrupted",
        run.summary ||
          "The worker stopped reporting. The previous action may have an unknown outcome.",
      );
      node.append(
        button(
          "Review before resuming",
          "button button-quiet button-small",
          () => showResumeForm(run),
        ),
      );
      block.append(node);
    }
    content.append(block);
  }
  const mode = state.server.readiness.mode;
  const control = section("Your guardrails");
  control.append(
    note(
      mode === "isolated"
        ? "Isolated execution"
        : mode === "trusted-local"
          ? "Trusted local execution"
          : "Runtime setup needed",
      mode === "isolated"
        ? "Your server reports OpenShell isolation. Permission profiles still control which mediated actions can run."
        : mode === "trusted-local"
          ? "Tools run as your local user. Profiles control mediated actions; OpenShell provides host-level isolation when configured."
          : state.server.readiness.message,
      mode !== "isolated",
    ),
  );
  control.append(
    button("Review permissions ↗", "text-button", () =>
      selectInspector("permissions"),
    ),
  );
  control.lastChild.style.marginTop = "12px";
  content.append(control);
  if (!mower) {
    const start = section("Build your crew");
    start.append(
      element(
        "p",
        "inspector-empty",
        "Give each mower a name, a model, and a permission profile. A groundskeeper can delegate work while each child keeps its own thread.",
      ),
      button("Add a mower", "button button-quiet button-small", () =>
        showMowerForm(),
      ),
    );
    start.lastChild.style.marginTop = "12px";
    content.append(start);
  }
}
function renderTasks(content) {
  const thread = currentThread();
  const scope = state.server.tasks.filter(
    (t) =>
      !thread || t.parentThreadId === thread.id || t.threadId === thread.id,
  );
  const block = section(
    "Delegated work",
    thread ? button("+", "icon-button", () => showTaskForm()) : null,
  );
  if (!scope.length) {
    block.append(
      element(
        "p",
        "inspector-empty",
        thread
          ? "No delegated work in this thread yet. Give another mower a task and follow its conversation here."
          : "Open a thread to delegate work to your crew.",
      ),
    );
    if (thread)
      block.append(
        button("Delegate a task ↗", "button button-quiet button-small", () =>
          showTaskForm(),
        ),
      );
  }
  for (const task of [...scope].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )) {
    const node = card(
      task.title,
      task.status,
      `Assigned to ${mowerById(task.mowerId)?.name || "mower"}`,
    );
    if (task.result) {
      const result = element("details", "task-result");
      result.dataset.id = task.id;
      result.append(
        element("summary", "", "View result"),
        element("pre", "", task.result),
      );
      node.append(result);
    }
    const actions = element("div", "card-actions");
    actions.append(
      button(
        "Open thread ↗",
        "button button-quiet",
        () => void openThread(task.threadId),
      ),
    );
    if (!["done", "cancelled"].includes(task.status))
      actions.append(
        button("Hand off", "button button-quiet", () => showHandoffForm(task)),
      );
    node.append(
      actions,
      element(
        "div",
        "id-line",
        `${shortId(task.id)} · ${timeAgo(task.updatedAt)}${task.handoffCount ? ` · ${task.handoffCount} handoff${task.handoffCount === 1 ? "" : "s"}` : ""}`,
      ),
    );
    block.append(node);
  }
  content.append(block);
  const guidance = section("A shared task, a clear owner");
  guidance.append(
    note(
      "Delegation stays within guardrails",
      "Children get their own thread and a bounded permission ceiling. A handoff changes task ownership; it does not copy credentials or grant broader access.",
    ),
  );
  content.append(guidance);
}
function renderPermissions(content) {
  const pending = pendingApprovals();
  const requests = section(
    `Needs your review${pending.length ? ` · ${pending.length}` : ""}`,
  );
  if (!pending.length)
    requests.append(
      element(
        "p",
        "inspector-empty",
        "All clear. Requests for additional permission will appear here with their exact action and destination.",
      ),
    );
  for (const approval of pending) {
    const mower = mowerById(approval.action.mowerId);
    const node = card(
      approval.action.operation,
      "pending",
      `${mower?.name || "Mower"} is asking to use this exact resource.`,
    );
    node.append(element("pre", "", approval.action.resource));
    if (approval.detail)
      node.append(element("pre", "approval-detail", approval.detail));
    node.append(
      detailsGrid([
        [
          "Thread",
          state.server.threads.find((t) => t.id === approval.action.threadId)
            ?.title || shortId(approval.action.threadId),
        ],
        [
          "Profile",
          `${profileById(approval.profileId, approval.profileVersion)?.name || "Profile"} · v${approval.profileVersion}`,
        ],
        ["Expires", formatTime(approval.expiresAt)],
        [
          "Arguments digest",
          element("span", "mono", approval.action.argumentsDigest),
        ],
      ]),
    );
    const actions = element("div", "card-actions");
    const allow = button(
      "Allow once",
      "button button-primary",
      () => void decideApproval(approval, "approve"),
    );
    allow.disabled = !approval.detail;
    if (!approval.detail) {
      allow.title =
        "This request has no inspectable action detail. Refresh or deny it before retrying.";
      node.append(
        note(
          "Action context unavailable",
          "This server did not provide an inspectable command or tool argument preview. You can deny the request; an approval requires the exact action details.",
          true,
        ),
      );
    }
    actions.append(
      allow,
      button(
        "Deny",
        "button button-quiet",
        () => void decideApproval(approval, "deny"),
      ),
      button("Set guardrails", "button button-quiet", () =>
        showGuardrailForm(approval),
      ),
      button("Discuss with Gatekeeper", "button button-quiet", () =>
        showAdviceForm(approval),
      ),
    );
    node.append(actions);
    requests.append(node);
  }
  content.append(requests);
  const thread = currentThread();
  const pinned = thread && profileById(thread.profileId, thread.profileVersion);
  if (pinned) {
    const snapshot = section(`Thread guardrails · v${pinned.version}`);
    const description = note(
      pinned.name,
      `${pinned.revokedAt ? "Revoked" : labelStatus(pinned.mode)} · This exact revision is pinned to the open thread. New defaults do not change it.`,
    );
    const rules = element("details", "profile-rules");
    rules.dataset.id = `pinned:${pinned.id}:${pinned.version}`;
    rules.append(
      element("summary", "", "Inspect the rules used by this thread"),
    );
    for (const rule of pinned.rules) {
      const row = element("div", "resource-rule");
      const label = element("span");
      label.append(
        document.createTextNode(rule.operation),
        element("span", "mono", rule.resource),
      );
      row.append(
        element("span", `rule-effect ${rule.effect}`, rule.effect),
        label,
      );
      rules.append(row);
    }
    if (!pinned.rules.length)
      rules.append(
        element(
          "p",
          "inspector-empty",
          "No tool capabilities are granted. Missing rules deny.",
        ),
      );
    description.append(rules);
    snapshot.append(description);
    content.append(snapshot);
  }
  const profiles = section(
    "Permission profiles",
    button("+", "icon-button", () => showProfileForm()),
  );
  if (!state.server.profiles.length)
    profiles.append(
      element(
        "p",
        "inspector-empty",
        "Start with a minimal profile. You can share a revision between mowers, then create a new revision when your guardrails change.",
      ),
      button("Create a profile", "button button-quiet button-small", () =>
        showProfileForm(),
      ),
    );
  const versions = new Map();
  for (const profile of state.server.profiles) {
    const current = versions.get(profile.id);
    if (!current || profile.version > current.version)
      versions.set(profile.id, profile);
  }
  for (const profile of versions.values()) {
    const node = card(
      profile.name,
      profile.revokedAt ? "revoked" : profile.mode,
      `${profile.rules.length} exact rule${profile.rules.length === 1 ? "" : "s"} · revision ${profile.version}`,
    );
    const rules = element("details", "profile-rules");
    rules.dataset.id = `${profile.id}:${profile.version}`;
    rules.append(element("summary", "", "Inspect rules"));
    if (!profile.rules.length)
      rules.append(
        element(
          "p",
          "inspector-empty",
          "No tool capabilities are granted. Model conversation can continue; unconfigured actions are denied.",
        ),
      );
    for (const rule of profile.rules) {
      const row = element("div", "resource-rule");
      const label = element("span");
      label.append(
        document.createTextNode(rule.operation),
        element("span", "mono", rule.resource),
      );
      row.append(
        element("span", `rule-effect ${rule.effect}`, rule.effect),
        label,
      );
      rules.append(row);
    }
    node.append(rules);
    const actions = element("div", "card-actions");
    if (!profile.revokedAt)
      actions.append(
        button("New revision", "button button-quiet", () =>
          showProfileForm(profile),
        ),
        button("Assign to mower", "button button-quiet", () =>
          showProfileAssignment(profile),
        ),
        button("Revoke", "button button-quiet", () =>
          showRevokeProfile(profile),
        ),
      );
    node.append(actions);
    profiles.append(node);
  }
  content.append(profiles);
  const modes = section("Choose how to handle requests");
  modes.append(
    note(
      "Auto mode is your adviser",
      "Auto mode helps collect feedback and proposes narrow guardrails. It cannot approve its own requests. Explicit denies always win; missing rules stay denied.",
    ),
  );
  content.append(modes);
}
function renderYards(content) {
  const block = section(
    "Execution yards",
    button("+", "icon-button", () => showWorkerForm()),
  );
  if (!state.server.workers.length)
    block.append(
      element(
        "p",
        "inspector-empty",
        "No workers are enrolled. Add a yard to connect an execution worker on this computer or a VPS.",
      ),
      button("Add a yard ↗", "button button-quiet button-small", () =>
        showWorkerForm(),
      ),
    );
  for (const worker of state.server.workers) {
    const node = card(
      worker.name,
      worker.status,
      worker.local ? "Local execution worker" : "Remote execution worker",
    );
    node.append(
      detailsGrid([
        [
          "Capacity",
          `${worker.capacity} concurrent run${worker.capacity === 1 ? "" : "s"}`,
        ],
        [
          "Last seen",
          worker.lastSeenAt ? timeAgo(worker.lastSeenAt) : "Not connected yet",
        ],
        [
          "Assigned mowers",
          state.server.mowers.filter((m) => m.workerId === worker.id).length,
        ],
      ]),
    );
    if (worker.labels?.length) {
      const tags = element("div", "yard-capabilities");
      for (const label of worker.labels)
        tags.append(element("span", "tag", label));
      node.append(tags);
    }
    node.append(element("div", "id-line", worker.id));
    if (!worker.local && worker.status !== "revoked") {
      const actions = element("div", "card-actions");
      actions.append(
        button("Revoke worker", "button button-quiet", () =>
          showRevokeWorker(worker),
        ),
      );
      node.append(actions);
    }
    block.append(node);
  }
  content.append(block);
  const help = section("Bring your own yard");
  help.append(
    note(
      "One control server. Many workers.",
      "Workers connect outbound using a distinct key. A registered yard receives only assigned work. Keep worker credentials outside agent environments and revoke a lost host.",
    ),
  );
  content.append(help);
}
function renderConnections(content) {
  const block = section(
    "MCP connections",
    button("+", "icon-button", () => showConnectionForm()),
  );
  if (!state.server.connections.length)
    block.append(
      element(
        "p",
        "inspector-empty",
        "Connect tools through the central broker. Credential references stay on the server; each discovered tool gets an exact permission identity.",
      ),
      button("Add a connection ↗", "button button-quiet button-small", () =>
        showConnectionForm(),
      ),
    );
  for (const connection of state.server.connections) {
    const node = card(
      connection.name,
      connection.enabled === false
        ? "disabled"
        : connection.discoveredAt
          ? "online"
          : "pending",
      connection.url,
    );
    node.append(
      detailsGrid([
        ["Transport", "MCP over HTTP"],
        ["Protocol", connection.protocolVersion || "Negotiated by server"],
        [
          "Catalog",
          connection.tools
            ? `${connection.tools.length} tool${connection.tools.length === 1 ? "" : "s"}`
            : "Not discovered",
        ],
        [
          "Credentials",
          connection.secretRef
            ? "Server-side reference configured"
            : "No credential reference",
        ],
        [
          "Last discovered",
          connection.discoveredAt ? timeAgo(connection.discoveredAt) : "Never",
        ],
      ]),
    );
    if (connection.tools?.length) {
      const tools = element("details", "profile-rules");
      tools.dataset.id = connection.id;
      tools.append(element("summary", "", "Inspect tool identities"));
      for (const tool of connection.tools) {
        const row = element("div", "resource-rule");
        const text = element("span");
        text.append(
          document.createTextNode(tool.name),
          element("span", "mono", tool.resource),
        );
        row.append(text);
        tools.append(row);
      }
      node.append(tools);
    }
    const actions = element("div", "card-actions");
    actions.append(
      button(
        "Discover tools",
        "button button-quiet",
        () => void discoverConnection(connection),
      ),
      button("Edit", "button button-quiet", () =>
        showConnectionForm(connection),
      ),
    );
    node.append(actions);
    block.append(node);
  }
  content.append(block);
  const telegram = section("Telegram");
  telegram.append(
    note(
      "Your threads, in your chats",
      "Create a one-time link code, then send it to your configured Telegram bot. Linking keeps your mower and thread ownership consistent across clients.",
    ),
    button(
      "Connect Telegram ↗",
      "button button-quiet button-small",
      () => void connectTelegram(),
    ),
  );
  content.append(telegram);
  const boundaries = section("Tools stay behind the broker");
  boundaries.append(
    note(
      "Catalog changes require review",
      "Tool identities include the endpoint, schema, and protocol. A changed tool catalog needs rediscovery and a matching permission rule. Adding a connection does not grant a mower access to it.",
    ),
  );
  content.append(boundaries);
}

let modalVersion = 0;
function showModal({
  title,
  eyebrow = "YOUR WORKSPACE",
  submit = "Save",
  content,
  onSubmit,
}) {
  modalVersion++;
  state.modalAction = onSubmit;
  state.modalBusy = false;
  $("modal-title").textContent = title;
  $("modal-eyebrow").textContent = eyebrow;
  $("modal-submit").textContent = submit;
  $("modal-submit").disabled = false;
  $("modal-error").textContent = "";
  $("modal-fields").replaceChildren(
    ...(Array.isArray(content) ? content : [content]),
  );
  $("modal-actions")?.removeAttribute("hidden");
  $("modal-submit").hidden = !onSubmit;
  $("modal-cancel").textContent = onSubmit ? "Cancel" : "Done";
  if (!$("modal").open) $("modal").showModal();
  $("modal-fields").querySelector("input,textarea,select,button")?.focus();
}
function closeModal() {
  if ($("modal").open) $("modal").close();
  $("modal-fields").replaceChildren();
  state.modalAction = null;
  state.modalBusy = false;
}
function field(
  name,
  label,
  {
    value = "",
    placeholder = "",
    required = false,
    hint = "",
    type = "text",
    options,
    rows = 3,
    min,
    max,
    maxlength,
    disabled = false,
    list,
  } = {},
) {
  const wrapper = element("div", "field");
  const id = `field-${name}`;
  const labelNode = element("label", "", label);
  labelNode.htmlFor = id;
  const input = element(
    options ? "select" : type === "textarea" ? "textarea" : "input",
  );
  input.id = id;
  input.name = name;
  if (options)
    for (const option of options) {
      const node = element("option", "", option.label);
      node.value = option.value;
      node.disabled = !!option.disabled;
      input.append(node);
    }
  else if (type === "textarea") input.rows = rows;
  else input.type = type;
  input.value = value;
  if (list) input.setAttribute("list", list);
  input.required = required;
  input.disabled = disabled;
  if (placeholder) input.placeholder = placeholder;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  if (maxlength) input.maxLength = maxlength;
  if (
    ["url", "password"].includes(type) ||
    name.includes("model") ||
    name.includes("resource") ||
    name.includes("key")
  )
    input.spellcheck = false;
  wrapper.append(labelNode, input);
  if (hint) wrapper.append(element("p", "field-hint", hint));
  return wrapper;
}
function checkbox(name, label, checked = false) {
  const wrapper = element("div", "checkbox-field");
  const input = element("input");
  input.id = `field-${name}`;
  input.name = name;
  input.type = "checkbox";
  input.checked = checked;
  const text = element("label", "", label);
  text.htmlFor = input.id;
  wrapper.append(input, text);
  return wrapper;
}
function formRow(...items) {
  const row = element("div", "form-row");
  row.append(...items);
  return row;
}
function value(name) {
  return $(`field-${name}`).value.trim();
}
function selectedProfileValue(profileId, version) {
  return profileId ? `${profileId}:${version}` : "";
}
function parseProfileValue(selected) {
  const at = selected.lastIndexOf(":");
  return at > 0
    ? {
        profileId: selected.slice(0, at),
        profileVersion: Number(selected.slice(at + 1)),
      }
    : {};
}
function profileOptions(includeStarter = true) {
  return [
    ...(includeStarter
      ? [{ value: "", label: "Starter guardrails · manual" }]
      : []),
    ...[...state.server.profiles]
      .filter((p) => !p.revokedAt)
      .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version)
      .map((p) => ({
        value: selectedProfileValue(p.id, p.version),
        label: `${p.name} · v${p.version} · ${p.mode}`,
      })),
  ];
}
function showMowerForm(mower) {
  void loadModels();
  const editing = !!mower;
  const fields = [
    field("name", "Mower name", {
      value: mower?.name || "",
      placeholder: "e.g. Clover, Moss, Groundskeeper",
      required: true,
      maxlength: 80,
    }),
    formRow(
      field("role", "Role", {
        value: mower?.role || "mower",
        options: [
          { value: "mower", label: "Mower" },
          { value: "director", label: "Groundskeeper · Director" },
          { value: "adviser", label: "Gatekeeper · Adviser" },
        ],
        disabled: editing,
      }),
      field("model", "Model", {
        value: mower?.model || "",
        placeholder: state.server.readiness.defaultModel || "Server default",
        list: "runtime-models",
        hint: "Choose a configured model or enter provider/model-id. Blank uses the server default.",
      }),
    ),
    field("profile", "Permission profile", {
      value: selectedProfileValue(mower?.profileId, mower?.profileVersion),
      options: profileOptions(),
      hint: editing
        ? "Changing a default applies to new threads. Existing threads keep their pinned revision."
        : "Starter guardrails allow reads and writes inside the thread workspace. Process execution asks first.",
    }),
    field("worker", "Execution yard", {
      value: mower?.workerId || "",
      options: [
        { value: "", label: "Automatic placement" },
        ...state.server.workers
          .filter((w) => w.status !== "revoked")
          .map((w) => ({
            value: w.id,
            label: `${w.name}${w.local ? " · local" : ""}`,
          })),
      ],
    }),
  ];
  showModal({
    title: editing ? `Edit ${mower.name}` : "A new member of the crew.",
    eyebrow: editing ? "MOWER SETTINGS" : "ADD A MOWER",
    submit: editing ? "Save mower" : "Create mower",
    content: fields,
    onSubmit: async () => {
      const body = {
        name: value("name"),
        ...parseProfileValue(value("profile")),
      };
      if (!editing) body.role = value("role");
      if (value("model")) body.model = value("model");
      if (value("worker")) body.workerId = value("worker");
      else if (editing) body.workerId = null;
      const result = await api(
        editing ? `/mowers/${encodeURIComponent(mower.id)}` : "/mowers",
        { method: editing ? "PATCH" : "POST", body },
      );
      const record = result.mower || result;
      if (record.id) state.selectedMowerId = record.id;
      await refresh();
      toast(
        editing
          ? "Mower updated. Existing threads keep their profile revision."
          : `${record.name || body.name} has joined your crew.`,
      );
    },
  });
}
function showThreadForm() {
  if (!state.server.mowers.length) return showMowerForm();
  const thread = currentThread();
  const selected = selectedMower();
  const fields = [
    field("title", "Thread name", {
      placeholder: "What are we working on?",
      required: true,
      maxlength: 160,
    }),
    field("mower", "Mower", {
      value: selected?.id || state.server.mowers[0].id,
      required: true,
      options: state.server.mowers
        .filter((m) => !m.archivedAt)
        .map((m) => ({
          value: m.id,
          label: `${m.name}${m.role === "director" ? " · Director" : ""}`,
        })),
    }),
    field("goal", "First message", {
      type: "textarea",
      placeholder: "Share a goal or start with a question…",
      hint: "Optional. You can also start an empty thread and send a message later.",
      rows: 4,
      maxlength: 32000,
    }),
  ];
  if (thread)
    fields.push(
      checkbox(
        "child",
        `Create as a child of “${thread.title}”. The parent’s delegation ceiling also applies.`,
      ),
    );
  showModal({
    title: "Plant a new thread.",
    eyebrow: "START A CONVERSATION",
    submit: "Create thread",
    content: fields,
    onSubmit: async () => {
      const goal = value("goal");
      const body = { mowerId: value("mower"), title: value("title") };
      if ($("field-child")?.checked && thread) body.parentThreadId = thread.id;
      const result = await api("/threads", { method: "POST", body });
      const record = result.thread || result;
      if (!record.id)
        throw new Error("The server did not return the new thread ID.");
      await refresh();
      await openThread(record.id);
      if (goal) {
        try {
          await api(`/threads/${encodeURIComponent(record.id)}/messages`, {
            method: "POST",
            body: { text: goal, requestId: crypto.randomUUID() },
          });
          await refresh();
        } catch (error) {
          $("message-input").value = goal;
          composerNote(
            `The thread was created, but its first message was not accepted: ${errorMessage(error)}`,
            true,
          );
          toast(
            "Your thread is ready. The first message has been kept in the composer.",
            true,
          );
        }
      } else toast("Thread created. Give it a goal when you’re ready.");
    },
  });
}
function ruleEditor(initialRules = []) {
  const wrapper = element("div", "rule-editor");
  const list = element("div");
  const rows = [];
  const add = (
    rule = {
      operation: "workspace.read",
      resource: "workspace:own",
      effect: "allow",
    },
  ) => {
    const row = element("div", "inline-rule");
    const operation = element("select");
    operation.setAttribute("aria-label", "Capability operation");
    for (const option of OPERATIONS) {
      const node = element("option", "", option);
      node.value = option;
      operation.append(node);
    }
    operation.value = rule.operation;
    const resource = element("input");
    resource.value = rule.resource;
    resource.placeholder = "Exact resource";
    resource.setAttribute("aria-label", "Exact resource identifier");
    resource.required = true;
    resource.maxLength = 4096;
    resource.spellcheck = false;
    const effect = element("select");
    effect.setAttribute("aria-label", "Rule decision");
    for (const choice of ["allow", "ask", "deny"]) {
      const option = element("option", "", choice);
      option.value = choice;
      effect.append(option);
    }
    effect.value = rule.effect;
    const entry = { row, operation, resource, effect };
    rows.push(entry);
    row.append(
      operation,
      resource,
      effect,
      button("×", "icon-button", () => {
        rows.splice(rows.indexOf(entry), 1);
        row.remove();
      }),
    );
    list.append(row);
  };
  initialRules.forEach((r) => add(r));
  wrapper.append(
    list,
    button("+ Add exact rule", "text-button", () => add()),
    element(
      "p",
      "",
      "workspace:own is confined to the current thread’s workspace. Use mowers:own for spawning and tasks:own for handoff. MCP tool identities appear in Connectors. Missing rules deny; explicit denies win. Shell execution still needs host isolation.",
    ),
  );
  wrapper.getRules = () =>
    rows.map(({ operation, resource, effect }) => ({
      operation: operation.value,
      resource: resource.value.trim(),
      effect: effect.value,
    }));
  return wrapper;
}
function showProfileForm(profile, proposedRules) {
  const editing = !!profile;
  const rules = ruleEditor(proposedRules || profile?.rules || []);
  const fields = [
    field("profile-name", "Profile name", {
      value: profile?.name || "",
      placeholder: "e.g. Careful gardener",
      required: true,
      maxlength: 80,
      disabled: editing,
    }),
    field("profile-mode", "Permission mode", {
      value: profile?.mode || "manual",
      options: [
        { value: "isolated", label: "Isolated · Stay within existing grants" },
        { value: "manual", label: "Manual · Ask me about explicit ask rules" },
        { value: "auto", label: "Auto · Let the adviser collect feedback" },
      ],
      hint: "Auto mode never grants itself more authority. Unconfigured operations remain denied.",
    }),
    element("label", "", "Exact capability rules"),
    rules,
  ];
  if (editing)
    fields.unshift(
      element(
        "p",
        "modal-warning",
        `This creates revision ${Math.max(...state.server.profiles.filter((p) => p.id === profile.id).map((p) => p.version)) + 1}. Existing mowers and threads keep their assigned revisions until you explicitly change them.`,
      ),
    );
  showModal({
    title: editing ? `Refine ${profile.name}.` : "Set a few good guardrails.",
    eyebrow: editing ? "NEW PROFILE REVISION" : "NEW PERMISSION PROFILE",
    submit: editing ? "Create reviewed revision" : "Create profile",
    content: fields,
    onSubmit: async () => {
      const body = { mode: value("profile-mode"), rules: rules.getRules() };
      if (editing) body.expectedBaseVersion = profile.version;
      if (!editing) body.name = value("profile-name");
      await api(
        editing
          ? `/profiles/${encodeURIComponent(profile.id)}/revisions`
          : "/profiles",
        { method: "POST", body },
      );
      await refresh();
      toast(
        editing
          ? "New revision saved. Assign it to a mower when you’re ready."
          : "Profile created. You can now share its revision between mowers.",
      );
    },
  });
}
function showProfileAssignment(profile) {
  if (!state.server.mowers.length)
    return toast("Create a mower before assigning a profile.", true);
  showModal({
    title: "Share these guardrails.",
    eyebrow: "ASSIGN PROFILE REVISION",
    submit: "Assign to mower",
    content: [
      element(
        "p",
        "modal-warning",
        `Assign “${profile.name}” revision ${profile.version} to a mower. Only its new threads use this default. Credentials are not shared by assigning a profile.`,
      ),
      field("mower", "Mower", {
        value: selectedMower()?.id || state.server.mowers[0].id,
        options: state.server.mowers
          .filter((m) => !m.archivedAt)
          .map((m) => ({ value: m.id, label: m.name })),
        required: true,
      }),
    ],
    onSubmit: async () => {
      await api(`/mowers/${encodeURIComponent(value("mower"))}`, {
        method: "PATCH",
        body: { profileId: profile.id, profileVersion: profile.version },
      });
      await refresh();
      toast("Default profile assigned. Existing threads keep their revision.");
    },
  });
}
function showRevokeProfile(profile) {
  showModal({
    title: "Revoke this revision?",
    eyebrow: "PERMISSION PROFILE",
    submit: "Revoke revision",
    content: [
      element(
        "p",
        "modal-warning",
        `Revoke “${profile.name}” revision ${profile.version}. New mediated actions using this revision will be denied. Already-running external side effects cannot be undone.`,
      ),
    ],
    onSubmit: async () => {
      await api(`/profiles/${encodeURIComponent(profile.id)}/revoke`, {
        method: "POST",
        body: { version: profile.version },
      });
      await refresh();
      toast("Profile revision revoked.");
    },
  });
}
function showTaskForm() {
  const thread = currentThread();
  if (!thread) return;
  showModal({
    title: "Give your crew a task.",
    eyebrow: "DELEGATE WORK",
    submit: "Delegate task",
    content: [
      field("task-name", "Task name", {
        placeholder: "A short name for this work",
        required: true,
        maxlength: 160,
      }),
      field("task-mower", "Assign to", {
        value:
          state.server.mowers.find((m) => m.id !== thread.mowerId)?.id ||
          thread.mowerId,
        required: true,
        options: state.server.mowers
          .filter((m) => !m.archivedAt)
          .map((m) => ({ value: m.id, label: m.name })),
      }),
      field("task-goal", "Goal and deliverables", {
        type: "textarea",
        placeholder:
          "Explain the task, relevant context, and the result you need…",
        required: true,
        rows: 5,
        maxlength: 32000,
        hint: "The child gets its own thread. Its permissions cannot exceed the parent’s delegation ceiling.",
      }),
    ],
    onSubmit: async () => {
      const result = await api("/tasks", {
        method: "POST",
        body: {
          parentThreadId: thread.id,
          mowerId: value("task-mower"),
          name: value("task-name"),
          goal: value("task-goal"),
          requestId: crypto.randomUUID(),
        },
      });
      await refresh();
      selectInspector("tasks");
      openInspector();
      toast(
        "Task delegated. You can open its thread to speak to the mower directly.",
      );
      const task = result.task || result;
      if (task.threadId) await loadEvents(task.threadId, true);
    },
  });
}
function showHandoffForm(task) {
  const candidates = state.server.mowers.filter(
    (m) => m.id !== task.mowerId && !m.archivedAt,
  );
  if (!candidates.length)
    return toast("Add another mower before handing off this task.", true);
  showModal({
    title: "Pass the task along.",
    eyebrow: "TASK HANDOFF",
    submit: "Hand off task",
    content: [
      element(
        "p",
        "modal-warning",
        `Hand off “${task.title}” to another mower. The recipient keeps its own profile and receives the recorded task context; credentials and broad permissions do not transfer.`,
      ),
      field("handoff-mower", "New task owner", {
        options: candidates.map((m) => ({ value: m.id, label: m.name })),
        required: true,
      }),
    ],
    onSubmit: async () => {
      await api(`/tasks/${encodeURIComponent(task.id)}/handoff`, {
        method: "POST",
        body: {
          mowerId: value("handoff-mower"),
          requestId: crypto.randomUUID(),
        },
      });
      await refresh();
      toast("Task handed off.");
    },
  });
}
function showWorkerForm() {
  showModal({
    title: "Bring another yard.",
    eyebrow: "ENROLL AN EXECUTION WORKER",
    submit: "Create worker key",
    content: [
      element(
        "p",
        "",
        "Register a worker for this computer or a VPS. You’ll get a distinct key once. Save it on the target host, outside agent environments.",
      ),
      field("worker-name", "Yard name", {
        placeholder: "e.g. Workshop, VPS east",
        required: true,
        maxlength: 80,
      }),
      formRow(
        field("worker-capacity", "Concurrent runs", {
          type: "number",
          value: "2",
          required: true,
          min: 1,
          max: 16,
        }),
        field("worker-labels", "Labels", {
          placeholder: "linux, coding",
          hint: "Comma-separated labels for placement.",
        }),
      ),
    ],
    onSubmit: async () => {
      const result = await api("/workers", {
        method: "POST",
        body: {
          name: value("worker-name"),
          capacity: Number(value("worker-capacity")),
          labels: value("worker-labels")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      await refresh();
      if (!result.key)
        throw new Error(
          "The worker was registered, but no key was returned. Create a new worker credential before connecting.",
        );
      showWorkerCredentials(result.worker, result.key);
      return false;
    },
  });
}
function showWorkerCredentials(worker, key) {
  const keyBox = element("div", "readonly-value", key);
  const copy = button(
    "Copy worker key",
    "button button-quiet button-small",
    () => void copyText(key),
  );
  const instructions = element("div", "note-card");
  instructions.append(
    element("strong", "", "Connect from the target host"),
    element(
      "p",
      "",
      "Save LAUN_CONTROLLER_URL and LAUN_WORKER_KEY in the target worker’s protected environment file. Choose explicit LAUN_TRUSTED_LOCAL=true for trusted development, or configure OPENSHELL_ENABLED=true for isolation. This key is shown once and is not stored in your browser.",
    ),
    element(
      "pre",
      "",
      `LAUN_CONTROLLER_URL=${location.origin}\nLAUN_WORKER_KEY=<paste the saved key>\n\n# From the laun checkout on the worker host:\nbun apps/worker/src/index.ts`,
    ),
  );
  showModal({
    title: `${worker?.name || "Your yard"} is registered.`,
    eyebrow: "SAVE THIS KEY NOW",
    content: [
      element(
        "p",
        "modal-warning",
        "A worker key grants access to assigned execution work. Keep it out of transcripts, source control, and shell history.",
      ),
      keyBox,
      copy,
      instructions,
    ],
    onSubmit: null,
  });
}
function showRevokeWorker(worker) {
  showModal({
    title: `Revoke ${worker.name}?`,
    eyebrow: "WORKER ACCESS",
    submit: "Revoke worker",
    content: [
      element(
        "p",
        "modal-warning",
        "This worker key will stop receiving work and active assignments will require reconciliation. Revocation cannot undo external actions already performed by a worker. Confirm that an unreachable host has stopped before resuming its work elsewhere.",
      ),
    ],
    onSubmit: async () => {
      await api(`/workers/${encodeURIComponent(worker.id)}/revoke`, {
        method: "POST",
        body: {},
      });
      await refresh();
      toast("Worker access revoked.");
    },
  });
}
function showConnectionForm(connection) {
  const editing = !!connection;
  showModal({
    title: editing ? "Tend this connection." : "A new tool connection.",
    eyebrow: "MCP TOOL BROKER",
    submit: editing ? "Save connection" : "Add connection",
    content: [
      field("connection-name", "Connection name", {
        value: connection?.name || "",
        placeholder: "e.g. Project tools",
        required: true,
        maxlength: 80,
      }),
      field("connection-url", "MCP endpoint", {
        value: connection?.url || "",
        type: "url",
        placeholder: "https://tools.example.com/mcp",
        required: true,
        hint: "Use a credential-free HTTP(S) endpoint. Redirects and unapproved private destinations are rejected.",
      }),
      formRow(
        field("connection-protocol", "MCP protocol", {
          value: connection?.protocolVersion || "2026-07-28",
          options: [
            { value: "2026-07-28", label: "2026-07-28" },
            { value: "2025-11-25", label: "2025-11-25 · legacy" },
          ],
        }),
        field("connection-secret", "Server credential reference", {
          value: connection?.secretRef || "",
          placeholder: "Optional reference",
          hint: "Reference only. Never paste a token or password here.",
        }),
      ),
      checkbox(
        "connection-local",
        "Request access to a local development endpoint. The server must separately permit loopback development connections.",
        connection?.allowLocal || false,
      ),
      checkbox(
        "connection-enabled",
        "Enable this connection",
        connection?.enabled !== false,
      ),
    ],
    onSubmit: async () => {
      const body = {
        name: value("connection-name"),
        url: value("connection-url"),
        protocolVersion: value("connection-protocol"),
        allowLocal: $("field-connection-local").checked,
        enabled: $("field-connection-enabled").checked,
      };
      if (value("connection-secret"))
        body.secretRef = value("connection-secret");
      else if (editing && connection.secretRef) body.secretRef = null;
      await api(
        editing
          ? `/connections/${encodeURIComponent(connection.id)}`
          : "/connections",
        { method: editing ? "PATCH" : "POST", body },
      );
      await refresh();
      toast(
        "Connection saved. Discover its tools before assigning exact permissions.",
      );
    },
  });
}
async function connectTelegram() {
  const generation = state.generation;
  try {
    const link = await api("/identity/telegram-link", {
      method: "POST",
      body: {},
    });
    if (!state.key || generation !== state.generation) return;
    if (typeof link.code !== "string" || !link.code)
      throw new Error("The server did not return a link code.");
    const command = `/link ${link.code}`;
    showModal({
      title: "Take your crew to Telegram.",
      eyebrow: "ONE-TIME IDENTITY LINK",
      content: [
        element(
          "p",
          "",
          "Send this command in a direct message to your configured Telegram bot. The code links Telegram to this workspace identity and is usable once.",
        ),
        element("div", "readonly-value", command),
        button(
          "Copy link command",
          "button button-quiet",
          () => void copyText(command),
        ),
        element(
          "p",
          "field-hint",
          `Expires ${link.expiresAt ? new Date(link.expiresAt).toLocaleTimeString() : "soon"}. Keep this code private. It is never stored in your browser or thread transcript.`,
        ),
      ],
      onSubmit: null,
    });
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
function showAdviceForm(approval) {
  const profile = profileById(approval.profileId, approval.profileVersion);
  if (!profile) return toast("This profile revision is unavailable.", true);
  const requestId = crypto.randomUUID();
  showModal({
    title: "Discuss your guardrails.",
    eyebrow: "GATEKEEPER · ADVICE ONLY",
    submit: "Start permission discussion",
    content: [
      note(approval.action.operation, approval.action.resource),
      field("advice-feedback", "What should Gatekeeper understand?", {
        type: "textarea",
        placeholder:
          "Describe your intent, concerns, and what you want your mower to be able to do…",
        required: true,
        rows: 4,
        maxlength: 4000,
      }),
      element(
        "p",
        "field-hint",
        "Your configured model receives a redacted action preview and feedback in a dedicated, tool-free thread. The current request remains gated. Gatekeeper can suggest a reusable rule, but you must review and apply any revision yourself.",
      ),
    ],
    onSubmit: async () => {
      const generation = state.generation;
      const result = await api(
        `/approvals/${encodeURIComponent(approval.id)}/advice`,
        {
          method: "POST",
          body: { feedback: value("advice-feedback"), requestId },
        },
      );
      if (generation !== state.generation || !state.key) return;
      if (!result.thread?.id || !result.run?.id)
        throw new Error("The server did not return a permission discussion.");
      state.advice.set(result.run.id, {
        runId: result.run.id,
        threadId: result.thread.id,
        approvalId: approval.id,
        baseProfileId: profile.id,
        baseProfileVersion: profile.version,
        status: "queued",
      });
      await refresh();
      await openThread(result.thread.id);
      toast(
        "Gatekeeper is discussing the request. The original action remains gated.",
      );
    },
  });
}
function showGuardrailForm(approval) {
  const profile = profileById(approval.profileId, approval.profileVersion);
  if (!profile) return toast("This profile revision is unavailable.", true);
  showModal({
    title: "Draft a narrow guardrail.",
    eyebrow: "QUICK RULE DRAFT",
    submit: "Review a proposal",
    content: [
      note(approval.action.operation, approval.action.resource),
      field("feedback", "What should your mower be able to do?", {
        type: "textarea",
        placeholder: "Describe what is okay here, and any limits you want…",
        required: true,
        rows: 4,
        maxlength: 2000,
        hint: "This quick draft uses a fixed ask rule, without an LLM discussion. It does not approve this action or change a profile automatically. Use Discuss with Gatekeeper for model advice.",
      }),
    ],
    onSubmit: async () => {
      const proposal = await api(
        `/approvals/${encodeURIComponent(approval.id)}/proposal`,
        { method: "POST", body: { feedback: value("feedback") } },
      );
      showProposal(profile, proposal.proposal || proposal);
      return false;
    },
  });
}
function showProposal(profile, proposal) {
  if (!proposal.suggestedProfile?.rules || proposal.status !== "proposed")
    throw new Error(
      "The adviser did not return a reviewable profile proposal.",
    );
  const explanation = note(
    "Proposed guardrail",
    proposal.explanation ||
      "Review the exact rule before creating a new profile revision.",
  );
  const rule = element(
    "pre",
    "readonly-value",
    JSON.stringify(proposal.rule, null, 2),
  );
  showModal({
    title: "A little more room, carefully.",
    eyebrow: "REVIEW PERMISSION PROPOSAL",
    submit: "Create reviewed revision",
    content: [
      explanation,
      element(
        "p",
        "",
        proposal.question || "Does this exact scope match what you intended?",
      ),
      rule,
      element(
        "p",
        "modal-warning",
        "Creating this revision does not approve the pending action or silently update existing mowers and threads. Assign the new default explicitly; use Allow once for the current action if appropriate.",
      ),
      button("Edit the proposed rules instead", "text-button", () =>
        showProfileForm(profile, proposal.suggestedProfile.rules),
      ),
    ],
    onSubmit: async () => {
      await api(`/profiles/${encodeURIComponent(profile.id)}/revisions`, {
        method: "POST",
        body: {
          expectedBaseVersion: proposal.baseProfileVersion,
          mode: proposal.suggestedProfile.mode,
          rules: proposal.suggestedProfile.rules,
        },
      });
      await refresh();
      toast(
        "Reviewed revision created. Assign it explicitly when you’re ready.",
      );
    },
  });
}
function showResumeForm(run) {
  const confirm = checkbox(
    "resume-confirmed",
    "I verified the previous worker has stopped and reconciled any external side effects before resuming this durable request.",
  );
  confirm.querySelector("input").required = true;
  showModal({
    title: "Reconcile before resuming.",
    eyebrow: "INTERRUPTED EXECUTION",
    submit: "Resume durable request",
    content: [
      element(
        "p",
        "modal-warning",
        "A lost connection does not prove work stopped. Resuming on another worker while the old one is active can duplicate side effects. Check the previous host and any external destination first.",
      ),
      note("Original request", run.prompt),
      ...(run.cancelRequested
        ? [
            element(
              "p",
              "modal-warning",
              "Cancellation was requested for this run. Resuming explicitly reactivates the original request after your confirmation.",
            ),
          ]
        : []),
      confirm,
    ],
    onSubmit: async () => {
      await api(`/runs/${encodeURIComponent(run.id)}/resume`, {
        method: "POST",
        body: { confirmedStopped: $("field-resume-confirmed").checked },
      });
      await refresh();
      toast("Reconciled request returned to the durable queue.");
    },
  });
}
function showThreadSettings() {
  const thread = currentThread();
  if (!thread) return;
  const mower = mowerById(thread.mowerId);
  const profile = profileById(thread.profileId, thread.profileVersion);
  const content = [
    detailsGrid([
      ["Mower", mower?.name],
      ["Thread ID", thread.id],
      ["Workspace", thread.workspaceId],
      [
        "Pinned profile",
        profile
          ? `${profile.name} · v${profile.version}`
          : `${thread.profileId} · v${thread.profileVersion}`,
      ],
      ["Created", new Date(thread.createdAt).toLocaleString()],
    ]),
    button(
      "Copy thread link",
      "button button-quiet",
      () =>
        void copyText(
          `${location.origin}${location.pathname}#/threads/${thread.id}`,
        ),
    ),
    button("Archive thread", "button button-quiet", () =>
      showArchiveThread(thread),
    ),
    button("Download last saved checkpoint", "button button-quiet", () =>
      showCheckpointDownload(thread),
    ),
  ];
  if (thread.parentThreadId)
    content.push(
      button("Open parent thread ↗", "button button-quiet", () => {
        closeModal();
        void openThread(thread.parentThreadId);
      }),
    );
  showModal({
    title: thread.title,
    eyebrow: "DURABLE THREAD",
    content,
    onSubmit: null,
  });
}
function showCheckpointDownload(thread) {
  showModal({
    title: "Save this thread’s checkpoint.",
    eyebrow: "SERVER-OWNED THREAD ARCHIVE",
    submit: "Download checkpoint",
    content: [
      element(
        "p",
        "",
        "The checkpoint contains the durable agent conversation and saved workspace files from the latest completed snapshot. Work still running may not be included.",
      ),
      element(
        "p",
        "modal-warning",
        "This is a private user artifact, including any sensitive content in the thread or workspace. Save it in a location you control and share it only with intended recipients.",
      ),
    ],
    onSubmit: async () => {
      const archive = await api(
        `/threads/${encodeURIComponent(thread.id)}/checkpoint`,
      );
      if (archive.threadId !== thread.id || !Array.isArray(archive.files))
        throw new Error("The server returned an invalid thread checkpoint.");
      const blob = new Blob([JSON.stringify(archive)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = element("a");
      link.href = url;
      link.download = `laun-thread-${thread.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast("Checkpoint downloaded. Keep the archive private.");
    },
  });
}
function showArchiveThread(thread) {
  showModal({
    title: "Archive this thread?",
    eyebrow: "DURABLE THREAD",
    submit: "Archive thread",
    content: [
      element(
        "p",
        "modal-warning",
        `Archive “${thread.title}” and cancel its active or queued work. Its durable history stays on the server. External actions already completed cannot be undone.`,
      ),
    ],
    onSubmit: async () => {
      await api(`/threads/${encodeURIComponent(thread.id)}/archive`, {
        method: "POST",
        body: {},
      });
      if (state.currentThreadId === thread.id) {
        state.currentThreadId = null;
        history.replaceState(null, "", location.pathname);
      }
      await refresh();
      toast("Thread archived. Its history remains on the server.");
    },
  });
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard.");
  } catch {
    toast(
      "Clipboard access is unavailable. Select and copy the displayed value.",
      true,
    );
  }
}
async function discoverConnection(connection) {
  try {
    await api(`/connections/${encodeURIComponent(connection.id)}/discover`, {
      method: "POST",
      body: currentThread() ? { threadId: currentThread().id } : {},
    });
    await refresh();
    toast(
      "Tool catalog discovered. Inspect exact identities before granting access.",
    );
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function decideApproval(approval, decision) {
  try {
    await api(`/approvals/${encodeURIComponent(approval.id)}`, {
      method: "POST",
      body: { decision },
    });
    await refresh();
    toast(
      decision === "approve"
        ? "Decision saved. The server will recheck and consume the action grant."
        : "Request denied. Your mower can choose an allowed alternative.",
    );
  } catch (error) {
    toast(errorMessage(error), true);
    await refresh().catch(() => {});
  }
}
function composerNote(
  text = "Enter to send · Shift + Enter for a new line",
  error = false,
) {
  $("composer-note").textContent = text;
  $("composer-note").className = error ? "error" : "";
}
async function sendMessage() {
  const thread = currentThread();
  const input = $("message-input");
  const text = input.value.trim();
  if (!thread || !text || state.sending) return;
  state.sending = true;
  $("send-button").disabled = true;
  composerNote("Saving your message…");
  // Retry the same text against the same thread with the same ID after a lost reply.
  if (
    !state.pendingRequest ||
    state.pendingRequest.threadId !== thread.id ||
    state.pendingRequest.text !== text
  )
    state.pendingRequest = {
      threadId: thread.id,
      text,
      requestId: crypto.randomUUID(),
    };
  const request = { text, requestId: state.pendingRequest.requestId };
  if ($("delivery-mode").value === "steer") request.mode = "steer";
  try {
    const receipt = await api(
      `/threads/${encodeURIComponent(thread.id)}/messages`,
      { method: "POST", body: request },
    );
    if (state.currentThreadId === thread.id && input.value.trim() === text)
      input.value = "";
    state.pendingRequest = null;
    composerNote(
      receipt.status === "queued" || receipt.run?.status === "queued"
        ? "Message saved in the thread’s durable queue."
        : "Message saved. Your mower is on it.",
    );
    await refresh();
  } catch (error) {
    composerNote(errorMessage(error), true);
  } finally {
    state.sending = false;
    $("send-button").disabled = false;
    input.focus();
    resizeComposer();
  }
}
async function cancelRun() {
  const thread = currentThread();
  if (!thread) return;
  $("cancel-run-button").disabled = true;
  try {
    await api(`/threads/${encodeURIComponent(thread.id)}/cancel`, {
      method: "POST",
      body: {},
    });
    await refresh();
    composerNote(
      "Cancellation requested. External side effects already completed cannot be undone.",
    );
  } catch (error) {
    composerNote(errorMessage(error), true);
  } finally {
    $("cancel-run-button").disabled = false;
  }
}
function resizeComposer() {
  const textarea = $("message-input");
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("auth-key").value.trim();
  if (key) void connect(key);
});
$("disconnect-button").addEventListener("click", () => disconnect());
$("refresh-button").addEventListener(
  "click",
  () => void refresh().catch((error) => toast(errorMessage(error), true)),
);
$("new-mower-button").addEventListener("click", () => showMowerForm());
$("new-thread-button").addEventListener("click", showThreadForm);
$("empty-start-button").addEventListener("click", showThreadForm);
$("thread-menu-button").addEventListener("click", showThreadSettings);
$("thread-search").addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderSidebar();
});
$("workspace-info").addEventListener("click", () =>
  showModal({
    title: "Your workspace.",
    eyebrow: "INSTALLATION SETTINGS",
    content: [
      detailsGrid([
        ["Control server", location.origin],
        ["Execution mode", state.server.readiness.mode],
      ]),
      button("Manage execution yards", "button button-quiet", () => {
        closeModal();
        selectInspector("yards");
        openInspector();
      }),
      button(
        "Connect Telegram ↗",
        "button button-quiet",
        () => void connectTelegram(),
      ),
    ],
    onSubmit: null,
  }),
);
$("sidebar-toggle").addEventListener("click", () => {
  const open = $("workspace").classList.toggle("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
});
$("inspector-toggle").addEventListener("click", () => {
  const hidden = $("workspace").classList.toggle("inspector-hidden");
  $("inspector-toggle").setAttribute("aria-expanded", String(!hidden));
});
$("inspector-close").addEventListener("click", () => {
  $("workspace").classList.add("inspector-hidden");
  $("inspector-toggle").setAttribute("aria-expanded", "false");
  $("inspector-toggle").focus();
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});
$("message-input").addEventListener("input", () => {
  resizeComposer();
  if (!state.sending) composerNote();
});
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$("send-button").disabled) $("composer").requestSubmit();
  }
});
$("cancel-run-button").addEventListener("click", () => void cancelRun());
$("messages").addEventListener("scroll", () => {
  const view = $("messages");
  state.follow = view.scrollHeight - view.scrollTop - view.clientHeight < 100;
  $("jump-latest").hidden = state.follow;
});
$("jump-latest").addEventListener("click", () => {
  state.follow = true;
  $("messages").scrollTop = $("messages").scrollHeight;
  $("jump-latest").hidden = true;
});
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.id = `details-tab-${tab.dataset.tab}`;
  tab.setAttribute("aria-controls", "inspector-content");
  tab.addEventListener("click", () => selectInspector(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const current = tabs.indexOf(tab);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[index].focus();
    selectInspector(tabs[index].dataset.tab);
  });
}
$("modal-close").addEventListener("click", closeModal);
$("modal-cancel").addEventListener("click", closeModal);
$("modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) {
    const rect = $("modal").getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeModal();
  }
});
$("modal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.modalAction || state.modalBusy) return;
  state.modalBusy = true;
  const version = modalVersion;
  $("modal-submit").disabled = true;
  $("modal-error").textContent = "";
  try {
    const result = await state.modalAction();
    if (modalVersion === version && result !== false) closeModal();
  } catch (error) {
    if (modalVersion === version)
      $("modal-error").textContent = errorMessage(error);
    else toast(errorMessage(error), true);
  } finally {
    if (modalVersion === version) {
      state.modalBusy = false;
      $("modal-submit").disabled = false;
    }
  }
});
window.addEventListener("hashchange", () => {
  const id = threadFromHash();
  if (id && state.key && id !== state.currentThreadId)
    void openThread(id, false);
});
window.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    state.key
  ) {
    event.preventDefault();
    if (innerWidth <= 680) $("workspace").classList.add("sidebar-open");
    $("thread-search").focus();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    state.key &&
    !$("modal").open
  ) {
    event.preventDefault();
    showThreadForm();
  }
  if (event.key === "Escape") {
    $("workspace").classList.remove("sidebar-open");
    if (innerWidth <= 990) {
      $("workspace").classList.add("inspector-hidden");
      $("inspector-toggle").setAttribute("aria-expanded", "false");
    }
  }
});
document.addEventListener("pointerdown", (event) => {
  if (
    innerWidth <= 680 &&
    $("workspace").classList.contains("sidebar-open") &&
    !$("sidebar").contains(event.target) &&
    !$("sidebar-toggle").contains(event.target)
  )
    $("workspace").classList.remove("sidebar-open");
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.key) schedulePoll(100);
});
matchMedia("(max-width: 990px)").addEventListener("change", (event) => {
  if (event.matches) {
    $("workspace").classList.add("inspector-hidden");
    $("inspector-toggle").setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("beforeunload", () => {
  clearTimeout(state.pollTimer);
  state.generation++;
});
$("login-origin").textContent = location.origin;
if (innerWidth <= 990) {
  $("workspace").classList.add("inspector-hidden");
  $("inspector-toggle").setAttribute("aria-expanded", "false");
}
selectInspector("overview");
const key = loadKey();
if (key) void connect(key);
