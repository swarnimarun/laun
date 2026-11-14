import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint, checkpointReference, restoreCheckpoint, validateCheckpoint } from "./index.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){const base=await mkdtemp(join(tmpdir(),"laun-checkpoint-"));dirs.push(base);const root=join(base,"source");await mkdir(join(root,"session"),{recursive:true});await mkdir(join(root,"work"));await writeFile(join(root,"session","events.jsonl"),'{"type":"durable"}\n');await writeFile(join(root,"work","answer.txt"),"durable artifact");return {base,root};}
test("quiescent durable thread plus artifacts restores from a validated archive",async()=>{
 const {base,root}=await fixture();const raw=await captureCheckpoint("thread",root);const ref=checkpointReference(raw,"thread");const restored=join(base,"restored");
 await restoreCheckpoint(raw,"thread",restored,ref.sha256);expect(await readFile(join(restored,"work","answer.txt"),"utf8")).toBe("durable artifact");expect(await readFile(join(restored,"session","events.jsonl"),"utf8")).toBe('{"type":"durable"}\n');
 await expect(restoreCheckpoint(raw,"thread",restored,ref.sha256)).rejects.toThrow("already exists");
});
test("rejects path traversal, tampered files, wrong runtime and mismatched thread",async()=>{
 const {root}=await fixture();const raw=await captureCheckpoint("thread",root);const value=JSON.parse(raw);
 for(const path of ["../outside","session/../../outside","work/../outside","work//file","work\\outside"]){const copy=structuredClone(value);copy.files[0].path=path;expect(()=>validateCheckpoint(JSON.stringify(copy))).toThrow();}
 const tampered=structuredClone(value);tampered.files[0].content=Buffer.from("changed").toString("base64");expect(()=>validateCheckpoint(JSON.stringify(tampered))).toThrow("checksum");
 expect(()=>validateCheckpoint(raw,"sibling")).toThrow();expect(()=>validateCheckpoint(JSON.stringify({...value,runtimeVersion:"other"}))).toThrow();
});
test("snapshot never follows a link into controller credentials",async()=>{
 const {base,root}=await fixture();await writeFile(join(base,"controller-secret"),"test-only-secret");await symlink(join(base,"controller-secret"),join(root,"work","leak"));
 await expect(captureCheckpoint("thread",root)).rejects.toThrow("symlinks");
});

test("recovery preserves a surviving workspace when session files are missing",async()=>{
 const {base,root}=await fixture();const raw=await captureCheckpoint("thread",root);const ref=checkpointReference(raw,"thread");const damaged=join(base,"damaged");await mkdir(join(damaged,"work"),{recursive:true});await writeFile(join(damaged,"work","local.txt"),"preserve local changes");
 const {recoverCheckpoint}=await import("./index.js");const recovery=await recoverCheckpoint(raw,"thread",damaged,ref.sha256);
 expect(recovery.preservedAt).toBeDefined();expect(await readFile(join(recovery.preservedAt!,"work","local.txt"),"utf8")).toBe("preserve local changes");expect(await readFile(join(damaged,"work","answer.txt"),"utf8")).toBe("durable artifact");
});
