import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;

for (const backend of ["jsonl", "sqlite"] as const) {
const openStorage = (directory: string) => backend === "jsonl"
  ? openNodeJsonlStorage(directory, context, { fsync: true })
  : openNodeSqliteStorage(join(directory, "session.sqlite"));

test(`Bun ${backend} opens the pinned harness and deduplicates a completed disk-backed submission after reopen`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "laun-durable-admission-"));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Stored mower answer.")])]);
  const open = async () => Harness.open(
    await openStorage(directory),
    { models, registry: createRegistry() }, context,
  );
  let harness: Harness | undefined;
  try {
    harness = await open();
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const request = { type: "input", content: "Reply once.", requestId: "laun-admission-1" } as const;
    const first = await root.submit(request, context);
    const outcome = await first.wait(context);
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done" || outcome.type !== "input") throw new Error("faux model did not answer");
    const answer = await root.commit((tx) => tx.entry(AssistantEntry, outcome.answer), context);
    expect(answer?.model?.[0]?.content).toEqual([fauxText("Stored mower answer.")]);
    const rootId = root.id;
    await harness.close(context);
    harness = undefined;

    harness = await open();
    const restored = await harness.root(context);
    expect(restored.id).toBe(rootId);
    const duplicate = await restored.submit(request, context);
    expect(duplicate.id).toBe(first.id);
    expect(await duplicate.wait(context)).toEqual(outcome);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test(`Bun ${backend} reopens a stored sleeping task and resumes from its checkpoint`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "laun-durable-resume-"));
  let now = 1_000_000;
  let signalSleeping!: () => void;
  const sleeping = new Promise<void>((resolve) => { signalSleeping = resolve; });
  const visited: string[] = [];
  const Task = defineTask<null, { phase: "start" } | { phase: "finish" }, string>({
    name: "laun.probe.checkpoint", version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (_task, runtime, ctx) => {
        visited.push("start");
        await runtime.sleepUntil(now + 60_000, { phase: "finish" }, ctx);
        signalSleeping();
      },
      finish: async (_task, runtime, ctx) => {
        visited.push("finish");
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "resumed" } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "laun.probe", tasks: [Task] }));
  const open = async () => Harness.open(
    await openStorage(directory),
    { models: createModels(), registry, now: () => now }, context,
  );
  let harness: Harness | undefined;
  try {
    harness = await open();
    const taskId = await (await harness.root(context)).commit(
      (tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }), context,
    );
    harness.resume();
    await sleeping;
    expect((await harness.getTask(taskId, context))?.state.status).toBe("sleeping");
    await harness.close(context);
    harness = undefined;
    now += 60_001;
    harness = await open();
    const completed = await harness.waitForTask(taskId, context);
    expect(completed.state).toMatchObject({ status: "terminal", outcome: { status: "completed", result: "resumed" } });
    expect(visited).toEqual(["start", "finish"]);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
}
