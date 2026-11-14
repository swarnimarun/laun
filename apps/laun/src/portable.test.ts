import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_ASSETS, CLI_ASSET_MANIFEST, deploymentAssets } from "./assets.js";
import { localSetup, remoteSetup, readEnvValue } from "./setup.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "laun-portable-"));
  dirs.push(dir);
  return dir;
};
const repo = resolve(import.meta.dir, "../../..");

test("embedded deployment templates match source and refuse altered cache files", async () => {
  for (const [path, file] of Object.entries(CLI_ASSETS))
    expect(
      createHash("sha256")
        .update(await readFile(join(repo, path)))
        .digest("hex"),
    ).toBe(file.sha256);
  const dir = await scratch(),
    env = join(dir, "install.env"),
    assets = deploymentAssets(join(dir, "missing-checkout"), env);
  expect(assets.bundled).toBe(true);
  expect(assets.manifest).toBe(CLI_ASSET_MANIFEST);
  expect((await stat(assets.root)).mode & 0o777).toBe(0o700);
  await writeFile(
    join(assets.root, "deploy/.env.example"),
    "tampered template",
  );
  expect(() => deploymentAssets(join(dir, "missing-checkout"), env)).toThrow(
    "template changed",
  );
});
test("portable setup pulls pinned images without a checkout and keeps stable project/credentials", async () => {
  const dir = await scratch(),
    env = join(dir, "install.env"),
    calls: string[][] = [];
  const options = {
    envFile: env,
    composeFile: "deploy/docker-compose.yml",
    host: "127.0.0.1",
    noStart: false,
    checkoutRoot: join(dir, "missing"),
    releaseVersion: "9.8.7",
    runner: async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const first = await localSetup(options),
    before = await readFile(env, "utf8");
  expect(readEnvValue(before, "LAUN_TAG")).toBe("9.8.7");
  expect(readEnvValue(before, "COMPOSE_PROJECT_NAME")).toMatch(
    /^laun-[a-f0-9]{12}$/,
  );
  expect(calls.some((call) => call.includes("pull"))).toBe(true);
  expect(calls.at(-1)).toContain("--no-build");
  expect(calls.flat()).not.toContain("--build");
  const second = await localSetup({ ...options, releaseVersion: "9.8.8" });
  expect(second.key).toBe(first.key);
  expect(
    readEnvValue(await readFile(env, "utf8"), "COMPOSE_PROJECT_NAME"),
  ).toBe(readEnvValue(before, "COMPOSE_PROJECT_NAME"));
  expect((await stat(env)).mode & 0o777).toBe(0o600);
});
test("source CLI respects a full service image override and never builds a digest tag", async () => {
  const dir = await scratch(),
    env = join(dir, "install.env"),
    calls: string[][] = [];
  await writeFile(
    env,
    `OPENSHELL_ENABLED=false\nLAUN_SERVICE_IMAGE=registry.example/laun@sha256:${"a".repeat(64)}\n`,
  );
  await localSetup({
    envFile: env,
    composeFile: join(repo, "deploy/docker-compose.yml"),
    host: "127.0.0.1",
    noStart: false,
    runner: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(calls[0]).toContain("pull");
  expect(calls.at(-1)).toContain("--no-build");
  expect(calls.flat()).not.toContain("--build");
});
test("existing writable asset cache is refused before template execution", async () => {
  if (typeof process.getuid !== "function") return;
  const dir = await scratch(),
    env = join(dir, "install.env"),
    cache = join(dir, ".laun-assets");
  await mkdir(cache, { mode: 0o700 });
  await chmod(cache, 0o777);
  expect(() => deploymentAssets(join(dir, "missing"), env)).toThrow(
    "owner-controlled",
  );
});
test("portable SSH transfers checksummed public templates and selects pull-only bootstrap", async () => {
  const dir = await scratch(),
    calls: { argv: string[]; stdin?: string }[] = [];
  const fixtureKey = "laun_deadbeef_" + "x".repeat(32);
  const result = await remoteSetup({
    identity: "/private/identity",
    host: "vps.example",
    user: "ubuntu",
    remoteDir: "/opt/laun",
    noStart: true,
    envFile: join(dir, "remote.env"),
    checkoutRoot: join(dir, "missing"),
    releaseVersion: "9.8.7",
    runner: async (argv, options) => {
      calls.push({ argv, stdin: options?.stdin });
      return {
        code: 0,
        stdout: argv.at(-1)?.includes("bash -s --")
          ? `LAUN_DIR=/opt/laun\nLAUN_PORT=8080\nLAUN_KEY=${fixtureKey}\n`
          : "",
        stderr: "",
      };
    },
  });
  expect(result.key).toBe(fixtureKey);
  expect(calls.length).toBe(Object.keys(CLI_ASSETS).length + 3);
  expect(calls.at(-1)!.argv.at(-1)).toContain("LAUN_RELEASE_ONLY=true");
  expect(
    calls.some((call) =>
      call.argv.at(-1)?.includes("sha256sum --check --status"),
    ),
  ).toBe(true);
  expect(calls.every((call) => !call.argv.join(" ").includes(fixtureKey))).toBe(
    true,
  );
});
test("pinned Bun helper extracts a digest artifact privately without overwriting global Bun", async () => {
  if (process.platform !== "linux") return;
  const dir = await scratch(),
    bin = join(dir, "bin"),
    tools = join(dir, "tools"),
    log = join(dir, "engine.log");
  await mkdir(bin);
  await writeFile(join(bin, "bun"), "#!/bin/sh\necho 1.3.13\n", {
    mode: 0o755,
  });
  await writeFile(
    join(bin, "engine"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUN_FAKE_DOCKER_LOG"\ncase "$1" in info|pull|rm) exit 0;; create) echo fixture-container;; cp) printf "#!/bin/sh\\necho 1.4.4\\n" > "$3"; chmod 755 "$3";; *) exit 1;; esac\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LAUN_TOOLS_DIR: tools,
    LAUN_CONTAINER_ENGINE: join(bin, "engine"),
    LAUN_FAKE_DOCKER_LOG: log,
  };
  const child = Bun.spawn(["bash", join(repo, "deploy/install-bun.sh")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, path] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  expect(code).toBe(0);
  expect(path.trim()).toBe(join(tools, "bun/1.4.4/bin/bun"));
  expect(await readFile(join(bin, "bun"), "utf8")).toContain("1.3.13");
  expect(await readFile(log, "utf8")).toContain(
    "@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d",
  );
});
test("compiled CLI setup works from an empty directory with full templates", async () => {
  const dir = await scratch(),
    binary = join(dir, process.platform === "win32" ? "laun.exe" : "laun"),
    empty = join(dir, "empty");
  await mkdir(empty);
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--define",
      'process.env.LAUN_VERSION="9.8.7"',
      "--outfile",
      binary,
      join(repo, "apps/laun/src/index.ts"),
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const [built, buildErrors] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  if (built !== 0)
    throw new Error(`portable CLI compile failed: ${buildErrors}`);
  const child = Bun.spawn([binary, "setup", "--no-start", "--json"], {
    cwd: empty,
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(errors).toBe("");
  expect(JSON.parse(output).envFile).toBe(join(empty, ".env"));
  const content = await readFile(join(empty, ".env"), "utf8");
  expect(readEnvValue(content, "LAUN_TAG")).toBe("9.8.7");
  expect(readEnvValue(content, "LAUN_TELEGRAM_BRIDGE_TOKEN")).toBeString();
  expect(content).toContain("LAUN_CONTROL_V2=true");
  expect((await stat(join(empty, ".env"))).mode & 0o777).toBe(0o600);
}, 120_000);
