import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createYardSourceArchive,
  yardSourceDecoder,
  allowedYardSource,
} from "./yard-source.js";
import {
  planYardSetup,
  runRemoteYardSetup,
  type YardSetupOptions,
} from "./yard-setup.js";
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "laun-yard-source-"));
  directories.push(path);
  await mkdir(join(path, "apps/worker/src"), { recursive: true });
  await writeFile(join(path, "package.json"), "{}");
  await writeFile(join(path, "bun.lock"), "{}");
  await writeFile(
    join(path, "apps/worker/src/index.ts"),
    'console.log("worker");',
  );
  await writeFile(
    join(path, "apps/worker/src/capabilities.json"),
    await Bun.file(
      join(import.meta.dir, "../../worker/src/capabilities.json"),
    ).text(),
  );
  return path;
}
function options(): YardSetupOptions {
  return {
    identity: "/private/id",
    host: "yard.example",
    user: "ubuntu",
    controllerUrl: "https://control.example",
    workerId: "12345678-1234-1234-1234-123456789abc",
    workerKey: "yard_12345678-1234-1234-1234-123456789abc_" + "x".repeat(32),
    remoteDir: "/opt/laun/yard",
    repoUrl: "https://github.com/example/laun.git",
    revision: "a".repeat(40),
    config: {
      OPENSHELL_BIN: "/usr/local/bin/openshell",
      OPENSHELL_SANDBOX_IMAGE: "laun-pi:qualified",
      XDG_CONFIG_HOME: "/etc/laun/yard-openshell",
    },
  };
}

test("source archive excludes dependencies, credentials and state while preserving unpublished files", async () => {
  const path = await fixture();
  await mkdir(join(path, "apps/worker/node_modules"));
  await writeFile(join(path, "apps/worker/node_modules/secret"), "omit");
  await writeFile(join(path, "apps/worker/.env"), "TOKEN=private");
  await mkdir(join(path, "deploy"));
  await writeFile(join(path, "deploy/host.key"), "private key");
  await writeFile(join(path, "deploy/.env.example"), "EXAMPLE=");
  for (const name of [
    "deploy/pi/agent/auth.json",
    "vendor/provider/credentials.json",
    "apps/worker/worker-key.json",
    "deploy/innocent-settings.json",
    "deploy/config/private.ts",
  ]) {
    await mkdir(join(path, name, ".."), { recursive: true });
    await writeFile(join(path, name), "never-transfer-this-secret");
  }
  await mkdir(join(path, "deploy/operator-private"), { recursive: true });
  await writeFile(
    join(path, "deploy/operator-private/custom.ts"),
    "configured-private-dir",
  );
  await writeFile(
    join(path, ".env"),
    `PI_CONTROLLER_AUTH_DIR=${join(path, "deploy/operator-private")}\n`,
  );
  await mkdir(join(path, "vendor/sdk/dist"), { recursive: true });
  await writeFile(
    join(path, "vendor/sdk/dist/index.js"),
    "export const vendorRuntime=true;",
  );
  const archive = await createYardSourceArchive(path);
  const names = archive.files.map((file) => file.path);
  expect(names).toContain("apps/worker/src/index.ts");
  expect(names).toContain("deploy/.env.example");
  expect(names).toContain("vendor/sdk/dist/index.js");
  expect(
    names.some(
      (name) =>
        name.includes("node_modules") ||
        name.endsWith(".env") ||
        name.endsWith(".key"),
    ),
  ).toBe(false);
  expect(JSON.stringify(archive)).not.toContain("private");
  expect(JSON.stringify(archive)).not.toContain("never-transfer");
  expect(names).not.toContain("deploy/operator-private/custom.ts");
  for (const name of [
    "packages/runtime/src/credentials.ts",
    "apps/gateway/src/auth.ts",
    "apps/gateway/src/keys.ts",
  ])
    expect(allowedYardSource(name)).toBe(true);
  for (const name of [
    "deploy/id_rsa",
    "deploy/pi/agent/auth.json",
    "vendor/provider/credentials.json",
    "apps/worker/worker-key.json",
  ])
    expect(allowedYardSource(name)).toBe(false);
  const destination = join(path, "restored");
  const child = Bun.spawn(
    [process.execPath, "-e", yardSourceDecoder(destination)],
    {
      stdin: new Blob([JSON.stringify(archive)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  expect(
    await readFile(join(destination, "apps/worker/src/index.ts"), "utf8"),
  ).toContain("worker");
});
test("decoder verifies the complete archive before writing or traversing paths", async () => {
  const path = await fixture(),
    archive = await createYardSourceArchive(path);
  archive.files[0]!.path = "../escape";
  const destination = join(path, "must-not-exist");
  const child = Bun.spawn(
    [process.execPath, "-e", yardSourceDecoder(destination)],
    {
      stdin: new Blob([JSON.stringify(archive)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).not.toBe(0);
  expect(
    await stat(destination).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
test("trusted receiver independently rejects credential paths before any file is created", async () => {
  const path = await fixture();
  for (const name of [
    "deploy/pi/agent/auth.json",
    "vendor/provider/credentials.json",
    "apps/worker/worker-key.json",
    "deploy/id_rsa",
  ]) {
    const archive = await createYardSourceArchive(path);
    archive.files[0]!.path = name;
    const destination = join(path, `reject-${crypto.randomUUID()}`);
    const process = Bun.spawn(
      [globalThis.process.execPath, "-e", yardSourceDecoder(destination)],
      {
        stdin: new Blob([JSON.stringify(archive)]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(await process.exited).not.toBe(0);
    expect(
      await stat(destination).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }
});
test("source collection rejects symlinked source paths", async () => {
  const path = await fixture();
  await symlink("/etc/passwd", join(path, "apps/worker/source-link"));
  await expect(createYardSourceArchive(path)).rejects.toThrow("symbolic link");
});
test("worker installation defaults controller inference and transfers only a scoped key through private stdin", async () => {
  const opt = options();
  const calls: { argv: string[]; stdin?: string; echo?: boolean }[] = [];
  await runRemoteYardSetup({
    ...opt,
    runner: async (argv, run) => {
      calls.push({ argv, stdin: run?.stdin, echo: run?.echo });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.stdin).toContain('LAUN_INFERENCE_MODE="controller"');
  expect(calls[0]!.stdin).toContain(opt.workerKey);
  expect(
    calls.every(
      (call) =>
        !call.argv.join(" ").includes(opt.workerKey) && call.echo === false,
    ),
  ).toBe(true);
  expect(calls[0]!.argv.join(" ")).toContain("umask 077");
  expect(calls[0]!.argv.join(" ")).toContain("remote configuration differs");
  expect(calls[1]!.stdin).toContain("KillMode=control-group");
  expect(calls[1]!.stdin).not.toContain(opt.workerKey);
  expect(calls[1]!.stdin).toContain("--frozen-lockfile --ignore-scripts");
});
test("local source transfers a verified manifest rather than requiring a published JJ commit", async () => {
  const path = await fixture(),
    opt = options(),
    archive = await createYardSourceArchive(path);
  delete opt.repoUrl;
  delete opt.revision;
  const calls: { argv: string[]; stdin?: string }[] = [];
  await runRemoteYardSetup({
    ...opt,
    sourceArchive: archive,
    runner: async (argv, run) => {
      calls.push({ argv, stdin: run?.stdin });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(calls).toHaveLength(3);
  expect(JSON.parse(calls[1]!.stdin!).manifest).toBe(archive.manifest);
  expect(calls[2]!.stdin).not.toContain("git -");
});
test("configuration refuses unsafe authority, shell targets and implicit local inference", () => {
  const opt = options();
  expect(() =>
    planYardSetup({
      ...opt,
      config: { ...opt.config, GATEWAY_TOKEN: "must-not-transfer" },
    }),
  ).toThrow("unsupported");
  expect(() =>
    planYardSetup({
      ...opt,
      config: { ...opt.config, PI_AUTH_FILE: "/secrets/provider.json" },
    }),
  ).toThrow("must not provision");
  expect(() => planYardSetup({ ...opt, inference: "local" })).toThrow(
    "PI_AUTH_FILE",
  );
  expect(
    planYardSetup({
      ...opt,
      inference: "local",
      config: { ...opt.config, PI_AUTH_FILE: "/secrets/yard-provider.json" },
    }).environment,
  ).toContain('LAUN_INFERENCE_MODE="local"');
  expect(() => planYardSetup({ ...opt, user: "-oProxyCommand=bad" })).toThrow(
    "invalid SSH",
  );
  expect(() =>
    planYardSetup({ ...opt, controllerUrl: "http://public.example" }),
  ).toThrow("HTTPS");
});
test("failed SSH never echoes the worker credential in the resulting error", async () => {
  const opt = options();
  await expect(
    runRemoteYardSetup({
      ...opt,
      runner: async () => ({
        code: 1,
        stdout: opt.workerKey,
        stderr: `failure ${opt.workerKey}`,
      }),
    }),
  ).rejects.toThrow("[redacted worker key]");
});
test("inference-only old workers fail setup before central durability can be bypassed", async () => {
  const path = await fixture();
  await writeFile(
    join(path, "apps/worker/src/capabilities.json"),
    JSON.stringify({
      protocolVersion: 1,
      checkpointVersion: "pi-durable@1.5.2",
      inferenceModes: ["controller", "local"],
    }),
  );
  const archive = await createYardSourceArchive(path),
    opt = options();
  delete opt.repoUrl;
  delete opt.revision;
  expect(() => planYardSetup({ ...opt, sourceArchive: archive })).toThrow(
    "durable adapter",
  );
});
