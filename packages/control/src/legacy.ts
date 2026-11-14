import { mkdir, open, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { captureCheckpoint } from "@laun/storage";
import type { ControlPrincipal, LegacyImportArchive, LegacyImportPreview, LegacyImportReport, PassiveLegacyHistory, ThreadRecord } from "@laun/protocol";
import { canonical, ControlError, ControlStore, hash, id, now, text } from "./store.js";
import { readLegacySources, type LegacyImportSources } from "./legacy-source.js";
import { purgedLegacySource, purgedOwner } from "./retention-guard.js";
export { previewLegacyImport } from "./legacy-source.js";
export type { LegacyImportSources } from "./legacy-source.js";

export interface LegacyImportOptions extends LegacyImportSources {
  store: ControlStore;
  runtimeDataDir: string;
  ownerId: string;
  name: string;
  model: string;
  writePassiveHistory(input: PassiveLegacyHistory): Promise<{ runtimeVersion: string; entries: number }>;
}
export interface StoredLegacyImport { id: string; owner_id: string; source_hash: string; thread_id: string; mower_id: string; created_at: string; body: string; raw_archive: string }
export function initializeLegacyImports(store: ControlStore): void {
  store.db.exec("CREATE TABLE IF NOT EXISTS legacy_imports(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source_hash TEXT NOT NULL,thread_id TEXT NOT NULL,mower_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,raw_archive TEXT NOT NULL,UNIQUE(owner_id,source_hash))");
}
function existing(store: ControlStore, ownerId: string, digest: string): StoredLegacyImport | null { return store.db.query("SELECT * FROM legacy_imports WHERE owner_id=? AND source_hash=?").get(ownerId, digest) as StoredLegacyImport | null; }
function fingerprintFor(report: LegacyImportPreview | LegacyImportReport, name: string, model: string): string { return hash(canonical({ sourceDigest: report.sourceDigest, legacySessionId: report.legacySessionId ?? null, files: report.files.map(file => ({ kind: file.kind, sha256: file.sha256 })), name, model })); }
function checked(row: StoredLegacyImport, fingerprint: string): LegacyImportReport {
  const value = validateStoredLegacyImport(row);
  if (JSON.parse(row.body).fingerprint !== fingerprint) throw new ControlError("this exact legacy transcript was imported with different options or companion files; inspect its existing report", 409); return value.report;
}

/** Pure archival validation also used by the offline backup reader. */
export function validateStoredLegacyImport(row: StoredLegacyImport): { report: LegacyImportReport; archive: LegacyImportArchive } {
  const value = JSON.parse(row.body) as { fingerprint: string; report: LegacyImportReport; options: { name: string; model: string } }, archive = JSON.parse(row.raw_archive) as LegacyImportArchive;
  const report = value.report;
  if (!report || report.id !== row.id || report.ownerId !== row.owner_id || report.threadId !== row.thread_id || report.mowerId !== row.mower_id || report.sourceDigest !== row.source_hash || report.createdAt !== row.created_at || !Number.isFinite(Date.parse(row.created_at)) || report.sourceFormat !== "pi-coding-agent-v3" ||
    !/^(?:user_[0-9a-f]{32}|key_[0-9a-f]{8,32})$/.test(report.ownerId) || typeof report.sourceSessionId !== "string" || report.sourceSessionId.length > 128 || typeof report.profileId !== "string" || report.profileVersion !== 1 || !Array.isArray(report.files) || report.files.length < 1 || report.files.length > 3 ||
    !/^[0-9a-f]{64}$/.test(report.sourceDigest) || !Number.isSafeInteger(report.entryCount) || report.entryCount < 0 || report.entryCount > 20_000 || !Array.isArray(report.leaves) || report.leaves.length > 10_000 || report.leaves.some(leaf => typeof leaf !== "string" || leaf.length > 128) ||
    !Array.isArray(report.unsupportedTypes) || report.unsupportedTypes.length > 256 || !Array.isArray(report.unsupportedFields) || report.unsupportedFields.length > 1000 || !Array.isArray(report.warnings) || report.warnings.length > 32 ||
    [...report.unsupportedTypes, ...report.unsupportedFields, ...report.warnings].some(item => typeof item !== "string" || item.length > 4096) ||
    !value.options || typeof value.options.name !== "string" || value.options.name.length > 80 || typeof value.options.model !== "string" || value.options.model.length > 256 || value.fingerprint !== fingerprintFor(report, value.options.name, value.options.model) || !archive || archive.version !== 1 || !Array.isArray(archive.files) || archive.files.length < 1 || archive.files.length > 3) throw new ControlError("invalid legacy import metadata");
  const kinds = new Set<string>();
  for (const file of archive.files) {
    const limit = file.kind === "pi-session" ? 16 * 1024 * 1024 : file.kind === "gateway-index" ? 4 * 1024 * 1024 : file.kind === "gateway-events" ? 8 * 1024 * 1024 : 0;
    if (!limit || kinds.has(file.kind) || typeof file.sourcePath !== "string" || file.sourcePath.length > 4096 || file.sourcePath.includes("\0") || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limit || typeof file.contentBase64 !== "string" || file.contentBase64.length > Math.ceil(limit / 3) * 4 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new ControlError("invalid legacy raw archive file");
    kinds.add(file.kind); const bytes = Buffer.from(file.contentBase64, "base64");
    const digest = createHash("sha256").update(bytes).digest("hex"); if (bytes.length !== file.bytes || bytes.toString("base64") !== file.contentBase64 || digest !== file.sha256) throw new ControlError("legacy raw archive checksum mismatch");
  }
  if (!kinds.has("pi-session") || archive.files.find(file => file.kind === "pi-session")!.sha256 !== report.sourceDigest || canonical(archive.files.map(({ contentBase64: _raw, ...file }) => file)) !== canonical(report.files)) throw new ControlError("legacy archive provenance mismatch");
  return { report, archive };
}

/** Offline administrator operation; imported state never creates a run or grant. */
export async function importLegacyHistory(options: LegacyImportOptions): Promise<LegacyImportReport> {
  if (!/^(?:user_[0-9a-f]{32}|key_[0-9a-f]{8,32})$/.test(options.ownerId)) throw new ControlError("legacy import requires an explicit stable human owner ID");
  const name = text(options.name, "imported mower name", 80), model = text(options.model, "current model", 256);
  if (!model.includes("/") || typeof options.writePassiveHistory !== "function") throw new ControlError("a current model and passive runtime writer are required");
  const { preview, archive } = await readLegacySources(options); const store = options.store; initializeLegacyImports(store);
  const fingerprint = fingerprintFor(preview, name, model);
  if(purgedLegacySource(store.db,options.ownerId,preview.sourceDigest))throw new ControlError("this legacy transcript's controller copy was removed; it will not be recreated by retry",410);
  const previous = existing(store, options.ownerId, preview.sourceDigest); if (previous) return checked(previous, fingerprint);
  const runtimeDir = resolve(options.runtimeDataDir); await mkdir(runtimeDir, { recursive: true, mode: 0o700 }); if (await realpath(runtimeDir) !== runtimeDir) throw new ControlError("runtime data directory must not contain symlinks");
  const parent = join(runtimeDir, "threads"); await mkdir(parent, { mode: 0o700, recursive: true }); if (await realpath(parent) !== parent) throw new ControlError("thread data directory must not contain symlinks");
  const importId = id(), threadId = id(), root = join(parent, threadId); await mkdir(root, { mode: 0o700 }); let committed = false;
  try {
    await mkdir(join(root, "work"), { mode: 0o700 });
    const passive = await options.writePassiveHistory({ threadId, sessionDir: join(root, "session"), importId, sourceDigest: preview.sourceDigest, sourceSessionId: preview.sourceSessionId, entries: preview.entries });
    if (passive.runtimeVersion !== "pi-durable@1.5.2" || passive.entries !== preview.entries.length) throw new ControlError("passive writer returned an incompatible or incomplete import");
    const checkpoint = await captureCheckpoint(threadId, root), p = { id: options.ownerId, admin: false }, at = now();
    const result = store.transaction(() => {
      if(purgedLegacySource(store.db,options.ownerId,preview.sourceDigest))throw new ControlError("this legacy transcript's controller copy was removed",410);
      const duplicate = existing(store, options.ownerId, preview.sourceDigest); if (duplicate) return { duplicate: true, report: checked(duplicate, fingerprint) };
      const profile = store.createProfile(p, { name: "Imported history · isolated", mode: "isolated", rules: [] });
      const mower = store.createMower(p, { name, model, profileId: profile.id, profileVersion: 1 });
      const thread: ThreadRecord = { id: threadId, ownerId: p.id, workspaceId: mower.workspaceId, mowerId: mower.id, title: name, profileId: profile.id, profileVersion: 1, createdAt: at, updatedAt: at, stoppedAt: at };
      store.put("thread", thread);
      const { entries: _entries, ...summary } = preview;
      const report: LegacyImportReport = { ...summary, id: importId, ownerId: p.id, mowerId: mower.id, threadId, profileId: profile.id, profileVersion: 1, createdAt: at };
      store.event(threadId, "system", { text: `Imported passive legacy history from session ${preview.sourceSessionId}. No model context, permissions, tasks or effects were activated.`, legacyImportId: importId, sourceDigest: preview.sourceDigest, warnings: preview.warnings });
      for (const entry of preview.entries) store.event(threadId, "system", { text: `[Untrusted legacy history · ${entry.sourceType} · ${entry.id}]\n${entry.text}${entry.truncated ? "\n[Preview shortened; exact original remains privately archived.]" : ""}`, legacyImportId: importId, sourceEntryId: entry.id, sourceParentId: entry.parentId, sourceTimestamp: entry.timestamp, truncated: entry.truncated });
      store.db.query("INSERT INTO checkpoints VALUES(?,?,?)").run(threadId, checkpoint, at);
      store.db.query("INSERT INTO legacy_imports VALUES(?,?,?,?,?,?,?,?)").run(importId, p.id, preview.sourceDigest, threadId, mower.id, at, JSON.stringify({ fingerprint, report, options: { name, model } }), JSON.stringify(archive));
      return { duplicate: false, report };
    });
    if (result.duplicate) { await rm(root, { recursive: true }); return result.report; }
    committed = true;
    const fd = await open(parent, "r"); try { await fd.sync(); } finally { await fd.close(); }
    return result.report;
  } catch (error) { if (!committed) await rm(root, { recursive: true, force: true }); throw error; }
}

export function listLegacyImports(store: ControlStore, principal: ControlPrincipal): LegacyImportReport[] {
  initializeLegacyImports(store); const rows = (principal.admin ? store.db.query("SELECT body FROM legacy_imports ORDER BY created_at DESC,id LIMIT 100").all() : store.db.query("SELECT body FROM legacy_imports WHERE owner_id=? ORDER BY created_at DESC,id LIMIT 100").all(principal.id)) as Array<{ body: string }>;
  return rows.map(row => (JSON.parse(row.body) as { report: LegacyImportReport }).report).filter(report=>!purgedOwner(store.db,"legacy",report.id));
}
export function legacyImportArchive(store: ControlStore, principal: ControlPrincipal, importId: string): { report: LegacyImportReport; archive: LegacyImportArchive } {
  if (!principal.admin) throw new ControlError("installation administrator required for raw legacy archives; they may contain secrets or unrelated index metadata", 403);
  store.assertNotPurged("legacy",importId,principal);
  initializeLegacyImports(store); const row = store.db.query("SELECT * FROM legacy_imports WHERE id=?").get(importId) as StoredLegacyImport | null; if (!row) throw new ControlError("legacy import not found", 404);
  return validateStoredLegacyImport(row);
}
