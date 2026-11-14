import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLI_ASSETS, CLI_ASSET_MANIFEST } from "./bundled-assets.generated.js";

export interface DeploymentAssets {
  root: string;
  bundled: boolean;
  manifest: string;
}
export interface DeploymentFile {
  path: string;
  content: string;
  sha256: string;
}
export function deploymentFiles(): DeploymentFile[] {
  return Object.entries(CLI_ASSETS).map(([path, file]) => ({ path, ...file }));
}
function secureDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (typeof process.getuid === "function" &&
      (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))
  )
    throw new Error(
      "portable deployment assets require an owner-controlled directory without group/other write access",
    );
}
/** A compiled CLI materializes its immutable public templates outside the source checkout. */
export function deploymentAssets(
  checkoutRoot: string,
  environmentFile: string,
): DeploymentAssets {
  if (
    existsSync(join(checkoutRoot, "deploy/.env.example")) &&
    existsSync(join(checkoutRoot, "deploy/bootstrap.sh"))
  )
    return { root: checkoutRoot, bundled: false, manifest: CLI_ASSET_MANIFEST };
  const cache = join(dirname(resolve(environmentFile)), ".laun-assets"),
    target = join(cache, CLI_ASSET_MANIFEST);
  mkdirSync(dirname(resolve(environmentFile)), {
    recursive: true,
    mode: 0o700,
  });
  secureDirectory(dirname(resolve(environmentFile)));
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  secureDirectory(cache);
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(cache, ".prepare-"));
    try {
      for (const [path, file] of Object.entries(CLI_ASSETS)) {
        const destination = join(staging, path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, file.content, { flag: "wx", mode: 0o600 });
      }
      try {
        renameSync(staging, target);
      } catch (error) {
        if (!existsSync(target)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  secureDirectory(target);
  for (const [path, file] of Object.entries(CLI_ASSETS)) {
    const source = join(target, path),
      stat = lstatSync(source);
    let parent = dirname(source);
    while (parent !== target) {
      secureDirectory(parent);
      parent = dirname(parent);
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (typeof process.getuid === "function" &&
        (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) ||
      createHash("sha256").update(readFileSync(source)).digest("hex") !==
        file.sha256
    )
      throw new Error(
        `portable deployment template changed; inspect the private asset cache before retrying: ${path}`,
      );
  }
  return { root: target, bundled: true, manifest: CLI_ASSET_MANIFEST };
}
export { CLI_ASSETS, CLI_ASSET_MANIFEST };
