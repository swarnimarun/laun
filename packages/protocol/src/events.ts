import type { AgentEvent } from "./index.js";

const statuses = new Set(["pending", "running", "waiting_approval", "done", "error"]);

/** Validate untrusted executor records before they enter durable history or UI. */
export function isAgentEvent(input: unknown): input is AgentEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const e = input as Record<string, unknown>;
  if (typeof e.sessionId !== "string" || !e.sessionId) return false;
  const optionalString = (key: string) => e[key] === undefined || typeof e[key] === "string";
  switch (e.type) {
    case "status":
      return typeof e.status === "string" && statuses.has(e.status) && optionalString("message");
    case "text":
    case "thinking":
      return typeof e.delta === "string";
    case "tool_call":
      return typeof e.name === "string";
    case "tool_result":
      return typeof e.name === "string" && typeof e.ok === "boolean" && optionalString("output");
    case "usage":
      return ["inputTokens", "outputTokens", "totalTokens", "costUsd"].every((key) =>
        e[key] === undefined || (typeof e[key] === "number" && Number.isFinite(e[key]) && e[key] >= 0),
      );
    case "approval_request":
      return typeof e.requestId === "string" && e.requestId.length > 0 && typeof e.reason === "string" && optionalString("detail");
    case "done":
      return optionalString("summary");
    case "error":
      return typeof e.message === "string";
    default:
      return false;
  }
}

export function isTerminalAgentEvent(event: AgentEvent): boolean {
  return event.type === "done" || event.type === "error" ||
    (event.type === "status" && (event.status === "done" || event.status === "error"));
}
