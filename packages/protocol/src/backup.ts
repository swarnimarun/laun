/** A local control-plane backup, not a VPS image or credential export. */
export interface ControlBackupManifest {
  version: 1;
  scope: "laun-v2-control";
  createdAt: string;
  schemaVersion: "1";
  files: Array<{ path: "control.sqlite" | "keys.json"; bytes: number; sha256: string }>;
}

export interface ControlRestoreResult {
  targetDir: string;
  manifest: ControlBackupManifest;
  /** Administrators may mint new credentials for these existing owners. */
  principals: Array<{ principalId: string; keyIds: string[] }>;
  safety: { interruptedRuns: number; interruptedInferenceCalls: number; expiredApprovals: number; revokedWorkers: number; revokedHumanKeys: number; stoppedThreads: number; uncertainDeliveries: number };
}
