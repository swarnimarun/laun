/**
 * Executor-level recovery for runs that die mid-flight.
 *
 * Measured failure: a run emits "The socket connection was closed
 * unexpectedly" mid-flight while the agent's own session shows the work
 * actually completed, and pi emits no auto_retry events for this error
 * class — so pi's own retry cannot help. This loop retries the run ourself,
 * in both json and rpc modes.
 *
 * Rules (see lane spec M2.7):
 * - Recover only when the attempt produced an `error` event and never
 *   produced `done`, and no abort was requested. A run that settled and
 *   then errored is finished; an aborted run stays dead.
 * - Retries continue, never repeat: the retry prompt is a continuation
 *   message (single exported constant below), not the original prompt.
 * - RUN_RECOVERY_ATTEMPTS bounds the number of *retries* after the initial
 *   run (total runs <= 1 + attempts). 0 disables recovery entirely.
 * - RUN_TIMEOUT_MS stays a wall-clock deadline across ALL attempts: each
 *   attempt gets the remaining budget, and backoff never sleeps past it.
 */
export const DEFAULT_RECOVERY_ATTEMPTS = 2;
export const DEFAULT_RECOVERY_BACKOFF_MS = 2000;
export const MAX_RECOVERY_ATTEMPTS = 10;
export const MAX_RECOVERY_BACKOFF_MS = 60000;

/**
 * Continuation prompt for recovery attempts. Tells the agent the previous
 * turn was cut off by a transport error and to resume without redoing
 * completed work. Kept in one exported constant so it is testable and
 * reviewable. Must stay free of double quotes and backslashes so tests can
 * match it verbatim inside the JSONL the stubs log.
 */
export const RECOVERY_CONTINUATION_PROMPT =
  "The previous turn was cut off by a transport error before its result reached the client. " +
  "Your session history is intact: resume from where you left off and complete the remaining work. " +
  "Do not repeat side effects (file writes, shell commands) that already succeeded — " +
  "verify current state first and continue without redoing completed work.";

/** Status message emitted before each retry. Must start with "retrying (". */
export function retryingMessage(retryIndex: number, maxRetries: number, firstError: string): string {
  return `retrying (${retryIndex}/${maxRetries}): ${firstError}`;
}

/** Terminal status message when every attempt failed. Names the attempt count. */
export function recoveryExhaustedMessage(totalRuns: number, firstError: string): string {
  return `run failed after ${totalRuns} attempts: ${firstError}`;
}

/** Sleep that resolves early when `signal` aborts (used for backoff). */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RecoveryAttemptResult {
  sawError: boolean;
  sawDone: boolean;
  aborted: boolean;
  /** Message of the first error event this attempt produced, if any. */
  firstError: string | null;
  /** Last attempt's exit code (json mode; used only for the terminal message). */
  exitCode?: number | null;
  /** The attempt hit its own timeout (rpc mode; implies sawError). */
  timedOut?: boolean;
}

export interface RecoveryLoopResult extends RecoveryAttemptResult {
  /** Total runs performed, initial attempt included. Never exceeds 1 + maxRetries. */
  totalRuns: number;
}

export interface RecoveryLoopOptions {
  /** Max retries after the initial run. 0 disables recovery. */
  maxRetries: number;
  backoffMs: number;
  /** Full budget for the initial attempt (RUN_TIMEOUT_MS, clamped). */
  timeoutMs: number;
  /** Wall-clock deadline (epoch ms) shared by all attempts. */
  deadline: number;
  signal?: AbortSignal;
  initialPrompt: string;
  onRetrying: (retryIndex: number, maxRetries: number, firstError: string) => void;
  attempt: (prompt: string, timeoutMs: number) => Promise<RecoveryAttemptResult>;
}

/**
 * Run one attempt, then retry on transport failure until the run settles,
 * aborts, exhausts retries, or hits the shared deadline. Attempts are
 * strictly sequential: an attempt's child is always reaped (the attempt
 * promise only resolves after its child closes) before the next starts.
 */
export async function runWithRecovery(opts: RecoveryLoopOptions): Promise<RecoveryLoopResult> {
  let prompt = opts.initialPrompt;
  let totalRuns = 0;
  let firstError: string | null = null;
  let last: RecoveryAttemptResult = { sawError: false, sawDone: false, aborted: false, firstError: null, exitCode: null, timedOut: false };

  for (;;) {
    const budget = totalRuns === 0 ? opts.timeoutMs : opts.deadline - Date.now();
    if (budget <= 0) break;
    if (opts.signal?.aborted) break;
    last = await opts.attempt(prompt, budget);
    totalRuns += 1;
    if (firstError === null && last.firstError !== null) firstError = last.firstError;
    const aborted = last.aborted || opts.signal?.aborted === true;
    // Settle or abort: never recover a run that produced done, or one the
    // operator stopped. A settled-then-errored run is finished.
    if (!last.sawError || last.sawDone || aborted) {
      return { ...last, firstError, totalRuns, aborted };
    }
    // Retries exhausted: totalRuns - 1 recovery attempts have been used.
    if (totalRuns - 1 >= opts.maxRetries) {
      return { ...last, firstError, totalRuns, aborted: false };
    }
    opts.onRetrying(totalRuns, opts.maxRetries, firstError ?? "unknown error");
    // Backoff, bounded by the shared deadline so total wall clock never
    // exceeds it, and woken early by an operator abort.
    const sleepMs = Math.min(opts.backoffMs, Math.max(0, opts.deadline - Date.now()));
    if (sleepMs > 0) await sleepAbortable(sleepMs, opts.signal);
    if (opts.signal?.aborted) {
      return { ...last, firstError, totalRuns, aborted: true };
    }
    if (Date.now() >= opts.deadline) {
      return { ...last, firstError, totalRuns, aborted: false };
    }
    prompt = RECOVERY_CONTINUATION_PROMPT;
  }
  return { ...last, firstError, totalRuns, aborted: opts.signal?.aborted === true || last.aborted };
}
