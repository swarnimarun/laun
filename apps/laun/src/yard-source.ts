import { createHash } from "node:crypto";
import { lstat, readdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { UsageError } from "./args.js";
import { readEnvValue } from "./compose-profile.js";

const ROOT_FILES = new Set([
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.base.json",
]);
const ROOT_DIRS = new Set(["apps", "packages", "vendor", "deploy"]);
export interface YardSourceFile {
  path: string;
  content: string;
  sha256: string;
  mode: number;
}
export interface YardSourceArchive {
  version: 1;
  manifest: string;
  files: YardSourceFile[];
}
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function allowedYardSource(
  path: string,
  directory = false,
  controller = false,
): boolean {
  if (
    controller &&
    (path === ".dockerignore" ||
      path === "deploy/openshell/Dockerfile.pi" ||
      [
        "scripts/build-cli.ts",
        "scripts/generate-cli-assets.ts",
        "scripts/cli-asset-list.ts",
        "scripts/qualify-packaged-control.ts",
        "scripts/qualify-packaged-control.test.ts",
        "scripts/check-container-context.ts",
        "scripts/dev-app.ts",
      ].includes(path) ||
      [
        "apps/gateway/public/v2/assets/garden.webp",
        "apps/gateway/public/v2/assets/dm-sans.ttf",
        "apps/gateway/public/v2/assets/newsreader.ttf",
        "apps/gateway/public/v2/assets/dm-sans-OFL.txt",
        "apps/gateway/public/v2/assets/newsreader-OFL.txt",
      ].includes(path) ||
      (directory && path === "scripts"))
  )
    return true;
  // Self-contained so the receiver embeds exactly the same source policy.
  const rootFiles = new Set([
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "tsconfig.base.json",
  ]);
  const roots = new Set(["apps", "packages", "vendor", "deploy"]);
  const omit = new Set([
    "node_modules",
    "data",
    "logs",
    "sessions",
    ".git",
    ".jj",
    ".laun-local",
    "coverage",
    "target",
    "config",
    "configs",
    "state",
    "credentials",
    "secrets",
    "auth",
    "mtls",
    ".ssh",
    ".aws",
  ]);
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith("/") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.includes("\\")
  )
    return false;
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        omit.has(part.toLowerCase()) ||
        (part === "dist" && parts[0] !== "vendor") ||
        (part.startsWith(".") && part !== ".env.example"),
    )
  )
    return false;
  const leaf = parts.at(-1)!;
  if (directory) return roots.has(parts[0]!);
  if (parts.length === 1) return rootFiles.has(path);
  if (!roots.has(parts[0]!)) return false;
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|css|html|svg|md|sh)$/.test(leaf)) return true;
  if (
    /(?:^|[-_.])(?:auth|credentials?|secrets?|tokens?|(?:api[-_]?)?keys?)(?:[-_.]|$)/i.test(
      leaf,
    )
  )
    return false;
  // Only known declarative JSON/YAML enters the bundle. Arbitrary provider or
  // operator configuration documents are not worker source.
  if (/\.json$/i.test(leaf))
    return (
      leaf === "package.json" ||
      /^tsconfig(?:\.[a-z-]+)?\.json$/.test(leaf) ||
      path === "apps/worker/src/capabilities.json" ||
      /^packages\/policy\/templates\/(restrictive|standard-dev)\.json$/.test(
        path,
      )
    );
  if (/\.ya?ml$/i.test(leaf))
    return /^(deploy\/docker-compose(?:\.openshell)?\.yml|deploy\/openshell\/(policy|provider-model)\.yaml|packages\/policy\/templates\/(restrictive|standard-dev)\.yaml)$/.test(
      path,
    );
  return (
    ["Dockerfile", "Caddyfile", "LICENSE", "NOTICE"].includes(leaf) ||
    path === "deploy/.env.example"
  );
}
/** Source-only bundle of this checkout, including unpublished JJ work and no dependency/data trees. */
export async function createYardSourceArchive(
  root: string,
  options: { controller?: boolean } = {},
): Promise<YardSourceArchive> {
  const files: YardSourceFile[] = [];
  let bytes = 0;
  const configured = new Set<string>();
  const names = [
    "PI_AUTH_FILE",
    "PI_CONTROLLER_AUTH_DIR",
    "PI_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
  ];
  let dotenv = "";
  try {
    const envStat = await lstat(join(root, ".env"));
    if (
      envStat.isFile() &&
      !envStat.isSymbolicLink() &&
      envStat.size <= 1024 * 1024
    )
      dotenv = await Bun.file(join(root, ".env")).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const value = process.env[name] ?? readEnvValue(dotenv, name);
    if (value && isAbsolute(value)) {
      configured.add(resolve(value));
      try {
        configured.add(await realpath(value));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const excluded = (path: string) =>
    [...configured].some((directory) => {
      const rel = relative(directory, resolve(root, path));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  const visit = async (path: string): Promise<void> => {
    if (excluded(path)) return;
    const full = join(root, path),
      stat = await lstat(full);
    if (
      stat.isSymbolicLink() &&
      (allowedYardSource(path, false, options.controller) ||
        allowedYardSource(path, true, options.controller))
    )
      throw new UsageError(`source archive refuses symbolic link: ${path}`);
    if (!allowedYardSource(path, stat.isDirectory(), options.controller))
      return;
    if (stat.isDirectory()) {
      for (const entry of (await readdir(full)).sort())
        await visit(`${path}/${entry}`);
      return;
    }
    if (!stat.isFile())
      throw new UsageError(`source archive requires a regular file: ${path}`);
    if (stat.size > 16 * 1024 * 1024)
      throw new UsageError(`source file is too large: ${path}`);
    const handle = await open(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let content: Buffer;
    try {
      if (!(await handle.stat()).isFile())
        throw new UsageError(`source archive requires a regular file: ${path}`);
      const chunks: Buffer[] = [];
      let length = 0;
      const buffer = Buffer.alloc(65536);
      for (;;) {
        const next = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, 16 * 1024 * 1024 + 1 - length),
          null,
        );
        if (!next.bytesRead) break;
        length += next.bytesRead;
        if (length > 16 * 1024 * 1024)
          throw new UsageError(`source file is too large: ${path}`);
        chunks.push(Buffer.from(buffer.subarray(0, next.bytesRead)));
      }
      content = Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
    bytes += content.byteLength;
    if (bytes > 32 * 1024 * 1024 || files.length >= 4096)
      throw new UsageError(
        "worker source bundle exceeds its 32 MiB/4096-file bound",
      );
    files.push({
      path,
      content: content.toString("base64"),
      sha256: sha(content),
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
    });
  };
  for (const entry of (await readdir(root)).sort())
    if (
      ROOT_FILES.has(entry) ||
      ROOT_DIRS.has(entry) ||
      (options.controller && [".dockerignore", "scripts"].includes(entry))
    )
      await visit(entry);
  for (const required of [
    "package.json",
    "bun.lock",
    "apps/worker/src/index.ts",
  ])
    if (!files.some((file) => file.path === required))
      throw new UsageError(`worker source is incomplete: ${required}`);
  return {
    version: 1,
    manifest: sha(
      files
        .map((file) => `${file.path}\0${file.sha256}\0${file.mode}\n`)
        .join(""),
    ),
    files,
  };
}

/** Fixed trusted decoder: verifies the entire manifest before creating a fresh release directory. */
export function yardSourceDecoder(destination: string): string {
  return `import {createHash} from 'node:crypto';import {mkdir,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
const root=${JSON.stringify(destination)},sha=v=>createHash('sha256').update(v).digest('hex');
const raw=await Bun.stdin.text();if(raw.length>48*1024*1024)throw Error('source archive exceeds transport bound');const a=JSON.parse(raw);
if(a.version!==1||!Array.isArray(a.files)||a.files.length>4096)throw Error('invalid source manifest');
const allowed=${allowedYardSource.toString()};
const seen=new Set();let bytes=0;const ready=[];
for(const f of a.files){if(typeof f.path!=='string'||!allowed(f.path)||seen.has(f.path))throw Error('disallowed source path');seen.add(f.path);
if(typeof f.content!=='string'||!([420,493].includes(f.mode)))throw Error('invalid source file');const content=Buffer.from(f.content,'base64');bytes+=content.length;if(content.length>16*1024*1024||bytes>32*1024*1024||sha(content)!==f.sha256)throw Error('source content mismatch');ready.push([f,content]);}
if(!['package.json','bun.lock','apps/worker/src/index.ts'].every(p=>seen.has(p))||sha(a.files.map(f=>f.path+'\\0'+f.sha256+'\\0'+f.mode+'\\n').join(''))!==a.manifest)throw Error('source manifest mismatch');
await mkdir(root,{mode:448});for(const [f,content]of ready){const target=join(root,f.path);await mkdir(dirname(target),{recursive:true,mode:448});await writeFile(target,content,{mode:f.mode,flag:'wx'});}console.log('LAUN_SOURCE_VERIFIED='+a.manifest);`;
}
