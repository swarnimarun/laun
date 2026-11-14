import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonValue } from "@earendil-works/chord/json";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, RuntimeCallbacks, RuntimeRunInput } from "@laun/protocol";
import { createPiRuntime, LocalExecution } from "./index.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(responses: FauxResponseStep[]) {
  const directory = await mkdtemp(join(tmpdir(), "laun-durable-runtime-")); directories.push(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  const events: AgentEvent[] = [];
  const input: RuntimeRunInput = { threadId: "thread", runId: "run1", prompt: "Make progress", model: "faux/faux-1", workspaceRoot: join(directory, "work"), sessionDir: join(directory, "session") };
  const callbacks: RuntimeCallbacks = { emit: (event) => { events.push(event); }, authorize: async () => {} };
  const runtime = createPiRuntime({ models, trustedLocal: true });
  return { directory, models, faux, events, input, callbacks, runtime };
}
const call = (name: string, args: Record<string, JsonValue>, id = "call1") => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

describe("real Pi Durable runtime adapter", () => {
  test("mediates file tools before effects and streams the actual committed answer", async () => {
    const f = await fixture([
      call("write_file", { path: "nested/result.txt", content: "mowed" }),
      call("read_file", { path: "nested/result.txt" }, "call2"),
      fauxAssistantMessage("Saved and read mowed."),
    ]);
    const requests: string[] = [];
    f.callbacks.authorize = async (request) => {
      requests.push(request.operation);
      expect(request.resource).toBe("workspace:own");
      if (request.operation === "workspace.write") expect(existsSync(join(f.input.workspaceRoot, "nested/result.txt"))).toBe(false);
    };
    const result = await f.runtime.run(f.input, f.callbacks);
    expect(result).toEqual({ status: "done", summary: "Saved and read mowed." });
    expect(requests).toEqual(["workspace.write", "workspace.read"]);
    expect(await readFile(join(f.input.workspaceRoot, "nested/result.txt"), "utf8")).toBe("mowed");
    expect(f.events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("Saved and read mowed.");
    expect(f.events.some((e) => e.type === "usage")).toBe(true);
    await f.runtime.close();
  }, 15_000);

  test("permission denial reaches the model without writing the file", async () => {
    const f = await fixture([call("write_file", { path: "denied.txt", content: "must not write" }), fauxAssistantMessage("The write was denied; no file was changed.")]);
    f.callbacks.authorize = async () => { throw new Error("permission denied"); };
    const result = await f.runtime.run(f.input, f.callbacks);
    expect(result.status).toBe("done");
    expect(existsSync(join(f.input.workspaceRoot, "denied.txt"))).toBe(false);
    expect(f.events.some((e) => e.type === "tool_result" && !e.ok && e.output === "permission denied")).toBe(true);
  }, 15_000);

  test("reopen deduplicates a completed request and rejects a changed request fingerprint", async () => {
    const f = await fixture([call("write_file", { path: "once.txt", content: "once" }), fauxAssistantMessage("Done once.")]);
    const first = await f.runtime.run(f.input, f.callbacks);
    expect(first.status).toBe("done");
    const count = f.faux.state.callCount;
    const secondRuntime = createPiRuntime({ models: f.models, trustedLocal: true });
    let reauthorized = false;
    const second = await secondRuntime.run(f.input, { ...f.callbacks, authorize: async () => { reauthorized = true; } });
    expect(second).toEqual(first);
    expect(f.faux.state.callCount).toBe(count);
    expect(reauthorized).toBe(false);
    const changed = await secondRuntime.run({ ...f.input, prompt: "different" }, f.callbacks);
    expect(changed.status).toBe("error");
    expect(changed.summary).toContain("different request");
  }, 15_000);

  test("cancellation aborts a parked permission callback without executing the tool", async () => {
    const f = await fixture([call("write_file", { path: "cancelled.txt", content: "no" })]);
    let entered!: () => void; const waiting = new Promise<void>((r) => { entered = r; });
    f.callbacks.authorize = (request) => new Promise((_, reject) => {
      entered();
      request.signal?.addEventListener("abort", () => reject(new Error("cancelled approval")), { once: true });
    });
    const result = f.runtime.run(f.input, f.callbacks);
    await waiting;
    await f.runtime.cancel(f.input.threadId);
    expect((await result).status).toBe("cancelled");
    expect(existsSync(join(f.input.workspaceRoot, "cancelled.txt"))).toBe(false);
  }, 15_000);

  test("broker calls use stable run and upstream call IDs without a second runtime approval", async () => {
    const f = await fixture([call("mower_spawn", { goal: "Investigate", name: "Fern" }, "spawn1"), fauxAssistantMessage("Delegated.")]);
    const invoked: unknown[] = [];
    f.callbacks.authorize = async () => { throw new Error("must be authorized by control broker"); };
    f.callbacks.invokeTool = async (name, args, signal) => { invoked.push({ name, args, signal: !!signal }); return { taskId: "task1" }; };
    expect((await f.runtime.run(f.input, f.callbacks)).status).toBe("done");
    expect(invoked).toEqual([{ name: "mower_spawn", args: { goal: "Investigate", name: "Fern", requestId: "run1:spawn1" }, signal: true }]);
  }, 15_000);

  test("unconfigured execution and unknown models fail without a fabricated response", async () => {
    const f = await fixture([fauxAssistantMessage("Should not run")]);
    const unconfigured = createPiRuntime({ models: f.models });
    expect((await unconfigured.run(f.input, f.callbacks)).summary).toContain("unconfigured");
    const unknown = await f.runtime.run({ ...f.input, runId: "run2", model: "absent/absent" }, f.callbacks);
    expect(unknown.status).toBe("error");
    expect(unknown.summary).toContain("unavailable");
    expect(f.faux.state.callCount).toBe(0);
  }, 15_000);

  test("model inventory returns neutral configured metadata with defensive copies", async () => {
    const f = await fixture([]);
    const first = await f.runtime.listModels!();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "faux/faux-1", provider: "faux", configured: true });
    first[0]!.name = "tampered";
    expect((await f.runtime.listModels!())[0]!.name).not.toBe("tampered");
    expect(Object.keys(first[0]!).sort()).toEqual(["configured", "id", "name", "provider"]);
  });

  test("SIGKILL during a parked unsafe tool recovers without replaying its side effect", async () => {
    const f = await fixture([fauxAssistantMessage("Recovered without replaying the interrupted write.")]);
    const marker = join(f.directory, "parked");
    const script = `
      import { createModels } from '@earendil-works/pi-ai/models';
      import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
      import { writeFile } from 'node:fs/promises';
      import { createPiRuntime } from './src/index.ts';
      const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(fauxToolCall('write_file', {path:'never-replay.txt',content:'unsafe'}, {id:'write-once'}), {stopReason:'toolUse'})]);
      const runtime = createPiRuntime({models,trustedLocal:true});
      await runtime.run(${JSON.stringify(f.input)}, {emit(){},authorize:async()=>{await writeFile(${JSON.stringify(marker)},'parked'); await new Promise(()=>{});}});
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    try {
      const end = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < end) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      child.kill("SIGKILL"); await child.exited;
      let replayed = false;
      f.callbacks.authorize = async () => { replayed = true; };
      const recovered = await f.runtime.run(f.input, f.callbacks);
      expect(recovered.status).toBe("done");
      expect(recovered.summary).toContain("Recovered without replaying");
      expect(replayed).toBe(false);
      expect(existsSync(join(f.input.workspaceRoot, "never-replay.txt"))).toBe(false);
    } finally {
      child.kill("SIGKILL"); await child.exited;
      await new Response(child.stdout).text(); await new Response(child.stderr).text();
    }
  }, 15_000);
});

describe("trusted-local mediated file boundary", () => {
  test("rejects traversal and symlinks for reads and writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "laun-local-boundary-")); directories.push(directory);
    const root = join(directory, "workspace"); await mkdir(root);
    const outside = join(directory, "outside.txt"); await writeFile(outside, "private");
    await symlink(outside, join(root, "linked.txt"));
    const execution = new LocalExecution(root);
    await expect(execution.readFile("../outside.txt")).rejects.toThrow("escapes");
    await expect(execution.readFile("linked.txt")).rejects.toThrow("escapes");
    await expect(execution.writeFile("linked.txt", "changed")).rejects.toThrow("escapes");
    expect(await readFile(outside, "utf8")).toBe("private");
  });

  test("shell receives platform environment but no provider or control secrets", async () => {
    const f = await fixture([call("run_command", { command: "printf '%s' \"${LAUN_TEST_CONTROLLER_SECRET-unset}:${OPENAI_API_KEY-unset}\"" }), fauxAssistantMessage("Checked.")]);
    const previous = { controller: process.env.LAUN_TEST_CONTROLLER_SECRET, model: process.env.OPENAI_API_KEY };
    process.env.LAUN_TEST_CONTROLLER_SECRET = "secret-controller"; process.env.OPENAI_API_KEY = "secret-model";
    try {
      expect((await f.runtime.run(f.input, f.callbacks)).status).toBe("done");
      const event = f.events.find((e) => e.type === "tool_result");
      expect(event && event.type === "tool_result" && event.output).toContain("unset:unset");
    } finally {
      if (previous.controller === undefined) delete process.env.LAUN_TEST_CONTROLLER_SECRET; else process.env.LAUN_TEST_CONTROLLER_SECRET = previous.controller;
      if (previous.model === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.model;
    }
  }, 15_000);
});
