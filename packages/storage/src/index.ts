import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { CheckpointReference, ThreadCheckpoint } from "@laun/protocol";
export {inspectDiskReserve,requireDiskReserve,StorageAdmissionError} from "./admission.js";
export type {DiskReserve} from "./admission.js";
export const MAX_CHECKPOINT_BYTES=48*1024*1024;
export const MAX_CHECKPOINT_DATA_BYTES=32*1024*1024;
const digest=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const validId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
const validPath=(v:unknown):v is string=>typeof v==="string"&&v.length<=4096&&/^(session|work)\//.test(v)&&!v.includes("\\")&&!v.includes("\0")&&v.split("/").every(p=>p!==""&&p!=="."&&p!=="..");
export function validateCheckpoint(raw:string|Uint8Array,threadId?:string):ThreadCheckpoint{
 if(Buffer.byteLength(raw)>MAX_CHECKPOINT_BYTES)throw new Error("checkpoint exceeds transport limit");
 const value=JSON.parse(typeof raw==="string"?raw:new TextDecoder("utf-8",{fatal:true}).decode(raw)) as ThreadCheckpoint;
 if(value.version!==1||!validId(value.threadId)||(threadId&&value.threadId!==threadId)||!/^pi-durable@1\.5\.2$/.test(value.runtimeVersion)||!Number.isFinite(Date.parse(value.createdAt))||!Array.isArray(value.files)||value.files.length>2048)throw new Error("invalid checkpoint manifest");
 if(value.omittedPaths!==undefined&&(!Array.isArray(value.omittedPaths)||value.omittedPaths.length>2048||value.omittedPaths.some(p=>!validPath(p)||!p.startsWith("work/"))))throw new Error("invalid checkpoint omission manifest");
 let total=0;const names=new Set<string>();
 for(const f of value.files){if(!f||!validPath(f.path)||names.has(f.path)||typeof f.content!=="string"||f.content.length%4!==0||/[^A-Za-z0-9+/=]/.test(f.content)||!/^[0-9a-f]{64}$/.test(f.sha256))throw new Error("invalid checkpoint file");
  if(f.mode!==undefined&&f.mode!==0o600&&f.mode!==0o700)throw new Error("invalid checkpoint file mode");
  names.add(f.path);const bytes=Buffer.from(f.content,"base64");total+=bytes.length;if(bytes.toString("base64")!==f.content||total>MAX_CHECKPOINT_DATA_BYTES||digest(bytes)!==f.sha256)throw new Error("checkpoint content limit or checksum mismatch");}
 if(!value.files.some(f=>f.path.startsWith("session/")))throw new Error("checkpoint has no durable session state");
 return value;
}
export function checkpointReference(raw:string|Uint8Array,threadId?:string):CheckpointReference{
 const value=validateCheckpoint(raw,threadId);return {threadId:value.threadId,sha256:digest(raw),bytes:Buffer.byteLength(raw),createdAt:value.createdAt,runtimeVersion:value.runtimeVersion,omittedPaths:value.omittedPaths};
}
/** Capture only after the runtime has closed its thread writer. Never follow links. */
export async function captureCheckpoint(threadId:string,threadRoot:string):Promise<string>{
 if(!validId(threadId))throw new Error("invalid checkpoint thread ID");const base=await realpath(threadRoot);const files:ThreadCheckpoint["files"]=[];const omittedPaths:string[]=[];let total=0;
 const walk=async(path:string,prefix:string):Promise<void>=>{
  let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(entry.name===".laun-runtime-lock")continue;
   const file=join(path,entry.name),name=`${prefix}/${entry.name}`;if(!validPath(name))throw new Error("invalid snapshot path");
   if(name.startsWith("work/")&&["node_modules",".git",".cache",".bun",".venv","venv","dist","target"].includes(entry.name)){if(omittedPaths.length>=2048)throw new Error("checkpoint omission limit exceeded");omittedPaths.push(name);continue;}
   const stat=await lstat(file);if(stat.isSymbolicLink())throw new Error("checkpoint refuses symlinks");
   const actual=await realpath(file);if(!actual.startsWith(base+sep))throw new Error("checkpoint path escapes thread");
   if(stat.isDirectory()){await walk(file,name);continue;}if(!stat.isFile())throw new Error("checkpoint refuses special files");
   if(files.length>=2048||total+stat.size>MAX_CHECKPOINT_DATA_BYTES){if(name.startsWith("work/")&&omittedPaths.length<2048){omittedPaths.push(name);continue;}throw new Error("checkpoint exceeds durable session limit");}
   const fd=await open(actual,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let content:Buffer;
   try{const before=await fd.stat();const chunks:Buffer[]=[];let size=0;
    if(!before.isFile())throw new Error("checkpoint source is not a regular file");
    for(;;){const buffer=Buffer.alloc(65536);const read=await fd.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;size+=read.bytesRead;if(total+size>MAX_CHECKPOINT_DATA_BYTES)throw new Error("checkpoint source grew past storage limit");chunks.push(buffer.subarray(0,read.bytesRead));}
    content=Buffer.concat(chunks,size);const after=await fd.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error("file changed during checkpoint");}finally{await fd.close();}
   if((await realpath(file))!==actual)throw new Error("checkpoint path changed during capture");
   total+=content.length;if(total>MAX_CHECKPOINT_DATA_BYTES)throw new Error("checkpoint exceeds storage limit");
   files.push({path:name,content:content.toString("base64"),sha256:digest(content),mode:stat.mode&0o100?0o700:0o600});
  }
 };
 await walk(join(base,"session"),"session");await walk(join(base,"work"),"work");
 const raw=JSON.stringify({version:1,threadId,runtimeVersion:"pi-durable@1.5.2",createdAt:new Date().toISOString(),files,omittedPaths} satisfies ThreadCheckpoint);
 validateCheckpoint(raw,threadId);return raw;
}
/** Restore into a fresh staging directory; preserve existing state on any error. */
export async function restoreCheckpoint(raw:string|Uint8Array,threadId:string,threadRoot:string,expectedSha256?:string):Promise<void>{
 if(expectedSha256&&digest(raw)!==expectedSha256)throw new Error("checkpoint archive checksum mismatch");
 const value=validateCheckpoint(raw,threadId);const destination=resolve(threadRoot),staging=`${destination}.restore-${randomUUID()}`;
 try{await mkdir(staging,{recursive:true,mode:0o700});for(const file of value.files){const target=resolve(staging,file.path);if(!target.startsWith(staging+sep))throw new Error("restore path escapes staging");await mkdir(dirname(target),{recursive:true,mode:0o700});
  const fd=await open(target,"wx",file.mode??0o600);try{await fd.writeFile(Buffer.from(file.content,"base64"));await fd.sync();}finally{await fd.close();}}
  // Existing live/local histories are never silently overwritten.
  try{await lstat(destination);throw new Error("checkpoint destination already exists; preserve or move it before restore");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  await rename(staging,destination);
 }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
}
export async function readBoundedBody(request:Request,limit=MAX_CHECKPOINT_BYTES):Promise<Uint8Array>{
 if(!request.body)return new Uint8Array();const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>limit){await reader.cancel();throw new Error("body exceeds checkpoint limit");}chunks.push(next.value);}}finally{reader.releaseLock();}
 const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}

/** Recover missing session state while preserving any surviving workspace. */
export async function recoverCheckpoint(raw:string|Uint8Array,threadId:string,threadRoot:string,expectedSha256:string):Promise<{preservedAt?:string}>{
 validateCheckpoint(raw,threadId);if(digest(raw)!==expectedSha256)throw new Error("checkpoint archive checksum mismatch");
 let preservedAt:string|undefined;
 try{const stat=await lstat(threadRoot);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("invalid local thread root for recovery");preservedAt=`${threadRoot}.recovery-${randomUUID()}`;await rename(threadRoot,preservedAt);}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 try{await restoreCheckpoint(raw,threadId,threadRoot,expectedSha256);return {preservedAt};}
 catch(error){if(preservedAt){try{await lstat(threadRoot);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")await rename(preservedAt,threadRoot);}}throw error;}
}

/** Host cache epochs prevent A→B→A placement from reopening A's old files. */
export async function placementChanged(threadRoot:string,placementId:string|undefined):Promise<boolean>{
 if(!placementId)return false;if(!validId(placementId))throw new Error("invalid thread placement epoch");
 let fd:Awaited<ReturnType<typeof open>>|undefined;
 try{fd=await open(join(threadRoot,".laun-placement"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await fd.stat();if(!stat.isFile()||stat.size>128)throw new Error("invalid placement marker");return (await fd.readFile("utf8"))!==placementId;}
 catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}finally{await fd?.close();}
}
export async function recordPlacement(threadRoot:string,placementId:string|undefined):Promise<void>{
 if(!placementId)return;if(!validId(placementId))throw new Error("invalid thread placement epoch");
 await mkdir(threadRoot,{recursive:true,mode:0o700});const temporary=join(threadRoot,`.laun-placement-${randomUUID()}`);
 try{const fd=await open(temporary,"wx",0o600);try{await fd.writeFile(placementId);await fd.sync();}finally{await fd.close();}await rename(temporary,join(threadRoot,".laun-placement"));const dir=await open(threadRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
 finally{await rm(temporary,{force:true});}
}
