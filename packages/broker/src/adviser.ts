import { randomUUID } from "node:crypto";
import type { PermissionAction, PermissionProfile, PermissionProposal } from "@laun/protocol";
import { isPermissionAction, isPermissionProfile } from "@laun/policy";

/** Safe adviser primitive: dialogue proposes an ask rule, never a persisted grant. */
export function proposePermissionChange(profile: PermissionProfile, action: PermissionAction, feedback: string, now = new Date()): PermissionProposal {
  if (!isPermissionProfile(profile) || !isPermissionAction(action)) throw new Error("invalid permission proposal context");
  if (typeof feedback !== "string" || !feedback.trim() || feedback.length > 8_000 || /\0/.test(feedback)) throw new Error("feedback must be 1-8000 characters");
  if (!Number.isFinite(now.getTime())) throw new Error("invalid proposal time");
  if (profile.rules.some((r) => r.operation === action.operation && r.resource === action.resource && r.effect === "deny")) {
    throw new Error("an explicit deny requires an owner-reviewed guardrail change; adviser cannot override it");
  }
  const rule = { operation: action.operation, resource: action.resource, effect: "ask" as const };
  const rules = profile.rules.filter((r) => !(r.operation === rule.operation && r.resource === rule.resource));
  if (rules.length >= 1024) throw new Error("profile rule limit exceeded");
  return {
    id: randomUUID(), status: "proposed", baseProfileId: profile.id, baseProfileVersion: profile.version, actionId: action.id,
    rule, explanation: `This mower requested ${action.operation} on ${action.resource}. An ask rule keeps each action subject to an explicit decision.`,
    question: "Should this mower ask for this resource, work within its current permissions, or stop the dependent task?",
    feedback: feedback.trim(), createdAt: now.toISOString(),
    suggestedProfile: { id: profile.id, version: profile.version + 1, mode: profile.mode, rules: [...rules.map((r) => ({ ...r })), rule] },
  };
}
