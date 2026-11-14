import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isAgentEvent, normalizeCreateSession } from "@laun/protocol";
import type { LegacyEntryPreview, LegacyImportArchive, LegacyImportFile, LegacyImportPreview } from "@laun/protocol";
import { redactAdviceText } from "./adviser.js";

export interface LegacyImportSources { sessionFile: string; indexFile?: string; eventsFile?: string; legacySessionId?: string; expectedSourceDigest?: string; confirmOffline: true }
type Row = Record<string, unknown>;
const MAX_RECORDS = 10_000;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new Error(`legacy import: ${message}`); }
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : fail("expected an object");
const id = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Native JSON validation plus duplicate-key/depth/finite-number rejection. */
function strictJson(raw: string): unknown {
  let offset = 0;
  const ws = () => { while (/\s/.test(raw[offset] ?? "") && offset < raw.length) offset++; };
  const string = (): string => { const start = offset++; let escaped = false;
    while (offset < raw.length) { const c = raw[offset++]!; if (!escaped && c === '"') return JSON.parse(raw.slice(start, offset)) as string; if (!escaped && c === "\\") escaped = true; else escaped = false; }
    return fail("unterminated JSON string"); };
  const scan = (depth: number): void => { if (depth > 64) fail("JSON nesting exceeds supported depth"); ws(); const c = raw[offset];
    if (c === "{") { offset++; ws(); const keys = new Set<string>(); if (raw[offset] === "}") { offset++; return; }
      for (;;) { ws(); if (raw[offset] !== '"') fail("invalid JSON object"); const key = string(); if (keys.has(key)) fail("duplicate JSON object key"); keys.add(key); ws(); if (raw[offset++] !== ":") fail("invalid JSON object"); scan(depth + 1); ws(); const end = raw[offset++]; if (end === "}") return; if (end !== ",") fail("invalid JSON object"); }
    }
    if (c === "[") { offset++; ws(); if (raw[offset] === "]") { offset++; return; } for (;;) { scan(depth + 1); ws(); const end = raw[offset++]; if (end === "]") return; if (end !== ",") fail("invalid JSON array"); } }
    if (c === '"') { string(); return; }
    const token = raw.slice(offset).match(/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0];
    if (!token) fail("invalid JSON value"); const value = JSON.parse(token!) as unknown; if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite JSON number"); offset += token!.length;
  };
  try { scan(0); ws(); if (offset !== raw.length) fail("trailing JSON data"); return JSON.parse(raw); }
  catch (error) { if (error instanceof Error && error.message.startsWith("legacy import:")) throw error; return fail("malformed JSON"); }
}
async function source(path: string, kind: LegacyImportFile["kind"], limit: number): Promise<{ file: LegacyImportArchive["files"][number]; text: string }> {
  const full = resolve(path); if (await realpath(full) !== full) fail("source paths must not contain symlinks");
  const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const before = await fd.stat(); if (!before.isFile() || before.size > limit) fail(`${kind} must be a bounded regular file (limit ${limit} bytes)`);
    const chunks: Buffer[] = []; let bytes = 0; for (;;) { const part = Buffer.alloc(65536); const read = await fd.read(part, 0, part.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; if (bytes > limit) fail(`${kind} grew beyond its size limit`); chunks.push(part.subarray(0, read.bytesRead)); }
    const after = await fd.stat(), current = await lstat(full); if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() || await realpath(full) !== full) fail("source changed; stop its writer before importing");
    const raw = Buffer.concat(chunks, bytes); let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { return fail("malformed UTF-8 source"); }
    return { text, file: { kind, sourcePath: full, bytes, sha256: sha(raw), contentBase64: raw.toString("base64") } };
  } finally { await fd.close(); }
}
function lines(raw: string): Row[] {
  if (!raw || !raw.endsWith("\n")) fail("JSONL must contain complete newline-terminated records");
  const values = raw.slice(0, -1).split("\n"); if (values.length > MAX_RECORDS + 1) fail("source record count exceeds 10000");
  return values.map(line => { if (!line.trim()) return fail("blank JSONL records are unsupported"); return row(strictJson(line)); });
}
const FIELDS: Record<string, string[]> = {
  message: ["message"], thinking_level_change: ["thinkingLevel"], model_change: ["provider", "modelId"], usage: ["kind", "provider", "model", "usage", "note"],
  compaction: ["summary", "firstKeptEntryId", "tokensBefore", "details", "usage", "fromHook", "systemMessage"], branch_summary: ["fromId", "summary", "details", "usage", "fromHook"],
  custom: ["customType", "data"], label: ["targetId", "label"], session_info: ["name"], custom_message: ["customType", "content", "details", "display"], context_edit: ["targetId", "replacement"],
};
function clip(value: string, max: number): { text: string; truncated: boolean } {
  let text = "", bytes = 0; for (const char of value) { const size = Buffer.byteLength(char); if (bytes + size > max) return { text, truncated: true }; text += char; bytes += size; } return { text, truncated: false };
}
function visible(value: string): string { return redactAdviceText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`); }
function content(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) ? value.filter(block => block && typeof block === "object" && (block as Row).type === "text" && typeof (block as Row).text === "string").map(block => (block as Row).text).join("\n") : ""; }
function describe(entry: Row): string {
  if (entry.type === "message") { const message = row(entry.message); return `${String(message.role ?? "unknown")} message (untrusted):\n${content(message.content) || "[Non-text message content is preserved in the private raw archive.]"}`; }
  if (typeof entry.summary === "string") return `${String(entry.type)} (historical, not current instructions):\n${entry.summary}`;
  if (entry.type === "custom_message") return `Custom message (inert):\n${content(entry.content)}`;
  if (entry.type === "session_info") return `Historical session name: ${String(entry.name ?? "")}`;
  if (entry.type === "label") return `Historical label: ${String(entry.label ?? "removed")} (target ${String(entry.targetId)})`;
  return `[${String(entry.type)} retained as inert metadata; executable/configuration state was not imported.]`;
}

export async function readLegacySources(options: LegacyImportSources): Promise<{ preview: LegacyImportPreview; archive: LegacyImportArchive }> {
  if (options.confirmOffline !== true) fail("stop the original gateway/executor/bridge and explicitly confirmOffline");
  const accepted = new Set(["sessionFile", "indexFile", "eventsFile", "legacySessionId", "expectedSourceDigest", "confirmOffline", "store", "runtimeDataDir", "ownerId", "name", "model", "writePassiveHistory"]);
  if (Object.keys(options).some(key => !accepted.has(key))) fail("unsupported import options; automatic resume, model-context selection and old permissions are not implemented");
  const pi = await source(options.sessionFile, "pi-session", 16 * 1024 * 1024), records = lines(pi.text), header = records.shift()!;
  if (options.expectedSourceDigest !== undefined && (typeof options.expectedSourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.expectedSourceDigest) || options.expectedSourceDigest !== pi.file.sha256)) fail("source digest changed since preview; inspect the new source before importing");
  if (!header || header.type !== "session" || header.version !== 3 || !id(header.id) || !date(header.timestamp) || typeof header.cwd !== "string" || header.cwd.length > 4096 || header.cwd.includes("\0") || (header.parentSession !== undefined && (typeof header.parentSession !== "string" || header.parentSession.length > 4096 || header.parentSession.includes("\0")))) fail("only explicit Pi coding-agent session format version3 is supported");
  if (options.legacySessionId !== undefined && (!id(options.legacySessionId) || options.legacySessionId !== header.id)) fail("selected legacy gateway session ID does not match the Pi session header");
  if ((options.indexFile || options.eventsFile) && !options.legacySessionId) fail("optional gateway files require an explicit matching legacySessionId");
  const unsupportedTypes = new Set<string>(), unsupportedFields = new Set<string>(), byId = new Map<string, Row>(), childIds = new Set<string>();
  const addFields = (entry: Row, allowed: string[], prefix: string) => { for (const key of Object.keys(entry)) if (!allowed.includes(key)) unsupportedFields.add(`${prefix}.${visible(key).slice(0, 160)}`); };
  addFields(header, ["type", "version", "id", "timestamp", "cwd", "parentSession"], "session");
  for (const entry of records) {
    if (entry.type === "session" || typeof entry.type !== "string" || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(entry.type) || !id(entry.id) || byId.has(entry.id) || (entry.parentId !== null && !id(entry.parentId)) || !date(entry.timestamp)) fail("invalid or duplicate legacy tree entry");
    const fields = Object.hasOwn(FIELDS, entry.type) ? FIELDS[entry.type] : undefined;
    byId.set(entry.id, entry); if (!fields) unsupportedTypes.add(entry.type);
    addFields(entry, ["type", "id", "parentId", "timestamp", ...(fields ?? [])], entry.type);
    if (entry.type === "message" && (!entry.message || typeof row(entry.message).role !== "string")) fail("invalid historical message");
    for (const required of entry.type === "compaction" ? ["summary", "firstKeptEntryId"] : entry.type === "branch_summary" ? ["summary", "fromId"] : ["context_edit", "label"].includes(entry.type) ? ["targetId"] : entry.type === "model_change" ? ["provider", "modelId"] : entry.type === "thinking_level_change" ? ["thinkingLevel"] : entry.type === "custom" || entry.type === "custom_message" ? ["customType"] : []) if (typeof entry[required] !== "string") fail("missing required historical entry field");
  }
  const resolved = new Set<string>();
  for (const entry of records) {
    if (entry.parentId !== null) childIds.add(String(entry.parentId));
    const seen = new Set<string>(); let current: unknown = entry.id;
    while (current !== null && !resolved.has(String(current))) { if (typeof current !== "string" || !byId.has(current) || seen.has(current)) fail("unresolved or cyclic legacy parent reference"); seen.add(current); current = byId.get(current)!.parentId; }
    for (const known of seen) resolved.add(known);
    for (const key of ["firstKeptEntryId", "fromId", "targetId"]) if (entry[key] !== undefined && (typeof entry[key] !== "string" || !byId.has(entry[key] as string))) fail("unresolved historical entry reference");
  }
  let budget = 1024 * 1024;
  const entries: LegacyEntryPreview[] = records.map(entry => { const preview = clip(visible(describe(entry)), Math.min(2000, budget)); budget -= Buffer.byteLength(preview.text);
    return { id: String(entry.id), parentId: entry.parentId as string | null, sourceType: String(entry.type), timestamp: String(entry.timestamp), text: preview.text || "[Preview budget exhausted; original entry remains archived.]", truncated: preview.truncated }; });
  const files = [pi.file];
  if (options.indexFile) {
    const index = await source(options.indexFile, "gateway-index", 4 * 1024 * 1024), value = strictJson(index.text);
    if (!Array.isArray(value) || value.length > MAX_RECORDS) fail("invalid gateway session index"); const seen = new Set<string>(); let selected: Row | undefined;
    for (const raw of value as unknown[]) { const item = row(raw); if (!id(item.id) || seen.has(item.id) || !date(item.createdAt) || !date(item.updatedAt) || !["pending", "running", "waiting_approval", "done", "error"].includes(String(item.status))) fail("invalid gateway session index record"); seen.add(item.id); normalizeCreateSession(item); if (item.id === options.legacySessionId) selected = item; }
    if (!selected || (selected.runtime !== undefined && selected.runtime !== "pi")) fail("matching Pi gateway session is missing");
    addFields(selected, ["id", "goal", "repo", "model", "runtime", "status", "createdAt", "updatedAt"], "gateway-index.selected"); files.push(index.file);
  }
  if (options.eventsFile) {
    const events = await source(options.eventsFile, "gateway-events", 8 * 1024 * 1024); let previous: string | null = null;
    const eventRecords = lines(events.text); if (eventRecords.length > MAX_RECORDS) fail("source record count exceeds 10000");
    for (const [index, value] of eventRecords.entries()) { if (!isAgentEvent(value) || value.sessionId !== options.legacySessionId) fail("invalid or cross-session gateway event");
      const text = clip(visible(`Gateway ${value.type} (historical):\n${JSON.stringify(value)}`), Math.min(2000, budget)); budget -= Buffer.byteLength(text.text); const entryId = `gateway:${index}`;
      entries.push({ id: entryId, parentId: previous, sourceType: `gateway:${value.type}`, timestamp: String(header.timestamp), text: text.text || "[Preview budget exhausted; original event remains archived.]", truncated: text.truncated }); previous = entryId;
    } files.push(events.file);
  }
  const truncated = entries.filter(entry => entry.truncated).length;
  if (unsupportedFields.size > 1000 || unsupportedTypes.size > 256) fail("unsupported metadata exceeds the bounded import report limit");
  const warnings = ["Imported history is passive data, not model context, permissions, tasks or known-complete external effects.", "Original tool/system/extension/provider state was not activated. Repository/artifact files were not copied; original paths are provenance only.", "Raw source files may contain secrets or unrelated gateway-index metadata and are available only to the installation administrator.", ...(truncated ? [`${truncated} entry previews were shortened; exact bytes remain in the private raw archive.`] : [])];
  const preview: LegacyImportPreview = { sourceFormat: "pi-coding-agent-v3", sourceSessionId: String(header.id), sourceDigest: pi.file.sha256, legacySessionId: options.legacySessionId,
    entryCount: entries.length, leaves: records.filter(entry => !childIds.has(String(entry.id))).map(entry => String(entry.id)), files: files.map(({ contentBase64: _content, ...file }) => file), unsupportedTypes: [...unsupportedTypes].sort(), unsupportedFields: [...unsupportedFields].sort(), warnings, entries };
  return { preview, archive: { version: 1, files } };
}

export async function previewLegacyImport(options: LegacyImportSources): Promise<LegacyImportPreview> { return (await readLegacySources(options)).preview; }
