import type { ControlPrincipal } from "@laun/protocol";
import { ControlError } from "@laun/control";
import { KeyStoreUnavailableError } from "./keys.js";
import type { createGateway } from "./server.js";

/** Shared by request admission and delayed-body revalidation. */
export function authenticateControlPrincipal(gateway: ReturnType<typeof createGateway>, request: Request): ControlPrincipal | null {
  try {
    const identity = gateway.authenticate(request);
    if (!identity) return null;
    const principalId = identity.kind === "service" ? "service" : gateway.keys.principalIdForKey(identity.keyId);
    return principalId ? { id: principalId, admin: identity.kind === "service" } : null;
  } catch (error) {
    if (error instanceof KeyStoreUnavailableError) throw new ControlError(error.message, 503);
    throw error;
  }
}
