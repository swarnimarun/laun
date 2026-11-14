import { createHash } from "node:crypto";

/** Names are short for OpenShell0.1.8; full labels are always checked too. */
export function managedSandboxName(threadId: string, placementId?: string): string {
  return `ln-${createHash("sha256").update(placementId ? `${threadId}:${placementId}` : threadId).digest("hex").slice(0, 16)}`;
}
