import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspace, materializeWorkspace, replaceWorkspace } from "./workspace.js";
import { executeProcess, LocalExecution } from "./execution.js";
import { createPiRuntime } from "./index.js";
const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "laun-workspace-")); dirs.push(root); return root; }

describe("isolated workspace checkpoint boundary", () => {
  test("trusted guest script source captures binary artifacts and restores only validated regular files", async () => {
    const root = await fixture(), source = join(root, "source"), restored = join(root, "restored");
    await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "src", "artifact.bin"), Buffer.from([0, 255, 128, 9]));
    await writeFile(join(source, "node_modules", "not-archived"), "generated");
    // Exercise precisely the self-contained JS source sent to OpenShell,
    // including Bun startup from an immutable cwd and without host HOME.
    const result = await executeProcess([process.execPath, "--cwd", "/usr", "--no-addons", "-e", `console.log(JSON.stringify(await (${captureWorkspace.toString()})(${JSON.stringify(source)})));`], { timeoutMs: 10_000, env: { HOME: "/nonexistent", PATH: process.env.PATH } });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout); expect(manifest.omittedPaths).toEqual(["node_modules"]);
    const restore = await executeProcess([process.execPath, "--cwd", "/usr", "--no-addons", "-e", `await (${materializeWorkspace.toString()})(${JSON.stringify(manifest)},${JSON.stringify(restored)});`], { timeoutMs: 10_000, env: { HOME: "/nonexistent", PATH: process.env.PATH } });
    expect(restore.exitCode).toBe(0); expect(await readFile(join(restored, "src", "artifact.bin"))).toEqual(Buffer.from([0, 255, 128, 9]));
    await expect(readFile(join(restored, "node_modules", "not-archived"))).rejects.toThrow();
  });

  test("rejects links and traversal, checksum corruption and file hierarchy conflicts before replacing the mirror", async () => {
    const root = await fixture(), source = join(root, "source"), mirror = join(root, "mirror");
    await mkdir(source); await mkdir(mirror); await writeFile(join(source, "source.txt"), "durable"); await writeFile(join(mirror, "keep.txt"), "previous");
    const manifest = await captureWorkspace(source);
    await expect(replaceWorkspace({ ...manifest, files: [{ ...manifest.files[0], path: "../escape" }] }, mirror)).rejects.toThrow("invalid workspace");
    await expect(replaceWorkspace({ ...manifest, files: [{ ...manifest.files[0], sha256: "0".repeat(64) }] }, mirror)).rejects.toThrow("checksum");
    await expect(replaceWorkspace({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: "source.txt/nested" }] }, mirror)).rejects.toThrow("conflicts");
    expect(await readFile(join(mirror, "keep.txt"), "utf8")).toBe("previous");
    await symlink("/etc/passwd", join(source, "escape")); await expect(captureWorkspace(source)).rejects.toThrow("symlinks");
    await rm(join(source, "escape")); await replaceWorkspace(manifest, mirror);
    expect(await readFile(join(mirror, "source.txt"), "utf8")).toBe("durable"); await expect(readFile(join(mirror, "keep.txt"))).rejects.toThrow();
  });

  test("an unarchivable isolated artifact makes the runtime fail before a done event", async () => {
    const root = await fixture(), events: string[] = [];
    const runtime = createPiRuntime({ enableFaux: true, execution(input) {
      const backend = new LocalExecution(input.workspaceRoot);
      return Object.assign(backend, { checkpoint: async () => { throw new Error("guest workspace symlink refused"); } });
    } });
    const result = await runtime.run({ threadId: "thread", runId: "run", model: "faux/faux-1", prompt: "hello", workspaceRoot: join(root, "work"), sessionDir: join(root, "session") }, { authorize: async () => {}, emit(event) { events.push(event.type); } });
    expect(result.status).toBe("error"); expect(result.summary).toContain("workspace checkpoint failed"); expect(events).not.toContain("done");
  });
});
