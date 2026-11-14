/** Explicit live qualification; never run by bun test or a production server. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AgentEvent, RuntimeCallbacks, RuntimeRunInput } from "@laun/protocol";
import { captureCheckpoint, checkpointReference, restoreCheckpoint } from "../../storage/src/index.js";
import { createPiRuntime, OpenShellExecution } from "../src/index.js";
import { executeProcess } from "../src/execution.js";

if (process.env.OPENSHELL_ENABLED !== "true" || !process.env.OPENSHELL_SANDBOX_IMAGE?.trim()) {
  throw new Error("Explicit live test requires OPENSHELL_ENABLED=true and OPENSHELL_SANDBOX_IMAGE; provision the OpenShell gateway separately");
}
const image = process.env.OPENSHELL_SANDBOX_IMAGE, bin = process.env.OPENSHELL_BIN || "openshell";
const threadId = `qual-${Date.now()}-${randomUUID().slice(0, 8)}`;
const name = `ln-${createHash("sha256").update(threadId).digest("hex").slice(0, 16)}`;
const root = await mkdtemp(join(tmpdir(), "laun-live-"));
const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
const call = (name: string, args: Record<string, JsonValue>, id: string) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
faux.setResponses([
  call("read_file", { path: "restored.txt" }, "read"),
  call("write_file", { path: "artifact.txt", content: "durable guest artifact" }, "write"),
  call("run_command", { command: `pi --version && test -z "$LAUN_LIVE_SECRET" && if (printf denied > /var/tmp/${threadId}) 2>/tmp/${threadId}.denied; then exit 9; else grep -qi 'permission denied' /tmp/${threadId}.denied && printf LAUN_DENIED; fi` }, "process"),
  fauxAssistantMessage("REAL_ISOLATED_HARNESS_OK"),
]);
process.env.LAUN_LIVE_SECRET = "qualification-must-not-inherit";
const openshell = { image, bin };
const options = { models, openshellEnabled: true, openshell, timeoutMs: 60_000, maxTurns: 6 };
const runtime = createPiRuntime(options);
const input: RuntimeRunInput = { threadId, runId: "qual-run", prompt: "Qualify the isolated backend using its scripted provider.", model: "faux/faux-1", sessionDir: join(root, "session"), workspaceRoot: join(root, "work") };
await mkdir(input.workspaceRoot); await writeFile(join(input.workspaceRoot, "restored.txt"), "server checkpoint source");
// Force transfer beyond the upstream exec stdin4MiB cap in both directions.
const large = Buffer.alloc(6 * 1024 * 1024, 0xa5);
await writeFile(join(input.workspaceRoot, "large-artifact.bin"), large);
const events: AgentEvent[] = [], permissions: string[] = [];
const callbacks: RuntimeCallbacks = { emit(event) { events.push(event); }, authorize: async (request) => { permissions.push(request.operation); } };
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
console.log(`Live qualification state: ${root}`);

async function deleteOwnedSandbox(): Promise<void> {
  const get = await executeProcess([bin, "sandbox", "get", name, "-o", "json"], { timeoutMs: 30_000 });
  if (get.exitCode !== 0) {
    if (/not found|does not exist|NotFound/i.test(get.stderr)) return;
    throw new Error(`cannot verify test-owned sandbox cleanup: ${get.stderr.slice(-500)}`);
  }
  assert(JSON.parse(get.stdout).labels?.["laun.thread-id"] === threadId, "refusing to delete a sandbox without this test's full thread label");
  const removed = await executeProcess([bin, "sandbox", "delete", name], { timeoutMs: 60_000 });
  assert(removed.exitCode === 0, "test-owned sandbox cleanup failed; inspect the printed local state directory");
}

let recoveredAt: string | undefined;
try {
  const result = await runtime.run(input, callbacks);
  assert(result.status === "done" && result.summary === "REAL_ISOLATED_HARNESS_OK", `live harness failed: ${result.summary}`);
  assert(events.some((e) => e.type === "tool_result" && e.ok && e.name === "read_file" && e.output?.includes("server checkpoint source")), "server workspace was not imported before the first file tool");
  assert(events.some((e) => e.type === "tool_result" && e.ok && e.output?.includes("LAUN_DENIED") && e.output.includes("1.5.2")), "real OS denial or Pi version verification failed");
  assert(await readFile(join(input.workspaceRoot, "artifact.txt"), "utf8") === "durable guest artifact", "guest artifact was not exported");
  assert((await readFile(join(input.workspaceRoot, "large-artifact.bin"))).equals(large), "large guest artifact export was corrupted");
  const calls = faux.state.callCount;
  assert((await runtime.run(input, callbacks)).status === "done" && faux.state.callCount === calls, "reopen replayed the completed model request");

  const backend = new OpenShellExecution({ ...openshell, threadId, stateDir: input.sessionDir, workspaceRoot: input.workspaceRoot });
  try {
    await backend.prepare(); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try { await backend.execute("touch before-cancel; sleep 5; touch after-cancel", 15_000, controller.signal); throw new Error("command ignored cancellation"); }
    catch (error) { assert(controller.signal.aborted && String(error).includes("cancel"), `unexpected cancellation result: ${String(error)}`); }
    finally { clearTimeout(timer); }
    await Bun.sleep(6000);
    assert(!(await backend.listFiles(".")).includes("after-cancel"), "remote command continued after cancellation");
    await backend.checkpoint();
  } finally { await backend.close(); }

  const archive = await captureCheckpoint(threadId, root), reference = checkpointReference(archive, threadId);
  recoveredAt = join(await mkdtemp(join(tmpdir(), "laun-live-restored-")), "thread");
  await restoreCheckpoint(archive, threadId, recoveredAt, reference.sha256);
  // Delete only our labelled test guest, after verifying its server archive.
  // This forces the recovered runtime to import into a genuinely new guest.
  await deleteOwnedSandbox();
  const restored = createPiRuntime(options);
  try {
    const result = await restored.run({ ...input, sessionDir: join(recoveredAt, "session"), workspaceRoot: join(recoveredAt, "work") }, callbacks);
    assert(result.status === "done" && faux.state.callCount === calls, `new-host restore replayed or failed: ${result.summary}`);
    assert(await readFile(join(recoveredAt, "work", "artifact.txt"), "utf8") === "durable guest artifact", "artifact was not restored into the fresh guest");
    assert((await readFile(join(recoveredAt, "work", "large-artifact.bin"))).equals(large), "large artifact was not restored into the fresh guest");
  } finally { await restored.close(); }
  console.log(JSON.stringify({ status: "passed", provider: "explicit upstream faux fixture", permissions, modelCalls: calls, filesystemDenial: true, remoteCancellation: true, newGuestRestore: true, state: root, recoveredAt }));
} finally {
  await runtime.close(); await deleteOwnedSandbox(); delete process.env.LAUN_LIVE_SECRET;
}
