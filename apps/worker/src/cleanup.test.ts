import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, HostCleanupPlan } from "@laun/protocol";
import {
  ControlService,
  ControlStore,
  handleControlRequest,
  beginThreadPurge,
  continueThreadPurge,
  listHostCleanupPlans,
  previewThreadPurge,
} from "@laun/control";
import { OutboundWorker } from "./worker.js";
import { WorkerJournal, type RunJournal } from "./journal.js";
const owner = { id: `user_${"a".repeat(32)}`, admin: false },
  cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function directory() {
  const dir = mkdtempSync("/tmp/laun-worker-cleanup-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("cleanup fixture timed out");
    await Bun.sleep(5);
  }
}
function journal(
  runId: string,
  threadId: string,
  phase: RunJournal["phase"] = "reported",
): RunJournal {
  return {
    runId,
    threadId,
    generation: 1,
    phase,
    nextSequence: 0,
    events: [],
    updatedAt: new Date().toISOString(),
    outcome: { status: "done", summary: "private old thread content" },
  };
}
function controller() {
  const data = directory(),
    store = new ControlStore(join(data, "control.sqlite")),
    service = new ControlService({
      store,
      dataDir: join(data, "controller"),
      mode: "unconfigured",
    });
  const { worker, key } = store.registerWorker(owner, { name: "Cleanup yard" }),
    mower = store.createMower(owner, {
      name: "Cleanable mower",
      workerId: worker.id,
      model: "fixture/model",
    }),
    thread = store.createThread(owner, {
      mowerId: mower.id,
      title: "Disposable controller copy",
    });
  const oldRun = store.submit(owner, thread.id, {
    text: "Disposable original input",
    requestId: crypto.randomUUID(),
  });
  store.cancel(owner, thread.id);
  const archived = store.get<typeof thread>("thread", thread.id);
  archived.archivedAt = new Date().toISOString();
  store.put("thread", archived);
  const preview = previewThreadPurge(store, owner, thread.id);
  let purge = beginThreadPurge(store, owner, thread.id, {
    requestId: "remove-copy",
    expectedDigest: preview.digest,
    confirmedStopped: true,
    confirmedControllerCopyOnly: true,
  });
  for (let batch = 0; batch < 30 && purge.status !== "done"; batch++)
    purge = continueThreadPurge(store, owner, purge.id);
  const plan = listHostCleanupPlans(store, owner, purge.id)[0]!;
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);
      return handleControlRequest(
        service,
        request,
        request.headers.get("authorization") === "Bearer human-fixture"
          ? owner
          : null,
      );
    },
  });
  cleanup.push(async () => {
    server.stop(true);
    await service.close();
    store.close();
  });
  const url = `http://127.0.0.1:${server.port}`;
  const human = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer human-fixture",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`operator fixture ${path} HTTP${response.status}`);
    return response.json() as Promise<any>;
  };
  const approve = async () => {
    const { review } = await human(`/host-copies/${plan.id}`);
    return human(`/host-copies/${plan.id}/approve`, {
      expectedDigest: review.digest,
      confirmedStopped: true,
      confirmedDeleteHostCopies: true,
    });
  };
  return {
    oldRun,
    store,
    service,
    worker,
    key,
    mower,
    thread,
    plan,
    url,
    paths,
    human,
    approve,
  };
}
function agent(
  cleanupThread: NonNullable<AgentRuntime["cleanupThread"]>,
): AgentRuntime {
  return {
    durabilityAdapter: { adapter: "fixture@1", version: 1 },
    checkpointVersion: "fixture@1",
    async run() {
      throw new Error("unexpected model invocation");
    },
    cancel() {},
    close() {},
    cleanupThread,
  };
}
function yard(
  c: ReturnType<typeof controller>,
  runtime: AgentRuntime,
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  const data = directory(),
    worker = new OutboundWorker({
      controllerUrl: c.url,
      workerKey: c.key,
      dataDir: data,
      runtime,
      heartbeatMs: 50,
      fetch: fetcher as typeof fetch | undefined,
    });
  cleanup.push(() => worker.close());
  return { data, worker };
}
function plan(c: ReturnType<typeof controller>): HostCleanupPlan {
  return listHostCleanupPlans(c.store, owner)[0]!;
}

test("host cleanup needs separate approval and first lease check, then prunes only typed matching journal copies", async () => {
  const c = controller();
  let effects = 0;
  const y = yard(
    c,
    agent(async (input) => {
      effects++;
      expect(c.paths.some((path) => path.endsWith("/cleanup-heartbeat"))).toBe(
        true,
      );
      rmSync(join(y.data, "threads", input.threadId), { recursive: true });
      return {
        verified: true,
        removedPaths: 1,
        removedSandboxes: 0,
        outstanding: [],
      };
    }),
  );
  mkdirSync(join(y.data, "threads", c.thread.id), { recursive: true });
  writeFileSync(
    join(y.data, "threads", c.thread.id, "artifact"),
    "old content",
  );
  const journals = new WorkerJournal(join(y.data, "journal"));
  // Unknown ACKs require explicit host cleanup; normal acknowledged finish
  // caches may be compacted independently before this approved operation.
  journals.save(journal("old-run", c.thread.id, "fenced"));
  journals.save(journal("other-run", "other-thread", "fenced"));
  await y.worker.tick();
  expect(effects).toBe(0);
  await c.approve();
  await y.worker.tick();
  expect(effects).toBe(1);
  expect(plan(c)).toMatchObject({
    status: "done",
    verified: true,
    removedPaths: 2,
  });
  expect(existsSync(join(y.data, "threads", c.thread.id))).toBe(false);
  expect(existsSync(join(y.data, "journal", "old-run.1.json"))).toBe(false);
  expect(existsSync(join(y.data, "journal", "other-run.1.json"))).toBe(true);
  await y.worker.tick();
  expect(effects).toBe(1);
});
test("withdrawing approval before the first heartbeat prevents every host effect", async () => {
  const c = controller();
  let effects = 0,
    withdrawn = false;
  const y = yard(
    c,
    agent(async () => {
      effects++;
      return {
        verified: true,
        removedPaths: 0,
        removedSandboxes: 0,
        outstanding: [],
      };
    }),
    async (input, options) => {
      if (String(input).endsWith("/cleanup-heartbeat") && !withdrawn) {
        withdrawn = true;
        const { review } = await c.human(`/host-copies/${c.plan.id}`);
        await c.human(`/host-copies/${c.plan.id}/revoke`, {
          expectedDigest: review.digest,
        });
      }
      return fetch(input, options);
    },
  );
  await y.worker.tick();
  await c.approve();
  await y.worker.tick();
  expect(effects).toBe(0);
  expect(plan(c).status).toBe("blocked");
  await y.worker.tick();
  expect(effects).toBe(0);
});
test.each(["withdraw", "revoke-key", "transport-loss"] as const)(
  "%s while host cleanup is active aborts deletion and never retries automatically",
  async (failure) => {
    const c = controller();
    let entered = false,
      aborted = false,
      effects = 0,
      heartbeats = 0;
    const y = yard(
      c,
      agent(async (input) => {
        effects++;
        entered = true;
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        input.signal!.throwIfAborted();
        return {
          verified: true,
          removedPaths: 99,
          removedSandboxes: 0,
          outstanding: [],
        };
      }),
      async (input, options) => {
        if (
          String(input).endsWith("/cleanup-heartbeat") &&
          ++heartbeats > 1 &&
          failure === "transport-loss"
        )
          throw new Error("fixture network lost");
        return fetch(input, options);
      },
    );
    await y.worker.tick();
    await c.approve();
    const working = y.worker.tick();
    await until(() => entered);
    if (failure === "withdraw") {
      const { review } = await c.human(`/host-copies/${c.plan.id}`);
      await c.human(`/host-copies/${c.plan.id}/revoke`, {
        expectedDigest: review.digest,
      });
    } else if (failure === "revoke-key")
      await c.human(`/workers/${c.worker.id}/revoke`, {});
    await working;
    expect(aborted).toBe(true);
    expect(effects).toBe(1);
    expect(plan(c).status).not.toBe("done");
    await y.worker.tick();
    expect(effects).toBe(1);
  },
);
test("a lost verified-result acknowledgement never replays deletion", async () => {
  const c = controller();
  let effects = 0,
    lost = false;
  const y = yard(
    c,
    agent(async () => {
      effects++;
      return {
        verified: true,
        removedPaths: 3,
        removedSandboxes: 1,
        outstanding: [],
      };
    }),
    async (input, options) => {
      const response = await fetch(input, options);
      if (String(input).endsWith("/cleanup-finish") && !lost) {
        lost = true;
        return Response.json(
          { error: "lost verified result ACK" },
          { status: 503 },
        );
      }
      return response;
    },
  );
  await y.worker.tick();
  await c.approve();
  await y.worker.tick();
  expect(plan(c).status).toBe("done");
  await y.worker.tick();
  expect(effects).toBe(1);
});
test("unknown journals remain on the host and block a verified completion claim", async () => {
  const c = controller(),
    y = yard(
      c,
      agent(async () => ({
        verified: true,
        removedPaths: 1,
        removedSandboxes: 0,
        outstanding: [],
      })),
    );
  await y.worker.tick();
  writeFileSync(
    join(y.data, "journal", "unrecognized-private-copy"),
    "sensitive unknown content",
    { mode: 0o600 },
  );
  await c.approve();
  await y.worker.tick();
  expect(plan(c).status).toBe("blocked");
  expect(plan(c).verified).toBe(false);
  expect(plan(c).outstanding?.join(" ")).toContain("Unrecognized");
  expect(existsSync(join(y.data, "journal", "unrecognized-private-copy"))).toBe(
    true,
  );
});
test("a purged attempt's unreported journal is fenced so reconnect can reach its approved cleanup", async () => {
  const c = controller(),
    data = directory(),
    journals = new WorkerJournal(join(data, "journal"));
  journals.save(journal(c.oldRun.id, c.thread.id, "interrupted"));
  let effects = 0;
  const worker = new OutboundWorker({
    controllerUrl: c.url,
    workerKey: c.key,
    dataDir: data,
    heartbeatMs: 50,
    runtime: agent(async () => {
      effects++;
      return {
        verified: true,
        removedPaths: 0,
        removedSandboxes: 0,
        outstanding: [],
      };
    }),
  });
  cleanup.push(() => worker.close());
  await worker.tick();
  expect(journals.read(c.oldRun.id, 1)?.phase).toBe("fenced");
  await c.approve();
  await worker.tick();
  expect(effects).toBe(1);
  expect(plan(c).status).toBe("done");
  expect(existsSync(join(data, "journal", `${c.oldRun.id}.1.json`))).toBe(
    false,
  );
});
test("a startup FIFO journal never blocks reads, new runs stay disabled and reviewed cleanup reports the preserved entry", async () => {
  if (process.platform !== "linux") return;
  const c = controller(),
    data = directory(),
    root = join(data, "journal");
  mkdirSync(root, { mode: 0o700 });
  expect(Bun.spawnSync(["mkfifo", join(root, "fifo.1.json")]).exitCode).toBe(0);
  let calls = 0;
  const runtime = agent(async () => {
      calls++;
      return {
        verified: true,
        removedPaths: 0,
        removedSandboxes: 0,
        outstanding: [],
      };
    }),
    worker = new OutboundWorker({
      controllerUrl: c.url,
      workerKey: c.key,
      dataDir: data,
      runtime,
      heartbeatMs: 50,
    });
  cleanup.push(() => worker.close());
  await expect(worker.tick()).rejects.toThrow("regular file");
  await c.approve();
  await worker.tick();
  expect(calls).toBe(1);
  expect(plan(c).status).toBe("blocked");
  expect(plan(c).outstanding?.join(" ")).toContain("Unsafe");
  expect(existsSync(join(root, "fifo.1.json"))).toBe(true);
});
test("ordinary active work defers cleanup claims until every execution writer is idle", async () => {
  const c = controller();
  let finish!: () => void,
    effects = 0;
  const runtime = agent(async () => {
    effects++;
    return {
      verified: true,
      removedPaths: 0,
      removedSandboxes: 0,
      outstanding: [],
    };
  });
  delete runtime.checkpointVersion;
  runtime.run = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { status: "done", summary: "ordinary fixture done" };
  };
  const y = yard(c, runtime),
    thread = c.store.createThread(owner, {
      mowerId: c.mower.id,
      title: "Active unrelated work",
    });
  c.store.submit(owner, thread.id, {
    text: "Hold ordinary execution",
    requestId: crypto.randomUUID(),
  });
  await y.worker.tick();
  await c.approve();
  const polls = c.paths.filter((path) => path.endsWith("/cleanup-poll")).length;
  await y.worker.tick();
  expect(c.paths.filter((path) => path.endsWith("/cleanup-poll"))).toHaveLength(
    polls,
  );
  expect(effects).toBe(0);
  finish();
  await y.worker.whenIdle();
  await y.worker.tick();
  expect(effects).toBe(1);
  expect(plan(c).status).toBe("done");
});
test("graceful worker shutdown interrupts the attempt and keeps later input blocked after restart", async () => {
  const c = controller();
  let release!: () => void,
    calls = 0;
  const runtime: AgentRuntime = {
    durabilityAdapter: { adapter: "fixture@1", version: 1 },
    async run() {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "cancelled", summary: "supervisor stopped" };
    },
    cancel() {
      release?.();
    },
    close() {},
  };
  const y = yard(c, runtime),
    thread = c.store.createThread(owner, {
      mowerId: c.mower.id,
      title: "Shutdown reconciliation",
    }),
    old = c.store.submit(owner, thread.id, {
      text: "Old request",
      requestId: crypto.randomUUID(),
    });
  await y.worker.tick();
  const later = c.store.submit(owner, thread.id, {
    text: "Queued followup must wait",
    requestId: crypto.randomUUID(),
  });
  await y.worker.close();
  expect(c.store.run(old.id).status).toBe("interrupted");
  expect(c.store.run(later.id).status).toBe("queued");
  const restarted = new OutboundWorker({
    controllerUrl: c.url,
    workerKey: c.key,
    dataDir: y.data,
    runtime,
    heartbeatMs: 50,
  });
  cleanup.push(() => restarted.close());
  await restarted.tick();
  await restarted.whenIdle();
  expect(calls).toBe(1);
  expect(c.store.run(later.id).status).toBe("queued");
});
test("a delayed valid poll response cannot start execution after worker close released its lock", async () => {
  const c = controller();
  let held = false,
    release!: () => void,
    calls = 0;
  const runtime: AgentRuntime = {
    durabilityAdapter: { adapter: "fixture@1", version: 1 },
    async run() {
      calls++;
      return { status: "done" };
    },
    cancel() {},
    close() {},
  };
  const y = yard(c, runtime, async (input, options) => {
    const response = await fetch(input, options);
    if (String(input).endsWith("/worker/poll")) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return response;
  });
  const thread = c.store.createThread(owner, {
    mowerId: c.mower.id,
    title: "Late dispatch",
  });
  c.store.submit(owner, thread.id, {
    text: "Never execute after shutdown",
    requestId: crypto.randomUUID(),
  });
  const polling = y.worker.tick().catch(() => {});
  await until(() => held);
  await y.worker.close();
  release();
  await polling;
  expect(calls).toBe(0);
  expect(new WorkerJournal(join(y.data, "journal")).list()).toEqual([]);
  expect(existsSync(join(y.data, ".worker-lock"))).toBe(false);
});
test("shutdown aborts active cleanup, awaits its adapter and releases the worker lock without new deletion", async () => {
  const c = controller();
  let entered = false,
    aborted = false,
    closed = false;
  const runtime = agent(async (input) => {
    entered = true;
    await new Promise<void>((resolve) =>
      input.signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    input.signal!.throwIfAborted();
    return {
      verified: true,
      removedPaths: 0,
      removedSandboxes: 0,
      outstanding: [],
    };
  });
  runtime.close = () => {
    closed = true;
  };
  const y = yard(c, runtime);
  await y.worker.tick();
  await c.approve();
  const running = y.worker.tick();
  await until(() => entered);
  await y.worker.close();
  await running;
  expect(aborted && closed).toBe(true);
  expect(plan(c).status).not.toBe("done");
  expect(existsSync(join(y.data, ".worker-lock"))).toBe(false);
});
test("journal pruning preserves unknown, shared, symlinked, public, running and unreadable typed entries", async () => {
  const data = directory(),
    root = join(data, "journal"),
    out = new WorkerJournal(root);
  out.save(journal("remove", "target"));
  out.save(journal("keep", "other"));
  out.save(journal("running", "target", "running"));
  out.save(journal("public", "target"));
  chmodSync(join(root, "public.1.json"), 0o644);
  const outside = join(data, "outside.json");
  writeFileSync(outside, JSON.stringify(journal("link", "target")), {
    mode: 0o600,
  });
  symlinkSync(outside, join(root, "link.1.json"));
  writeFileSync(join(root, "unknown"), "untyped private content", {
    mode: 0o600,
  });
  writeFileSync(join(root, "bad.1.json"), "invalid json", { mode: 0o600 });
  writeFileSync(join(root, "oversized.1.json"), Buffer.alloc(8_388_609), {
    mode: 0o600,
  });
  if (process.platform === "linux")
    expect(Bun.spawnSync(["mkfifo", join(root, "fifo.1.json")]).exitCode).toBe(
      0,
    );
  out.save(journal("shared", "target"));
  linkSync(join(root, "shared.1.json"), join(data, "shared-copy.json"));
  const result = await out.pruneThread("target");
  expect(result.removed).toBe(1);
  expect(result.outstanding.length).toBeGreaterThan(0);
  expect(existsSync(join(root, "remove.1.json"))).toBe(false);
  expect(readFileSync(outside, "utf8")).toContain("target");
  for (const path of [
    "keep.1.json",
    "running.1.json",
    "public.1.json",
    "link.1.json",
    "unknown",
    "bad.1.json",
    "oversized.1.json",
    "shared.1.json",
  ])
    expect(existsSync(join(root, path))).toBe(true);
  if (process.platform === "linux")
    expect(existsSync(join(root, "fifo.1.json"))).toBe(true);
});
test("journal cleanup requires a real private root and blocks every active run writer", async () => {
  const data = directory(),
    root = join(data, "journal"),
    out = new WorkerJournal(root);
  out.save(journal("writer", "target"));
  const busy = await out.pruneThread("target", {
    activeRunIds: new Set(["writer"]),
  });
  expect(busy.removed).toBe(0);
  expect(busy.outstanding.join(" ")).toContain("active writer");
  chmodSync(root, 0o755);
  expect((await out.pruneThread("target")).removed).toBe(0);
  chmodSync(root, 0o700);
  const moved = join(data, "moved");
  Bun.spawnSync(["mv", root, moved]);
  symlinkSync(moved, root);
  const result = await out.pruneThread("target");
  expect(result.removed).toBe(0);
  expect(result.outstanding.join(" ")).toContain("boundary");
});
test("journal unlink rechecks cancellation after its awaited final inspection", async () => {
  const root = join(directory(), "journal"),
    journals = new WorkerJournal(root),
    controller = new AbortController();
  journals.save(journal("held", "target"));
  let entered = false,
    release!: () => void;
  const removing = journals.pruneThread("target", {
    signal: controller.signal,
    beforeFinalInspect: async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await until(() => entered);
  controller.abort();
  release();
  await expect(removing).rejects.toThrow();
  expect(existsSync(join(root, "held.1.json"))).toBe(true);
});
test.each(["chmod", "hardlink"] as const)(
  "journal final inspection catches a concurrent %s without unlinking",
  async (change) => {
    const data = directory(),
      root = join(data, "journal"),
      journals = new WorkerJournal(root);
    journals.save(journal("changed", "target"));
    const path = join(root, "changed.1.json");
    const result = await journals.pruneThread("target", {
      beforeFinalInspect: async () => {
        if (change === "chmod") chmodSync(path, 0o644);
        else linkSync(path, join(data, "another-copy"));
      },
    });
    expect(result.removed).toBe(0);
    expect(result.outstanding.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
  },
);
