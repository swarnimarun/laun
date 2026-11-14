import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createThreadCleaner } from "./cleanup.js";
import { managedSandboxName } from "./sandbox-identity.js";
import { lockThread } from "./lock.js";
import { createPiRuntime } from "./index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "laun-cleanup-fixture-")); roots.push(base);
  const root = join(base, "state"); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "threads"), { mode: 0o700 });
  return { base, root };
}
function tree(root: string, name: string) {
  const path = join(root, "threads", name); mkdirSync(join(path, "session"), { recursive: true, mode: 0o700 }); mkdirSync(join(path, "work"), { mode: 0o700 });
  writeFileSync(join(path, "work", "evidence.txt"), "dedicated fixture only"); return path;
}
const request = (extra: object = {}) => ({ threadId: "fern", placementIds: [] as string[], confirmedStopped: true as const, ...extra });
function guest(placementId?: string, extra: object = {}) {
  return { name: managedSandboxName("fern", placementId), labels: { "laun.thread-id": "fern", ...(placementId ? { "laun.placement-id": placementId } : {}),
    "laun.policy-sha256": "0".repeat(49) + "1", "laun.resources-sha256": "0".repeat(49) + "2" }, phase: "Ready", workspace: "default", ...extra };
}
function fake(base: string, guests: unknown[], mode = "") {
  const file = join(base, "guests.json"), log = join(base, "calls.jsonl"), bin = join(base, "openshell"); writeFileSync(file, JSON.stringify(guests));
  writeFileSync(bin, `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
const a=process.argv.slice(2),file=${JSON.stringify(file)},mode=${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
let guests=JSON.parse(readFileSync(file,'utf8'));const save=()=>writeFileSync(file,JSON.stringify(guests));
if(a[0]!=='sandbox')process.exit(71);
if(a[1]==='list'){
 if(mode==='list-auth'){console.error('PermissionDenied: sandbox not found');process.exit(1);}
 if(mode==='list-malformed'){console.log('{}');process.exit(0);}
 let items=guests;
 if(a.includes('--selector'))items=items.filter(g=>g.labels?.['laun.thread-id']==='fern');
 if(mode==='hidden'||mode==='nested-notfound')items=[];
 if(mode==='pages'&&items.length){const token=a.includes('--page-token');console.log(JSON.stringify({sandboxes:token?items.slice(1):items.slice(0,1),next_page_token:token?'':'page2'}));}
 else console.log(JSON.stringify({sandboxes:items,next_page_token:''}));process.exit(0);
}
const index=guests.findIndex(g=>g.name===a[2]);
if(a[1]==='get'){
 if(index>=0&&guests[index].phase==='Deleting'){
  if(mode==='delete-get-slow')await Bun.sleep(2000);
  if(mode==='delete-get-auth'){console.error('PermissionDenied');process.exit(1);}
  if(mode==='delete-get-malformed'){console.log('{}');process.exit(0);}
  if(['delete-delayed','delete-index-delayed'].includes(mode)){guests[index].polls=(guests[index].polls||0)+1;if(guests[index].polls>=3){guests.splice(index,1);save();console.error(${JSON.stringify("Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"")});process.exit(1);}save();}
  if(['delete-index-delayed','delete-index-collision'].includes(mode)){console.error(${JSON.stringify("Error:   × code: 'Some requested entity was not found', message: \"sandbox config not found\"")});process.exit(1);}
 }
 if(mode==='get-auth'){console.error('Unauthenticated: sandbox not found');process.exit(1);}
 if(mode==='nested-notfound'){console.error('Error:   × status: Unknown, message: "driver failed: code: NotFound"');process.exit(1);}
 if(mode==='nested-human-notfound'){console.error(${JSON.stringify("Error:   × code: 'Unknown error', message: \"driver failed: code: 'Some requested entity was not found'\"")});process.exit(1);}
 if(index<0){console.error(${JSON.stringify("Error:   × code: 'Some requested entity was not found', message: \"sandbox missing\"")});process.exit(1);}
 if(mode==='reorder-labels'&&readFileSync(${JSON.stringify(log)},'utf8').split('\\n').length%2)guests[index].labels=Object.fromEntries(Object.entries(guests[index].labels).reverse());
 console.log(JSON.stringify(guests[index]));process.exit(0);
}
if(a[1]==='stop'){
 if(mode==='stop-fail'){console.error('transport unavailable');process.exit(1);}
 if(mode==='slow-stop')await Bun.sleep(2000);
 if(index>=0){guests[index].phase=mode==='stop-pending'?'Stopping':'Stopped';
  if(mode==='mutate-stop')guests[index].labels['laun.thread-id']='another';save();}
 process.exit(0);
}
if(a[1]==='delete'){
 if(mode==='delete-auth'){console.error('PermissionDenied');process.exit(1);}
 if(['delete-delayed','delete-index-delayed','delete-get-auth','delete-get-malformed','delete-collision','delete-index-collision','delete-get-slow'].includes(mode)){guests[index].phase='Deleting';if(['delete-collision','delete-index-collision'].includes(mode))guests[index].labels['laun.thread-id']='other';save();process.exit(0);}
 if(mode!=='delete-pending'){guests=guests.filter(g=>g.name!==a[2]);save();}process.exit(0);
}
console.error('forbidden command');process.exit(72);
`); chmodSync(bin, 0o700);
  return { bin, file, commands: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [] };
}

describe("explicit managed runtime cleanup", () => {
  test("removes only exact private thread and bounded UUID recovery copies, with idempotent retry", async () => {
    const f = fixture(); const current = tree(f.root, "fern"), recovery = tree(f.root, `fern.recovery-${randomUUID()}`), restore = tree(f.root, `fern.restore-${randomUUID()}`), other = tree(f.root, "fern-other");
    mkdirSync(join(current, "runtime-recovery")); writeFileSync(join(current, "runtime-recovery", "preserved-cache"), "divergent fixture");
    const cleaner = createThreadCleaner({ cleanupRoot: f.root });
    expect(await cleaner.cleanup(request())).toEqual({ verified: true, removedPaths: 3, removedSandboxes: 0, outstanding: [] });
    for (const path of [current, recovery, restore]) expect(existsSync(path)).toBe(false); expect(existsSync(other)).toBe(true);
    expect(await cleaner.cleanup(request())).toEqual({ verified: true, removedPaths: 0, removedSandboxes: 0, outstanding: [] });
  });

  test("unknown copies, nested symlinks and live legacy writers preserve every local copy", async () => {
    for (const kind of ["unknown", "link", "writer"]) {
      const f = fixture(), current = tree(f.root, "fern"); const external = join(f.base, "external"); writeFileSync(external, "preserved"); let release: (() => void) | undefined;
      if (kind === "unknown") tree(f.root, "fern.recovery-malformed");
      if (kind === "link") symlinkSync(external, join(current, "work", "link"));
      if (kind === "writer") release = lockThread(join(current, "session"));
      const result = await createThreadCleaner({ cleanupRoot: f.root }).cleanup(request());
      expect(result.verified).toBe(false); expect(result.outstanding.length).toBeGreaterThan(0); expect(result.removedPaths).toBe(0); expect(existsSync(current)).toBe(true); expect(readFileSync(external, "utf8")).toBe("preserved"); release?.();
    }
  });

  test("rejects symlink ancestors, writable or replaced roots, and does not follow thread-root links", async () => {
    const f = fixture(), current = tree(f.root, "fern"), link = join(f.base, "alias"); symlinkSync(f.root, link);
    expect((await createThreadCleaner({ cleanupRoot: link }).cleanup(request())).verified).toBe(false);
    chmodSync(f.root, 0o750); expect((await createThreadCleaner({ cleanupRoot: f.root }).cleanup(request())).verified).toBe(false); chmodSync(f.root, 0o700);
    const cleaner = createThreadCleaner({ cleanupRoot: f.root }); const release = cleaner.acquire("some-other-thread"); release();
    renameSync(f.root, join(f.base, "old")); mkdirSync(f.root, { mode: 0o700 });
    expect((await cleaner.cleanup(request())).verified).toBe(false); expect(existsSync(join(f.base, "old", "threads", "fern"))).toBe(true);
    const g = fixture(), destination = join(g.base, "preserve"); mkdirSync(destination, { mode: 0o700 }); writeFileSync(join(destination, "keep"), "yes"); symlinkSync(destination, join(g.root, "threads", "fern"));
    expect((await createThreadCleaner({ cleanupRoot: g.root }).cleanup(request())).verified).toBe(false); expect(readFileSync(join(destination, "keep"), "utf8")).toBe("yes");
  });

  test("shared runtime guard blocks another cleaner and run until released", async () => {
    const f = fixture(), current = tree(f.root, "fern"), a = createThreadCleaner({ cleanupRoot: f.root }), b = createThreadCleaner({ cleanupRoot: f.root });
    const release = a.acquire("fern"); const blocked = await b.cleanup(request()); expect(blocked.verified).toBe(false); expect(blocked.removedPaths).toBe(0); expect(existsSync(current)).toBe(true);
    const runtime = createPiRuntime({ cleanupRoot: f.root, trustedLocal: true, enableFaux: true });
    const result = await runtime.run({ threadId: "fern", runId: "r", prompt: "hello", model: "faux/faux-1", sessionDir: join(current, "session"), workspaceRoot: join(current, "work") }, { emit() {}, authorize: async () => {} });
    expect(result.status).toBe("error"); expect(result.summary).toContain("writer"); release();
    expect((await b.cleanup(request())).verified).toBe(true);
  });

  test("unconfigured and custom execution runtimes fail closed; pre-aborted requests do not mutate", async () => {
    const f = fixture(), current = tree(f.root, "fern"); const controller = new AbortController(); controller.abort();
    expect((await createThreadCleaner({ cleanupRoot: f.root }).cleanup(request({ signal: controller.signal }))).verified).toBe(false); expect(existsSync(current)).toBe(true);
    expect((await createPiRuntime().cleanupThread!(request())).verified).toBe(false);
    expect((await createThreadCleaner({ cleanupRoot: f.root, unsupportedExecution: true }).cleanup(request())).verified).toBe(false); expect(existsSync(current)).toBe(true);
    const runtime = createPiRuntime({ cleanupRoot: f.root, trustedLocal: true, enableFaux: true });
    const result = await runtime.run({ threadId: "fern", runId: "elsewhere", prompt: "hello", model: "faux/faux-1", sessionDir: join(f.base, "outside-session"), workspaceRoot: join(current, "work") }, { emit() {}, authorize: async () => {} });
    expect(result.status).toBe("error"); expect(result.summary).toContain("namespace"); expect(existsSync(join(f.base, "outside-session"))).toBe(false);
    const elsewhere = join(f.base, "unmanaged", "target"); mkdirSync(elsewhere, { recursive: true }); symlinkSync(elsewhere, join(current, "escape"));
    const disguised = await runtime.run({ threadId: "fern", runId: "disguised", prompt: "hello", model: "faux/faux-1", sessionDir: `${current}/escape/../session`, workspaceRoot: join(current, "work") }, { emit() {}, authorize: async () => {} });
    expect(disguised.status).toBe("error"); expect(disguised.summary).toContain("namespace"); expect(existsSync(join(f.base, "unmanaged", "session"))).toBe(false);
  });

  test("factory rejects cleanup while the same thread is active and rejects a run during cleanup", async () => {
    const f = fixture(), current = tree(f.root, "fern"); let ready!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => finish = resolve);
    const runtime = createPiRuntime({ cleanupRoot: f.root, execution: async () => { ready(); await held; throw new Error("fixture finished"); } });
    const input = { threadId: "fern", runId: "r", prompt: "hello", model: "faux/faux-1", sessionDir: join(current, "session"), workspaceRoot: join(current, "work") };
    const running = runtime.run(input, { emit() {}, authorize: async () => {} }); await entered;
    expect((await runtime.cleanupThread!(request())).outstanding).toContain("Thread has active runtime work or cleanup"); expect(existsSync(current)).toBe(true); finish(); await running;
    const cli = fake(f.base, [guest()], "slow-stop"), controller = new AbortController();
    const other = createPiRuntime({ cleanupRoot: f.root, openshellEnabled: true, openshell: { image: "fixture", bin: cli.bin } });
    const cleaning = other.cleanupThread!(request({ signal: controller.signal }));
    await expect(other.run(input, { emit() {}, authorize: async () => {} })).rejects.toThrow("cleanup"); controller.abort(); expect((await cleaning).verified).toBe(false);
  });

  test("enumerates every verified epoch with pagination and deletes after authoritative stop/not-found only", async () => {
    const f = fixture(), current = tree(f.root, "fern"), one = randomUUID(), old = randomUUID(); const cli = fake(f.base, [guest(), guest(one), guest(old)], "pages");
    const result = await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request({ placementIds: [one] }));
    expect(result).toEqual({ verified: true, removedPaths: 1, removedSandboxes: 3, outstanding: [] }); expect(existsSync(current)).toBe(false);
    const calls = cli.commands(); expect(calls.some(a => a.includes("--page-token"))).toBe(true); expect(calls.filter(a => a[1] === "delete")).toHaveLength(3); expect(calls.filter(a => a[1] === "list").every(a => a.includes("--all-workspaces"))).toBe(true);
    expect(calls.some(a => ["create", "start", "exec"].includes(a[1]!))).toBe(false);
    expect((await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request({ placementIds: [one] }))).verified).toBe(true);
  }, 20_000);

  test("missing, malformed or changed managed guest identities preserve guests and host evidence", async () => {
    const bad = [guest(undefined, { name: "unmanaged" }), guest(undefined, { labels: { "laun.thread-id": "another" } }), guest("malformed-epoch"), guest(undefined, { labels: { "laun.thread-id": "fern" } }), guest(undefined, { workspace: "historical" })];
    for (const value of bad) {
      const f = fixture(), current = tree(f.root, "fern"), cli = fake(f.base, [value]);
      const result = await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request());
      expect(result.verified).toBe(false); expect(existsSync(current)).toBe(true); expect(cli.commands().some(a => ["stop", "delete"].includes(a[1]!))).toBe(false);
    }
    const f = fixture(), current = tree(f.root, "fern"), cli = fake(f.base, [guest(undefined, { labels: { "laun.thread-id": "another" } })], "hidden");
    expect((await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request())).verified).toBe(false); expect(existsSync(current)).toBe(true); expect(cli.commands().some(a => a[1] === "delete")).toBe(false);
  }, 20_000);

  test("unrelated guests are never stopped, deleted, or counted as thread copies", async () => {
    const f = fixture(), other = { ...guest(), name: managedSandboxName("other"), labels: { ...guest().labels, "laun.thread-id": "other" } }, cli = fake(f.base, [guest(), other]); tree(f.root, "fern");
    const result = await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request());
    expect(result).toEqual({ verified: true, removedPaths: 1, removedSandboxes: 1, outstanding: [] });
    expect(JSON.parse(readFileSync(cli.file, "utf8"))).toEqual([other]); expect(cli.commands().filter(a => ["stop", "delete"].includes(a[1]!)).every(a => a[2] === managedSandboxName("fern"))).toBe(true);
  });

  test("equivalent label map ordering across CLI processes does not alter managed identity", async () => {
    const f = fixture(), cli = fake(f.base, [guest()], "reorder-labels"); tree(f.root, "fern");
    expect(await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request())).toEqual({ verified: true, removedPaths: 1, removedSandboxes: 1, outstanding: [] });
  });

  test("accepted asynchronous deletion polls only reads until strict lookup and enumeration confirm absence", async () => {
    for (const mode of ["delete-delayed", "delete-index-delayed"]) {
    const f = fixture(), cli = fake(f.base, [guest()], mode); tree(f.root, "fern");
    expect(await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request())).toEqual({ verified: true, removedPaths: 1, removedSandboxes: 1, outstanding: [] });
    const calls = cli.commands(), at = calls.findIndex(args => args[1] === "delete");
    expect(calls.filter(args => args[1] === "delete")).toHaveLength(1); expect(calls.slice(at + 1).every(args => ["get", "list"].includes(args[1]!))).toBe(true); expect(calls.slice(at + 1).filter(args => args[1] === "get").length).toBeGreaterThanOrEqual(3);
    }
  });
  test("auth, malformed state and identity collisions after accepted delete never claim completion or retry deletion", async () => {
    for (const mode of ["delete-get-auth", "delete-get-malformed", "delete-collision", "delete-index-collision"]) {
      const f = fixture(), cli = fake(f.base, [guest()], mode), current = tree(f.root, "fern");
      const result = await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request());
      expect(result.verified).toBe(false); expect(result.removedSandboxes).toBe(0); expect(existsSync(current)).toBe(true); expect(cli.commands().filter(args => args[1] === "delete")).toHaveLength(1);
    }
  });
  test("lease cancellation during post-delete verification stops reads and never starts local deletion", async () => {
    const f = fixture(), cli = fake(f.base, [guest()], "delete-get-slow"), current = tree(f.root, "fern"), controller = new AbortController();
    const pending = createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request({ signal: controller.signal }));
    const deadline = Date.now() + 5000;
    for (;;) {
      const calls = cli.commands(), index = calls.findIndex(args => args[1] === "delete");
      if (index >= 0 && calls.slice(index + 1).some(args => args[1] === "get")) break;
      if (Date.now() >= deadline) { controller.abort(); await pending; throw new Error("fixture never reached post-delete read"); }
      await Bun.sleep(10);
    }
    controller.abort(); const result = await pending; expect(result.verified).toBe(false); expect(result.removedSandboxes).toBe(0); expect(existsSync(current)).toBe(true); expect(cli.commands().filter(args => args[1] === "delete")).toHaveLength(1);
  });

  test("transport/auth failures, pending stop/deletion, and post-stop identity changes never claim success", async () => {
    for (const mode of ["list-auth", "list-malformed", "get-auth", "nested-notfound", "nested-human-notfound", "stop-fail", "stop-pending", "mutate-stop", "delete-auth", "delete-pending"]) {
      const f = fixture(), current = tree(f.root, "fern"), cli = fake(f.base, [guest()], mode);
      const result = await createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request());
      expect(result.verified).toBe(false); expect(existsSync(current)).toBe(true); expect(result.outstanding.length).toBeGreaterThan(0);
      expect(cli.commands().length).toBeGreaterThan(0);
      if (!["delete-auth", "delete-pending"].includes(mode)) expect(cli.commands().some(a => a[1] === "delete")).toBe(false);
    }
  }, 30_000);

  test("cancellation while stopping a guest prevents every subsequent delete and local removal", async () => {
    const f = fixture(), current = tree(f.root, "fern"), cli = fake(f.base, [guest()], "slow-stop"), controller = new AbortController();
    const running = createThreadCleaner({ cleanupRoot: f.root, openshell: cli }).cleanup(request({ signal: controller.signal }));
    const end = Date.now() + 5000; while (!cli.commands().some(a => a[1] === "stop") && Date.now() < end) await Bun.sleep(10);
    const observedStop = cli.commands().some(a => a[1] === "stop"); controller.abort(); const result = await running; expect(observedStop).toBe(true); expect(result.verified).toBe(false); expect(existsSync(current)).toBe(true); expect(cli.commands().some(a => a[1] === "delete")).toBe(false);
  }, 10_000);
});
