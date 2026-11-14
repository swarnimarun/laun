import { createHash } from "node:crypto";
import { UsageError } from "./args.js";
import {
  allowedYardSource,
  createYardSourceArchive,
  type YardSourceArchive,
} from "./yard-source.js";
export const CONTROLLER_SOURCE_REQUIRED = [
  "package.json",
  "bun.lock",
  ".dockerignore",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/control.ts",
  "packages/control/src/http.ts",
  "packages/control/src/durability.ts",
  "packages/runtime/src/index.ts",
  "deploy/Dockerfile",
  "deploy/bootstrap.sh",
  "deploy/controller-contract.js",
  "deploy/install-bun.sh",
  "apps/laun/src/compose-profile.ts",
  "apps/laun/src/controller-source.ts",
  "scripts/build-cli.ts",
  "scripts/generate-cli-assets.ts",
  "scripts/cli-asset-list.ts",
  "scripts/qualify-packaged-control.ts",
  "scripts/qualify-packaged-control.test.ts",
  "scripts/check-container-context.ts",
  "scripts/dev-app.ts",
];
const REQUIRED = CONTROLLER_SOURCE_REQUIRED;
export function validateControllerSource(archive: YardSourceArchive): void {
  if (
    archive.version !== 1 ||
    !Array.isArray(archive.files) ||
    archive.files.length > 4096
  )
    throw new UsageError("invalid controller source archive");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of archive.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      !allowedYardSource(file.path, false, true) ||
      ["deploy/controller-source-installer.ts"].includes(file.path) ||
      paths.has(file.path) ||
      ![0o644, 0o755].includes(file.mode)
    )
      throw new UsageError("disallowed controller source path");
    paths.add(file.path);
    const content = Buffer.from(file.content, "base64");
    bytes += content.length;
    if (
      content.length > 16 * 1024 * 1024 ||
      bytes > 32 * 1024 * 1024 ||
      createHash("sha256").update(content).digest("hex") !== file.sha256
    )
      throw new UsageError("invalid controller source content");
  }
  if (
    !REQUIRED.every((path) => paths.has(path)) ||
    createHash("sha256")
      .update(
        archive.files
          .map((file) => `${file.path}\0${file.sha256}\0${file.mode}\n`)
          .join(""),
      )
      .digest("hex") !== archive.manifest
  )
    throw new UsageError(
      "controller source is incomplete or its manifest is invalid",
    );
}
export async function createControllerSourceArchive(
  root: string,
): Promise<YardSourceArchive> {
  const archive = await createYardSourceArchive(root, { controller: true });
  validateControllerSource(archive);
  return archive;
}

/** Trusted receiver, supplied by this CLI rather than executed from the archive. */
export function controllerSourceInstaller(directory: string): string {
  return `import {createHash,randomUUID} from 'node:crypto';import {constants} from 'node:fs';import {lstat,readdir,mkdir,open,readFile,link,unlink} from 'node:fs/promises';import {join,dirname,resolve,parse} from 'node:path';
const root=${JSON.stringify(directory)},uid=process.getuid?.(),allowed=${allowedYardSource.toString()},sha=v=>createHash('sha256').update(v).digest('hex');
const raw=await Bun.stdin.text();if(raw.length>48*1024*1024)throw Error('controller source transport exceeds bound');const a=JSON.parse(raw),seen=new Set(),ready=[];let total=0;
if(a.version!==1||!Array.isArray(a.files)||a.files.length>4096)throw Error('invalid controller source archive');for(const f of a.files){if(typeof f.path!=='string'||!allowed(f.path,false,true)||f.path==='deploy/controller-source-installer.ts'||seen.has(f.path)||!([420,493].includes(f.mode))||typeof f.content!=='string')throw Error('unsafe controller source path');seen.add(f.path);const bytes=Buffer.from(f.content,'base64');total+=bytes.length;if(bytes.length>16*1024*1024||total>32*1024*1024||sha(bytes)!==f.sha256)throw Error('controller source content mismatch');ready.push([f,bytes]);}
if(!${JSON.stringify(REQUIRED)}.every(path=>seen.has(path))||sha(a.files.map(f=>f.path+'\\0'+f.sha256+'\\0'+f.mode+'\\n').join(''))!==a.manifest)throw Error('controller source manifest mismatch');
const info=await lstat(root);if(info.isSymbolicLink()||!info.isDirectory()||(uid!==undefined&&info.uid!==uid)||(info.mode&63)!==0)throw Error('controller installation root must be real private and installer-owned');
async function exists(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function bounded(path,limit=16*1024*1024,publicSource=false){const before=await lstat(path);if(before.isSymbolicLink()||!before.isFile()||!publicSource&&before.nlink!==1||(uid!==undefined&&before.uid!==uid)||(before.mode&18)!==0||before.size>limit)throw Error('unsafe existing controller source file');const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await fd.stat();if(!s.isFile()||s.ino!==before.ino||s.dev!==before.dev||!publicSource&&s.nlink!==1||(uid!==undefined&&s.uid!==uid)||(s.mode&18)!==0||s.size>limit)throw Error('controller source changed');const chunks=[];let size=0;for(;;){const buffer=Buffer.alloc(Math.min(65536,limit+1-size)),r=await fd.read(buffer);if(!r.bytesRead)break;size+=r.bytesRead;if(size>limit)throw Error('controller source read bound');chunks.push(buffer.subarray(0,r.bytesRead));}const latest=await lstat(path);if(latest.isSymbolicLink()||!latest.isFile()||latest.ino!==s.ino||latest.dev!==s.dev||latest.size!==s.size||latest.mtimeMs!==s.mtimeMs||latest.ctimeMs!==s.ctimeMs||!publicSource&&latest.nlink!==1||(uid!==undefined&&latest.uid!==uid)||(latest.mode&18)!==0)throw Error('controller source changed while verifying');return Buffer.concat(chunks,size);}finally{await fd.close();}}
const marker=join(root,'.laun-source.json'),pending=join(root,'.laun-source-pending.json'),identity={version:1,kind:'controller-source',manifest:a.manifest};
const installation=JSON.parse((await bounded(join(root,'.laun-install.json'),1024)).toString());if(installation.version!==1||installation.kind!=='controller')throw Error('missing verified controller installation identity');
for(const path of[marker,pending])if(await exists(path)){if(JSON.stringify(JSON.parse((await bounded(path,1024)).toString()))!==JSON.stringify(identity))throw Error('controller source changed; use an explicit reviewed upgrade');}
if(!await exists(marker)&&!await exists(pending)&&await exists(join(root,'package.json')))throw Error('existing unverified checkout cannot be adopted; choose a fresh application directory or explicit reviewed migration');
const expected=new Map(ready.map(([f])=>[f.path,f]));let inventory=0;
async function inventoryTree(relative){const path=join(root,relative),s=await lstat(path);if(++inventory>20000)throw Error('controller source inventory exceeds bound');if(s.isSymbolicLink()||(uid!==undefined&&s.uid!==uid)||(s.mode&18)!==0)throw Error('controller source has unsafe ownership or writable paths');if(s.isDirectory()){if(['node_modules','dist'].includes(relative.split('/').at(-1))&&!(relative.startsWith('vendor/')&&relative.endsWith('/dist'))){if(!await exists(marker))throw Error('unverified dependency/build directory; use a fresh application path');return;}for(const name of await readdir(path))await inventoryTree(relative+'/'+name);return;}if(!s.isFile())throw Error('controller source contains a special file');if(relative==='deploy/controller-source-installer.ts'||relative.endsWith('.tsbuildinfo')&&await exists(marker))return;const f=expected.get(relative);if(!f||sha(await bounded(path,16*1024*1024,true))!==f.sha256)throw Error('unrecognized or changed source in installation; use an explicit reviewed upgrade');}
for(const part of['apps','packages','vendor','deploy','scripts','node_modules','dist'])if(await exists(join(root,part)))await inventoryTree(part);
for(const [f]of ready){const path=join(root,f.path);if(await exists(path)&&sha(await bounded(path,16*1024*1024,true))!==f.sha256)throw Error('existing source differs; setup will not overwrite it');}
async function sync(path){const dir=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
async function publish(path,bytes,mode){await mkdir(dirname(path),{recursive:true,mode:448});const temporary=path+'.tmp-'+randomUUID();const fd=await open(temporary,'wx',mode);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}try{await link(temporary,path);}finally{await unlink(temporary);}await sync(dirname(path));}
const identityBytes=Buffer.from(JSON.stringify(identity));if(!await exists(pending)&&!await exists(marker))await publish(pending,identityBytes,384);
for(const [f,bytes]of ready){const path=join(root,f.path);if(!await exists(path))await publish(path,bytes,f.mode);}
const parents=new Set();for(const [f]of ready){let path=dirname(join(root,f.path));while(path!==root){parents.add(path);path=dirname(path);}}for(const path of [...parents].sort((a,b)=>b.length-a.length))await sync(path);if(!await exists(marker))await publish(marker,identityBytes,384);if(await exists(pending))await unlink(pending);await sync(root);console.log('LAUN_CONTROLLER_SOURCE_VERIFIED='+a.manifest);`;
}

/** Initialize the actual source API in an isolated temporary directory, without model calls. */
export const CONTROLLER_QUALIFICATION_SCRIPT = `import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';const root=resolve(process.argv[1]),temporary=await mkdtemp(join(tmpdir(),'laun-controller-contract-'));let control;try{const {loadConfig}=await import(pathToFileURL(join(root,'apps/gateway/src/config.ts')).href);const {createControl}=await import(pathToFileURL(join(root,'apps/gateway/src/control.ts')).href);const env={GATEWAY_TOKEN:'contract-only-not-a-service-key',DATA_DIR:temporary,MODEL:'qualification/metadata-only',LAUN_TRUSTED_LOCAL:'false',OPENSHELL_ENABLED:'false',LAUN_DEMO:'false',PI_AUTH_FILE:join(temporary,'not-configured.json')};control=createControl(loadConfig(env),env);const p={id:'qualification',admin:true},state=await control.handle(new Request('http://qualification/api/v2/state'),p),me=await control.handle(new Request('http://qualification/api/v2/me'),p);if(!state.ok||!me.ok)throw Error('source lacks v2 owner API');const value=await state.json();if(value.readiness?.durableJournal!==true||value.readiness?.inferenceRelay!==true||(await me.json()).principalId!==p.id)throw Error('source lacks required v2 durable/inference contract');console.log('LAUN_CONTROLLER_CONTRACT_OK');}finally{await control?.service.close();control?.store.close();await rm(temporary,{recursive:true,force:true});}`;
