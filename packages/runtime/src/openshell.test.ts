import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime, OpenShellExecution } from "./index.js";
import { captureWorkspace } from "./workspace.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fake(failCreate = false, failStop = false) {
  const dir = await mkdtemp(join(tmpdir(), "laun-v2-openshell-")); dirs.push(dir);
  const log = join(dir, "argv.jsonl"); const bin = join(dir, "openshell");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a)+"\\n");
if(a[1]==="get") { if(existsSync(${JSON.stringify(join(dir, "server-exists"))})){console.log(readFileSync(${JSON.stringify(join(dir, "server-exists"))},'utf8'));process.exit(0);} console.error('sandbox not found');process.exit(1); }
if(a[1]==="create") { if(${!failCreate})writeFileSync(${JSON.stringify(join(dir, "server-exists"))},JSON.stringify({labels:{'laun.thread-id':a[a.indexOf('--label')+1].split('=')[1]}})); process.exit(${failCreate ? 1 : 0}); }
if(a[1]==="stop") process.exit(${failStop ? 1 : 0});
if(a[1]==="exec") {
 if(a.at(-1).startsWith("let raw=")) writeFileSync(${JSON.stringify(join(dir, "import.json"))},await Bun.stdin.text());
 else if(a.at(-1).includes("console.log(JSON.stringify(await"))console.log(existsSync(${JSON.stringify(join(dir, "guest.json"))})?readFileSync(${JSON.stringify(join(dir, "guest.json"))},'utf8'):JSON.stringify({version:1,files:[],omittedPaths:[]}));
 else if(a.at(-1).includes("LAUN_BOUNDARY_OK")) console.log("LAUN_BOUNDARY_OK");
 else console.log("sandbox output");
}
`);
  await chmod(bin, 0o755);
  return { dir, log, bin };
}

describe("OpenShell-only tool execution seam", () => {
  test("creates hard-requirement, egress-denied sandbox and executes with an empty agent environment", async () => {
    const f = await fake();
    const execution = new OpenShellExecution({ threadId: "fern", stateDir: f.dir, image: "fixture-image@sha256:fixed", bin: f.bin });
    await execution.prepare();
    const result = await execution.execute("echo inside", 1000);
    expect(result.stdout).toBe("sandbox output\n");
    await execution.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands[0]).toEqual(["sandbox", "get", "ln-f0a5da17e0ffa3a2", "-o", "json"]);
    expect(commands[1]).toEqual(["sandbox", "create", "--name", "ln-f0a5da17e0ffa3a2", "--from", "fixture-image@sha256:fixed", "--policy", join(f.dir, "sandbox-policy.yaml"), "--label", "laun.thread-id=fern", "--approval-mode", "manual", "--detach", "--no-tty", "--no-auto-providers", "--", "sleep", "infinity"]);
    expect(commands[2].at(-1)).toContain("filesystem denial probe");
    expect(commands[3]).toEqual(["sandbox", "exec", "-n", "ln-f0a5da17e0ffa3a2", "--workdir", "/workspace", "--no-login-shell", "--no-tty", "--timeout", "1", "--", "env", "-i", "HOME=/workspace", "PATH=/usr/local/bin:/usr/bin:/bin", "BUN_INSTALL_CACHE_DIR=/tmp/.laun-bun-install", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/.laun-bun-transpile", "bash", "-c", "echo inside"]);
    expect(commands[4]).toEqual(["sandbox", "stop", "ln-f0a5da17e0ffa3a2"]);
    const policy = await readFile(join(f.dir, "sandbox-policy.yaml"), "utf8");
    expect(policy).toContain("compatibility: hard_requirement");
    expect(policy).toContain("network_policies: {}");
  }, 10_000);

  test("a failed isolated setup never falls back to a trusted host tool", async () => {
    const f = await fake(true);
    const runtime = createPiRuntime({ openshellEnabled: true, trustedLocal: true, enableFaux: true,
      openshell: { image: "fixture", bin: f.bin } });
    const result = await runtime.run({ threadId: "fern", runId: "run", prompt: "hello", model: "faux/faux-1", workspaceRoot: join(f.dir, "work"), sessionDir: join(f.dir, "session") },
      { emit() {}, authorize: async () => {} });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("OpenShell create failed");
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.some((a) => a[1] === "exec")).toBe(false);
  }, 10_000);

  test("imports a fresh restored workspace once and atomically exports the authoritative guest before reopen", async () => {
    const f = await fake(), work = join(f.dir, "work"), guest = join(f.dir, "guest");
    await mkdir(work); await writeFile(join(work, "restored.txt"), "server checkpoint");
    const options = { threadId: "migrated", stateDir: f.dir, workspaceRoot: work, image: "fixture", bin: f.bin };
    const first = new OpenShellExecution(options); await first.prepare();
    expect(JSON.parse(await readFile(join(f.dir, "import.json"), "utf8")).files[0].path).toBe("restored.txt");
    await mkdir(guest); await writeFile(join(guest, "new-artifact.txt"), "guest is authoritative");
    await writeFile(join(f.dir, "guest.json"), JSON.stringify(await captureWorkspace(guest)));
    await first.checkpoint(); await first.close();
    expect(await readFile(join(work, "new-artifact.txt"), "utf8")).toBe("guest is authoritative");
    await expect(readFile(join(work, "restored.txt"))).rejects.toThrow();
    const reopened = new OpenShellExecution(options); await reopened.prepare(); await reopened.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((args: string[]) => args.at(-1)?.startsWith("let raw=")).length).toBe(1);
    expect(commands.some((args: string[]) => args.join(" ").includes("HOME=/nonexistent bun --cwd /usr --no-addons"))).toBe(true);
  }, 10_000);

  test("failed sandbox shutdown returns interrupted and cannot announce done", async () => {
    const f = await fake(false, true), events: string[] = [];
    const runtime = createPiRuntime({ openshellEnabled: true, enableFaux: true, openshell: { image: "fixture", bin: f.bin } });
    const result = await runtime.run({ threadId: "fern", runId: "run", prompt: "hello", model: "faux/faux-1", workspaceRoot: join(f.dir, "work"), sessionDir: join(f.dir, "session") },
      { emit(event) { events.push(event.type); }, authorize: async () => {} });
    expect(result.status).toBe("interrupted"); expect(result.summary).toContain("reconciliation"); expect(events).not.toContain("done");
  }, 10_000);

  test("refuses a colliding sandbox identity and an interrupted initial workspace import", async () => {
    const f = await fake();
    const options = { threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin };
    const first = new OpenShellExecution(options); await first.prepare(); await first.close();
    await writeFile(join(f.dir, "server-exists"), JSON.stringify({ labels: { "laun.thread-id": "different-thread" } }));
    const collision = new OpenShellExecution(options); await expect(collision.prepare()).rejects.toThrow("identity mismatch"); await collision.close();
    await writeFile(join(f.dir, "server-exists"), JSON.stringify({ labels: { "laun.thread-id": "fern" } }));
    await writeFile(join(f.dir, "sandbox-import-pending"), "interrupted");
    const partial = new OpenShellExecution(options); await expect(partial.prepare()).rejects.toThrow("import was interrupted"); await partial.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((args: string[]) => args[1] === "exec")).toHaveLength(1);
  }, 10_000);
});
