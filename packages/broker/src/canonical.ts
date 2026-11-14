import { createHash } from "node:crypto";

export function canonicalJson(value: unknown, maxBytes = 65_536): string {
  const seen = new Set<object>();
  const encode = (v: unknown, depth: number): string => {
    if (depth > 32) throw new Error("JSON nesting limit exceeded");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || !v) throw new Error("arguments must contain only JSON values");
    if (seen.has(v)) throw new Error("circular JSON value");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new Error("arguments must contain plain JSON objects");
    }
    seen.add(v);
    const result = Array.isArray(v)
      ? `[${v.map((item) => encode(item, depth + 1)).join(",")}]`
      : `{${Object.keys(v).sort().map((key) => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    seen.delete(v);
    if (Buffer.byteLength(result) > maxBytes) throw new Error("JSON byte limit exceeded");
    return result;
  };
  const result = encode(value, 0);
  if (Buffer.byteLength(result) > maxBytes) throw new Error("JSON byte limit exceeded");
  return result;
}

export const argumentsDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const replace = (text: string) => secrets.reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, text);
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) return "[TRUNCATED]";
    if (typeof item === "string") return replace(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [replace(key), visit(child, depth + 1)]));
    return item;
  };
  return visit(value, 0) as T;
}
