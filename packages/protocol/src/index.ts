// Shared contract for cloudbear services.
// Gateway, executor, and telegram-bridge must import from here.
// No pi/goose/dots-specific wire details outside the executor.

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
}

export type AgentEvent =
  | { type: "status"; sessionId: string; status: SessionStatus; message?: string }
  | { type: "text"; sessionId: string; delta: string }
  | { type: "tool_call"; sessionId: string; name: string; args?: unknown }
  | { type: "tool_result"; sessionId: string; name: string; ok: boolean; output?: string }
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

export function normalizeCreateSession(input: CreateSessionRequest): Required<Pick<CreateSessionRequest, "model" | "runtime">> & CreateSessionRequest {
  const goal = (input.goal ?? "").trim();
  if (!goal) throw new Error("goal is required");
  if (goal.length > 8000) throw new Error("goal too long (max 8000 chars)");
  return {
    ...input,
    goal,
    model: input.model?.trim() || DEFAULT_MODEL,
    runtime: input.runtime ?? DEFAULT_RUNTIME,
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
