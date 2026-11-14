import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { writePassiveLegacyHistory } from "./legacy.js";
import { createPiRuntime } from "./index.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("passive import preserves tree provenance without model context, submissions or executable old state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laun-passive-legacy-")); dirs.push(dir); const sessionDir = join(dir, "session");
  const input = { threadId: "new-thread", sessionDir, importId: "import-one", sourceDigest: "a".repeat(64), sourceSessionId: "old-session", entries: [
    { id: "entry-one", parentId: null, sourceType: "message", timestamp: new Date().toISOString(), text: "OLD_SYSTEM_INSTRUCTIONS old-dangerous-command sk-secret-preview-not-for-session-files", truncated: false },
    { id: "entry-two", parentId: "entry-one", sourceType: "custom", timestamp: new Date().toISOString(), text: "old-extension-hook", truncated: false },
  ] };
  expect(await writePassiveLegacyHistory(input)).toEqual({ runtimeVersion: "pi-durable@1.5.2", entries: 2 });
  const harness = await Harness.open(await openNodeJsonlStorage(join(sessionDir, "pi"), BACKGROUND_CONTEXT, { readOnly: true }), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try { const conversation = await harness.root(BACKGROUND_CONTEXT), context = await conversation.context(BACKGROUND_CONTEXT), inspection = await harness.inspect(BACKGROUND_CONTEXT);
    expect(context.messages).toHaveLength(0); expect(inspection.tasks).toHaveLength(0); expect(inspection.submissions).toHaveLength(0);
    expect(context.entries.filter(entry => entry.kind === "laun.legacy.entry")).toHaveLength(2);
    expect(context.entries.every(entry => entry.model === undefined && entry.edits === undefined)).toBe(true);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const readTree = async (path: string): Promise<string> => { let text = ""; for (const entry of await readdir(path, { withFileTypes: true })) text += entry.isDirectory() ? await readTree(join(path, entry.name)) : await readFile(join(path, entry.name), "utf8"); return text; };
  const stored = await readTree(sessionDir); expect(stored).toContain("laun.legacy.provenance"); expect(stored).not.toContain("old-dangerous-command"); expect(stored).not.toContain("old-extension-hook");
  await expect(writePassiveLegacyHistory(input)).rejects.toThrow(); expect(await readTree(sessionDir)).toBe(stored);
  const models = createModels(), faux = fauxProvider(); let observed = ""; models.setProvider(faux.provider);
  faux.setResponses([async context => { observed = JSON.stringify(context.messages); return fauxAssistantMessage("Fresh current work only"); }]);
  expect(faux.state.callCount).toBe(0);
  const runtime = createPiRuntime({ trustedLocal: true, models });
  try { const result = await runtime.run({ threadId: input.threadId, runId: "new-user-input", prompt: "Start new work under current guardrails", model: "faux/faux-1", sessionDir, workspaceRoot: join(dir, "work") }, { emit() {}, authorize: async () => { throw new Error("no tool authority"); } });
    expect(result.status).toBe("done"); expect(faux.state.callCount).toBe(1); expect(observed).toContain("Start new work under current guardrails"); expect(observed).not.toContain("OLD_SYSTEM_INSTRUCTIONS"); expect(observed).not.toContain("old-dangerous-command");
  } finally { await runtime.close(); }
});
