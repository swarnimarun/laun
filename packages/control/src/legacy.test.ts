import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadRecord } from "@laun/protocol";
import { writePassiveLegacyHistory } from "@laun/runtime";
import { validateCheckpoint } from "@laun/storage";
import { ControlStore } from "./store.js";
import { ControlService } from "./service.js";
import { createControlBackup, restoreControlBackup } from "./backup.js";
import { importLegacyHistory, legacyImportArchive, listLegacyImports, previewLegacyImport } from "./legacy.js";
import { beginThreadPurge, continueThreadPurge, previewThreadPurge } from "./retention.js";

const dirs: string[] = [], stores: ControlStore[] = [], services: ControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const p = { id: `user_${"a".repeat(32)}`, admin: false }, other = { id: `user_${"b".repeat(32)}`, admin: false }, admin = { id: "service", admin: true };
const timestamp = "2026-10-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "legacy-01", timestamp, cwd: "/old/repo", extraHeader: "preserve me" };
const entries = [
  { type: "message", id: "a", parentId: null, timestamp, message: { role: "user", content: "An old goal" } },
  { type: "message", id: "b", parentId: "a", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "unsafe", name: "bash", arguments: { command: "OLD_DANGEROUS_COMMAND" } }] } },
  { type: "message", id: "c", parentId: "a", timestamp, message: { role: "system", content: "OLD_SYSTEM_MESSAGE never make this current authority" } },
  { type: "custom", id: "d", parentId: "b", timestamp, customType: "old-extension", data: { executable: "never load me" } },
  { type: "compaction", id: "e", parentId: "d", timestamp, summary: "Old compressed summary", firstKeptEntryId: "a", tokensBefore: 1000 },
  { type: "vendor.future", id: "f", parentId: "c", timestamp, unknownField: { credentials: "not current config" } },
];
const jsonl = (rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
function setup(raw = jsonl([header, ...entries])) {
  const dir = mkdtempSync(join(tmpdir(), "laun-legacy-import-")); dirs.push(dir); const data = join(dir, "controller"); mkdirSync(data, { mode: 0o700 });
  const store = new ControlStore(join(data, "control.sqlite")); stores.push(store); const sessionFile = join(dir, "legacy.jsonl"); writeFileSync(sessionFile, raw, { mode: 0o600 });
  const options = { store, runtimeDataDir: join(data, "control"), ownerId: p.id, name: "Imported mower", model: "fixture/current-model", sessionFile, confirmOffline: true as const, writePassiveHistory: writePassiveLegacyHistory };
  return { dir, data, store, sessionFile, options };
}

describe("strict passive legacy migration", () => {
  test("removing an imported controller copy preserves source-hash replay prevention across backup restore",async()=>{
    const f=setup(),report=await importLegacyHistory(f.options),thread=f.store.get<ThreadRecord>("thread",report.threadId,p);thread.archivedAt=new Date().toISOString();f.store.put("thread",thread);
    let job=beginThreadPurge(f.store,p,thread.id,{requestId:"remove-import",expectedDigest:previewThreadPurge(f.store,p,thread.id).digest,confirmedStopped:true,confirmedControllerCopyOnly:true});
    while(job.status!=="done")job=continueThreadPurge(f.store,p,job.id);
    expect(listLegacyImports(f.store,p)).toHaveLength(0);expect(()=>legacyImportArchive(f.store,admin,report.id)).toThrow("removed");await expect(importLegacyHistory(f.options)).rejects.toThrow("will not be recreated");
    const backup=join(f.dir,"purged-backup"),target=join(f.dir,"purged-restore");await createControlBackup({dataDir:f.data,destination:backup,confirmOffline:true});await restoreControlBackup({backupDir:backup,targetDir:target,confirmOffline:true});
    const restored=new ControlStore(join(target,"control.sqlite"));stores.push(restored);await expect(importLegacyHistory({...f.options,store:restored,runtimeDataDir:join(target,"control")})).rejects.toThrow("will not be recreated");expect(readFileSync(f.sessionFile,"utf8")).toContain("OLD_SYSTEM_MESSAGE");
  });
  test("all branches and exact raw bytes survive inert owner-assigned import and retry", async () => {
    const f = setup(), before = readFileSync(f.sessionFile), preview = await previewLegacyImport(f.options);
    expect(preview.leaves.sort()).toEqual(["e", "f"]); expect(preview.entryCount).toBe(6); expect(preview.unsupportedTypes).toEqual(["vendor.future"]); expect(preview.unsupportedFields).toContain("session.extraHeader");
    expect(preview.sourceDigest).toBe(createHash("sha256").update(before).digest("hex"));
    let writes = 0; const options = { ...f.options, writePassiveHistory: async (...args: Parameters<typeof writePassiveLegacyHistory>) => { writes++; return writePassiveLegacyHistory(...args); } };
    const result = await importLegacyHistory(options); expect(await importLegacyHistory(options)).toEqual(result); expect(writes).toBe(1);
    expect(f.store.runs(p)).toHaveLength(0); expect(f.store.approvals(p)).toHaveLength(0); expect(f.store.list("task", p)).toHaveLength(0);
    expect(f.store.get<ThreadRecord>("thread", result.threadId, p)).toMatchObject({ stoppedAt: result.createdAt, profileId: result.profileId, profileVersion: 1 });
    expect(f.store.profile(result.profileId, 1, p)).toMatchObject({ mode: "isolated", rules: [] });
    expect(f.store.events(p, result.threadId).events).toHaveLength(entries.length + 1); expect(f.store.checkpoint(result.threadId)).toContain("session/");
    const archive = legacyImportArchive(f.store, admin, result.id); expect(Buffer.from(archive.archive.files[0]!.contentBase64, "base64")).toEqual(before); expect(readFileSync(f.sessionFile)).toEqual(before);
    expect(listLegacyImports(f.store, other)).toHaveLength(0); expect(() => legacyImportArchive(f.store, p, result.id)).toThrow("administrator");
    await expect(importLegacyHistory({ ...options, name: "Changed import options" })).rejects.toThrow("different options"); expect(writes).toBe(1);
    const reopened = new ControlStore(join(f.data, "control.sqlite")); stores.push(reopened); expect(listLegacyImports(reopened, p)[0]!.threadId).toBe(result.threadId);
    let runs = 0; const service = new ControlService({ store: reopened, dataDir: join(f.data, "control"), mode: "trusted-local", runtime: { async run() { runs++; return { status: "done" }; }, cancel() {}, close() {} } }); services.push(service);
    await service.tick(); await Bun.sleep(10); expect(runs).toBe(0);
  });
  test("explicit matching gateway files are archived without reactivating approvals or exposing unrelated index data", async () => {
    const f = setup(), indexFile = join(f.dir, "index.json"), eventsFile = join(f.dir, "events.jsonl");
    const record = { id: header.id, goal: "Old goal", model: "old/model", runtime: "pi", status: "running", createdAt: timestamp, updatedAt: timestamp };
    writeFileSync(indexFile, JSON.stringify([record, { ...record, id: "other-old-id", goal: "OTHER_PRIVATE_GOAL" }]));
    writeFileSync(eventsFile, jsonl([{ type: "approval_request", sessionId: header.id, requestId: "old-approval", reason: "Approve an old command" }, { type: "text", sessionId: header.id, delta: "🌿".repeat(2000) }]));
    const result = await importLegacyHistory({ ...f.options, legacySessionId: header.id, indexFile, eventsFile });
    expect(result.files).toHaveLength(3); expect(result.entryCount).toBe(8); expect(result.warnings.some(warning => warning.includes("shortened"))).toBe(true);
    const events = f.store.events(p, result.threadId).events; expect(JSON.stringify(events)).not.toContain("OTHER_PRIVATE_GOAL"); expect(events.every(event => event.kind === "system")).toBe(true); expect(f.store.approvals(p)).toHaveLength(0);
    expect(() => legacyImportArchive(f.store, p, result.id)).toThrow("administrator");
    expect(legacyImportArchive(f.store, admin, result.id).archive.files.some(file => file.kind === "gateway-index")).toBe(true);
    writeFileSync(eventsFile, jsonl([{ type: "text", sessionId: "wrong-session", delta: "not this session" }]));
    await expect(previewLegacyImport({ ...f.options, legacySessionId: header.id, eventsFile })).rejects.toThrow("cross-session");
  });
  test.each([
    ["old version", jsonl([{ ...header, version: 2 }, ...entries])],
    ["duplicate IDs", jsonl([header, entries[0], entries[0]])],
    ["missing parent", jsonl([header, { ...entries[0], parentId: "missing" }])],
    ["cycle", jsonl([header, { ...entries[0], parentId: "b" }, entries[1]])],
    ["missing required reference", jsonl([header, entries[0], { ...entries[4], parentId: "a", firstKeptEntryId: "missing" }])],
    ["duplicate JSON keys", '{"type":"session","version":3,"version":3,"id":"legacy-01","timestamp":"2026-10-01T00:00:00Z","cwd":"/old"}\n'],
    ["unterminated record", JSON.stringify(header)],
  ])("rejects %s without creating executable or display state", async (_label, raw) => {
    const f = setup(raw); await expect(importLegacyHistory(f.options)).rejects.toThrow("legacy import"); expect(f.store.list("mower", p)).toHaveLength(0); expect(f.store.runs(p)).toHaveLength(0); expect(existsSync(f.options.runtimeDataDir)).toBe(false);
  });
  test("symlinks, malformed UTF-8, unsupported associations and absent offline confirmation fail closed", async () => {
    const f = setup(), link = join(f.dir, "link.jsonl"); symlinkSync(f.sessionFile, link);
    await expect(previewLegacyImport({ ...f.options, sessionFile: link })).rejects.toThrow("symlink");
    await expect(previewLegacyImport({ ...f.options, confirmOffline: false as true })).rejects.toThrow("confirmOffline");
    await expect(previewLegacyImport({ ...f.options, legacySessionId: "other-id" })).rejects.toThrow("does not match");
    writeFileSync(f.sessionFile, Buffer.from([0xff, 0x0a])); await expect(previewLegacyImport(f.options)).rejects.toThrow("UTF-8");
    writeFileSync(f.sessionFile, Buffer.alloc(16 * 1024 * 1024 + 1)); await expect(previewLegacyImport(f.options)).rejects.toThrow("bounded regular");
  });
  test("writer failure removes only the newly staged thread and leaves source and registry intact", async () => {
    const f = setup(), before = readFileSync(f.sessionFile);
    await expect(importLegacyHistory({ ...f.options, writePassiveHistory: async () => { throw new Error("injected passive writer failure"); } })).rejects.toThrow("passive writer failure");
    expect(readFileSync(f.sessionFile)).toEqual(before); expect(f.store.list("mower", p)).toHaveLength(0); expect(f.store.list("profile", p)).toHaveLength(0); expect(readdirSync(join(f.options.runtimeDataDir, "threads"))).toEqual([]);
  });
  test("unknown prototype-named entry types remain inert and a reviewed digest binds the source", async () => {
    const f = setup(jsonl([header, ...["constructor", "toString", "__proto__"].map((type, index) => ({ type, id: `unknown-${index}`, parentId: null, timestamp, opaque: "preserved" }))]));
    const preview = await previewLegacyImport(f.options); expect(preview.unsupportedTypes).toEqual(["__proto__", "constructor", "toString"]);
    await expect(importLegacyHistory({ ...f.options, expectedSourceDigest: "0".repeat(64) })).rejects.toThrow("source digest changed"); expect(f.store.runs(p)).toHaveLength(0);
    const result = await importLegacyHistory({ ...f.options, expectedSourceDigest: preview.sourceDigest }); expect(result.entryCount).toBe(3);
  });
  test("special files and requested unsupported activation never become hidden work", async () => {
    const f = setup(), fifo = join(f.dir, "source-fifo"); const made = Bun.spawn(["mkfifo", fifo]); expect(await made.exited).toBe(0);
    await expect(previewLegacyImport({ ...f.options, sessionFile: fifo })).rejects.toThrow("bounded regular file");
    await expect(importLegacyHistory({ ...f.options, includeContext: true } as typeof f.options)).rejects.toThrow("unsupported import options");
    expect(f.store.runs(p)).toHaveLength(0); expect(f.store.list("mower", p)).toHaveLength(0);
  });
  test("control backup/restore preserves raw archive and inert passive checkpoint after source files disappear", async () => {
    const f = setup(); const report = await importLegacyHistory(f.options); const digest = report.sourceDigest; rmSync(f.sessionFile);
    const backup = join(f.dir, "backup"), target = join(f.dir, "restored"); await createControlBackup({ dataDir: f.data, destination: backup, confirmOffline: true }); await restoreControlBackup({ backupDir: backup, targetDir: target, confirmOffline: true });
    const restored = new ControlStore(join(target, "control.sqlite")); stores.push(restored); expect(listLegacyImports(restored, p)[0]!.sourceDigest).toBe(digest); expect(restored.runs(p)).toHaveLength(0); expect(restored.profile(report.profileId, 1, p).rules).toEqual([]);
    expect(validateCheckpoint(restored.checkpoint(report.threadId)!, report.threadId).files.some(file => Buffer.from(file.content, "base64").toString().includes("laun.legacy"))).toBe(true);
    expect(legacyImportArchive(restored, admin, report.id).archive.files[0]!.sha256).toBe(digest);
  });
});
