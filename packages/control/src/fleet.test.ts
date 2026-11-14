import { afterEach, expect, test } from "bun:test";
import type { ControlApproval, WorkerRecord } from "@laun/protocol";
import { ControlError, ControlStore, hash } from "./store.js";
import { rotateWorkerKey, setWorkerDraining } from "./fleet.js";
import {
  beginThreadPurge,
  continueThreadPurge,
  listHostCleanupPlans,
  previewThreadPurge,
} from "./retention.js";
import {
  approveHostCleanupPlan,
  claimHostCleanup,
  heartbeatHostCleanup,
  previewHostCleanupPlan,
} from "./cleanup.js";
const owner = { id: `user_${"a".repeat(32)}`, admin: false },
  other = { id: `user_${"b".repeat(32)}`, admin: false },
  admin = { id: "service", admin: true };
const stores: ControlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new ControlStore(":memory:");
  stores.push(store);
  const registered = store.registerWorker(owner, {
      name: "Stable yard",
      capacity: 2,
    }),
    worker = registered.worker;
  worker.checkpointVersion = "fixture@1";
  worker.durabilityAdapter = { adapter: "fixture@1", version: 1 };
  worker.inferenceMode = "controller";
  worker.reportedCapacity = 2;
  store.put("worker", worker);
  store.heartbeat(worker.id);
  const mower = store.createMower(owner, {
    name: "Fleet worker",
    workerId: worker.id,
    model: "fixture/model",
  });
  const submit = (title: string) => {
    const thread = store.createThread(owner, { mowerId: mower.id, title });
    return {
      thread,
      run: store.submit(owner, thread.id, {
        text: title,
        requestId: crypto.randomUUID(),
      }),
    };
  };
  return { store, worker, key: registered.key, mower, submit };
}
function status(f: () => unknown) {
  try {
    f();
    return 200;
  } catch (error) {
    return (error as ControlError).status;
  }
}
test("drain preserves active work and queued affinity while stale snapshots cannot claim", () => {
  const f = fixture(),
    first = f.submit("Active"),
    active = f.store.claim(f.worker)!,
    queued = f.submit("Queued");
  expect(active.run.id).toBe(first.run.id);
  const drained = setWorkerDraining(f.store, owner, f.worker.id, true);
  expect(drained.drainingAt).toBeDefined();
  expect(f.store.claim(f.worker)).toBeNull();
  expect(f.store.run(active.run.id).status).toBe("running");
  expect(f.store.run(queued.run.id).status).toBe("queued");
  expect(f.store.get<WorkerRecord>("worker", f.worker.id).ownerId).toBe(
    owner.id,
  );
  expect(
    f.store.fence(active.run.id, f.worker.id, active.run.generation).id,
  ).toBe(active.run.id);
  expect(setWorkerDraining(f.store, owner, f.worker.id, true).drainingAt).toBe(
    drained.drainingAt,
  );
  expect(
    setWorkerDraining(f.store, owner, f.worker.id, false).drainingAt,
  ).toBeUndefined();
  expect(f.store.claim(drained)?.run.id).toBe(queued.run.id);
});
test("stale poll snapshots cannot exceed either enrolled or currently reported worker capacity", () => {
  const f = fixture(),
    stale = { ...f.worker, capacity: 16, reportedCapacity: 16 };
  f.submit("First ordinary run");
  f.submit("Second ordinary run");
  f.submit("Third ordinary run");
  let current = f.store.get<WorkerRecord>("worker", f.worker.id);
  current.capacity = 2;
  current.reportedCapacity = 1;
  f.store.put("worker", current);
  const first = f.store.claim(stale)!;
  expect(first).toBeDefined();
  expect(f.store.claim(stale)).toBeNull();
  f.store.finish(first.run.id, f.worker.id, first.run.generation, "done");
  current = f.store.get<WorkerRecord>("worker", f.worker.id);
  current.capacity = 1;
  current.reportedCapacity = 16;
  f.store.put("worker", current);
  const second = f.store.claim(stale)!;
  expect(second.run.id).not.toBe(first.run.id);
  expect(f.store.claim(stale)).toBeNull();
  expect(
    f.store.runs(owner).filter((run) => run.status === "running"),
  ).toHaveLength(1);
});
test("rotation atomically keeps stable identity, invalidates old key and fences active leases/approvals", () => {
  const f = fixture(),
    first = f.submit("Waiting for review"),
    active = f.store.claim(f.worker)!,
    queued = f.submit("Queued on stable yard");
  f.store.setRunStatus(active.run.id, "waiting_permission");
  const at = new Date().toISOString(),
    approval: ControlApproval = {
      id: "approval",
      ownerId: owner.id,
      profileId: first.thread.profileId,
      profileVersion: first.thread.profileVersion,
      status: "pending",
      createdAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: {
        id: "action",
        principalId: owner.id,
        workspaceId: first.thread.workspaceId,
        mowerId: f.mower.id,
        threadId: first.thread.id,
        runId: active.run.id,
        operation: "process.execute",
        resource: "workspace:own",
        argumentsDigest: hash("command"),
      },
    };
  f.store.requestApproval(approval, "fingerprint");
  const result = rotateWorkerKey(f.store, owner, f.worker.id, {
    expectedCredentialVersion: 1,
    confirmedStopped: true,
  });
  expect(result.worker.id).toBe(f.worker.id);
  expect(result.worker.ownerId).toBe(owner.id);
  expect(result.worker.credentialVersion).toBe(2);
  expect(result.worker.status).toBe("offline");
  expect(result.worker.drainingAt).toBeDefined();
  expect(result.worker.lastSeenAt).toBeUndefined();
  expect(result.key).not.toBe(f.key);
  expect(f.store.authenticateWorker(f.key)).toBeNull();
  expect(f.store.authenticateWorker(result.key)?.id).toBe(f.worker.id);
  expect(result.interruptedRunIds).toEqual([active.run.id]);
  expect(f.store.run(active.run.id)).toMatchObject({
    status: "interrupted",
    cancelRequested: true,
  });
  expect(f.store.run(active.run.id).leaseUntil).toBeUndefined();
  expect(f.store.approval(approval.id).status).toBe("expired");
  expect(
    status(() =>
      f.store.fence(active.run.id, f.worker.id, active.run.generation),
    ),
  ).toBe(409);
  expect(f.store.run(queued.run.id).status).toBe("queued");
  expect(f.store.get("mower", f.mower.id)).toMatchObject({
    workerId: f.worker.id,
  });
  for (const table of ["objects", "events", "worker_auth", "receipts"]) {
    const serialized = JSON.stringify(
      f.store.db.query(`SELECT * FROM ${table}`).all(),
    );
    expect(serialized).not.toContain(result.key);
    expect(serialized).not.toContain(result.key.split("_").at(-1)!);
  }
  expect(
    status(() => setWorkerDraining(f.store, owner, f.worker.id, false)),
  ).toBe(409);
  f.store.heartbeat(f.worker.id);
  expect(
    status(() => setWorkerDraining(f.store, owner, f.worker.id, false)),
  ).toBe(409);
  const reconnected = f.store.get<WorkerRecord>("worker", f.worker.id);
  reconnected.reportedCapacity = 2;
  reconnected.durabilityAdapter = { adapter: "fixture@1", version: 1 };
  reconnected.checkpointVersion = "fixture@1";
  reconnected.inferenceMode = "controller";
  f.store.put("worker", reconnected);
  expect(
    setWorkerDraining(f.store, owner, f.worker.id, false).drainingAt,
  ).toBeUndefined();
});
test("owner ACL, explicit stopped confirmation and version CAS reject stale rotation without invalidating keys", () => {
  const f = fixture();
  expect(
    status(() => setWorkerDraining(f.store, other, f.worker.id, true)),
  ).toBe(404);
  expect(
    status(() =>
      rotateWorkerKey(f.store, other, f.worker.id, {
        expectedCredentialVersion: 1,
        confirmedStopped: true,
      }),
    ),
  ).toBe(404);
  expect(
    status(() =>
      rotateWorkerKey(f.store, owner, f.worker.id, {
        expectedCredentialVersion: 1,
      }),
    ),
  ).toBe(409);
  expect(f.store.authenticateWorker(f.key)?.id).toBe(f.worker.id);
  const result = rotateWorkerKey(f.store, admin, f.worker.id, {
    expectedCredentialVersion: 1,
    confirmedStopped: true,
  });
  expect(
    status(() =>
      rotateWorkerKey(f.store, owner, f.worker.id, {
        expectedCredentialVersion: 1,
        confirmedStopped: true,
      }),
    ),
  ).toBe(409);
  expect(f.store.authenticateWorker(result.key)?.id).toBe(f.worker.id);
  const revoked = f.store.get<WorkerRecord>("worker", f.worker.id);
  revoked.status = "revoked";
  f.store.put("worker", revoked);
  expect(
    status(() => setWorkerDraining(f.store, owner, f.worker.id, false)),
  ).toBe(409);
  expect(
    status(() =>
      rotateWorkerKey(f.store, owner, f.worker.id, {
        expectedCredentialVersion: 2,
        confirmedStopped: true,
      }),
    ),
  ).toBe(409);
  expect(f.store.authenticateWorker(result.key)).toBeNull();
});
test("rotation rollback preserves the old credential if event persistence fails", () => {
  const f = fixture();
  f.submit("Running");
  f.store.claim(f.worker);
  const event = f.store.event;
  f.store.event = () => {
    throw new Error("injected persistence failure");
  };
  expect(() =>
    rotateWorkerKey(f.store, owner, f.worker.id, {
      expectedCredentialVersion: 1,
      confirmedStopped: true,
    }),
  ).toThrow("persistence failure");
  f.store.event = event;
  expect(f.store.authenticateWorker(f.key)?.id).toBe(f.worker.id);
  expect(
    f.store.get<WorkerRecord>("worker", f.worker.id).credentialVersion,
  ).toBeUndefined();
  expect(f.store.runs(owner)[0]?.status).toBe("running");
});
test("rotation atomically fences destructive cleanup approval and rolls it back with credential persistence", () => {
  const f = fixture(),
    removed = f.submit("Remove controller fixture");
  f.store.cancel(owner, removed.thread.id);
  const thread = f.store.get<typeof removed.thread>(
    "thread",
    removed.thread.id,
  );
  thread.archivedAt = new Date().toISOString();
  f.store.put("thread", thread);
  const preview = previewThreadPurge(f.store, owner, thread.id);
  let purge = beginThreadPurge(f.store, owner, thread.id, {
    requestId: "cleanup-fleet",
    expectedDigest: preview.digest,
    confirmedStopped: true,
    confirmedControllerCopyOnly: true,
  });
  for (let batch = 0; batch < 30 && purge.status !== "done"; batch++)
    purge = continueThreadPurge(f.store, owner, purge.id);
  expect(purge.status).toBe("done");
  const plan = listHostCleanupPlans(f.store, owner, purge.id)[0]!,
    review = previewHostCleanupPlan(f.store, owner, plan.id);
  approveHostCleanupPlan(f.store, owner, plan.id, {
    expectedDigest: review.digest,
    confirmedStopped: true,
    confirmedDeleteHostCopies: true,
  });
  const lease = claimHostCleanup(f.store, f.worker.id)!;
  expect(lease.planId).toBe(plan.id);
  f.submit("Active during credential transaction");
  f.store.claim(f.worker);
  const emit = f.store.event;
  f.store.event = () => {
    throw new Error("injected event failure");
  };
  expect(() =>
    rotateWorkerKey(f.store, owner, f.worker.id, {
      expectedCredentialVersion: 1,
      confirmedStopped: true,
    }),
  ).toThrow("injected event failure");
  f.store.event = emit;
  const rolledBack = previewHostCleanupPlan(f.store, owner, plan.id).plan;
  expect(rolledBack.status).toBe("running");
  expect(rolledBack.generation).toBe(lease.generation);
  expect(rolledBack.approvedAt).toBeDefined();
  expect(f.store.authenticateWorker(f.key)?.id).toBe(f.worker.id);
  rotateWorkerKey(f.store, owner, f.worker.id, {
    expectedCredentialVersion: 1,
    confirmedStopped: true,
  });
  const fenced = previewHostCleanupPlan(f.store, owner, plan.id).plan;
  expect(fenced.status).toBe("blocked");
  expect(fenced.generation).toBeGreaterThan(lease.generation);
  expect(fenced.approvedAt).toBeUndefined();
  expect(fenced.leaseUntil).toBeUndefined();
  expect(
    status(() =>
      heartbeatHostCleanup(f.store, f.worker.id, plan.id, lease.generation),
    ),
  ).toBe(409);
  expect(claimHostCleanup(f.store, f.worker.id)).toBeNull();
});
test("local runtime and stale/incomplete reconnect metadata cannot be resumed or rotated", () => {
  const f = fixture();
  const local: WorkerRecord = { ...f.worker, id: "local", local: true };
  f.store.put("worker", local);
  expect(status(() => setWorkerDraining(f.store, admin, "local", true))).toBe(
    409,
  );
  expect(
    status(() =>
      rotateWorkerKey(f.store, admin, "local", {
        confirmedStopped: true,
        expectedCredentialVersion: 1,
      }),
    ),
  ).toBe(409);
  const worker = f.store.get<WorkerRecord>("worker", f.worker.id);
  worker.lastSeenAt = new Date(Date.now() - 120_000).toISOString();
  f.store.put("worker", worker);
  expect(
    status(() => setWorkerDraining(f.store, owner, f.worker.id, false)),
  ).toBe(409);
  f.store.heartbeat(worker.id);
  delete worker.durabilityAdapter;
  worker.lastSeenAt = new Date().toISOString();
  worker.status = "online";
  f.store.put("worker", worker);
  expect(
    status(() => setWorkerDraining(f.store, owner, f.worker.id, false)),
  ).toBe(409);
});
