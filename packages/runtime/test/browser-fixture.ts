/** Scripted upstream model for browser tests only; never imported by production. */
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentRuntime } from "@laun/protocol";
import { createPiRuntime } from "../src/index.js";

export function createBrowserFixtureRuntime(): AgentRuntime {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const response: FauxResponseFactory = async (context) => {
    faux.appendResponses([response]);
    const latest = context.messages.at(-1);
    const lastUser = [...context.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : lastUser?.content
            ?.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n") || "";
    if (
      prompt.startsWith("You are Gatekeeper, a permission adviser for Laun.")
    ) {
      const input = JSON.parse(
        prompt.slice(prompt.lastIndexOf("\n\n{") + 2),
      ) as {
        action: { id: string; operation: string; resource: string };
        profile: { id: string; version: number };
      };
      return fauxAssistantMessage(
        JSON.stringify({
          baseProfileId: input.profile.id,
          baseProfileVersion: input.profile.version,
          actionId: input.action.id,
          operation: input.action.operation,
          resource: input.action.resource,
          effect: "ask",
          explanation:
            "Ask before future writes in this workspace so you can inspect the exact file action each time.",
          question:
            "Would you like future workspace writes to keep requiring your review?",
        }),
      );
    }
    if (
      prompt.includes("UI_APPROVE_WRITE") ||
      prompt.includes("UI_DENY_WRITE")
    ) {
      const allowed = prompt.includes("UI_APPROVE_WRITE");
      if (latest?.role === "user")
        return fauxAssistantMessage(
          fauxToolCall(
            "write_file",
            {
              path: allowed ? "approved.txt" : "denied.txt",
              content: allowed
                ? "approved by browser"
                : "must never be written",
            },
            { id: allowed ? "browser-approve-write" : "browser-deny-write" },
          ),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        allowed
          ? "The reviewed write completed."
          : "The write was denied. No file was changed.",
      );
    }
    return fauxAssistantMessage(`Browser fixture answer: ${prompt}`);
  };
  faux.setResponses([response]);
  return createPiRuntime({ models, trustedLocal: true, timeoutMs: 60_000 });
}
