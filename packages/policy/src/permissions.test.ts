import { describe, expect, test } from "bun:test";
import type { CapabilityRule, PermissionAction, PermissionGrant, PermissionProfile } from "@laun/protocol";
import { canDelegateProfile, evaluatePermission, isPermissionAction, isPermissionProfile } from "./permissions.js";

const action: PermissionAction = { id: "a", principalId: "owner", mowerId: "fern", threadId: "t", runId: "r", workspaceId: "w",
  operation: "mcp.invoke", resource: "github:issues:create", argumentsDigest: "a".repeat(64) };
const nowMs = Date.parse("2026-11-14T00:00:00Z");
const rule = (effect: CapabilityRule["effect"], resource = action.resource): CapabilityRule => ({ operation: action.operation, resource, effect });
const profile = (rules: CapabilityRule[], mode: PermissionProfile["mode"] = "manual"): PermissionProfile => ({ id: "p", version: 1, rules, mode });
const grant = (): PermissionGrant => ({ id: "grant", profileId: "p", profileVersion: 1, action: { ...action }, approvedBy: "human",
  expiresAt: new Date(nowMs + 60_000).toISOString() });

describe("deterministic permission kernel", () => {
  test("defaults to deny; resources never imply prefix or wildcard matching", () => {
    for (const rules of [[], [rule("allow", "github:*")], [rule("allow", "github:issues")]]) {
      expect(evaluatePermission(profile(rules), action, { nowMs })).toEqual({ effect: "deny", reason: "no_rule" });
    }
    expect(evaluatePermission(profile([rule("allow")]), action, { nowMs })).toEqual({ effect: "allow", reason: "rule_allow" });
  });

  test("deny beats ask and allow in any rule order, including with an approval", () => {
    for (const rules of [[rule("allow"), rule("deny"), rule("ask")], [rule("deny"), rule("ask"), rule("allow")]]) {
      expect(evaluatePermission(profile(rules), action, { nowMs, grant: grant() })).toEqual({ effect: "deny", reason: "explicit_deny" });
    }
    expect(evaluatePermission(profile([rule("allow"), rule("ask")]), action, { nowMs }).effect).toBe("ask");
  });

  test("auto dialogue never grants; isolated never asks", () => {
    expect(evaluatePermission(profile([rule("ask")], "auto"), action, { nowMs })).toEqual({ effect: "ask", reason: "approval_required" });
    expect(evaluatePermission(profile([rule("ask")], "isolated"), action, { nowMs, grant: grant() })).toEqual({ effect: "deny", reason: "isolated" });
  });

  test("approval is context bound and cannot override revocation or missing rules", () => {
    expect(evaluatePermission(profile([rule("ask")]), action, { nowMs, grant: grant() }).effect).toBe("allow");
    expect(evaluatePermission(profile([rule("ask")]), action, { nowMs, grant: grant(), revoked: true }).reason).toBe("revoked");
    expect(evaluatePermission(profile([]), action, { nowMs, grant: grant() }).reason).toBe("no_rule");
    for (const key of Object.keys(action) as (keyof PermissionAction)[]) {
      const g = grant();
      (g.action as unknown as Record<string, unknown>)[key] = key === "argumentsDigest" ? "b".repeat(64) : "other";
      expect(evaluatePermission(profile([rule("ask")]), action, { nowMs, grant: g }).reason).toBe("invalid_grant");
    }
    for (const patch of [{ profileId: "other" }, { profileVersion: 2 }, { approvedBy: "" }, { expiresAt: "invalid" },
      { expiresAt: new Date(nowMs).toISOString() }, { expiresAt: new Date(nowMs - 1).toISOString() }]) {
      expect(evaluatePermission(profile([rule("ask")]), action, { nowMs, grant: { ...grant(), ...patch } }).reason).toBe("invalid_grant");
    }
    expect(evaluatePermission({ ...profile([rule("ask")]), version: 2 }, action, { nowMs, grant: grant() }).reason).toBe("invalid_grant");
    const inheritedAction = Object.create(action);
    const otherGrant = grant();
    otherGrant.action.threadId = "sibling";
    expect(evaluatePermission(profile([rule("ask")]), inheritedAction, { nowMs, grant: otherGrant }).reason).toBe("invalid_grant");
  });

  test("rejects forged modes, operations, effects, digests and malformed records", () => {
    for (const value of [null, [], {}, { ...profile([]), mode: "root" }, { ...profile([]), version: 0 },
      profile([{ ...rule("allow"), effect: "yes" } as never]), profile([{ ...rule("allow"), operation: "admin" } as never])]) {
      expect(isPermissionProfile(value)).toBe(false);
      expect(evaluatePermission(value, action, { nowMs }).reason).toBe("invalid_input");
    }
    for (const value of [null, [], {}, { ...action, workspaceId: "" }, { ...action, resource: "a\0b" },
      { ...action, argumentsDigest: "raw-secret" }, { ...action, operation: "admin" }]) {
      expect(isPermissionAction(value)).toBe(false);
      expect(evaluatePermission(profile([rule("allow")]), value, { nowMs }).reason).toBe("invalid_input");
    }
    expect(evaluatePermission(profile([]), action, { nowMs: NaN }).reason).toBe("invalid_input");
  });
});

describe("profile delegation attenuation", () => {
  test("cannot gain missing rules, turn asks into allows or drop effective denies", () => {
    expect(canDelegateProfile(profile([]), profile([rule("ask")]))).toBe(false);
    expect(canDelegateProfile(profile([rule("ask")]), profile([rule("allow")]))).toBe(false);
    expect(canDelegateProfile(profile([rule("deny"), rule("allow")]), profile([rule("allow")]))).toBe(false);
    expect(canDelegateProfile(profile([rule("allow"), rule("deny")]), profile([rule("ask")]))).toBe(false);
    expect(canDelegateProfile(profile([rule("ask"), rule("allow")]), profile([rule("allow")]))).toBe(false);
  });

  test("can narrow or remove authority, never increase autonomy", () => {
    expect(canDelegateProfile(profile([rule("allow")], "auto"), profile([rule("ask")], "manual"))).toBe(true);
    expect(canDelegateProfile(profile([rule("allow")]), profile([]))).toBe(true);
    expect(canDelegateProfile(profile([rule("deny")]), profile([]))).toBe(true);
    expect(canDelegateProfile(profile([], "manual"), profile([], "auto"))).toBe(false);
    expect(canDelegateProfile(profile([rule("ask")], "isolated"), profile([rule("allow")], "isolated"))).toBe(false);
    expect(canDelegateProfile(null, profile([]))).toBe(false);
  });
});
