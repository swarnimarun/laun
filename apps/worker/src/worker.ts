import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isAgentEvent,
  type AgentEvent,
  type AgentRuntime,
  type RuntimeResult,
  type WorkerJob,
  type ControlRun,
} from "@laun/protocol";
import {
  WorkerClient,
  WorkerHttpError,
  WorkerTransportError,
} from "./client.js";
import { WorkerJournal, type RunJournal } from "./journal.js";
import {
  captureCheckpoint,
  recoverCheckpoint,
  placementChanged,
  recordPlacement,
  requireDiskReserve,
} from "@laun/storage";
import { performHostCleanup, assertCleanupJob } from "./cleanup.js";

export interface WorkerOptions {
  controllerUrl: string;
  workerKey: string;
  dataDir: string;
  runtime: AgentRuntime;
  capacity?: number;
  pollMs?: number;
  heartbeatMs?: number;
  approvalTimeoutMs?: number;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  inferenceMode?: "controller" | "local";
  minFreeDiskBytes?: number;
}
interface Active {
  job: WorkerJob;
  journal: RunJournal;
  controller: AbortController;
  lost: boolean;
  fenced: boolean;
  events: Promise<void>;
  finished?: Promise<void>;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const delay = async (ms: number) => {
  await Bun.sleep(ms);
};

function lockDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".worker-lock");
  const value = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let n = 0; n < 2; n++) {
    try {
      writeFileSync(path, value, { mode: 0o600, flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8") === value) rmSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = readFileSync(path, "utf8");
      let previous: { pid: number };
      try {
        previous = JSON.parse(raw);
      } catch {
        throw new Error("worker lock is corrupt; inspect before recovery");
      }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new Error("worker lock has an invalid PID");
      try {
        process.kill(previous.pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("cannot verify worker process ownership");
        if (readFileSync(path, "utf8") !== raw)
          throw new Error("worker lock changed during recovery");
        rmSync(path);
        continue;
      }
      throw new Error("another worker process owns this data directory");
    }
  }
  throw new Error("cannot acquire worker data directory");
}

function assertJob(
  value: unknown,
  workerId: string,
): asserts value is WorkerJob {
  if (!value || typeof value !== "object")
    throw new Error("controller returned invalid worker job");
  const { run, thread, mower } = value as WorkerJob;
  if (
    !run ||
    !thread ||
    !mower ||
    ![run.id, thread.id, mower.id].every(
      (id) => typeof id === "string" && ID.test(id),
    ) ||
    run.workerId !== workerId ||
    run.threadId !== thread.id ||
    thread.mowerId !== mower.id ||
    run.ownerId !== thread.ownerId ||
    mower.ownerId !== thread.ownerId ||
    !Number.isSafeInteger(run.generation) ||
    run.generation < 1 ||
    !["running", "waiting_permission"].includes(run.status) ||
    typeof run.prompt !== "string" ||
    run.prompt.length > 32_000 ||
    run.prompt.includes("\0") ||
    typeof mower.model !== "string" ||
    mower.model.length > 256 ||
    !run.leaseUntil ||
    !Number.isFinite(Date.parse(run.leaseUntil))
  ) {
    throw new Error("controller returned an inconsistent worker job");
  }
  if (Date.parse(run.leaseUntil) <= Date.now())
    throw new WorkerHttpError("controller returned an expired run lease", 409);
}

/** Outbound, independently authenticated yard. No public worker listener. */
export class OutboundWorker {
  private client: WorkerClient;
  private journal: WorkerJournal;
  private active = new Map<string, Active>();
  private stopped = false;
  private ticking = false;
  private storageFailed = false;
  private journalBlocked = false;
  private startupCompaction = true;
  private cleanupController: AbortController | undefined;
  private cleanupTask: Promise<boolean> | undefined;
  private shutdownController = new AbortController();
  private release: () => void;
  private workerId: string;
  private capacity: number;
  private heartbeatMs: number;
  private approvalTimeoutMs: number;
  lastError: string | undefined;
  constructor(private options: WorkerOptions) {
    const match = options.workerKey.match(
      /^yard_([0-9a-f-]{36})_[A-Za-z0-9_-]{20,128}$/,
    );
    if (!match) throw new Error("invalid enrolled yard credential");
    this.workerId = match[1]!;
    this.capacity = options.capacity ?? 1;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 310_000;
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 16 ||
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs < 50 ||
      this.heartbeatMs > 5000 ||
      !Number.isSafeInteger(this.approvalTimeoutMs) ||
      this.approvalTimeoutMs < 100 ||
      this.approvalTimeoutMs > 3_610_000
    )
      throw new Error("invalid worker limits");
    this.client = new WorkerClient(
      options.controllerUrl,
      options.workerKey,
      options.fetch,
    );
    this.release = lockDirectory(options.dataDir);
    try {
      this.journal = new WorkerJournal(join(options.dataDir, "journal"));
      let existing: RunJournal[] = [];
      try {
        existing = this.journal.list();
      } catch (error) {
        this.journalBlocked = true;
        this.log(
          `Worker journal requires inspection before accepting new runs: ${message(error)}`,
        );
      }
      for (const state of existing) {
        if (state.phase === "running") {
          state.phase = "interrupted";
          state.reason =
            "Worker restarted during execution; prior side effects are unknown. Reconcile before resuming.";
          this.save(state);
        }
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }
  private sanitize<T>(value: T): T {
    const secret = this.options.workerKey.split("_").slice(2).join("_");
    // Enrolled key/secret characters are JSON-safe base64url; replacement
    // cannot invalidate serialized JSON, including in object property names.
    let raw = JSON.stringify(value)
      .split(this.options.workerKey)
      .join("[REDACTED]");
    if (secret) raw = raw.split(secret).join("[REDACTED]");
    return JSON.parse(raw) as T;
  }
  private save(value: RunJournal) {
    value.updatedAt = new Date().toISOString();
    Object.assign(value, this.sanitize(value));
    this.journal.save(value);
  }
  private log(value: string) {
    const safe = this.sanitize(value);
    if (this.lastError === safe) return;
    this.lastError = safe;
    this.options.log?.(safe);
  }
  private base(state: RunJournal) {
    return { runId: state.runId, generation: state.generation };
  }
  private lose(active: Active, error: unknown) {
    if (active.lost || active.fenced) return;
    active.fenced =
      error instanceof WorkerHttpError &&
      [401, 403, 404, 409, 410].includes(error.status);
    active.lost = !active.fenced;
    active.journal.phase = active.fenced ? "fenced" : "interrupted";
    active.journal.reason = `Execution stopped: ${message(error)}`;
    try {
      this.save(active.journal);
    } catch (storageError) {
      this.storageFailed = true;
      this.log(
        `Worker storage failed; stopping execution: ${message(storageError)}`,
      );
    }
    active.controller.abort();
    void Promise.resolve()
      .then(() => this.options.runtime.cancel(active.job.thread.id))
      .catch(() => {});
    this.log(active.journal.reason);
  }
  private networkLost(error: unknown) {
    this.cleanupController?.abort(error);
    for (const active of this.active.values()) this.lose(active, error);
    this.log(message(error));
  }
  private async cleanupOnce(controller: AbortController): Promise<boolean> {
    try {
      const { job } = await this.client.request<{
        job: import("@laun/protocol").HostCleanupJob | null;
      }>("cleanup-poll", {}, { signal: controller.signal });
      if (!job) return false;
      assertCleanupJob(job);
      controller.signal.throwIfAborted();
      const result = await performHostCleanup({
        client: this.client,
        runtime: this.options.runtime,
        journal: this.journal,
        job,
        signal: controller.signal,
        heartbeatMs: this.heartbeatMs,
        activeRunIds: new Set(this.active.keys()),
        sanitize: (value) => this.sanitize(value),
      });
      this.log(
        result.status === "done"
          ? "Verified approved host cleanup completed."
          : "Host cleanup remains blocked; inspect outstanding copies before fresh approval.",
      );
      return true;
    } catch (error) {
      if (!this.stopped)
        this.log(
          `Host cleanup stopped; no deletion will be retried automatically: ${message(error)}`,
        );
      return true;
    }
  }
  private async flush(state: RunJournal, signal?: AbortSignal): Promise<void> {
    while (state.events.length) {
      const entry = state.events[0]!;
      await this.client.request(
        "events",
        { ...this.base(state), sequence: entry.sequence, event: entry.event },
        { signal },
      );
      state.events.shift();
      this.save(state);
    }
  }
  private emit(active: Active, event: AgentEvent): Promise<void> {
    const produce = async () => {
      if (!isAgentEvent(event) || event.sessionId !== active.job.thread.id)
        throw new Error("runtime emitted an invalid thread event");
      active.journal.events.push({
        sequence: active.journal.nextSequence++,
        event,
      });
      try {
        this.save(active.journal);
      } catch (error) {
        this.storageFailed = true;
        this.lose(active, error);
        throw error;
      }
      try {
        await this.flush(active.journal, active.controller.signal);
      } catch (error) {
        if (
          !(
            error instanceof WorkerHttpError &&
            error.status === 499 &&
            active.controller.signal.aborted
          )
        ) {
          if (
            error instanceof WorkerTransportError ||
            (error instanceof WorkerHttpError && error.status >= 500)
          )
            this.networkLost(error);
          else this.lose(active, error);
        }
        throw error;
      }
    };
    active.events = active.events.then(produce, produce);
    return active.events;
  }
  private async report(state: RunJournal): Promise<void> {
    if (
      state.phase === "reported" ||
      state.phase === "fenced" ||
      state.phase === "running"
    )
      return;
    let pendingHeartbeat = false;
    const lease = setInterval(() => {
      if (pendingHeartbeat) return;
      pendingHeartbeat = true;
      void this.client
        .request("heartbeat", this.base(state))
        .catch(() => {})
        .finally(() => {
          pendingHeartbeat = false;
        });
    }, this.heartbeatMs);
    lease.unref();
    try {
      let acknowledgedStatus: "done" | "error" | "cancelled" | undefined;
      await this.flush(state);
      if (state.phase === "settled" && state.outcome) {
        if (
          this.options.runtime.checkpointVersion &&
          (state.outcome.status !== "cancelled" ||
            existsSync(
              join(this.options.dataDir, "threads", state.threadId, "session"),
            ))
        ) {
          const checkpoint = await captureCheckpoint(
            state.threadId,
            resolve(this.options.dataDir, "threads", state.threadId),
          );
          await this.client.request(
            "checkpoint",
            { ...this.base(state), checkpoint },
            { timeoutMs: 60_000 },
          );
        }
        const summary = state.outcome.summary
          ?.replace(/\0/g, "")
          .slice(0, 8000);
        const reply = await this.client.request<{ run: ControlRun }>("finish", {
          ...this.base(state),
          status: state.outcome.status,
          ...(summary ? { summary } : {}),
        });
        const confirmed = reply.run;
        if (!confirmed || confirmed.id !== state.runId || confirmed.threadId !== state.threadId || confirmed.workerId !== this.workerId || confirmed.generation !== state.generation || !["done", "error", "cancelled"].includes(confirmed.status)) throw new WorkerTransportError("controller finish acknowledgement did not match this attempt; preserve for reconciliation");
        acknowledgedStatus = confirmed.status as "done" | "error" | "cancelled";
      } else {
        await this.client.request("interrupted", {
          ...this.base(state),
          summary:
            state.reason?.slice(0, 8000) ??
            "Worker outcome is unknown; reconcile before resuming.",
        });
      }
      state.phase = "reported";
      if (acknowledgedStatus && state.outcome && state.reason === undefined) state.finishAcknowledged = {
        version: 1, runId: state.runId, threadId: state.threadId, workerId: this.workerId, generation: state.generation,
        nextSequence: state.nextSequence, outcomeStatus: state.outcome.status as "done" | "error" | "cancelled", serverStatus: acknowledgedStatus, at: new Date().toISOString(),
      };
      this.save(state);
      // Only after the exact positive ACK and its durable marker. Failure
      // preserves the reported record for bounded startup maintenance.
      if (state.finishAcknowledged) await this.journal.compactAcknowledged(state.runId, state.generation, this.shutdownController.signal);
    } catch (error) {
      if (
        error instanceof WorkerHttpError &&
        [401, 403, 404, 409, 410].includes(error.status)
      ) {
        // A lost final acknowledgement is not permission to mutate settled or
        // reassigned work. Keep the local outcome for explicit reconciliation.
        state.phase = "fenced";
        state.reason = message(error);
        this.save(state);
      }
      throw error;
    } finally {
      clearInterval(lease);
    }
  }
  private async drain(): Promise<void> {
    for (const state of this.journal.list()) {
      if (
        this.active.has(state.runId) ||
        state.phase === "reported" ||
        state.phase === "fenced"
      )
        continue;
      try {
        await this.report(state);
      } catch (error) {
        if (
          error instanceof WorkerHttpError &&
          [401, 403, 404, 409, 410].includes(error.status)
        ) {
          this.log(`Old worker attempt fenced: ${message(error)}`);
          continue;
        }
        throw error;
      }
    }
  }
  private async execute(active: Active): Promise<void> {
    const { job, controller } = active;
    let heartbeatPending = false;
    let executionEnded = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void this.client
        .request<{ cancelRequested: boolean }>(
          "heartbeat",
          this.base(active.journal),
        )
        .then(
          (reply) => {
            if (executionEnded) return;
            if (reply.cancelRequested) {
              controller.abort();
              void Promise.resolve()
                .then(() => this.options.runtime.cancel(job.thread.id))
                .catch((error) => this.log(message(error)));
            }
          },
          (error) => {
            if (executionEnded) return;
            if (
              error instanceof WorkerTransportError ||
              (error instanceof WorkerHttpError && error.status >= 500)
            )
              this.networkLost(error);
            else this.lose(active, error);
          },
        )
        .finally(() => {
          heartbeatPending = false;
        });
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      const root = resolve(this.options.dataDir, "threads", job.thread.id);
      const moved = await placementChanged(root, job.thread.placementId);
      if (job.checkpoint && (moved || !existsSync(join(root, "session")))) {
        const reply = await this.client.request<{ checkpoint: string }>(
          "checkpoint-download",
          this.base(active.journal),
          { timeoutMs: 60_000, signal: controller.signal },
        );
        const recovered = await recoverCheckpoint(
          reply.checkpoint,
          job.thread.id,
          root,
          job.checkpoint.sha256,
        );
        if (recovered.preservedAt)
          this.log(
            `Recovered server checkpoint; prior partial data preserved at ${recovered.preservedAt}`,
          );
      } else if (moved && existsSync(join(root, "session")))
        throw new Error(
          "existing thread placement cannot be replaced without a server checkpoint",
        );
      await recordPlacement(root, job.thread.placementId);
      const result = await this.options.runtime.run(
        {
          threadId: job.thread.id,
          runId: job.run.id,
          placementId: job.thread.placementId,
          prompt: job.run.prompt,
          instructions: job.run.instructions,
          model: job.run.model ?? job.mower.model,
          workspaceRoot: join(root, "work"),
          sessionDir: join(root, "session"),
        },
        {
          durability: this.options.runtime.durabilityAdapter
            ? {
                load: async (afterSequence, signal) => {
                  try {
                    return await this.client.request<
                      import("@laun/protocol").RuntimeDurabilityPage
                    >(
                      "durable-load",
                      { ...this.base(active.journal), afterSequence },
                      {
                        timeoutMs: 60_000,
                        signal: signal
                          ? AbortSignal.any([signal, controller.signal])
                          : controller.signal,
                      },
                    );
                  } catch (error) {
                    if (
                      error instanceof WorkerTransportError ||
                      (error instanceof WorkerHttpError && error.status >= 500)
                    )
                      this.networkLost(error);
                    else this.lose(active, error);
                    throw error;
                  }
                },
                append: async (request, signal) => {
                  try {
                    return await this.client.request<{ sequence: number }>(
                      "durable-append",
                      { ...this.base(active.journal), ...request },
                      {
                        timeoutMs: 60_000,
                        signal: signal
                          ? AbortSignal.any([signal, controller.signal])
                          : controller.signal,
                      },
                    );
                  } catch (error) {
                    if (
                      error instanceof WorkerTransportError ||
                      (error instanceof WorkerHttpError && error.status >= 500)
                    )
                      this.networkLost(error);
                    else this.lose(active, error);
                    throw error;
                  }
                },
              }
            : undefined,
          inference:
            this.options.inferenceMode === "controller"
              ? {
                  describe: async (signal) => {
                    try {
                      return (
                        await this.client.request<{
                          envelope: import("@laun/protocol").RuntimeInferenceEnvelope;
                        }>("inference-describe", this.base(active.journal), {
                          signal: signal
                            ? AbortSignal.any([signal, controller.signal])
                            : controller.signal,
                        })
                      ).envelope;
                    } catch (error) {
                      this.lose(active, error);
                      throw error;
                    }
                  },
                  stream: async function* (
                    this: OutboundWorker,
                    request: import("@laun/protocol").RuntimeInferenceRequest,
                    signal?: AbortSignal,
                  ) {
                    try {
                      yield* this.client.inference(
                        this.base(active.journal),
                        request,
                        signal
                          ? AbortSignal.any([signal, controller.signal])
                          : controller.signal,
                      );
                    } catch (error) {
                      this.lose(active, error);
                      throw error;
                    }
                  }.bind(this),
                }
              : undefined,
          emit: (event) => this.emit(active, event),
          authorize: async (request) => {
            if (controller.signal.aborted)
              throw new WorkerHttpError("worker run cancelled", 499);
            try {
              await this.client.request(
                "authorize",
                {
                  ...this.base(active.journal),
                  operation: request.operation,
                  resource: request.resource,
                  arguments: request.arguments,
                  actionId: randomUUID(),
                },
                {
                  timeoutMs: this.approvalTimeoutMs,
                  signal: request.signal
                    ? AbortSignal.any([request.signal, controller.signal])
                    : controller.signal,
                },
              );
            } catch (error) {
              if (
                error instanceof WorkerTransportError ||
                (error instanceof WorkerHttpError && error.status >= 500)
              )
                this.networkLost(error);
              else if (
                error instanceof WorkerHttpError &&
                [401, 404, 409, 410].includes(error.status)
              )
                this.lose(active, error);
              throw error;
            }
          },
          invokeTool: async (name, args, signal) => {
            if (controller.signal.aborted)
              throw new WorkerHttpError("worker run cancelled", 499);
            try {
              const reply = await this.client.request<{ result: unknown }>(
                "invoke",
                { ...this.base(active.journal), name, arguments: args },
                {
                  timeoutMs: this.approvalTimeoutMs,
                  signal: signal
                    ? AbortSignal.any([signal, controller.signal])
                    : controller.signal,
                },
              );
              return reply.result;
            } catch (error) {
              if (
                error instanceof WorkerTransportError ||
                (error instanceof WorkerHttpError && error.status >= 500)
              )
                this.networkLost(error);
              else if (
                error instanceof WorkerHttpError &&
                [401, 404, 409, 410].includes(error.status)
              )
                this.lose(active, error);
              throw error;
            }
          },
        },
      );
      await active.events.catch(() => {});
      if (!active.lost && !active.fenced) {
        if (result.status === "interrupted") {
          active.journal.phase = "interrupted";
          active.journal.reason =
            result.summary ?? "Runtime could not verify execution shutdown";
        } else {
          active.journal.outcome = result;
          active.journal.phase = "settled";
        }
        this.save(active.journal);
      }
    } catch (error) {
      if (!active.lost && !active.fenced) {
        // Runtime failure may follow a committed external effect. Never submit
        // the prompt again automatically after an unclassified thrown error.
        active.journal.phase = "interrupted";
        active.journal.reason = `Runtime stopped with an uncertain outcome: ${message(error)}`;
        try {
          this.save(active.journal);
        } catch (storageError) {
          this.storageFailed = true;
          this.log(message(storageError));
        }
      }
    } finally {
      if (!this.storageFailed)
        try {
          await this.report(active.journal);
        } catch (error) {
          this.log(message(error));
        }
      executionEnded = true;
      clearInterval(heartbeat);
      this.active.delete(job.run.id);
    }
  }
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      if (this.options.runtime.cleanupThread && this.active.size === 0) {
        const controller = new AbortController();
        this.cleanupController = controller;
        const task = this.cleanupOnce(controller);
        this.cleanupTask = task;
        try {
          if (await task) return;
        } finally {
          if (this.cleanupTask === task) {
            this.cleanupTask = undefined;
            this.cleanupController = undefined;
          }
        }
      }
      if (this.stopped) return;
      if (this.startupCompaction && this.active.size === 0) {
        const batch = await this.journal.compactReportedBatch({ signal: this.shutdownController.signal });
        if (!batch.complete) return;
        this.startupCompaction = false;
      }
      if (this.storageFailed)
        throw new Error(
          "worker storage failed; inspect disk and restart before accepting work",
        );
      if (this.journalBlocked) {
        for (const state of this.journal.list()) {
          if (state.phase !== "running") continue;
          state.phase = "interrupted";
          state.reason = "Worker restarted during execution; prior side effects are unknown. Reconcile before resuming.";
          this.save(state);
        }
        this.journalBlocked = false;
      }
      await this.drain();
      try {
        requireDiskReserve(this.options.dataDir, this.options.minFreeDiskBytes);
      } catch (error) {
        for (const active of this.active.values()) this.lose(active, error);
        throw error;
      }
      if (this.active.size >= this.capacity + 1) return;
      const reply = await this.client.request<{ job: WorkerJob | null }>(
        "poll",
        {
          activeRunIds: [...this.active.keys()],
          capacity: this.capacity,
          checkpointVersion: this.options.runtime.checkpointVersion,
          inferenceMode: this.options.inferenceMode ?? "local",
          durabilityAdapter: this.options.runtime.durabilityAdapter,
        },
        { signal: this.shutdownController.signal },
      );
      if (this.stopped) return;
      if (!reply.job) return;
      assertJob(reply.job, this.workerId);
      const job = reply.job;
      if (this.active.has(job.run.id)) return;
      const previous = this.journal.read(job.run.id, job.run.generation);
      if (previous) {
        if (
          previous.phase === "running" ||
          previous.phase === "reported" ||
          previous.phase === "fenced"
        ) {
          previous.phase = "interrupted";
          previous.reason =
            "Controller redelivered a prior attempt; execution was not replayed.";
          this.save(previous);
        }
        await this.report(previous);
        return;
      }
      const state: RunJournal = {
        runId: job.run.id,
        threadId: job.thread.id,
        generation: job.run.generation,
        phase: "running",
        nextSequence: 0,
        events: [],
        updatedAt: new Date().toISOString(),
      };
      if (job.run.cancelRequested) {
        state.phase = "settled";
        state.outcome = {
          status: "cancelled",
          summary: "Cancellation was requested before worker dispatch",
        };
        this.save(state);
        await this.report(state);
        return;
      }
      this.save(state);
      const active: Active = {
        job,
        journal: state,
        controller: new AbortController(),
        lost: false,
        fenced: false,
        events: Promise.resolve(),
      };
      this.active.set(job.run.id, active);
      active.finished = this.execute(active);
    } catch (error) {
      if (
        error instanceof WorkerTransportError ||
        (error instanceof WorkerHttpError && error.status >= 500)
      )
        this.networkLost(error);
      throw error;
    } finally {
      this.ticking = false;
    }
  }
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        this.log(message(error));
      }
      if (!this.stopped) await delay(this.options.pollMs ?? 1000);
    }
  }
  async whenIdle(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map((active) => active.finished),
    );
    await this.cleanupTask;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.shutdownController.abort(new Error("worker shutdown requested"));
    this.cleanupController?.abort(new Error("worker shutdown requested"));
    try {
      const current = [...this.active.values()];
      for (const active of current)
        this.lose(
          active,
          new WorkerTransportError(
            "Worker stopped; prior attempt requires reconciliation.",
          ),
        );
      for (const active of current) active.controller.abort();
      await Promise.allSettled(
        current.map((active) =>
          this.options.runtime.cancel(active.job.thread.id),
        ),
      );
      await this.whenIdle();
      await this.journal.closeMaintenance();
      await this.options.runtime.close();
    } finally {
      this.release();
    }
  }
}
