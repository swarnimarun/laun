export interface LegacyImportFile { kind: "pi-session" | "gateway-index" | "gateway-events"; sourcePath: string; bytes: number; sha256: string }
export interface LegacyEntryPreview { id: string; parentId: string | null; sourceType: string; timestamp: string; text: string; truncated: boolean }
export interface LegacyImportPreview {
  sourceFormat: "pi-coding-agent-v3";
  sourceSessionId: string;
  sourceDigest: string;
  legacySessionId?: string;
  entryCount: number;
  leaves: string[];
  files: LegacyImportFile[];
  unsupportedTypes: string[];
  unsupportedFields: string[];
  warnings: string[];
  entries: LegacyEntryPreview[];
}
export interface LegacyImportReport extends Omit<LegacyImportPreview, "entries"> {
  id: string; ownerId: string; mowerId: string; threadId: string; profileId: string; profileVersion: number; createdAt: string;
}
export interface LegacyImportArchive {
  version: 1;
  files: Array<LegacyImportFile & { contentBase64: string }>;
}
/** Passive adapter data only: never a model message, tool call or submission. */
export interface PassiveLegacyHistory {
  threadId: string; sessionDir: string; importId: string; sourceDigest: string; sourceSessionId: string; entries: LegacyEntryPreview[];
}
