import type { CheckpointReference } from "./checkpoint.js";
import type { ThreadEvent, ThreadRecord } from "./control.js";

export interface ThreadProfileRebase {
  profileId: string; profileVersion: number;
  expectedProfileId: string; expectedProfileVersion: number;
  confirmedStopped: true;
}
export interface ThreadWorkerMove {
  workerId: string;
  expectedWorkerId: string | null;
  confirmedStopped: true;
  checkpointSha256?: string;
  confirmedOmissions?: true;
}
export interface ThreadLifecycleResult { thread: ThreadRecord; event: ThreadEvent; checkpoint?: CheckpointReference }
