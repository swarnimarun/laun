import type {
  AgentRuntime,
  HostCleanupJob,
  HostCleanupPlan,
  RuntimeThreadCleanupResult,
} from "@laun/protocol";
import { WorkerClient, WorkerHttpError } from "./client.js";
import { WorkerJournal } from "./journal.js";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertCleanupJob(
  value: unknown,
): asserts value is HostCleanupJob {
  const job = value as HostCleanupJob;
  if (
    !job ||
    typeof job !== "object" ||
    ![job.planId, job.threadId].every(
      (id) => typeof id === "string" && ID.test(id),
    ) ||
    !Number.isSafeInteger(job.generation) ||
    job.generation < 1 ||
    !Array.isArray(job.placementIds) ||
    job.placementIds.length > 100_000 ||
    job.placementIds.some((id) => typeof id !== "string" || !ID.test(id)) ||
    new Set(job.placementIds).size !== job.placementIds.length ||
    !job.leaseUntil ||
    !Number.isFinite(Date.parse(job.leaseUntil)) ||
    Date.parse(job.leaseUntil) <= Date.now()
  )
    throw new WorkerHttpError(
      "invalid or expired controller host cleanup lease",
      409,
    );
}
function output(value: unknown): RuntimeThreadCleanupResult {
  const result = value as RuntimeThreadCleanupResult;
  if (
    !result ||
    typeof result.verified !== "boolean" ||
    !Number.isSafeInteger(result.removedPaths) ||
    result.removedPaths < 0 ||
    !Number.isSafeInteger(result.removedSandboxes) ||
    result.removedSandboxes < 0 ||
    !Array.isArray(result.outstanding) ||
    result.outstanding.length > 100 ||
    result.outstanding.some(
      (item) => typeof item !== "string" || !item || item.length > 1000,
    )
  )
    throw new Error(
      "runtime returned an invalid host cleanup verification result",
    );
  return {
    verified: result.verified,
    removedPaths: result.removedPaths,
    removedSandboxes: result.removedSandboxes,
    outstanding: [...result.outstanding],
  };
}
/** A single approved attempt. Unknown outcomes require new server-side review. */
export async function performHostCleanup(options: {
  client: WorkerClient;
  runtime: AgentRuntime;
  journal: WorkerJournal;
  job: HostCleanupJob;
  signal: AbortSignal;
  heartbeatMs: number;
  activeRunIds: ReadonlySet<string>;
  sanitize: (result: RuntimeThreadCleanupResult) => RuntimeThreadCleanupResult;
}): Promise<HostCleanupPlan> {
  const { client, runtime, journal, job } = options;
  assertCleanupJob(job);
  if (!runtime.cleanupThread || options.activeRunIds.size)
    throw new Error(
      "host cleanup requires an idle worker with a configured cleanup adapter",
    );
  const controller = new AbortController(),
    signal = AbortSignal.any([options.signal, controller.signal]);
  let leaseTimer: ReturnType<typeof setTimeout> | undefined,
    interval: ReturnType<typeof setInterval> | undefined,
    pending: Promise<void> | undefined,
    finished = false,
    heartbeatFailure: unknown;
  const arm = (until: string) => {
    if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())
      throw new WorkerHttpError(
        "host cleanup lease expired before deletion",
        409,
      );
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(
      () => controller.abort(new Error("host cleanup lease expired")),
      Date.parse(until) - Date.now(),
    );
    leaseTimer.unref();
  };
  const renew = async () => {
    signal.throwIfAborted();
    const reply = await client.request<{
      cancelRequested: false;
      leaseUntil: string;
    }>(
      "cleanup-heartbeat",
      { planId: job.planId, generation: job.generation },
      { signal },
    );
    if (finished) return;
    signal.throwIfAborted();
    if (reply.cancelRequested !== false)
      throw new WorkerHttpError("host cleanup approval was withdrawn", 409);
    arm(reply.leaseUntil);
  };
  arm(job.leaseUntil);
  try {
    // No filesystem or sandbox effect before an authenticated lease check.
    await renew();
    interval = setInterval(() => {
      if (pending || finished || signal.aborted) return;
      pending = renew()
        .catch((error) => {
          if (!finished) {
            heartbeatFailure = error;
            controller.abort(error);
          }
        })
        .finally(() => {
          pending = undefined;
        });
    }, options.heartbeatMs);
    interval.unref();
    let result: RuntimeThreadCleanupResult;
    try {
      result = output(
        await runtime.cleanupThread({
          threadId: job.threadId,
          placementIds: [...job.placementIds],
          confirmedStopped: true,
          signal,
        }),
      );
    } catch (error) {
      if (signal.aborted) throw heartbeatFailure ?? error;
      result = {
        verified: false,
        removedPaths: 0,
        removedSandboxes: 0,
        outstanding: [
          `Host cleanup outcome is unknown: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            1000,
          ),
        ],
      };
    }
    signal.throwIfAborted();
    if (result.verified && !result.outstanding.length) {
      await renew();
      try {
        const pruned = await journal.pruneThread(job.threadId, {
          signal,
          activeRunIds: options.activeRunIds,
        });
        result.removedPaths += pruned.removed;
        result.outstanding.push(...pruned.outstanding);
        if (pruned.outstanding.length) result.verified = false;
      } catch (error) {
        if (signal.aborted) throw error;
        result.verified = false;
        result.outstanding.push(
          "Worker journal cleanup could not verify its private storage boundary; remaining files were preserved.",
        );
      }
    }
    signal.throwIfAborted();
    await renew();
    const reply = await client.request<{ plan: HostCleanupPlan }>(
      "cleanup-finish",
      {
        planId: job.planId,
        generation: job.generation,
        result: options.sanitize(result),
      },
      { signal },
    );
    finished = true;
    return reply.plan;
  } finally {
    finished = true;
    clearInterval(interval);
    clearTimeout(leaseTimer);
    controller.abort();
    await pending?.catch(() => {});
  }
}
