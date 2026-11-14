/** Explicit logical removal of the controller copy; host copies are tracked separately. */
export interface ThreadPurgePreview {
  version: 1; threadId: string; ownerId: string; digest: string;
  eligible: boolean; blockers: string[]; warnings: string[];
  counts: Record<string, number>; bytes: number;
  familyRootId: string; tokens: number; cost: number;
  workers: Array<{ workerId: string; placementIds: string[]; unknownPlacements: boolean }>;
  legacyTelegramRoutes: string[];
  legacyTelegramRouteDetails: Array<{ routeKey:string;botId?:string;chatId?:string;topicId?:string;deliveries:number }>;
}
export interface ThreadPurgeInput {
  requestId: string; expectedDigest: string; confirmedStopped: true;
  confirmedControllerCopyOnly: true; confirmedLegacyTelegramRouteCleanup?: true;
}
export interface ThreadPurgeJob {
  id: string; ownerId: string; threadId: string; status: "removing" | "done";
  createdAt: string; updatedAt: string; removed: Record<string, number>;
  pendingHostCopies: number; reclamation: "pending" | "reusable";
}
export interface HostCleanupPlan {
  id: string; purgeId: string; ownerId: string; threadId: string; workerId: string;
  placementIds: string[]; unknownPlacements: boolean;
  status: "pending" | "running" | "done" | "blocked";
  createdAt: string; updatedAt: string;
  removedPaths?: number; removedSandboxes?: number; outstanding?: string[];
  verified?:boolean;
  approvedAt?:string;approvedBy?:string;approvalDigest?:string;approvalExpiresAt?:string;
  generation?:number;leaseUntil?:string;finishedGeneration?:number;resultDigest?:string;
}
export interface HostCleanupReview { plan:HostCleanupPlan;digest:string;warnings:string[] }
export interface HostCleanupApproval {expectedDigest:string;confirmedStopped:true;confirmedDeleteHostCopies:true}
export interface HostCleanupJob {planId:string;threadId:string;placementIds:string[];generation:number;leaseUntil:string}
export interface RuntimeThreadCleanupInput {
  threadId: string; placementIds: string[]; confirmedStopped: true;
  signal?:AbortSignal;
}
export interface RuntimeThreadCleanupResult {
  verified:boolean;
  removedPaths: number; removedSandboxes: number; outstanding: string[];
}
