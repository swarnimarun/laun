import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PROMPT_CHARS = 8000;
export const MIN_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 1_800_000;

export function assertValidSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error("invalid sessionId (1-64 chars, A-Z a-z 0-9 _ -)");
}

export function assertValidPrompt(prompt: string): void {
  if (!prompt || !prompt.trim()) throw new Error("prompt is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
}

/** Absolute per-session dir, guaranteed inside sessionDir (throws on traversal). */
export function resolveSessionDir(sessionDir: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  const base = resolve(sessionDir);
  const dir = resolve(join(base, sessionId));
  if (dir !== base && !dir.startsWith(base + sep)) {
    throw new Error("session dir escapes sessionDir");
  }
  return dir;
}

/** Absolute per-session workdir, guaranteed inside sessionDir (throws on traversal). */
export function resolveWorkdir(sessionDir: string, sessionId: string): string {
  return join(resolveSessionDir(sessionDir, sessionId), "work");
}

export function ensureWorkdir(workdir: string): void {
  mkdirSync(workdir, { recursive: true });
}

export function clampTimeout(requested: unknown, fallback: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? requested : fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}
