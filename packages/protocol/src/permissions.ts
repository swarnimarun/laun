/** Runtime-neutral authorization contracts. All identities are server-derived. */
export type PermissionMode = "isolated" | "manual" | "auto";
export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionOperation =
  | "workspace.read" | "workspace.write" | "process.execute" | "network.connect"
  | "mcp.invoke" | "connector.send" | "mower.spawn" | "task.handoff";

/** Exact resource identifiers only. Adapters canonicalize before evaluation. */
export interface CapabilityRule {
  operation: PermissionOperation;
  resource: string;
  effect: PermissionEffect;
}

/** Immutable versions: updates produce a new version, assignments are explicit. */
export interface PermissionProfile {
  id: string;
  version: number;
  mode: PermissionMode;
  rules: CapabilityRule[];
}

export interface PermissionAction {
  id: string;
  principalId: string;
  mowerId: string;
  threadId: string;
  runId: string;
  workspaceId: string;
  operation: PermissionOperation;
  resource: string;
  /** Lowercase SHA-256 of broker-canonicalized arguments; never raw secrets. */
  argumentsDigest: string;
}

/** Trusted broker record. Never accept this shape as proof from an agent. */
export interface PermissionGrant {
  id: string;
  profileId: string;
  profileVersion: number;
  action: PermissionAction;
  approvedBy: string;
  expiresAt: string;
}

export type PermissionVerdict = {
  effect: PermissionEffect;
  reason: "invalid_input" | "revoked" | "explicit_deny" | "no_rule" | "isolated"
    | "rule_allow" | "approval_required" | "grant_allow" | "invalid_grant";
};
