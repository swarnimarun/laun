import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { validateIsolatedCommandPolicy } from "@laun/policy";

export const DEFAULT_ISOLATED_POLICY = `version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /lib, /bin, /etc, /opt/pi, /proc, /sys/fs/cgroup, /dev/urandom, /dev/random]
  read_write: [/workspace, /tmp, /dev/null]
landlock:
  compatibility: hard_requirement
process: {}
network_policies: {}
network_middlewares: {}
`;
const MAX_BYTES = 65536;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
async function readPolicy(path: string): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat(); if (!before.isFile() || before.size > MAX_BYTES) throw new Error("v2 OpenShell policy must be a regular file of at most 64 KiB");
    const bytes = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    for (;;) { const result = await fd.read(bytes, offset, bytes.length - offset, null); offset += result.bytesRead; if (offset > MAX_BYTES) throw new Error("v2 OpenShell policy exceeds 64 KiB"); if (!result.bytesRead) break; }
    const after = await fd.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== offset) throw new Error("v2 OpenShell policy changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await fd.close(); }
}

/** Snapshot validated bytes; the sandbox never consumes a mutable operator path. */
export async function prepareIsolatedPolicy(stateDir: string, source?: string): Promise<{ path: string; sha256: string }> {
  const raw = source ? await readPolicy(source) : DEFAULT_ISOLATED_POLICY;
  const problems = validateIsolatedCommandPolicy(raw); if (problems.length) throw new Error(`Unsupported v2 OpenShell command policy: ${problems.join("; ")}`);
  const sha256 = digest(raw); await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, `sandbox-policy-${sha256}.yaml`);
  try { const fd = await open(path, "wx", 0o600); try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (digest(await readPolicy(path)) !== sha256) throw new Error("preserved OpenShell policy snapshot does not match its digest"); }
  return { path, sha256 };
}
