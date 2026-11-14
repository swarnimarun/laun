import type { PermissionProposal } from "./broker.js";

/** A model-generated proposal remains inert until an owner reviews a profile revision. */
export interface AdviceResult {
  runId: string;
  threadId: string;
  ownerId: string;
  approvalId: string;
  baseProfileId: string;
  baseProfileVersion: number;
  status: "queued" | "running" | "proposed" | "invalid" | "failed";
  createdAt: string;
  completedAt?: string;
  proposal?: PermissionProposal;
  /** Model dialogue only; it grants no authority and is not the reviewable rule. */
  discussion?: { explanation: string; question: string };
  error?: string;
}
