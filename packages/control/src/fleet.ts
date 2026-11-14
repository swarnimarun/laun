import { randomBytes } from "node:crypto";
import type {
  ControlPrincipal,
  WorkerKeyRotation,
  WorkerKeyRotationResult,
  WorkerRecord,
} from "@laun/protocol";
import { ControlError, ControlStore, hash, now, record } from "./store.js";
import { fenceWorkerCleanup } from "./cleanup.js";

function remoteWorker(
  store: ControlStore,
  principal: ControlPrincipal,
  workerId: string,
): WorkerRecord {
  const worker = store.get<WorkerRecord>("worker", workerId, principal);
  if (worker.local)
    throw new ControlError(
      "the controller's local runtime is managed by installation configuration",
      409,
    );
  if (worker.status === "revoked")
    throw new ControlError(
      "revoked yards cannot be resumed or given replacement credentials; enroll a new identity",
      409,
    );
  return worker;
}
/** Drain affects future claims only. Existing leases and queued affinity remain. */
export function setWorkerDraining(
  store: ControlStore,
  principal: ControlPrincipal,
  workerId: string,
  draining: boolean,
): WorkerRecord {
  if (typeof draining !== "boolean")
    throw new ControlError("draining must be a boolean");
  return store.transaction(() => {
    const worker = remoteWorker(store, principal, workerId);
    if (!draining) {
      const seen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : NaN,
        age = Date.now() - seen;
      if (
        worker.status !== "online" ||
        !Number.isFinite(age) ||
        age < -5000 ||
        age > 60_000
      )
        throw new ControlError(
          "resume requires a recent authenticated yard heartbeat after configuration replacement",
          409,
        );
      if (
        worker.credentialRotatedAt &&
        (!Number.isFinite(Date.parse(worker.credentialRotatedAt)) ||
          seen < Date.parse(worker.credentialRotatedAt))
      )
        throw new ControlError(
          "resume requires a heartbeat using the replacement worker credential",
          409,
        );
      if (
        !worker.durabilityAdapter ||
        worker.durabilityAdapter.version !== 1 ||
        !/^[-a-zA-Z0-9._@]{1,80}$/.test(worker.durabilityAdapter.adapter) ||
        !worker.checkpointVersion ||
        !/^[-a-zA-Z0-9._@]{1,100}$/.test(worker.checkpointVersion) ||
        !["controller", "local"].includes(worker.inferenceMode ?? "") ||
        !Number.isSafeInteger(worker.reportedCapacity) ||
        Number(worker.reportedCapacity) < 1 ||
        Number(worker.reportedCapacity) > 16
      )
        throw new ControlError(
          "resume requires current inference, checkpoint, capacity and central durable adapter metadata; upgrade and reconnect this yard",
          409,
        );
    }
    if (draining) worker.drainingAt ??= now();
    else delete worker.drainingAt;
    store.put("worker", worker);
    return worker;
  });
}
/** Atomic credential replacement. No receipt contains this one-time secret. */
export function rotateWorkerKey(
  store: ControlStore,
  principal: ControlPrincipal,
  workerId: string,
  input: WorkerKeyRotation | unknown,
): WorkerKeyRotationResult {
  const b = record(input);
  if (
    Object.keys(b).some(
      (key) => !["expectedCredentialVersion", "confirmedStopped"].includes(key),
    )
  )
    throw new ControlError("unknown worker rotation fields");
  if (b.confirmedStopped !== true)
    throw new ControlError(
      "confirm the old worker process is stopped and external effects reconciled before replacing its key",
      409,
    );
  if (
    !Number.isSafeInteger(b.expectedCredentialVersion) ||
    Number(b.expectedCredentialVersion) < 1
  )
    throw new ControlError(
      "review the current credential version before rotating",
    );
  return store.transaction(() => {
    const worker = remoteWorker(store, principal, workerId),
      version = worker.credentialVersion ?? 1;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version >= Number.MAX_SAFE_INTEGER
    )
      throw new ControlError("invalid stored worker credential version", 409);
    if (b.expectedCredentialVersion !== version)
      throw new ControlError(
        "worker credential changed; review its current version before rotating",
        409,
      );
    fenceWorkerCleanup(
      store,
      worker.id,
      "Worker credential changed. Verify the prior process stopped, reconcile cleanup effects and obtain fresh owner approval before retrying host cleanup.",
    );
    const key = `yard_${worker.id}_${randomBytes(32).toString("base64url")}`;
    const changed = store.db
      .query("UPDATE worker_auth SET hash=? WHERE id=?")
      .run(hash(key), worker.id).changes;
    if (changed !== 1)
      throw new ControlError(
        "worker credential record is unavailable; enroll a new identity",
        409,
      );
    const at = now(),
      rows = store.db
        .query(
          "SELECT id,thread_id FROM runs WHERE worker_id=? AND status IN('running','waiting_permission') ORDER BY id",
        )
        .all(worker.id) as Array<{ id: string; thread_id: string }>;
    for (const row of rows) {
      store.db
        .query(
          "UPDATE runs SET status='interrupted',cancel_requested=1,lease_until=NULL,updated_at=?,summary=? WHERE id=?",
        )
        .run(
          at,
          "Worker credential rotated. Reconcile before explicit resume or abandonment.",
          row.id,
        );
      store.expireRunApprovals(row.id);
      store.event(
        row.thread_id,
        "system",
        {
          status: "interrupted",
          text: "The yard credential was replaced. The old credential is invalid; this attempt will not resume automatically. Verify the old process stopped and reconcile effects before resuming or abandoning.",
          workerId: worker.id,
          credentialVersion: version + 1,
        },
        row.id,
      );
    }
    worker.credentialVersion = version + 1;
    worker.credentialRotatedAt = at;
    worker.drainingAt ??= at;
    worker.status = "offline";
    delete worker.lastSeenAt;
    delete worker.reportedCapacity;
    delete worker.durabilityAdapter;
    delete worker.checkpointVersion;
    delete worker.inferenceMode;
    store.put("worker", worker);
    return { worker, key, interruptedRunIds: rows.map((row) => row.id) };
  });
}
