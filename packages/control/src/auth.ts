import type { ControlPrincipal } from "@laun/protocol";
import { ControlError } from "./store.js";

/** A trusted synchronous authentication lookup; never supplied by a request. */
export type AuthenticatePrincipal = () => ControlPrincipal | null;

/** Revalidate before admitting a delayed request, without changing its owner. */
export function assertSamePrincipal(expected: ControlPrincipal | null | undefined, authenticate?: AuthenticatePrincipal): void {
  if (!authenticate) return; // In-process trusted callers supply their own identity.
  const current = authenticate();
  if (!expected || !current || current.id !== expected.id || current.admin !== expected.admin) throw new ControlError("authentication expired or changed before request admission", 401);
}
