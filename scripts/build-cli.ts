import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { CliArtifactManifest, WorkerCapabilities } from "@laun/protocol";
import { parseArgs, flagString, UsageError } from "../apps/laun/src/args.js";
import { createYardSourceArchive } from "../apps/laun/src/yard-source.js";
import { supportsYardCapabilities } from "../apps/laun/src/yard-setup.js";
import { generateCliAssets } from "./generate-cli-assets.js";

export async function buildCli(
  argv = process.argv.slice(2),
): Promise<CliArtifactManifest> {
  if (Bun.version !== "1.4.4")
    throw new Error(
      "release CLI compilation requires pinned Bun 1.4.4; source development remains Bun >=1.2",
    );
  const root = resolve(import.meta.dir, ".."),
    parsed = parseArgs(argv, { value: ["target", "outfile", "version"] });
  if (parsed.positionals.length)
    throw new UsageError(
      "usage: bun scripts/build-cli.ts [--target bun-linux-x64] [--outfile dist/laun] [--version X.Y.Z]",
    );
  const target = flagString(parsed.flags, "target");
  if (
    target &&
    !/^bun-(?:linux-(?:x64(?:-baseline)?|arm64)|darwin-(?:x64|arm64)|windows-x64)$/.test(
      target,
    )
  )
    throw new UsageError("unsupported CLI compilation target");
  const pkg = (await Bun.file(resolve(root, "package.json")).json()) as {
    version: string;
  };
  const version =
    flagString(parsed.flags, "version") ??
    process.env.LAUN_VERSION ??
    pkg.version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version))
    throw new UsageError("CLI version must be a concrete release version");
  const revision = process.env.LAUN_SOURCE_REVISION ?? process.env.GITHUB_SHA;
  if (revision && !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("source revision must be an exact commit SHA");
  const repository =
    process.env.LAUN_SOURCE_REPOSITORY ??
    `https://github.com/${process.env.GITHUB_REPOSITORY ?? "swarnimarun/laun"}.git`;
  const url = new URL(repository);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("source repository must be credential-free HTTPS");
  const output = resolve(
    flagString(parsed.flags, "outfile") ??
      resolve(
        root,
        "dist",
        target?.includes("windows") || process.platform === "win32"
          ? "laun.exe"
          : "laun",
      ),
  );
  await generateCliAssets(root);
  const assets = await import(
    `../apps/laun/src/bundled-assets.generated.js?build=${Date.now()}`
  );
  const source = await createYardSourceArchive(root);
  const capabilities = (await Bun.file(
    resolve(root, "apps/worker/src/capabilities.json"),
  ).json()) as WorkerCapabilities;
  if (!supportsYardCapabilities(capabilities, "controller"))
    throw new Error(
      "release worker capabilities lack the required central inference/durability contract",
    );
  await mkdir(dirname(output), { recursive: true });
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      ...(target ? [`--target=${target}`] : []),
      "--define",
      `process.env.LAUN_VERSION=${JSON.stringify(version)}`,
      "--define",
      `process.env.LAUN_SOURCE_REVISION=${JSON.stringify(revision ?? "")}`,
      "--define",
      `process.env.LAUN_SOURCE_REPOSITORY=${JSON.stringify(repository)}`,
      resolve(root, "apps/laun/src/index.ts"),
      "--outfile",
      output,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0)
    throw new Error("portable CLI compilation failed");
  const manifest: CliArtifactManifest = {
    version: 1,
    kind: "laun-cli",
    cliVersion: version,
    createdAt: new Date().toISOString(),
    sourceRevision: revision,
    sourceRepository: revision ? repository : undefined,
    sourceBundleSha256: source.manifest,
    deploymentTemplatesSha256: assets.CLI_ASSET_MANIFEST,
    toolchain: {
      bun: Bun.version,
      piDurable: capabilities.checkpointVersion.replace(/^pi-durable@/, ""),
      openShell: "0.1.8",
      workerProtocol: capabilities.protocolVersion,
      durabilityAdapters: capabilities.durabilityAdapters!,
    },
    binary: {
      fileName: basename(output),
      target: target ?? `bun-${process.platform}-${process.arch}`,
      bytes: (await stat(output)).size,
      sha256: createHash("sha256")
        .update(await readFile(output))
        .digest("hex"),
    },
  };
  await Bun.write(
    `${output}.manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
if (import.meta.main) {
  try {
    const result = await buildCli();
    console.log(
      `Built ${result.binary.fileName} with checksummed deployment templates and artifact manifest.`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
