import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceManifest {
  version: 1;
  files: Array<{ path: string; content: string; sha256: string }>;
  omittedPaths: string[];
}
export const MAX_WORKSPACE_TRANSPORT_BYTES = 48 * 1024 * 1024;

// Both functions are deliberately self-contained. Their source is also run by
// the trusted Bun installation inside an isolated guest, never by repo code.
export async function captureWorkspace(root: string): Promise<WorkspaceManifest> {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { join, sep } = await import("node:path");
  const base = await fs.realpath(root);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("workspace root cannot be a symlink");
  const files: WorkspaceManifest["files"] = [], omittedPaths: string[] = [];
  let total = 0, entries = 0;
  const valid = (p: string) => p.length <= 4096 && !p.includes("\\") && !p.includes("\0") && p.split("/").every((v) => v !== "" && v !== "." && v !== "..");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 8192) throw new Error("workspace directory entry limit exceeded");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!valid(name)) throw new Error("invalid workspace snapshot path");
      if (["node_modules", ".git", ".cache", ".bun", ".venv", "venv", "dist", "target"].includes(entry.name)) {
        if (omittedPaths.length >= 2048) throw new Error("workspace omission limit exceeded");
        omittedPaths.push(name); continue;
      }
      const path = join(directory, entry.name), stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) throw new Error("workspace snapshot refuses symlinks");
      if (!(await fs.realpath(path)).startsWith(base + sep)) throw new Error("workspace snapshot path escapes root");
      if (stat.isDirectory()) { await walk(path, name); continue; }
      if (!stat.isFile()) throw new Error("workspace snapshot refuses special files");
      if (files.length >= 2048 || total + stat.size > 32 * 1024 * 1024) throw new Error("workspace snapshot exceeds storage limit");
      const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: Buffer;
      try {
        const before = await fd.stat(); if (!before.isFile()) throw new Error("workspace snapshot requires regular files");
        const chunks: Buffer[] = []; let size = 0;
        for (;;) {
          const bytes = Buffer.alloc(65536); const read = await fd.read(bytes, 0, bytes.length, null); if (!read.bytesRead) break;
          size += read.bytesRead; if (total + size > 32 * 1024 * 1024) throw new Error("workspace file grew past storage limit");
          chunks.push(bytes.subarray(0, read.bytesRead));
        }
        const after = await fd.stat();
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("workspace file changed during snapshot");
        content = Buffer.concat(chunks, size);
      } finally { await fd.close(); }
      if ((await fs.realpath(path)) !== join(base, name)) throw new Error("workspace snapshot path changed");
      total += content.length;
      files.push({ path: name, content: content.toString("base64"), sha256: createHash("sha256").update(content).digest("hex") });
    }
  };
  await walk(base, ""); return { version: 1, files, omittedPaths };
}

/** Validate the entire untrusted manifest before creating any artifact. */
export async function materializeWorkspace(value: unknown, root: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { dirname, join } = await import("node:path");
  const m = value as WorkspaceManifest;
  const valid = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\\") && !p.includes("\0") && p.split("/").every((v) => v !== "" && v !== "." && v !== "..");
  if (!m || m.version !== 1 || !Array.isArray(m.files) || m.files.length > 2048 || !Array.isArray(m.omittedPaths) || m.omittedPaths.length > 2048 || m.omittedPaths.some((p) => !valid(p) || !["node_modules", ".git", ".cache", ".bun", ".venv", "venv", "dist", "target"].includes(p.split("/").at(-1)!))) throw new Error("invalid workspace manifest");
  const names = new Set<string>(); let total = 0;
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const f of m.files) {
    if (!f || !valid(f.path) || names.has(f.path) || typeof f.content !== "string" || f.content.length > 48 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("invalid workspace manifest file");
    names.add(f.path); const bytes = Buffer.from(f.content, "base64"); total += bytes.length;
    if (total > 32 * 1024 * 1024 || bytes.toString("base64") !== f.content || createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw new Error("workspace checksum or storage limit mismatch");
    files.push({ path: f.path, bytes });
  }
  // A file cannot be an ancestor of another file or of an omission marker.
  for (const name of [...names, ...m.omittedPaths]) {
    if (m.omittedPaths.includes(name) && names.has(name)) throw new Error("workspace omission conflicts with a file");
    const parts = name.split("/"); parts.pop();
    while (parts.length) { if (names.has(parts.join("/"))) throw new Error("workspace path conflicts with a file"); parts.pop(); }
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(root)).length) throw new Error("workspace restore destination must be an empty directory");
  for (const file of files) {
    const target = join(root, file.path); await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const fd = await fs.open(target, "wx", 0o600); try { await fd.writeFile(file.bytes); await fd.sync(); } finally { await fd.close(); }
  }
  // Empty excluded directories carry truthful omission metadata into the
  // controller archive; their generated dependencies are never copied.
  for (const path of m.omittedPaths) await fs.mkdir(join(root, path), { recursive: true, mode: 0o700 });
}

/** Replace only the backend-owned host mirror, after complete validation. */
export async function replaceWorkspace(value: unknown, root: string): Promise<void> {
  const destination = resolve(root), stage = `${destination}.sync-${randomUUID()}`, previous = `${destination}.previous-${randomUUID()}`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  let moved = false;
  try {
    await materializeWorkspace(value, stage);
    try {
      const stat = await lstat(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid host workspace mirror");
      await rename(destination, previous); moved = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(stage, destination); } catch (error) { if (moved) await rename(previous, destination); throw error; }
    if (moved) await rm(previous, { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
