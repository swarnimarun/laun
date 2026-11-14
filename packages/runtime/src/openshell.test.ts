import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime, OpenShellExecution } from "./index.js";
import { captureWorkspace } from "./workspace.js";
import { createHash } from "node:crypto";
import { DEFAULT_ISOLATED_POLICY } from "./isolated-policy.js";
import { resolveResourceLimits } from "./resources.js";
const policyDigest = createHash("sha256").update(DEFAULT_ISOLATED_POLICY).digest("hex");
const resourceDigest = resolveResourceLimits().sha256;
const policyLabel = BigInt(`0x${policyDigest}`).toString(36).padStart(50, "0"), resourceLabel = BigInt(`0x${resourceDigest}`).toString(36).padStart(50, "0");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fake(failCreate = false, failStop = false, behavior: { report?: unknown; proof?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "laun-v2-openshell-")); dirs.push(dir);
  const log = join(dir, "argv.jsonl"); const bin = join(dir, "openshell");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a)+"\\n");
if(a[0]==='gateway'&&a[1]==='info'){console.log(${JSON.stringify(JSON.stringify(behavior.report ?? { status: "healthy", compute_drivers: [{ capabilities: { resource_capabilities: { cpu: { limit_supported: true }, memory: { limit_supported: true } } } }] }))});process.exit(0);}
if(a[1]==="get") { if(existsSync(${JSON.stringify(join(dir, "server-exists"))})){const raw=readFileSync(${JSON.stringify(join(dir, "server-exists"))},'utf8');const record=JSON.parse(raw);if(!record.name||record.name===a[2]){console.log(raw);process.exit(0);}} console.error('sandbox not found');process.exit(1); }
if(a[1]==="create") { const labels={};for(let i=0;i<a.length;i++)if(a[i]==='--label'){const split=a[i+1].indexOf('=');labels[a[i+1].slice(0,split)]=a[i+1].slice(split+1);}if(${!failCreate})writeFileSync(${JSON.stringify(join(dir, "server-exists"))},JSON.stringify({name:a[a.indexOf('--name')+1],labels,resources:{cpu:a[a.indexOf('--cpu')+1],memory:a[a.indexOf('--memory')+1]}})); process.exit(${failCreate ? 1 : 0}); }
if(a[1]==="stop") process.exit(${failStop ? 1 : 0});
if(a[1]==="exec") {
 if(a.at(-1).startsWith("let raw=")) writeFileSync(${JSON.stringify(join(dir, "import.json"))},await Bun.stdin.text());
 else if(a.at(-1).includes("console.log(JSON.stringify(await"))console.log(existsSync(${JSON.stringify(join(dir, "guest.json"))})?readFileSync(${JSON.stringify(join(dir, "guest.json"))},'utf8'):JSON.stringify({version:1,files:[],omittedPaths:[]}));
 else if(a.at(-1).includes("LAUN_BOUNDARY_OK")) console.log(${JSON.stringify(behavior.proof ?? "LAUN_RESOURCE_OK 200000 100000 1073741824\nLAUN_BOUNDARY_OK")});
 else console.log("sandbox output");
}
`);
  await chmod(bin, 0o755);
  return { dir, log, bin };
}

describe("OpenShell-only tool execution seam", () => {
  test("explicit unsupported resources prevent guest creation and unbounded proofs stop before workload dispatch", async () => {
    const f = await fake(false, false, { report: { status: "healthy", compute_drivers: [{ capabilities: { resource_capabilities: { cpu: { limit_supported: false } } } }] } });
    const unsupported = new OpenShellExecution({ threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin });
    await expect(unsupported.prepare()).rejects.toThrow("Bounded isolated"); await unsupported.close();
    expect((await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([["gateway", "info", "-o", "json"]]);
    const g = await fake(false, false, { report: { status: "healthy", compute_drivers: [{ capabilities: { driver_name: "podman", driver_version: "0.1.8" } }] }, proof: "LAUN_RESOURCE_OK max 100000 max\nLAUN_BOUNDARY_OK" });
    const unbounded = new OpenShellExecution({ threadId: "fern", stateDir: g.dir, image: "fixture", bin: g.bin });
    await expect(unbounded.prepare()).rejects.toThrow("Bounded isolated");
    await expect(unbounded.execute("echo forbidden-bypass", 1000)).rejects.toThrow("Bounded isolated"); await unbounded.close();
    const commands = (await readFile(g.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(commands.filter(args => args[1] === "exec")).toHaveLength(2); expect(commands.some(args => args.at(-1) === "echo forbidden-bypass")).toBe(false); expect(commands.at(-1)?.[1]).toBe("stop");
  });
  test("retained resource identity and available requested limits are rechecked before restart", async () => {
    const f = await fake(), options = { threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin };
    const first = new OpenShellExecution(options); await first.prepare(); await first.close();
    const retained = JSON.parse(await readFile(join(f.dir, "server-exists"), "utf8")) as { labels: Record<string, string>; resources: { cpu: string } }; const original = JSON.stringify(retained);
    delete retained.labels["laun.resources-sha256"]; await writeFile(join(f.dir, "server-exists"), JSON.stringify(retained));
    const missing = new OpenShellExecution(options); await expect(missing.prepare()).rejects.toThrow("resource identity"); await missing.close();
    const changed = JSON.parse(original) as typeof retained; changed.resources.cpu = "3"; await writeFile(join(f.dir, "server-exists"), JSON.stringify(changed));
    const altered = new OpenShellExecution(options); await expect(altered.prepare()).rejects.toThrow("resource specification exceeds"); await altered.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]); expect(commands.filter(args => args[1] === "start")).toHaveLength(0);
  });
  test("custom network permissions are rejected before any sandbox lookup or execution", async () => {
    const f = await fake(); const policy = join(f.dir, "unsafe.yaml");
    await writeFile(policy, DEFAULT_ISOLATED_POLICY.replace("network_policies: {}", "network_policies: {bypass: {endpoints: [{host: example.com, port: 443, protocol: tcp}], binaries: [{path: /usr/bin/bash}]}}"));
    const execution = new OpenShellExecution({ threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin, policyFile: policy });
    await expect(execution.prepare()).rejects.toThrow("central MCP broker"); await execution.close();
    await expect(readFile(f.log)).rejects.toThrow();
  });
  test("retained guests with missing or changed policy identity never reopen implicitly", async () => {
    const f = await fake(), policy = join(f.dir, "operator.yaml"); await writeFile(policy, DEFAULT_ISOLATED_POLICY);
    const options = { threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin, policyFile: policy };
    const first = new OpenShellExecution(options); await first.prepare(); await first.close();
    const retained = JSON.parse(await readFile(join(f.dir, "server-exists"), "utf8")) as { labels: Record<string, string> };
    const original = JSON.stringify(retained); delete retained.labels["laun.policy-sha256"]; await writeFile(join(f.dir, "server-exists"), JSON.stringify(retained));
    const missing = new OpenShellExecution(options); await expect(missing.prepare()).rejects.toThrow("policy identity"); await missing.close();
    await writeFile(join(f.dir, "server-exists"), original); await writeFile(policy, `${DEFAULT_ISOLATED_POLICY}# reviewed different bytes\n`);
    const changed = new OpenShellExecution(options); await expect(changed.prepare()).rejects.toThrow("policy identity"); await changed.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(commands.filter(args => args[1] === "exec")).toHaveLength(1); expect(commands.filter(args => args[1] === "start")).toHaveLength(0);
  });
  test("creates hard-requirement, egress-denied sandbox and executes with an empty agent environment", async () => {
    const f = await fake();
    const execution = new OpenShellExecution({ threadId: "fern", stateDir: f.dir, image: "fixture-image@sha256:fixed", bin: f.bin });
    await execution.prepare();
    const result = await execution.execute("echo inside", 1000);
    expect(result.stdout).toBe("sandbox output\n");
    await execution.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands[0]).toEqual(["gateway", "info", "-o", "json"]);
    expect(commands[1]).toEqual(["sandbox", "get", "ln-f0a5da17e0ffa3a2", "-o", "json"]);
    expect(commands[2]).toEqual(["sandbox", "create", "--name", "ln-f0a5da17e0ffa3a2", "--from", "fixture-image@sha256:fixed", "--cpu", "2", "--memory", "1Gi", "--policy", join(f.dir, `sandbox-policy-${policyDigest}.yaml`), "--label", "laun.thread-id=fern", "--label", `laun.policy-sha256=${policyLabel}`, "--label", `laun.resources-sha256=${resourceLabel}`, "--approval-mode", "manual", "--detach", "--no-tty", "--no-auto-providers", "--", "sleep", "infinity"]);
    for (let index = 0; index < commands[2].length; index++) if (commands[2][index] === "--label") expect(commands[2][index + 1].split("=")[1]).toMatch(/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?$/);
    expect(commands[3].at(-1)).toContain("filesystem denial probe");
    expect(commands[4]).toEqual(["sandbox", "exec", "-n", "ln-f0a5da17e0ffa3a2", "--workdir", "/workspace", "--no-login-shell", "--no-tty", "--timeout", "1", "--", "env", "-i", "HOME=/workspace", "PATH=/usr/local/bin:/usr/bin:/bin", "BUN_INSTALL_CACHE_DIR=/tmp/.laun-bun-install", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/.laun-bun-transpile", "bash", "-c", "echo inside"]);
    expect(commands[5]).toEqual(["sandbox", "stop", "ln-f0a5da17e0ffa3a2"]);
    const policy = await readFile(join(f.dir, `sandbox-policy-${policyDigest}.yaml`), "utf8");
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

  test("a new placement epoch creates a fresh guest instead of reopening the host's stale workspace", async () => {
    const f = await fake(), work = join(f.dir, "work"); await mkdir(work); await writeFile(join(work, "current.txt"), "placement one");
    const options = { threadId: "fern", stateDir: f.dir, workspaceRoot: work, image: "fixture", bin: f.bin };
    const first = new OpenShellExecution({ ...options, placementId: "epoch-one" }); await first.prepare(); await first.close();
    await writeFile(join(work, "current.txt"), "newer server checkpoint");
    const returned = new OpenShellExecution({ ...options, placementId: "epoch-three" }); await returned.prepare(); await returned.close();
    const imported = JSON.parse(await readFile(join(f.dir, "import.json"), "utf8"));
    expect(Buffer.from(imported.files[0].content, "base64").toString()).toBe("newer server checkpoint");
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const creates = commands.filter((args) => args[1] === "create");
    expect(creates).toHaveLength(2); expect(creates[0]![creates[0]!.indexOf("--name") + 1]).not.toBe(creates[1]![creates[1]!.indexOf("--name") + 1]);
    expect(creates[1]).toContain("laun.placement-id=epoch-three"); expect(commands.some((args) => args[1] === "start")).toBe(false);
  }, 10_000);

  test("refuses a colliding sandbox identity and an interrupted initial workspace import", async () => {
    const f = await fake();
    const options = { threadId: "fern", stateDir: f.dir, image: "fixture", bin: f.bin };
    const first = new OpenShellExecution(options); await first.prepare(); await first.close();
    const preserved = await readFile(join(f.dir, "server-exists"), "utf8");
    await writeFile(join(f.dir, "server-exists"), JSON.stringify({ labels: { "laun.thread-id": "different-thread" } }));
    const collision = new OpenShellExecution(options); await expect(collision.prepare()).rejects.toThrow("identity mismatch"); await collision.close();
    await writeFile(join(f.dir, "server-exists"), preserved);
    await writeFile(join(f.dir, "sandbox-import-pending"), "interrupted");
    const partial = new OpenShellExecution(options); await expect(partial.prepare()).rejects.toThrow("import was interrupted"); await partial.close();
    const commands = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((args: string[]) => args[1] === "exec")).toHaveLength(1);
  }, 10_000);
});
