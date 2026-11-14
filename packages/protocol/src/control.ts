import type { AgentEvent } from "./index.js";
import type { PermissionAction, PermissionOperation, PermissionProfile } from "./permissions.js";
import type { BrokerConnection } from "./broker.js";

export interface ControlContext {
  principalId: string; workspaceId: string; mowerId: string; threadId: string; runId: string;
}
export interface RuntimeRunInput {
  threadId: string; runId: string; prompt: string; model: string; workspaceRoot: string; sessionDir: string;
}
export interface RuntimePermissionRequest { operation: PermissionOperation; resource: string; arguments: unknown; signal?: AbortSignal }
export interface RuntimeCallbacks {
  emit(event: AgentEvent): void | Promise<void>;
  authorize(request: RuntimePermissionRequest): Promise<void>;
  invokeTool?(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface RuntimeResult { status: "done" | "cancelled" | "error"; summary?: string }
export interface RuntimeModel { id: string; name: string; provider: string; configured: boolean }
export interface AgentRuntime {
  run(input: RuntimeRunInput, callbacks: RuntimeCallbacks): Promise<RuntimeResult>;
  cancel(threadId: string): void | Promise<void>;
  close(): void | Promise<void>;
  listModels?(): Promise<RuntimeModel[]>;
}

export interface ControlPrincipal { id: string; admin: boolean }
export interface StoredProfile extends PermissionProfile {
  ownerId: string; name: string; createdAt: string; revokedAt?: string;
}
export interface MowerRecord {
  id: string; ownerId: string; workspaceId: string; name: string; role: "mower" | "director" | "adviser";
  model: string; profileId: string; profileVersion: number; workerId?: string; createdAt: string; archivedAt?: string;
}
export interface ThreadRecord {
  id: string; ownerId: string; workspaceId: string; mowerId: string; title: string; parentThreadId?: string;
  profileId: string; profileVersion: number; createdAt: string; updatedAt: string; archivedAt?: string;
}
export type ControlRunStatus = "queued" | "running" | "waiting_permission" | "done" | "error" | "cancelled" | "interrupted";
export interface ControlRun {
  id: string; ownerId: string; threadId: string; requestId: string; prompt: string; status: ControlRunStatus;
  workerId?: string; generation: number; leaseUntil?: string; createdAt: string; updatedAt: string;
  cancelRequested: boolean; summary?: string;
}
export interface ThreadEvent {
  sequence: number; threadId: string; runId?: string; createdAt: string;
  kind: "message" | "agent" | "approval" | "task" | "system";
  payload: { text?: string; role?: "user" | "assistant"; event?: AgentEvent; [key: string]: unknown };
}
export interface ControlApproval {
  id: string; ownerId: string; action: PermissionAction; profileId: string; profileVersion: number;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  createdAt: string; expiresAt: string; decidedAt?: string; decidedBy?: string;
  detail?: string;
}
export interface WorkerRecord {
  id: string; ownerId: string; name: string; labels: string[]; capacity: number; status: "online" | "offline" | "revoked";
  lastSeenAt?: string; createdAt: string; local: boolean;
}
export interface TaskRecord {
  id: string; ownerId: string; parentThreadId: string; threadId: string; mowerId: string; title: string;
  status: "queued" | "running" | "done" | "error" | "cancelled"; createdAt: string; updatedAt: string;
  handoffCount: number; result?: string;
}
export interface ControlState {
  mowers: MowerRecord[]; threads: ThreadRecord[]; runs: ControlRun[]; profiles: StoredProfile[];
  workers: WorkerRecord[]; tasks: TaskRecord[]; approvals: ControlApproval[]; connections: BrokerConnection[];
  readiness: { runtime: boolean; mode: "isolated" | "trusted-local" | "unconfigured"; message: string; defaultModel?: string };
}
export interface WorkerJob { run: ControlRun; thread: ThreadRecord; mower: MowerRecord; checkpoint?: string }
