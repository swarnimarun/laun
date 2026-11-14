import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
  link,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import {
  createControllerSourceArchive,
  controllerSourceInstaller,
  CONTROLLER_SOURCE_REQUIRED,
  CONTROLLER_QUALIFICATION_SCRIPT,
} from "./controller-source.js";
import { deploymentFiles } from "./assets.js";
import { remoteSetup } from "./setup.js";
import { runRemoteSetup, type CommandRunner } from "./ssh.js";
import { shQuote } from "./shell-quote.js";
import type { YardSourceArchive } from "./yard-source.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp("/tmp/laun-controller-source-");
  directories.push(directory);
  return directory;
}
async function fixture() {
  const root = await scratch();
  for (const path of new Set([
    ...CONTROLLER_SOURCE_REQUIRED,
    "apps/worker/src/index.ts",
  ])) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, path),
      path === "package.json"
        ? ' {"type":"module"}\n'
        : path.endsWith(".json")
          ? "{}"
          : path === ".dockerignore"
            ? "**\n!apps/\n!apps/**\n"
            : "export {};\n",
    );
  }
  for (const file of deploymentFiles()) {
    await mkdir(dirname(join(root, file.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(root, file.path),
      await readFile(resolve(import.meta.dir, "../../..", file.path), "utf8"),
    );
  }
  await writeFile(
    join(root, "apps/gateway/src/unpublished.ts"),
    "export const currentJJ='source-not-on-GitHub';\n",
  );
  return root;
}
async function target() {
  const root = await scratch();
  await writeFile(
    join(root, ".laun-install.json"),
    JSON.stringify({ version: 1, kind: "controller" }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(join(root, ".env"), "PRIVATE_TOKEN=preserve\n", {
    mode: 0o600,
  });
  return root;
}
async function execute(script: string, stdin = "") {
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function install(root: string, archive: YardSourceArchive) {
  return execute(controllerSourceInstaller(root), JSON.stringify(archive));
}

test("controller archive preserves exact Docker boundary/current JJ files and only fixed public scripts", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "scripts/operator-secret.ts"),
    "must-not-transfer",
  );
  await mkdir(join(root, "deploy/pi/agent"), { recursive: true });
  await writeFile(join(root, "deploy/pi/agent/auth.json"), "private-auth");
  const archive = await createControllerSourceArchive(root),
    names = archive.files.map((file) => file.path);
  expect(names).toContain("apps/gateway/src/unpublished.ts");
  expect(names).toContain("scripts/qualify-packaged-control.test.ts");
  expect(names).not.toContain("scripts/operator-secret.ts");
  expect(names).not.toContain("deploy/pi/agent/auth.json");
  const ignore = archive.files.find((file) => file.path === ".dockerignore")!;
  expect(Buffer.from(ignore.content, "base64").toString()).toBe(
    await readFile(join(root, ".dockerignore"), "utf8"),
  );
});
test("verified source installation is durable/no-clobber and identical reruns preserve existing private config", async () => {
  const root = await fixture(),
    archive = await createControllerSourceArchive(root),
    destination = await target(),
    script = controllerSourceInstaller(destination);
  const first = await install(destination, archive);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain(archive.manifest);
  const before = await stat(
    join(destination, "apps/gateway/src/unpublished.ts"),
  );
  expect((await install(destination, archive)).code).toBe(0);
  expect(
    (await stat(join(destination, "apps/gateway/src/unpublished.ts"))).ino,
  ).toBe(before.ino);
  expect(await readFile(join(destination, ".env"), "utf8")).toBe(
    "PRIVATE_TOKEN=preserve\n",
  );
  expect(
    JSON.parse(await readFile(join(destination, ".laun-source.json"), "utf8")),
  ).toMatchObject({ manifest: archive.manifest });
  expect(
    (await stat(join(destination, ".laun-source.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(script).toContain("O_NOFOLLOW");
});
test("a verified pending installation resumes only the exact source manifest", async () => {
  const root = await fixture(),
    archive = await createControllerSourceArchive(root),
    destination = await target(),
    identity = {
      version: 1,
      kind: "controller-source",
      manifest: archive.manifest,
    };
  await writeFile(
    join(destination, ".laun-source-pending.json"),
    JSON.stringify(identity),
    { mode: 0o600 },
  );
  const file = archive.files.find((file) => file.path === "package.json")!;
  await writeFile(
    join(destination, file.path),
    Buffer.from(file.content, "base64"),
    { mode: file.mode },
  );
  expect((await install(destination, archive)).code).toBe(0);
  expect(
    await stat(join(destination, ".laun-source-pending.json")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
test("read-only public source hardlinks remain verifiable while private source identity cannot be shared", async () => {
  const root = await fixture(),
    archive = await createControllerSourceArchive(root),
    destination = await target(),
    cache = await scratch();
  expect((await install(destination, archive)).code).toBe(0);
  await link(
    join(destination, "apps/gateway/src/unpublished.ts"),
    join(cache, "bun-source-copy"),
  );
  expect((await install(destination, archive)).code).toBe(0);
  await link(
    join(destination, ".laun-source.json"),
    join(cache, "private-identity-copy"),
  );
  expect((await install(destination, archive)).code).not.toBe(0);
});
test("changed manifest, changed existing files, unrecognized checkout and symlinked parents refuse without overwrite", async () => {
  const root = await fixture(),
    archive = await createControllerSourceArchive(root),
    destination = await target();
  expect((await install(destination, archive)).code).toBe(0);
  await writeFile(
    join(root, "apps/gateway/src/unpublished.ts"),
    "export const changed=true;",
  );
  const changed = await createControllerSourceArchive(root);
  expect((await install(destination, changed)).code).not.toBe(0);
  expect(
    await readFile(
      join(destination, "apps/gateway/src/unpublished.ts"),
      "utf8",
    ),
  ).toContain("source-not-on-GitHub");
  await writeFile(
    join(destination, "apps/gateway/src/unpublished.ts"),
    "local edit",
  );
  expect((await install(destination, archive)).code).not.toBe(0);
  expect(
    await readFile(
      join(destination, "apps/gateway/src/unpublished.ts"),
      "utf8",
    ),
  ).toBe("local edit");
  const old = await target();
  await writeFile(join(old, "package.json"), "{}");
  expect((await install(old, archive)).stderr).toContain("cannot be adopted");
  expect(await readFile(join(old, "package.json"), "utf8")).toBe("{}");
  const linked = await target(),
    outside = await scratch();
  await symlink(outside, join(linked, "apps"));
  expect((await install(linked, archive)).code).not.toBe(0);
  expect(
    await stat(join(outside, "gateway")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
test("fixed script parents and build caches must be real, with dependency caches admitted only after source verification", async () => {
  const source = await fixture(), archive = await createControllerSourceArchive(source);
  for (const component of ["scripts", "node_modules", "dist"]) {
    const destination = await target(), outside = await scratch();
    await symlink(outside, join(destination, component));
    expect((await install(destination, archive)).code).not.toBe(0);
    expect(await readFile(join(destination, ".env"), "utf8")).toBe("PRIVATE_TOKEN=preserve\n");
    expect(await stat(join(outside, "build-cli.ts")).then(() => true, () => false)).toBe(false);
  }
  const destination = await target();
  await mkdir(join(destination, "node_modules"), {mode:0o700});
  expect((await install(destination, archive)).stderr).toContain("unverified dependency/build directory");
  await rm(join(destination, "node_modules"), {recursive:true});
  expect((await install(destination, archive)).code).toBe(0);
  await mkdir(join(destination, "node_modules"), {mode:0o700});
  expect((await install(destination, archive)).code).toBe(0);
});
test("corrupt archives do not publish source, and incomplete local inputs fail before SSH or local env creation", async () => {
  const root = await fixture(),
    archive = await createControllerSourceArchive(root),
    destination = await target();
  archive.files[0]!.content = Buffer.from("corrupt").toString("base64");
  expect((await install(destination, archive)).code).not.toBe(0);
  expect(
    await stat(join(destination, "package.json")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  await rm(join(root, ".dockerignore"));
  let calls = 0;
  const env = join(root, "operator.env");
  await expect(
    remoteSetup({
      identity: "id",
      host: "fixture",
      user: "ubuntu",
      remoteDir: "/opt/laun",
      checkoutRoot: root,
      envFile: env,
      noStart: true,
      runner: async () => {
        calls++;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow("incomplete");
  expect(calls).toBe(0);
  expect(
    await stat(env).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
test("a source without the actual v2 API fails no-model qualification", async () => {
  const root = await fixture(),
    result = await execute(
      CONTROLLER_QUALIFICATION_SCRIPT.replace(
        "resolve(process.argv[1])",
        JSON.stringify(root),
      ),
    );
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain("LAUN_CONTROLLER_CONTRACT_OK");
});
test("source SSH transmits current checkout and hashchecked trusted receiver rather than requesting a floating clone", async () => {
  const source = await fixture(),
    base = await scratch(),
    destination = join(base, "controller"),
    calls: { argv: string[]; stdin?: string }[] = [],
    key = "laun_deadbeef_" + "x".repeat(32);
  const runner: CommandRunner = async (argv, options) => {
    calls.push({ argv, stdin: options?.stdin });
    const command = argv.at(-1)!;
    if (command.includes("bash -s --")) {
      const result = await execute(
        await readFile(
          join(destination, "deploy/controller-source-installer.ts"),
          "utf8",
        ),
        await readFile(join(destination, ".controller-source.json"), "utf8"),
      );
      return {
        code: result.code,
        stdout:
          result.code === 0
            ? `LAUN_KEY=${key}\nLAUN_DIR=${destination}\n`
            : result.stdout,
        stderr: result.stderr,
      };
    }
    const child = Bun.spawn(["bash", "-c", command], {
      stdin:
        options?.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
  const result = await remoteSetup({
    identity: "id",
    host: "fixture",
    user: "ubuntu",
    remoteDir: destination,
    envFile: join(base, "local.env"),
    checkoutRoot: source,
    noStart: true,
    runner,
  });
  expect(result.key).toBe(key);
  expect(
    await readFile(
      join(destination, "apps/gateway/src/unpublished.ts"),
      "utf8",
    ),
  ).toContain("source-not-on-GitHub");
  expect(await readFile(join(destination, ".dockerignore"), "utf8")).toBe(
    await readFile(join(source, ".dockerignore"), "utf8"),
  );
  expect(calls.at(-1)?.argv.at(-1)).toContain("LAUN_SOURCE_ARCHIVE=true");
  expect(
    calls.every((call) => !call.argv.join(" ").includes("git clone")),
  ).toBe(true);
  expect(
    calls.filter((call) =>
      call.argv.at(-1)?.includes("sha256sum --check --status"),
    ),
  ).toHaveLength(deploymentFiles().length + 1);
});
test("direct SSH cannot silently reuse a remote checkout without an explicit source mode", async () => {
  let calls = 0;
  await expect(
    runRemoteSetup({
      identity: "id",
      host: "fixture",
      remoteDir: "/opt/laun",
      envContent: "private",
      bootstrapScript: "",
      runner: async () => {
        calls++;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow("no remote checkout");
  expect(calls).toBe(0);
});
test("bootstrap summary reads quoted export dotenv values without changing private config", async () => {
  const root = await target(),
    bin = join(root, "tools"),
    key = "laun_deadbeef_" + "q".repeat(32);
  await mkdir(bin, { mode: 0o700 });
  for (const file of deploymentFiles()) {
    await mkdir(dirname(join(root, file.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(root, file.path),
      await readFile(resolve(import.meta.dir, "../../..", file.path), "utf8"),
      { mode: 0o600 },
    );
  }
  const value = `export LAUN_KEY='${key}'\nexport GATEWAY_PORT="18123"\nexport LAUN_TAG='9.8.7'\nexport GATEWAY_TOKEN='private-fixture-controller'\n`;
  await writeFile(join(root, ".env"), value, { mode: 0o600 });
  for (const command of [
    "curl",
    "git",
    "unzip",
    "dpkg",
    "docker",
    "systemctl",
    "usermod",
  ])
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(bin, "sudo"),
    '#!/bin/sh\n[ "$1" != -n ] || shift\ncase "$1" in true|systemctl|usermod|apt-get|service) exit 0;; *) echo "unexpected privilege request refused in fixture" >&2; exit 90;; esac\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "bun"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(["bash", join(root, "deploy/bootstrap.sh"), root], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAUN_RELEASE_ONLY: "true",
      LAUN_SOURCE_ARCHIVE: "false",
      LAUN_NO_START: "true",
      LAUN_SERVICE_IMAGE: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code === 0).toBe(true);
  expect(stdout.includes("LAUN_PORT=18123")).toBe(true);
  expect(stdout.split("\n").at(-2) === `LAUN_KEY=${key}`).toBe(true);
  expect(stderr.includes(key)).toBe(false);
  expect((await readFile(join(root, ".env"), "utf8")) === value).toBe(true);
});
test("a fresh source bootstrap refuses missing v2 qualification before starting any container", async () => {
  const source = await fixture(),
    archive = await createControllerSourceArchive(source),
    root = await target(),
    bin = join(root, "fixture-tools"),
    key = "laun_deadbeef_" + "f".repeat(32);
  await mkdir(bin, { mode: 0o700 });
  for (const file of deploymentFiles()) {
    await mkdir(dirname(join(root, file.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(root, file.path),
      await readFile(resolve(import.meta.dir, "../../..", file.path), "utf8"),
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(root, "deploy/controller-source-installer.ts"),
    controllerSourceInstaller(root),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, ".controller-source.json"),
    JSON.stringify(archive),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, ".env"),
    `LAUN_KEY=${key}\nGATEWAY_TOKEN=fixture-only\nGATEWAY_PORT=18124\n`,
    { mode: 0o600 },
  );
  for (const command of [
    "curl",
    "git",
    "unzip",
    "dpkg",
    "docker",
    "systemctl",
    "usermod",
  ])
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(bin, "sudo"),
    '#!/bin/sh\n[ "$1" != -n ] || shift\ncase "$1" in true|systemctl|usermod|apt-get|service) exit 0;; *) echo "fixture blocked an unexpected privilege request" >&2; exit 90;; esac\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "bun"),
    `#!/bin/sh\ncase "$1" in install) exit 0;; run) [ "$2" != build ] || exit 0;; esac\nexec ${shQuote(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(["bash", join(root, "deploy/bootstrap.sh"), root], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAUN_RELEASE_ONLY: "false",
      LAUN_SOURCE_ARCHIVE: "true",
      LAUN_NO_START: "false",
      LAUN_SERVICE_IMAGE: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code !== 0).toBe(true);
  expect(stderr.includes("source controller qualification failed")).toBe(true);
  expect(stdout.includes("validating deployment configuration")).toBe(false);
  expect(stdout.includes(key) || stderr.includes(key)).toBe(false);
});
test("a pulled legacy image is rejected in an isolated contract probe before any compose up", async () => {
  const root = await target(),
    bin = join(root, "fixture-engine"),
    log = join(root, "engine.log"),
    key = "laun_deadbeef_" + "p".repeat(32);
  await mkdir(bin, { mode: 0o700 });
  for (const file of deploymentFiles()) {
    await mkdir(dirname(join(root, file.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(root, file.path),
      await readFile(resolve(import.meta.dir, "../../..", file.path), "utf8"),
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(root, ".env"),
    `LAUN_KEY=${key}\nGATEWAY_TOKEN=private-fixture-only\nGATEWAY_PORT=18125\nLAUN_TAG=9.8.7\nLAUN_SERVICE_IMAGE=registry.example/legacy@sha256:${"a".repeat(64)}\nOPENSHELL_ENABLED=false\n`,
    { mode: 0o600 },
  );
  for (const command of [
    "curl",
    "git",
    "unzip",
    "dpkg",
    "systemctl",
    "usermod",
  ])
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(bin, "bun"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUN_FAKE_ENGINE_LOG"\nif [ "$1" = run ]; then echo "legacy image lacks v2 API" >&2; exit 1; fi\nexit 0\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "sudo"),
    '#!/bin/sh\n[ "$1" != -n ] || shift\ncase "$1" in true|systemctl|usermod|apt-get|service) exit 0;; env|timeout) exec "$@";; *) exit 90;; esac\n',
    { mode: 0o755 },
  );
  const child = Bun.spawn(["bash", join(root, "deploy/bootstrap.sh"), root], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAUN_RELEASE_ONLY: "true",
      LAUN_SOURCE_ARCHIVE: "false",
      LAUN_NO_START: "false",
      LAUN_FAKE_ENGINE_LOG: log,
      LAUN_SERVICE_IMAGE: `registry.example/legacy@sha256:${"a".repeat(64)}`,
      PI_CONFIG_DIR: join(root, "private-pi"),
      PI_CONTROLLER_AUTH_DIR: join(root, "private-auth"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);
  expect(code !== 0).toBe(true);
  expect(
    stderr.includes(
      "pulled image lacks the required v2 owner/durable/inference contract",
    ),
  ).toBe(true);
  const calls = await readFile(log, "utf8");
  expect(calls.includes("run --rm --network none --read-only")).toBe(true);
  expect(calls.includes("--cap-drop ALL")).toBe(true);
  expect(calls.includes("--env-file")).toBe(true);
  expect(
    calls
      .split("\n")
      .some((line) => line.startsWith("compose ") && line.includes(" up ")),
  ).toBe(false);
  expect(calls.includes("--volume") || calls.includes(" -v ")).toBe(false);
  expect(
    calls.includes(key) || stdout.includes(key) || stderr.includes(key),
  ).toBe(false);
});
