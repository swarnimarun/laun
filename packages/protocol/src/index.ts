// Shared contract for laun services.
// Gateway, executor, and telegram-bridge must import from here.
// No pi/goose/dots-specific wire details outside the executor.

export { isAgentEvent, isTerminalAgentEvent } from "./events.js";
export type { CheckpointFile, ThreadCheckpoint, CheckpointReference } from "./checkpoint.js";
export type { InferenceJsonValue, RuntimeInferenceEnvelope, RuntimeInferenceRequest, RuntimeInferenceUsage, RuntimeInferenceClient, RuntimeInferenceService, WorkerInferenceStreamItem } from "./inference.js";
export type { BrokerConnection, BrokerContext, BrokerTool, BrokerToolResult, McpProtocolVersion, PermissionProposal } from "./broker.js";
export type { TelegramIdentity, TelegramInboundUpdate, TelegramDelivery, TelegramIngestResult, TelegramLinkCode } from "./connector.js";
export type { AdviceResult } from "./advice.js";
export type { ControlContext, RuntimeRunInput, RuntimePermissionRequest, RuntimeCallbacks, RuntimeResult, RuntimeModel, AgentRuntime,
  ControlPrincipal, StoredProfile, MowerRecord, ThreadRecord, ControlRunStatus, ControlRun, ThreadEvent,
  ControlApproval, WorkerCapabilities, WorkerRecord, TaskRecord, ControlState, WorkerJob } from "./control.js";

export type { CapabilityRule, PermissionAction, PermissionEffect, PermissionGrant, PermissionMode,
  PermissionOperation, PermissionProfile, PermissionVerdict } from "./permissions.js";

export type RuntimeKind = "pi" | "goose" | "dots";

export type SessionStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "done"
  | "error";

export interface CreateSessionRequest {
  goal: string;
  /** Optional repo path or URL checked out inside the executor workdir. */
  repo?: string;
  /** Pi-style model ref, e.g. "opencode-go/muse-spark-1.3-contributor". */
  model?: string;
  runtime?: RuntimeKind;
}

export interface SendMessageRequest {
  text: string;
  /**
   * Delivery intent for a busy session. `steer` interrupts with new
   * direction, `queue` appends after the run. Gateway honors this once
   * steer/queue lands; until then the gateway keeps returning 409.
   */
  mode?: "steer" | "queue";
}

export type ApprovalDecisionValue = "approve" | "deny";

export interface ApprovalDecision {
  requestId: string;
  decision: ApprovalDecisionValue;
  note?: string;
}

export interface ExecutorRunRequest {
  sessionId: string;
  prompt: string;
  model?: string;
  /** Absolute workdir the agent runs in. Executor must confine it. */
  workdir?: string;
  timeoutMs?: number;
  /** Repo path or URL the executor checks out before starting (if set). */
  repo?: string;
  /** Runtime harness (executor routes goose/dots to its ACP adapter). */
  runtime?: RuntimeKind;
}

export type AgentEvent =
  | { type: "status"; sessionId: string; status: SessionStatus; message?: string }
  | { type: "text"; sessionId: string; delta: string }
  | { type: "tool_call"; sessionId: string; name: string; args?: unknown }
  | { type: "tool_result"; sessionId: string; name: string; ok: boolean; output?: string }
  /**
   * A coalesced chunk of model reasoning. The executor batches thinking
   * deltas (flush at >=300 chars or on a reasoning boundary) so a long
   * reasoning block cannot flood the gateway's bounded event ring.
   */
  | { type: "thinking"; sessionId: string; delta: string }
  /**
   * Token/cost accounting surfaced from the harness (pi reports `usage`
   * on `message_update`). All fields optional: forward what the harness
   * gives, omit the rest.
   */
  | { type: "usage"; sessionId: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }
  | { type: "approval_request"; sessionId: string; requestId: string; reason: string; detail?: string }
  | { type: "done"; sessionId: string; summary?: string }
  | { type: "error"; sessionId: string; message: string };

export interface SessionRecord {
  id: string;
  goal: string;
  repo?: string;
  model: string;
  runtime: RuntimeKind;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_MODEL = "opencode-go/muse-spark-1.3-contributor";
export const DEFAULT_RUNTIME: RuntimeKind = "pi";
export const GATEWAY_PORT = 8080;
export const EXECUTOR_PORT = 8081;

export function normalizeCreateSession(input: unknown): Required<Pick<CreateSessionRequest, "model" | "runtime">> & CreateSessionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("session must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.goal !== "string") throw new Error("goal is required and must be a string");
  const goal = value.goal.trim();
  if (!goal) throw new Error("goal is required");
  if (goal.includes("\0")) throw new Error("goal must not contain NUL");
  if (goal.length > 8000) throw new Error("goal too long (max 8000 chars)");
  for (const [key, max] of [["repo", 4096], ["model", 256]] as const) {
    const v = value[key];
    if (v !== undefined && (typeof v !== "string" || v.length > max || v.includes("\0"))) {
      throw new Error(`${key} must be a string of at most ${max} chars without NUL`);
    }
  }
  const runtime = value.runtime ?? DEFAULT_RUNTIME;
  if (runtime !== "pi" && runtime !== "goose" && runtime !== "dots") throw new Error("unsupported runtime");
  return {
    goal,
    repo: (value.repo as string | undefined)?.trim() || undefined,
    model: (value.model as string | undefined)?.trim() || DEFAULT_MODEL,
    runtime,
  };
}

/** "123,456" -> ["123","456"]. Empty env -> []. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowlisted(userId: string | number, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false; // fail closed
  return allowlist.includes(String(userId));
}

export function checkBearer(authHeader: string | null | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  if (!authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = m[1].trim();
  if (got.length !== expectedToken.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Agent keys: the human-facing credential minted by `laun setup` and used
// by the CLI and web UI. Distinct from GATEWAY_TOKEN, which stays service-only.
// Wire form: laun_<id>_<secret>. Only the sha256 of <secret> is ever stored.
// ---------------------------------------------------------------------------

export type { PublicAgentKeyRecord, GatewayMe } from "./identity.js";
export type { ControlBackupManifest, ControlRestoreResult } from "./backup.js";
export type { ThreadProfileRebase, ThreadWorkerMove, ThreadLifecycleResult } from "./lifecycle.js";

export const AGENT_KEY_PREFIX = "laun";
const AGENT_KEY_RE = /^laun_([0-9a-f]{8,32})_([A-Za-z0-9_-]{20,128})$/;
const KEY_ID_RE = /^[0-9a-f]{8,32}$/;

export interface AgentKeyParts {
  id: string;
  secret: string;
}

export function formatAgentKey(id: string, secret: string): string {
  if (!KEY_ID_RE.test(id)) throw new Error("invalid agent key id");
  if (!AGENT_KEY_RE.test(`${AGENT_KEY_PREFIX}_${id}_${secret}`)) throw new Error("invalid agent key secret");
  return `${AGENT_KEY_PREFIX}_${id}_${secret}`;
}

/** Strict parse. Returns null for anything that is not a well-formed agent key. */
export function parseAgentKey(raw: string | null | undefined): AgentKeyParts | null {
  if (!raw) return null;
  const m = raw.trim().match(AGENT_KEY_RE);
  if (!m) return null;
  return { id: m[1], secret: m[2] };
}

/** Extract a bearer token from an authorization header, if present. */
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
