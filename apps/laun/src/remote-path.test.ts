import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import {
  prepareRemoteDirectory,
  publishRemoteConfig,
  validateInstallDirectory,
  prepareAssetParent,
} from "./remote-path.js";
import { createHash } from "node:crypto";
import { runRemoteSetup, type CommandRunner } from "./ssh.js";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const path = await mkdtemp("/tmp/laun-install-safety-");
  paths.push(path);
  return path;
}
async function shell(script: string, input = "") {
  const process = Bun.spawn(["bash", "-c", script], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}
test("canonical application path validation rejects protected and ambiguous destinations before SSH", async () => {
  for (const path of [
    "/",
    "/etc",
    "/etc/laun",
    "/proc/x",
    "/var",
    "/home/user",
    "/opt/../etc/laun",
    "/opt//laun",
    "/tmp/laun/",
    "/tmp/x\n",
    "/root/.ssh",
    "/home/alice/.config",
    "/home/alice/.local",
    "/home/alice/.aws/laun",
  ]) {
    expect(() => validateInstallDirectory(path)).toThrow();
    let calls = 0;
    await expect(
      runRemoteSetup({
        host: "example",
        identity: "id",
        remoteDir: path,
        envContent: "secret",
        bootstrapScript: "",
        runner: async () => {
          calls++;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  }
});
test("private config publication preserves identical reruns and refuses differing credentials", async () => {
  const base = await fixture(),
    dir = join(base, "controller");
  expect((await shell(prepareRemoteDirectory(dir, "controller"))).code).toBe(0);
  const script = publishRemoteConfig(dir, ".env"),
    value = "TOKEN=first-private-value\nGUARDRAIL=deny\n";
  expect((await shell(script, value)).code).toBe(0);
  const before = await stat(join(dir, ".env"));
  expect(before.mode & 0o777).toBe(0o600);
  expect((await shell(prepareRemoteDirectory(dir, "controller"))).code).toBe(0);
  expect((await shell(script, value)).code).toBe(0);
  expect((await stat(join(dir, ".env"))).ino).toBe(before.ino);
  const denied = await shell(script, "TOKEN=changed\n");
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toContain("explicit reviewed");
  expect(denied.stderr).not.toContain("first-private-value");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe(value);
  expect(
    (await readdir(dir)).filter((name) => name.startsWith(".config.")),
  ).toEqual([]);
});
test("symlink config, symlink ancestors, unmarked nonempty and writable destinations remain untouched", async () => {
  const base = await fixture(),
    dir = join(base, "app"),
    outside = join(base, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "original"), "preserve");
  await symlink(outside, dir);
  expect(
    (await shell(prepareRemoteDirectory(dir, "controller"))).code,
  ).not.toBe(0);
  expect(await readdir(outside)).toEqual(["original"]);
  await rm(dir);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "operator-data"), "preserve");
  expect(
    (await shell(prepareRemoteDirectory(dir, "controller"))).code,
  ).not.toBe(0);
  expect(await readdir(dir)).toEqual(["operator-data"]);
  await rm(join(dir, "operator-data"));
  expect((await shell(prepareRemoteDirectory(dir, "controller"))).code).toBe(0);
  await symlink(join(outside, "original"), join(dir, ".env"));
  expect(
    (await shell(publishRemoteConfig(dir, ".env"), "replace")).code,
  ).not.toBe(0);
  expect(await readFile(join(outside, "original"), "utf8")).toBe("preserve");
  await symlink(outside, join(dir, "deploy"));
  expect(
    (await shell(prepareAssetParent(dir, "deploy/openshell"))).code,
  ).not.toBe(0);
  expect(await readdir(outside)).toEqual(["original"]);
  await chmod(dir, 0o755);
  expect(
    (await shell(prepareRemoteDirectory(dir, "controller"))).code,
  ).not.toBe(0);
  expect((await stat(dir)).mode & 0o777).toBe(0o755);
});
test("real local SSH substitute exercises safe publication before a fake bootstrap", async () => {
  const base = await fixture(),
    directory = join(base, "controller"),
    key = "laun_aabbccdd_" + "a".repeat(32);
  let bootstraps = 0;
  const runner: CommandRunner = async (argv, options) => {
    const command = argv.at(-1)!;
    if (command.startsWith("bash -s")) {
      bootstraps++;
      return { code: 0, stdout: `LAUN_KEY=${key}\n`, stderr: "" };
    }
    return shell(command, options?.stdin);
  };
  const opts = {
    host: "fixture",
    identity: "id",
    remoteDir: directory,
    envContent: `LAUN_KEY=${key}\n`,
    bootstrapScript: "fixture",
    runner,
  };
  await runRemoteSetup(opts);
  await runRemoteSetup(opts);
  expect(bootstraps).toBe(2);
  await expect(
    runRemoteSetup({ ...opts, envContent: "changed\n" }),
  ).rejects.toThrow("env write failed");
  expect(bootstraps).toBe(2);
  expect(await readFile(join(directory, ".env"), "utf8")).toBe(opts.envContent);
});
test("matching existing templates still reject group-writable executable content", async () => {
  const base = await fixture(),
    directory = join(base, "controller"),
    key = "laun_aabbccdd_" + "b".repeat(32),
    content = "echo reviewed-public-template\n";
  let bootstraps = 0;
  const runner: CommandRunner = async (argv, options) => {
    const command = argv.at(-1)!;
    if (command.startsWith("bash -s")) {
      bootstraps++;
      return { code: 0, stdout: `LAUN_KEY=${key}\n`, stderr: "" };
    }
    return shell(command, options?.stdin);
  };
  const opts = {
    host: "fixture",
    identity: "id",
    remoteDir: directory,
    envContent: `LAUN_KEY=${key}\n`,
    bootstrapScript: "fixture",
    runner,
    assets: [
      {
        path: "deploy/bootstrap.sh",
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
  await runRemoteSetup(opts);
  await chmod(join(directory, "deploy/bootstrap.sh"), 0o664);
  await expect(runRemoteSetup(opts)).rejects.toThrow(
    "template transfer failed",
  );
  expect(bootstraps).toBe(1);
  expect(
    (await stat(join(directory, "deploy/bootstrap.sh"))).mode & 0o777,
  ).toBe(0o664);
});
