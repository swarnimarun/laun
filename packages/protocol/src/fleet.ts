import type { WorkerRecord } from "./control.js";

export interface WorkerDrainResult {
  worker: WorkerRecord;
}
/** Human maintenance authority. The old execution host must be stopped first. */
export interface WorkerKeyRotation {
  expectedCredentialVersion: number;
  confirmedStopped: true;
}
/** The replacement key is returned once and must never be retained in events. */
export interface WorkerKeyRotationResult {
  worker: WorkerRecord;
  key: string;
  interruptedRunIds: string[];
}
