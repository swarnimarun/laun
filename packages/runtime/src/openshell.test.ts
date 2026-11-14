import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime, OpenShellExecution } from "./index.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fake(failCreate = false) {
  const dir = await mkdtemp(join(tmpdir(), "laun-v2-openshell-")); dirs.push(dir);
  const log = join(dir, "argv.jsonl"); const bin = join(dir, "openshell");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a)+"\\n");
if(a[1]==="get") process.exit(1);
if(a[1]==="create") process.exit(${failCreate ? 1 : 0});
if(a[1]==="exec") { if(a.at(-1).includes("LAUN_BOUNDARY_OK")) console.log("LAUN_BOUNDARY_OK"); else console.log("sandbox output"); }
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
    expect(commands[0]).toEqual(["sandbox", "get", "laun-v2-fern"]);
    expect(commands[1]).toEqual(["sandbox", "create", "--name", "laun-v2-fern", "--from", "fixture-image@sha256:fixed", "--policy", join(f.dir, "sandbox-policy.yaml"), "--approval-mode", "manual"]);
    expect(commands[2].at(-1)).toContain("filesystem denial probe");
    expect(commands[3]).toEqual(["sandbox", "exec", "-n", "laun-v2-fern", "--workdir", "/workspace", "--", "env", "-i", "HOME=/workspace", "PATH=/usr/local/bin:/usr/bin:/bin", "bash", "-c", "echo inside"]);
    expect(commands[4]).toEqual(["sandbox", "stop", "laun-v2-fern"]);
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
});
