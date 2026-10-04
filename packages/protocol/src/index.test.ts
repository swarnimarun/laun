import { describe, expect, test } from "bun:test";
import {
  bearerToken,
  checkBearer,
  formatAgentKey,
  isAllowlisted,
  normalizeCreateSession,
  parseAgentKey,
  parseAllowlist,
} from "./index.js";

describe("protocol", () => {
  test("normalizeCreateSession applies defaults", () => {
    const s = normalizeCreateSession({ goal: "  fix tests  " });
    expect(s.goal).toBe("fix tests");
    expect(s.model).toBe("opencode-go/muse-spark-1.3-contributor");
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

describe("agent keys", () => {
  const ID = "a1b2c3d4";
  const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

  test("format -> parse round trip", () => {
    const key = formatAgentKey(ID, SECRET);
    expect(key).toBe(`laun_${ID}_${SECRET}`);
    expect(parseAgentKey(key)).toEqual({ id: ID, secret: SECRET });
  });

  test("parse rejects anything malformed", () => {
    expect(parseAgentKey(undefined)).toBeNull();
    expect(parseAgentKey(null)).toBeNull();
    expect(parseAgentKey("")).toBeNull();
    expect(parseAgentKey(SECRET)).toBeNull();
    expect(parseAgentKey(`laun_${ID}`)).toBeNull();
    expect(parseAgentKey(`laun_${ID}_${SECRET}+`)).toBeNull();
    expect(parseAgentKey(`laun_${ID}_${SECRET} _x`)).toBeNull();
    // surrounding whitespace from a paste is tolerated
    expect(parseAgentKey(`  laun_${ID}_${SECRET}\n`)).toEqual({ id: ID, secret: SECRET });
    // id must be lowercase hex, secret must stay in the url-safe alphabet
    expect(parseAgentKey(`laun_${ID.toUpperCase()}_${SECRET}`)).toBeNull();
    expect(parseAgentKey(`laun_zz_${SECRET}`)).toBeNull();
    expect(parseAgentKey(`laun_${ID}_short`)).toBeNull();
    expect(parseAgentKey(`laun_${ID}_${SECRET}!`)).toBeNull();
    // a gateway service token must never look like an agent key
    expect(parseAgentKey("service-token-abc1234567890")).toBeNull();
  });

  test("format refuses to build an invalid key", () => {
    expect(() => formatAgentKey("NOTHEX!!", SECRET)).toThrow("invalid agent key id");
    expect(() => formatAgentKey(ID, "short")).toThrow("invalid agent key secret");
  });

  test("bearerToken extracts the credential", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer  abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
