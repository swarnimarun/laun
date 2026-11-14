import { randomBytes } from "node:crypto";
import { checkBearer } from "@laun/protocol";
import type { ControlApproval, ControlPrincipal, MowerRecord, TaskRecord, TelegramDelivery, TelegramIdentity, TelegramInboundUpdate, TelegramIngestResult, ThreadEvent, ThreadRecord } from "@laun/protocol";
import { ControlService } from "./service.js";
import { canonical, ControlError, hash, id, now, record, text } from "./store.js";

export interface TelegramConnectorOptions {
  serviceToken: string;
  botId: string;
  allowlist: string[];
  allowChats?: string[];
  defaultModel?: string;
  linkTtlMs?: number;
}
interface Identity extends TelegramIdentity { topicId: string }
interface Route { route_key: string; bot_id: string; user_id: string; chat_id: string; topic_id: string; owner_id: string; thread_id: string }
interface Payload { botId: string; userId: string; chatId: string; topicId: string; routeKey: string; text: string; buttons?: TelegramDelivery["buttons"]; onboarding?: boolean }
interface OutboxRow { id: string; owner_id: string; destination: string; body: string; status: string }
const initialized = new WeakSet<object>();
const HELP = "🌱 Laun · your mower crew\n\n/link <code> — link the account code from the web app (private chat only)\n/new [mower name] | <goal> — start a named mower thread\n/mowers — list your mowers\n/thread [thread id] — inspect or change this chat/topic’s thread\n/delegate [mower name] | <goal> — delegate from the selected thread\n/status [thread id] — progress and pending permission requests\n/approve <handle> or /deny <handle> — decide an exact request\n/deliveries — inspect uncertain deliveries\n/retry <delivery id> — explicitly retry a possibly delivered message\n\nPlain text follows up through a durable queue. Link your account before starting work. Group chats require a separate server allowlist.";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function initialize(service: ControlService) {
  if (initialized.has(service.store)) return;
  service.store.db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_link_codes(hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
    CREATE TABLE IF NOT EXISTS telegram_links(bot_id TEXT NOT NULL,user_id TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(bot_id,user_id));
    CREATE TABLE IF NOT EXISTS telegram_routes(route_key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,topic_id TEXT NOT NULL,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_subscriptions(route_key TEXT NOT NULL,thread_id TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(route_key,thread_id));
    CREATE TABLE IF NOT EXISTS telegram_inbox(bot_id TEXT NOT NULL,update_id INTEGER NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(bot_id,update_id));
    CREATE TABLE IF NOT EXISTS telegram_handles(handle TEXT PRIMARY KEY,route_key TEXT NOT NULL,owner_id TEXT NOT NULL,approval_id TEXT NOT NULL,expires_at TEXT NOT NULL,can_approve INTEGER NOT NULL,used_at TEXT,UNIQUE(route_key,approval_id));
    CREATE TABLE IF NOT EXISTS telegram_deliveries(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,lease_id TEXT,lease_until TEXT,next_at TEXT NOT NULL,updated_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,message_id TEXT);
  `);
  initialized.add(service.store);
}
function identity(value: unknown, options: TelegramConnectorOptions): Identity {
  const b = record(value);
  const botId = String(b.botId ?? ""), userId = String(b.userId ?? ""), chatId = String(b.chatId ?? "");
  const topicId = b.topicId === undefined || b.topicId === null || b.topicId === "" ? "0" : String(b.topicId);
  if (!/^\d{1,20}$/.test(botId) || botId !== options.botId || !/^\d{1,20}$/.test(userId) || !options.allowlist.includes(userId)) throw new ControlError("Telegram identity is not allowed", 403);
  if (!/^-?\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(topicId)) throw new ControlError("invalid Telegram chat/topic", 400);
  if (chatId.startsWith("-")) {
    if (!options.allowChats?.includes(chatId)) throw new ControlError("Telegram group chat is not allowlisted", 403);
  } else if (chatId !== userId || topicId !== "0") throw new ControlError("invalid private Telegram route", 403);
  return { botId, userId, chatId, topicId };
}
function routeKey(identity: Identity): string { return hash(canonical(identity)); }
function linkedOwner(service: ControlService, scope: Identity): string | undefined {
  return (service.store.db.query("SELECT owner_id FROM telegram_links WHERE bot_id=? AND user_id=?").get(scope.botId, scope.userId) as { owner_id: string } | null)?.owner_id;
}
function principal(ownerId: string): ControlPrincipal { return { id: ownerId, admin: false }; }
function splitTelegram(value: string): string[] {
  const chunks: string[] = []; let current = "";
  for (const char of value) { if (current.length + char.length > 3500) { chunks.push(current); current = ""; } current += char; }
  if (current) chunks.push(current); return chunks;
}
function enqueue(service: ControlService, scope: Identity, ownerId: string, sourceId: string, value: string, buttons?: TelegramDelivery["buttons"], onboarding = false) {
  const key = routeKey(scope);
  const chunks = splitTelegram(value);
  for (let index = 0; index < chunks.length; index++) {
    const deliveryId = hash(`telegram:${scope.botId}:${key}:${sourceId}:${index}`);
    const payload: Payload = { ...scope, routeKey: key, text: chunks[index]!, ...(index === chunks.length - 1 && buttons ? { buttons } : {}), ...(onboarding ? { onboarding: true } : {}) };
    service.store.db.query("INSERT OR IGNORE INTO outbox(id,owner_id,destination,body,status) VALUES(?,?,?,?,'pending')").run(deliveryId, ownerId, `telegram:${key}`, JSON.stringify(payload));
    service.store.db.query("INSERT OR IGNORE INTO telegram_deliveries(id,bot_id,next_at,updated_at) VALUES(?,?,?,?)").run(deliveryId, scope.botId, now(), now());
  }
}
function selectThread(service: ControlService, scope: Identity, ownerId: string, thread: ThreadRecord, fromBeginning = false) {
  const key = routeKey(scope);
  service.store.get<ThreadRecord>("thread", thread.id, principal(ownerId));
  service.store.db.query("INSERT INTO telegram_routes VALUES(?,?,?,?,?,?,?) ON CONFLICT(route_key) DO UPDATE SET owner_id=excluded.owner_id,thread_id=excluded.thread_id").run(key, scope.botId, scope.userId, scope.chatId, scope.topicId, ownerId, thread.id);
  const max = service.store.db.query("SELECT COALESCE(MAX(sequence),0) n FROM events WHERE thread_id=?").get(thread.id) as { n: number };
  service.store.db.query("INSERT OR IGNORE INTO telegram_subscriptions VALUES(?,?,?)").run(key, thread.id, fromBeginning ? 0 : max.n);
}
function currentThread(service: ControlService, scope: Identity, ownerId: string): ThreadRecord | undefined {
  const route = service.store.db.query("SELECT * FROM telegram_routes WHERE route_key=? AND owner_id=?").get(routeKey(scope), ownerId) as Route | null;
  return route ? service.store.get<ThreadRecord>("thread", route.thread_id, principal(ownerId)) : undefined;
}
function handleFor(service: ControlService, scope: Identity, ownerId: string, approval: ControlApproval): string {
  const key = routeKey(scope);
  const existing = service.store.db.query("SELECT handle FROM telegram_handles WHERE route_key=? AND approval_id=?").get(key, approval.id) as { handle: string } | null;
  if (existing) return existing.handle;
  const handle = randomBytes(16).toString("base64url");
  const detail = approval.detail ?? "";
  const canApprove = detail.length > 0 && detail.length <= 1200 && approval.action.resource.length <= 600;
  service.store.db.query("INSERT INTO telegram_handles(handle,route_key,owner_id,approval_id,expires_at,can_approve) VALUES(?,?,?,?,?,?)").run(handle, key, ownerId, approval.id, new Date(Math.min(Date.parse(approval.expiresAt), Date.now() + 300_000)).toISOString(), canApprove ? 1 : 0);
  return handle;
}
function approvalMessage(service: ControlService, scope: Identity, ownerId: string, approval: ControlApproval): { text: string; buttons: TelegramDelivery["buttons"] } {
  const handle = handleFor(service, scope, ownerId, approval);
  const row = service.store.db.query("SELECT can_approve FROM telegram_handles WHERE handle=?").get(handle) as { can_approve: number };
  return { text: `🛑 Permission request\n${approval.action.operation}\n${approval.action.resource.slice(0, 600)}\n\n${(approval.detail ?? "Action preview unavailable; inspect it in the web app.").slice(0, 1200)}\n\n${row.can_approve ? `/approve ${handle} or /deny ${handle}` : `Open the web app to inspect and allow this action. /deny ${handle} remains available.`}`,
    buttons: [...(row.can_approve ? [{ text: "Allow once", callbackData: `laun:a:${handle}` }] : []), { text: "Deny", callbackData: `laun:d:${handle}` }] };
}
function decideHandle(service: ControlService, scope: Identity, ownerId: string, handle: string, decision: "approve" | "deny"): string {
  const row = service.store.db.query("SELECT * FROM telegram_handles WHERE handle=?").get(handle) as { route_key: string; owner_id: string; approval_id: string; expires_at: string; used_at: string | null; can_approve: number } | null;
  if (!row || row.route_key !== routeKey(scope) || row.owner_id !== ownerId || row.used_at || Date.parse(row.expires_at) <= Date.now()) throw new ControlError("Permission button is expired, already used, or belongs to a different user/chat/topic", 403);
  if (decision === "approve" && !row.can_approve) throw new ControlError("Inspect the full action in the web app before allowing it", 403);
  service.store.decide(principal(ownerId), row.approval_id, decision);
  service.store.db.query("UPDATE telegram_handles SET used_at=? WHERE handle=?").run(now(), handle);
  return decision === "approve" ? "Decision recorded: allow once. The controller will recheck current authority before applying it." : "Decision recorded: deny. No permission was granted.";
}
function pickMower(service: ControlService, ownerId: string, selector: string | undefined, options: TelegramConnectorOptions, parent?: ThreadRecord): MowerRecord {
  const p = principal(ownerId);
  const all = service.store.list<MowerRecord>("mower", p).filter((m) => !m.archivedAt);
  if (selector) {
    const found = all.find((m) => m.id === selector || m.name.toLowerCase() === selector.toLowerCase());
    if (found) return found;
    return service.store.createMower(p, { name: selector, model: options.defaultModel, ...(parent ? { profileId: parent.profileId, profileVersion: parent.profileVersion } : {}) });
  }
  if (parent) return service.store.createMower(p, { name: `Mower ${id().slice(0, 6)}`, model: service.store.get<MowerRecord>("mower", parent.mowerId, p).model, profileId: parent.profileId, profileVersion: parent.profileVersion });
  return all.find((m) => m.role === "director") ?? service.store.createMower(p, { name: "Groundskeeper", role: "director", model: options.defaultModel });
}
function namedGoal(input: string): { selector?: string; goal: string } {
  const split = input.indexOf("|");
  if (split < 0) return { goal: text(input, "goal") };
  return { selector: input.slice(0, split).trim() || undefined, goal: text(input.slice(split + 1), "goal") };
}
function command(service: ControlService, scope: Identity, input: TelegramInboundUpdate, options: TelegramConnectorOptions): { text: string; ownerId: string; buttons?: TelegramDelivery["buttons"]; callbackAnswer?: string; onboarding?: boolean } {
  const ownerId = linkedOwner(service, scope);
  const fallbackOwner = `telegram_${scope.botId}_${scope.userId}`;
  const source = input.text?.trim() ?? "";
  const match = source.match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  const name = match?.[1]?.toLowerCase(); const args = match?.[2]?.trim() ?? "";
  if (name === "link") {
    if (scope.chatId !== scope.userId || scope.topicId !== "0") throw new ControlError("Send /link privately to the bot; never post account codes in a group", 403);
    if (!/^launlink_[A-Za-z0-9_-]{22}$/.test(args)) throw new ControlError("Get a fresh Telegram link code from the authenticated web app");
    const row = service.store.db.query("SELECT * FROM telegram_link_codes WHERE hash=?").get(hash(args)) as { owner_id: string; expires_at: string; used_at: string | null } | null;
    if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) throw new ControlError("This link code is invalid, expired or already used. Get a fresh code in the web app");
    if (ownerId && ownerId !== row.owner_id) throw new ControlError("Telegram is already linked to another account. Unlink it from that account before changing owners", 409);
    service.store.db.query("INSERT INTO telegram_links VALUES(?,?,?,?) ON CONFLICT(bot_id,user_id) DO UPDATE SET owner_id=excluded.owner_id").run(scope.botId, scope.userId, row.owner_id, now());
    service.store.db.query("UPDATE telegram_link_codes SET used_at=? WHERE hash=?").run(now(), hash(args));
    // Old pre-link help belongs to no real account. It must not block the
    // newly linked owner's replies or be delivered after identity changes.
    service.store.db.query("UPDATE outbox SET status='cancelled' WHERE owner_id=? AND status='pending'").run(fallbackOwner);
    return { ownerId: row.owner_id, text: "🌱 Linked. Telegram and the web app now use the same mower crew. Use /mowers, /thread, or /new <goal>." };
  }
  if (name === "start" || name === "help") return { ownerId: ownerId ?? fallbackOwner, text: HELP, onboarding: !ownerId };
  if (!ownerId) return { ownerId: fallbackOwner, text: "Link your account before starting work. Open the authenticated Laun web app, generate a Telegram link code, and send /link <code> here in a private chat.", onboarding: true };
  const p = principal(ownerId);
  if (input.callbackData) {
    const decoded = input.callbackData.match(/^laun:([ad]):([A-Za-z0-9_-]{22})$/);
    if (!decoded) throw new ControlError("Unknown permission button");
    return { ownerId, text: decideHandle(service, scope, ownerId, decoded[2]!, decoded[1] === "a" ? "approve" : "deny"), callbackAnswer: "Decision recorded" };
  }
  if (name === "approve" || name === "deny") return { ownerId, text: decideHandle(service, scope, ownerId, args, name) };
  if (name === "mowers") return { ownerId, text: service.store.list<MowerRecord>("mower", p).filter((m) => !m.archivedAt).slice(0, 30).map((m) => `${m.name} · ${m.role}\n${m.id}`).join("\n\n") || "No mowers yet. /new <goal> creates your groundskeeper." };
  if (name === "thread") {
    if (args) { const thread = service.store.get<ThreadRecord>("thread", args, p); if (thread.archivedAt) throw new ControlError("Thread is archived"); selectThread(service, scope, ownerId, thread); return { ownerId, text: `Routing this user/chat/topic to ${thread.title}\n${thread.id}` }; }
    const selected = currentThread(service, scope, ownerId);
    return { ownerId, text: `${selected ? `Selected: ${selected.title}\n${selected.id}\n\n` : "No thread selected.\n\n"}${service.store.list<ThreadRecord>("thread", p).filter((t) => !t.archivedAt).slice(-10).map((t) => `${t.title}\n/thread ${t.id}`).join("\n\n") || "/new <goal> starts one."}` };
  }
  if (name === "status") {
    const thread = args ? service.store.get<ThreadRecord>("thread", args, p) : currentThread(service, scope, ownerId);
    if (!thread) throw new ControlError("No thread selected; use /thread <id> or /new <goal>");
    const runs = service.store.runs(p).filter((run) => run.threadId === thread.id).slice(0, 4);
    const pending = service.store.approvals(p).filter((a) => a.action.threadId === thread.id && a.status === "pending" && Date.parse(a.expiresAt) > Date.now());
    for (const approval of pending) { const prompt = approvalMessage(service, scope, ownerId, approval); enqueue(service, scope, ownerId, `approval:${approval.id}`, prompt.text, prompt.buttons); }
    return { ownerId, text: `${thread.title}\n${thread.id}\n${runs.map((r) => `${r.status} · ${r.summary ?? r.prompt.slice(0, 200)}`).join("\n") || "No runs yet."}\nPending decisions: ${pending.length}` };
  }
  if (name === "deliveries") {
    const rows = service.store.db.query("SELECT o.id,o.body,o.status FROM outbox o JOIN telegram_deliveries d ON d.id=o.id WHERE o.owner_id=? AND d.bot_id=? AND o.status IN('uncertain','failed') ORDER BY d.updated_at DESC LIMIT 10").all(ownerId, scope.botId) as OutboxRow[];
    return { ownerId, text: rows.filter((row) => (JSON.parse(row.body) as Payload).routeKey === routeKey(scope)).map((row) => `${row.id}\nDelivery outcome uncertain. /retry ${row.id} may duplicate a message already delivered.`).join("\n\n") || "No uncertain deliveries for this user/chat/topic." };
  }
  if (name === "retry") {
    const row = service.store.db.query("SELECT * FROM outbox WHERE id=? AND owner_id=? AND status IN('uncertain','failed')").get(args, ownerId) as OutboxRow | null;
    if (!row || (JSON.parse(row.body) as Payload).routeKey !== routeKey(scope)) throw new ControlError("Uncertain delivery not found for this user/chat/topic", 404);
    service.store.db.query("UPDATE outbox SET status='pending' WHERE id=?").run(row.id); service.store.db.query("UPDATE telegram_deliveries SET next_at=?,updated_at=? WHERE id=?").run(now(), now(), row.id);
    return { ownerId, text: "Explicit retry requested. A previous timed-out send may already exist in Telegram." };
  }
  if (name === "delegate") {
    const parent = currentThread(service, scope, ownerId); if (!parent) throw new ControlError("Select a parent thread before delegating");
    const { selector, goal } = namedGoal(args); const mower = pickMower(service, ownerId, selector, options, parent);
    const thread = service.store.createThread(p, { mowerId: mower.id, title: goal.slice(0, 160), parentThreadId: parent.id });
    const run = service.store.submit(p, thread.id, { text: goal, requestId: `telegram:${scope.botId}:${input.updateId}` });
    const task: TaskRecord = { id: id(), ownerId, parentThreadId: parent.id, threadId: thread.id, mowerId: mower.id, title: goal.slice(0, 160), status: "queued", createdAt: now(), updatedAt: now(), handoffCount: 0 };
    service.store.put("task", task); service.store.event(parent.id, "task", { taskId: task.id, threadId: thread.id, text: `Delegated: ${goal.slice(0, 200)}` });
    selectThread(service, scope, ownerId, thread, true);
    // Keep the director selected for later plain messages while subscribing to its child.
    service.store.db.query("UPDATE telegram_routes SET thread_id=? WHERE route_key=?").run(parent.id, routeKey(scope));
    return { ownerId, text: `Delegated to ${mower.name}\nTask ${task.id}\nThread ${thread.id}\nRun ${run.id}\nUse /thread ${thread.id} to interact directly.` };
  }
  if (name && name !== "new") throw new ControlError("Unknown command. /help lists supported commands");
  let thread = name === "new" ? undefined : currentThread(service, scope, ownerId);
  const { selector, goal } = name === "new" ? namedGoal(args) : { goal: text(source, "message") };
  if (!thread) { const mower = pickMower(service, ownerId, selector, options); thread = service.store.createThread(p, { mowerId: mower.id, title: goal.slice(0, 160) }); selectThread(service, scope, ownerId, thread, true); }
  const run = service.store.submit(p, thread.id, { text: goal, requestId: `telegram:${scope.botId}:${input.updateId}` });
  return { ownerId, text: `Queued for ${service.store.get<MowerRecord>("mower", thread.mowerId, p).name}\nThread ${thread.id}\nRun ${run.id}` };
}

function permitted(payload: Payload, ownerId: string, options: TelegramConnectorOptions, service: ControlService): boolean {
  try {
    const scope = identity(payload, options);
    const linked = linkedOwner(service, scope);
    return linked === ownerId || (payload.onboarding === true && !linked && ownerId === `telegram_${scope.botId}_${scope.userId}`);
  } catch { return false; }
}
function materialize(service: ControlService, options: TelegramConnectorOptions) {
  const db = service.store.db;
  const routes = db.query("SELECT r.*,s.thread_id subscription_thread,s.cursor FROM telegram_routes r JOIN telegram_subscriptions s ON s.route_key=r.route_key WHERE r.bot_id=?").all(options.botId) as Array<Route & { subscription_thread: string; cursor: number }>;
  for (const route of routes) {
    const scope: Identity = { botId: route.bot_id, userId: route.user_id, chatId: route.chat_id, topicId: route.topic_id };
    if (!permitted({ ...scope, routeKey: route.route_key, text: "" }, route.owner_id, options, service)) continue;
    const p = principal(route.owner_id);
    const thread = service.store.get<ThreadRecord>("thread", route.subscription_thread, p);
    const mower = service.store.get<MowerRecord>("mower", thread.mowerId, p);
    const events = service.store.events(p, thread.id, route.cursor);
    let buffer = ""; let first: number | undefined; let last: number | undefined;
    const flush = () => {
      if (buffer) enqueue(service, scope, route.owner_id, `text:${thread.id}:${first}:${last}`, `[${mower.name} · ${thread.title}]\n${buffer}`);
      buffer = ""; first = undefined; last = undefined;
    };
    for (const entry of events.events) {
      if (entry.kind === "agent" && entry.payload.event?.type === "text") {
        if (first === undefined) first = entry.sequence; last = entry.sequence; buffer += entry.payload.event.delta;
        if (buffer.length > 12_000) flush();
        continue;
      }
      flush();
      if (entry.kind === "approval" && entry.payload.status === "pending" && typeof entry.payload.approvalId === "string") {
        const approval = service.store.approval(entry.payload.approvalId, p);
        if (approval.status === "pending" && Date.parse(approval.expiresAt) > Date.now()) {
          const prompt = approvalMessage(service, scope, route.owner_id, approval);
          enqueue(service, scope, route.owner_id, `approval:${approval.id}`, `[${mower.name} · ${thread.title}]\n${prompt.text}`, prompt.buttons);
        }
      } else if (entry.kind === "agent" && entry.payload.event?.type === "error") {
        enqueue(service, scope, route.owner_id, `event:${thread.id}:${entry.sequence}`, `[${mower.name} · ${thread.title}]\nRun reported an error: ${entry.payload.event.message}`);
      } else if (entry.kind === "system" && typeof entry.payload.status === "string" && ["done", "error", "cancelled", "interrupted"].includes(entry.payload.status)) {
        enqueue(service, scope, route.owner_id, `event:${thread.id}:${entry.sequence}`, `[${mower.name} · ${thread.title}]\n${entry.payload.status}: ${entry.payload.text ?? entry.payload.status}`);
      } else if (entry.kind === "task") {
        enqueue(service, scope, route.owner_id, `event:${thread.id}:${entry.sequence}`, `[${mower.name} · ${thread.title}]\n${entry.payload.text ?? "Task updated"}\n${entry.payload.threadId ? `/thread ${String(entry.payload.threadId)}` : ""}`);
      }
    }
    flush();
    db.query("UPDATE telegram_subscriptions SET cursor=? WHERE route_key=? AND thread_id=?").run(events.nextCursor, route.route_key, thread.id);
  }
  // A bridge that disappeared after a Telegram send leaves an uncertain
  // external outcome. Do not blindly send the same message after lease expiry.
  db.query("UPDATE outbox SET status='uncertain' WHERE id IN(SELECT id FROM telegram_deliveries WHERE lease_until<?) AND status='sending'").run(now());
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = ""; let bytes = 0;
  if (reader) try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 65_536) throw new ControlError("Telegram connector request too large", 413);
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return record(JSON.parse(value || "{}")); } catch { throw new ControlError("invalid Telegram connector JSON"); }
}

/** Independent bridge credential validation; a user header can never choose an owner. */
export async function handleTelegramConnectorRequest(
  service: ControlService, req: Request, options: TelegramConnectorOptions, authenticated?: ControlPrincipal | null,
): Promise<Response | null> {
  const path = new URL(req.url).pathname.replace(/^\/api\/v2/, "");
  const human = ["/identity/telegram-link", "/identity/telegram-deliveries"].includes(path);
  if (!human && !path.startsWith("/connectors/telegram/")) return null;
  try {
    if (!/^\d{1,20}$/.test(options.botId)) throw new ControlError("Telegram connector is unconfigured: set LAUN_TELEGRAM_BOT_ID on the controller", 503);
    initialize(service);
    const db = service.store.db;
    if (human) {
      if (!authenticated) throw new ControlError("unauthorized", 401);
      if (path === "/identity/telegram-link" && req.method === "POST") {
        const ttl = options.linkTtlMs ?? 120_000;
        if (!Number.isSafeInteger(ttl) || ttl < 100 || ttl > 300_000) throw new ControlError("invalid link lifetime");
        const code = `launlink_${randomBytes(16).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + ttl).toISOString();
        service.store.transaction(() => {
          db.query("DELETE FROM telegram_link_codes WHERE owner_id=? AND used_at IS NULL").run(authenticated.id);
          db.query("INSERT INTO telegram_link_codes(hash,owner_id,expires_at) VALUES(?,?,?)").run(hash(code), authenticated.id, expiresAt);
        });
        return json({ code, expiresAt, botId: options.botId });
      }
      if (path === "/identity/telegram-link" && req.method === "GET") return json({ links: db.query("SELECT bot_id botId,user_id userId,created_at createdAt FROM telegram_links WHERE owner_id=?").all(authenticated.id) });
      if (path === "/identity/telegram-link" && req.method === "DELETE") {
        const b = await requestBody(req); const userId = text(b.userId, "userId", 20);
        service.store.transaction(() => {
          const routes = db.query("SELECT route_key FROM telegram_routes WHERE bot_id=? AND user_id=? AND owner_id=?").all(options.botId, userId, authenticated.id) as { route_key: string }[];
          for (const route of routes) {
            db.query("DELETE FROM telegram_subscriptions WHERE route_key=?").run(route.route_key);
            db.query("DELETE FROM telegram_handles WHERE route_key=?").run(route.route_key);
            db.query("UPDATE outbox SET status='cancelled' WHERE destination=? AND status IN('pending','sending','uncertain')").run(`telegram:${route.route_key}`);
          }
          db.query("DELETE FROM telegram_routes WHERE bot_id=? AND user_id=? AND owner_id=?").run(options.botId, userId, authenticated.id);
          db.query("DELETE FROM telegram_links WHERE bot_id=? AND user_id=? AND owner_id=?").run(options.botId, userId, authenticated.id);
        });
        return json({ unlinked: true });
      }
      if (path === "/identity/telegram-deliveries" && req.method === "GET") {
        const rows = db.query("SELECT o.id,o.body,o.status,d.updated_at,d.attempts,d.message_id FROM outbox o JOIN telegram_deliveries d ON d.id=o.id WHERE o.owner_id=? ORDER BY d.updated_at DESC LIMIT 100").all(authenticated.id) as Array<OutboxRow & { updated_at: string; attempts: number; message_id?: string }>;
        return json({ deliveries: rows.map((row) => { const p = JSON.parse(row.body) as Payload; return { id: row.id, chatId: p.chatId, topicId: p.topicId, text: p.text.slice(0, 200), status: row.status, updatedAt: row.updated_at, attempts: row.attempts, messageId: row.message_id }; }) });
      }
      throw new ControlError("method not allowed", 405);
    }
    if (!checkBearer(req.headers.get("authorization"), options.serviceToken)) throw new ControlError("unauthorized bridge", 401);
    if (req.method !== "POST") throw new ControlError("method not allowed", 405);
    const b = await requestBody(req);
    if (String(b.botId ?? "") !== options.botId) throw new ControlError("Telegram bot identity mismatch", 403);
    if (path === "/connectors/telegram/ingest") {
      const scope = identity(b, options);
      if (!Number.isSafeInteger(b.updateId) || Number(b.updateId) < 0) throw new ControlError("invalid Telegram update ID");
      if ((typeof b.text === "string") === (typeof b.callbackData === "string")) throw new ControlError("send exactly one text or callback");
      if (b.text !== undefined) text(b.text, "text");
      if (b.callbackData !== undefined) text(b.callbackData, "callbackData", 64);
      const input: TelegramInboundUpdate = { ...scope, updateId: Number(b.updateId), ...(b.text !== undefined ? { text: String(b.text) } : { callbackData: String(b.callbackData) }) };
      const fingerprint = hash(canonical(input));
      const result = service.store.transaction(() => {
        const previous = db.query("SELECT fingerprint,body FROM telegram_inbox WHERE bot_id=? AND update_id=?").get(scope.botId, input.updateId) as { fingerprint: string; body: string } | null;
        if (previous) { if (previous.fingerprint !== fingerprint) throw new ControlError("Telegram update identity conflict", 409); return JSON.parse(previous.body) as TelegramIngestResult; }
        let answer: ReturnType<typeof command>;
        try { answer = service.store.transaction(() => command(service, scope, input, options)); }
        catch (error) { answer = { ownerId: linkedOwner(service, scope) ?? `telegram_${scope.botId}_${scope.userId}`, text: message(error), onboarding: !linkedOwner(service, scope), callbackAnswer: input.callbackData ? "Decision not applied" : undefined }; }
        enqueue(service, scope, answer.ownerId, `update:${input.updateId}`, answer.text, answer.buttons, answer.onboarding);
        const receipt: TelegramIngestResult = { accepted: true, ...(answer.callbackAnswer ? { callbackAnswer: answer.callbackAnswer } : {}) };
        db.query("INSERT INTO telegram_inbox VALUES(?,?,?,?)").run(scope.botId, input.updateId, fingerprint, JSON.stringify(receipt)); return receipt;
      });
      void service.tick(); return json(result);
    }
    if (path === "/connectors/telegram/poll") {
      const limit = Math.max(1, Math.min(8, Number.isSafeInteger(b.limit) ? Number(b.limit) : 4));
      const deliveries = service.store.transaction(() => {
        materialize(service, options);
        const rows = db.query("SELECT o.* FROM outbox o JOIN telegram_deliveries d ON d.id=o.id WHERE d.bot_id=? AND o.status='pending' AND d.next_at<=? ORDER BY d.next_at,d.rowid LIMIT 64").all(options.botId, now()) as OutboxRow[];
        const selected: TelegramDelivery[] = [];
        for (const row of rows) {
          const payload = JSON.parse(row.body) as Payload;
          if (!permitted(payload, row.owner_id, options, service)) {
            db.query("UPDATE outbox SET status='cancelled' WHERE id=? AND status='pending'").run(row.id);
            continue;
          }
          const leaseId = id();
          db.query("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id);
          db.query("UPDATE telegram_deliveries SET lease_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?").run(leaseId, new Date(Date.now() + 60_000).toISOString(), now(), row.id);
          selected.push({ id: row.id, leaseId, chatId: payload.chatId, ...(payload.topicId !== "0" ? { topicId: payload.topicId } : {}), text: payload.text, ...(payload.buttons ? { buttons: payload.buttons } : {}) });
          if (selected.length >= limit) break;
        }
        return selected;
      });
      return json({ deliveries });
    }
    if (path === "/connectors/telegram/ack") {
      const deliveryId = text(b.id, "id", 100), leaseId = text(b.leaseId, "leaseId", 100);
      const state = b.status;
      if (!["delivered", "retry", "uncertain", "failed"].includes(String(state))) throw new ControlError("invalid delivery result");
      service.store.transaction(() => {
        const row = db.query("SELECT d.*,o.body,o.owner_id,o.status FROM telegram_deliveries d JOIN outbox o ON o.id=d.id WHERE d.id=? AND d.bot_id=?").get(deliveryId, options.botId) as { lease_id: string; lease_until: string; body: string; owner_id: string; status: string } | null;
        if (!row || row.lease_id !== leaseId) throw new ControlError("stale Telegram delivery lease", 409);
        if (row.status === (state === "retry" ? "pending" : state)) return;
        if (row.status !== "sending" || Date.parse(row.lease_until) <= Date.now()) throw new ControlError("Telegram delivery outcome requires reconciliation", 409);
        if (!permitted(JSON.parse(row.body), row.owner_id, options, service)) throw new ControlError("Telegram delivery route was revoked", 403);
        let retryMs = 0;
        if (state === "retry") { retryMs = Number(b.retryAfterMs ?? 1000); if (!Number.isSafeInteger(retryMs) || retryMs < 100 || retryMs > 3_600_000) throw new ControlError("invalid retry delay"); }
        const status = state === "retry" ? "pending" : String(state);
        db.query("UPDATE outbox SET status=? WHERE id=?").run(status, deliveryId);
        db.query("UPDATE telegram_deliveries SET next_at=?,updated_at=?,message_id=? WHERE id=?").run(new Date(Date.now() + retryMs).toISOString(), now(), b.messageId === undefined ? null : text(String(b.messageId), "messageId", 40), deliveryId);
      });
      return json({ acknowledged: true });
    }
    throw new ControlError("connector endpoint not found", 404);
  } catch (error) { const e = error as Error & { status?: number }; return json({ error: e.message }, e.status ?? 400); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
