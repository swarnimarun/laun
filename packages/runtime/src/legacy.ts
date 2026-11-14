import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { PassiveLegacyHistory } from "@laun/protocol";

/** Create a fresh passive conversation; there is no model, tool or submission call. */
export async function writePassiveLegacyHistory(input: PassiveLegacyHistory): Promise<{ runtimeVersion: string; entries: number }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.threadId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.importId) || !/^[0-9a-f]{64}$/.test(input.sourceDigest) ||
    typeof input.sourceSessionId !== "string" || input.sourceSessionId.length > 128 || !isAbsolute(input.sessionDir) || !Array.isArray(input.entries) || input.entries.length > 20_000 || Buffer.byteLength(JSON.stringify(input.entries)) > 8 * 1024 * 1024) throw new Error("invalid passive legacy history");
  for (const entry of input.entries) if (!entry || typeof entry.id !== "string" || entry.id.length > 128 || (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length > 128)) ||
    typeof entry.sourceType !== "string" || entry.sourceType.length > 80 || typeof entry.text !== "string" || Buffer.byteLength(entry.text) > 4096 || typeof entry.truncated !== "boolean" || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error("invalid passive legacy entry");
  if (await realpath(dirname(input.sessionDir)) !== dirname(input.sessionDir)) throw new Error("passive history parent must not contain symlinks");
  await mkdir(input.sessionDir, { mode: 0o700 });
  let harness: Harness | undefined;
  try {
    // An empty model registry cannot infer credentials, install providers or
    // perform model discovery. The entry drafts contain only kind and data.
    harness = await Harness.open(await openNodeJsonlStorage(join(input.sessionDir, "pi"), BACKGROUND_CONTEXT, { fsync: true }), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const conversation = await harness.root(BACKGROUND_CONTEXT, { init: async (tx, conversationId) => {
      await tx.appendEntry(conversationId, { kind: "laun.legacy.provenance", data: { version: 1, importId: input.importId, sourceDigest: input.sourceDigest, sourceSessionId: input.sourceSessionId, modelContext: false } });
      // Previews stay in the controller's display log. Session files carry
      // only provenance/tree metadata, not old prompts, secrets or tool data.
      for (const entry of input.entries) await tx.appendEntry(conversationId, { kind: "laun.legacy.entry", data: { id: entry.id, parentId: entry.parentId, sourceType: entry.sourceType, timestamp: entry.timestamp, previewStoredByController: true, truncated: entry.truncated } });
    } });
    const inspection = await harness.inspect(BACKGROUND_CONTEXT), context = await conversation.context(BACKGROUND_CONTEXT);
    if (inspection.tasks.length || inspection.submissions.length || context.messages.length) throw new Error("passive import unexpectedly created active/model state");
    await harness.close(BACKGROUND_CONTEXT); harness = undefined;
    const protect = async (path: string): Promise<void> => { const info = await lstat(path); if (info.isSymbolicLink()) throw new Error("unexpected passive history symlink");
      if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await protect(join(path, name)); }
      else if (info.isFile()) await chmod(path, 0o600); else throw new Error("unexpected passive history special file");
      const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); }
    };
    await protect(input.sessionDir);
    return { runtimeVersion: "pi-durable@1.5.2", entries: input.entries.length };
  } catch (error) { await harness?.close(BACKGROUND_CONTEXT).catch(() => {}); await rm(input.sessionDir, { recursive: true, force: true }); throw error; }
}
