import type { CapabilityRule, PermissionAction, PermissionEffect, PermissionGrant,
  PermissionOperation, PermissionProfile, PermissionVerdict } from "@laun/protocol";

const OPERATIONS = new Set<PermissionOperation>(["workspace.read", "workspace.write", "process.execute", "network.connect",
  "mcp.invoke", "connector.send", "mower.spawn", "task.handoff"]);
const MODES = new Set(["isolated", "manual", "auto"]);
const EFFECTS = new Set(["allow", "deny", "ask"]);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const ACTION_KEYS = ["id", "principalId", "mowerId", "threadId", "runId", "generation", "workspaceId", "operation", "resource", "argumentsDigest"] as const;

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  if (!object(value) || !text(value.id) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
      !MODES.has(value.mode as string) || !Array.isArray(value.rules) || value.rules.length > 1024) return false;
  return value.rules.every((r: unknown) => object(r) && OPERATIONS.has(r.operation as PermissionOperation) && text(r.resource) && EFFECTS.has(r.effect as string));
}

export function isPermissionAction(value: unknown): value is PermissionAction {
  return object(value) && ["id", "principalId", "mowerId", "threadId", "runId", "workspaceId", "resource"].every((k) => text(value[k])) &&
    (value.generation===undefined||(Number.isSafeInteger(value.generation)&&Number(value.generation)>0))&&OPERATIONS.has(value.operation as PermissionOperation) && digest(value.argumentsDigest);
}

function effectiveRule(profile: PermissionProfile, operation: PermissionOperation, resource: string): PermissionEffect | undefined {
  const matches = profile.rules.filter((r) => r.operation === operation && r.resource === resource);
  // Combining duplicate entries must never let allow overwrite a restriction.
  if (matches.some((r) => r.effect === "deny")) return "deny";
  if (matches.some((r) => r.effect === "ask")) return "ask";
  if (matches.some((r) => r.effect === "allow")) return "allow";
  return undefined;
}

function sameAction(a: PermissionAction, b: unknown): boolean {
  return isPermissionAction(b) && ACTION_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Pure decision kernel, not an enforcement boundary. The caller authenticates
 * identities, canonicalizes resources/arguments, loads trusted grants and
 * current revocations, then atomically consumes a grant with dispatch.
 * Auto mode asks an adviser; it cannot invent authority. No wildcard matching.
 */
export function evaluatePermission(
  profile: unknown,
  action: unknown,
  options: { nowMs: number; revoked?: boolean; grant?: PermissionGrant } ,
): PermissionVerdict {
  const deny = (reason: PermissionVerdict["reason"]): PermissionVerdict => ({ effect: "deny", reason });
  if (!isPermissionProfile(profile) || !isPermissionAction(action) || !Number.isFinite(options.nowMs)) return deny("invalid_input");
  if (options.revoked) return deny("revoked");
  const effect = effectiveRule(profile, action.operation, action.resource);
  if (effect === "deny") return deny("explicit_deny");
  if (effect === undefined) return deny("no_rule");
  if (effect === "allow") return { effect: "allow", reason: "rule_allow" };
  if (profile.mode === "isolated") return deny("isolated");
  const grant = options.grant;
  if (grant !== undefined) {
    if (!object(grant) || !text(grant.id) || !text(grant.approvedBy) || grant.profileId !== profile.id ||
        grant.profileVersion !== profile.version || !sameAction(action, grant.action) || typeof grant.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= options.nowMs) return deny("invalid_grant");
    return { effect: "allow", reason: "grant_allow" };
  }
  return { effect: "ask", reason: "approval_required" };
}

/**
 * Profile-only attenuation, before assignments or grants. The future broker
 * must also enforce ancestor revocations/grants and delegated resource scope.
 * Returning true does not grant a mower permission to create a child.
 */
export function canDelegateProfile(parent: unknown, child: unknown): boolean {
  if (!isPermissionProfile(parent) || !isPermissionProfile(child)) return false;
  // Automatic permission dialogue must be explicitly delegated by an auto parent.
  const autonomy = { isolated: 0, manual: 1, auto: 2 };
  if (autonomy[child.mode] > autonomy[parent.mode]) return false;
  // Iterate the union: omitted parent denies still deny, omitted child rules narrow.
  const rules: CapabilityRule[] = [...parent.rules, ...child.rules];
  for (const { operation, resource } of rules) {
    const p = effectiveRule(parent, operation, resource) ?? "deny";
    const c = effectiveRule(child, operation, resource) ?? "deny";
    const rank = { deny: 0, ask: 1, allow: 2 };
    // In isolated mode an ask can never receive a grant.
    const pe = parent.mode === "isolated" && p === "ask" ? "deny" : p;
    const ce = child.mode === "isolated" && c === "ask" ? "deny" : c;
    if (rank[ce] > rank[pe]) return false;
  }
  return true;
}
