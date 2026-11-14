import type { WorkerCapabilities } from "./control.js";
/** Public, checksummed CLI artifact metadata; credential references and values are excluded. */
export interface CliArtifactManifest {
  version: 1;
  kind: "laun-cli";
  cliVersion: string;
  createdAt: string;
  sourceRevision?: string;
  sourceRepository?: string;
  sourceBundleSha256: string;
  deploymentTemplatesSha256: string;
  toolchain: {
    bun: string;
    piDurable: string;
    openShell: string;
    workerProtocol: number;
    durabilityAdapters: NonNullable<WorkerCapabilities["durabilityAdapters"]>;
  };
  binary: { fileName: string; target: string; bytes: number; sha256: string };
}
