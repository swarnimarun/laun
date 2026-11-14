import type { CapabilityRule, PermissionAction, PermissionProfile } from "./permissions.js";

/** Authenticated identities supplied by the server, never inferred from tool args. */
export type BrokerContext = Pick<PermissionAction, "principalId" | "workspaceId" | "mowerId" | "threadId" | "runId">;
export type McpProtocolVersion = "2026-07-28" | "2025-11-25";

export interface BrokerTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Complete discovered definition for identity revalidation, including annotations. */
  definition: Record<string, unknown>;
  /** SHA-256 of endpoint, protocol and complete tool definition, not just its name. */
  schemaDigest: string;
  resource: string;
}

/** Persisted connector metadata. Secret values are resolved separately in broker memory. */
export interface BrokerConnection {
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  transport: "http";
  url: string;
  protocolVersion?: McpProtocolVersion;
  secretRef?: string;
  /** Requires a separate controller-level loopback development exception. */
  allowLocal?: boolean;
  enabled?: boolean;
  tools?: BrokerTool[];
  catalogDigest?: string;
  discoveredAt?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Adviser output only. Applying this is a distinct authorized profile revision action. */
export interface PermissionProposal {
  id: string;
  status: "proposed";
  baseProfileId: string;
  baseProfileVersion: number;
  actionId: string;
  rule: CapabilityRule;
  explanation: string;
  question: string;
  feedback: string;
  createdAt: string;
  suggestedProfile: PermissionProfile;
}
