/** A readable, deterministic upstream model for documentation only. No provider network calls. */
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { AgentRuntime } from "@laun/protocol";
import { createPiRuntime } from "../src/index.js";

export const DEMO_PROMPTS = {
  plan: "Help me prepare the next Laun release. Suggest a small plan and clear owners. Ask before changing files.",
  review: "Review the release plan. Give me a short checklist for durable threads, exact permissions, and the mobile experience. Return your findings here; do not change files.",
  followup: "What should we verify before calling this ready for a real VPS?",
  write: "Write RELEASE_NOTES.md with a short summary of the durable workspace. Please ask before writing it.",
  advice: "Keep asking before workspace writes. Explain what a reusable guardrail would cover before I decide.",
} as const;

export function createDemoFixtureRuntime(): AgentRuntime {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const response: FauxResponseFactory = async (context) => {
    faux.appendResponses([response]);
    const latest = context.messages.at(-1);
    const user = [...context.messages].reverse().find((message) => message.role === "user");
    const prompt = typeof user?.content === "string" ? user.content : user?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "";
    if (prompt.startsWith("You are Gatekeeper, a permission adviser for Laun.")) {
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n{") + 2)) as {action:{id:string;operation:string;resource:string};profile:{id:string;version:number}};
      return fauxAssistantMessage(JSON.stringify({
        baseProfileId: input.profile.id, baseProfileVersion: input.profile.version,
        actionId: input.action.id, operation: input.action.operation, resource: input.action.resource,
        effect: "ask",
        explanation: "Keep workspace writes behind a review. You can inspect the file path and proposed content each time, while read-only planning continues within the existing guardrails.",
        question: "Would you like every future workspace write to keep requiring your review?",
      }));
    }
    if (prompt === DEMO_PROMPTS.write) {
      if (latest?.role === "user") return fauxAssistantMessage(fauxToolCall("write_file", {
        path:"RELEASE_NOTES.md",content:"# Laun release brief\n\n- Durable conversations live on the controller.\n- Each mower has its own permission profile.\n- Delegated tasks keep their own threads.\n- File changes require your review.\n",
      },{id:"release-brief-write"}),{stopReason:"toolUse"});
      return fauxAssistantMessage(JSON.stringify(latest).toLowerCase().includes("denied") ? "The write was denied. I’ll keep working within the current guardrails; no release file was created." : "The reviewed release brief is saved in RELEASE_NOTES.md. The conversation and the file remain separate durable artifacts.");
    }
    if (prompt === DEMO_PROMPTS.followup) return fauxAssistantMessage("Before a real VPS rollout, verify these on the target host:\n\n• OpenShell blocks a write outside the allowed workspace.\n• A stopped worker can restore its durable thread on another yard.\n• Provider authentication and resource limits are configured.\n• Backup, restore, and rollback have been rehearsed.\n\nThis local demonstration does not qualify those production steps.");
    if (prompt.includes(DEMO_PROMPTS.review)) return fauxAssistantMessage("Release review\n\n• Durable threads — keep the plan, child work, and results easy to reopen.\n• Permissions — show the exact action before approval; keep advice separate from authority.\n• Mobile — make the conversation usable before opening the inspector.\n\nRecommendation: review one file change together, then qualify the real execution yard before unattended work.");
    if (prompt === DEMO_PROMPTS.plan) return fauxAssistantMessage("A small plan with clear owners:\n\n1. Clover reviews durable threads, permissions, and the mobile flow.\n2. Juniper can prepare a concise release brief after that review.\n3. I keep the decisions and returned results in this thread.\n\nStart by delegating the review to Clover. You can open its child thread and give direction directly. We’ll inspect file changes before approving them.");
    return fauxAssistantMessage("Clover’s review is back in the release plan. The next useful step is to inspect a proposed file change together, while keeping the existing guardrails in place.\n\nThe child conversation remains available for follow-up questions.");
  };
  faux.setResponses([response]);
  return createPiRuntime({models,trustedLocal:true,timeoutMs:120_000});
}
