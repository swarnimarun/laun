import { describe, expect, test } from "bun:test";
import {
  checkBearer,
  isAllowlisted,
  normalizeCreateSession,
  parseAllowlist,
} from "./index.js";

describe("protocol", () => {
  test("normalizeCreateSession applies defaults", () => {
    const s = normalizeCreateSession({ goal: "  fix tests  " });
    expect(s.goal).toBe("fix tests");
    expect(s.model).toBe("x-ai/grok-4.6");
    expect(s.runtime).toBe("pi");
  });

  test("normalizeCreateSession rejects empty goal", () => {
    expect(() => normalizeCreateSession({ goal: "   " })).toThrow("goal is required");
  });

  test("parseAllowlist + isAllowlisted fail closed", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(isAllowlisted("123", [])).toBe(false);
    const list = parseAllowlist("123, 456 789");
    expect(list).toEqual(["123", "456", "789"]);
    expect(isAllowlisted(456, list)).toBe(true);
    expect(isAllowlisted("999", list)).toBe(false);
  });

  test("checkBearer compares tokens", () => {
    expect(checkBearer("Bearer abc", "abc")).toBe(true);
    expect(checkBearer("Bearer abc", "abd")).toBe(false);
    expect(checkBearer("Bearer ab", "abc")).toBe(false);
    expect(checkBearer(undefined, "abc")).toBe(false);
    expect(checkBearer("Bearer abc", "")).toBe(false);
  });
});
