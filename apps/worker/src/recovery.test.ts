import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createControlBackup, restoreControlBackup } from "@laun/control";
import { createPiRuntime } from "@laun/runtime";
import type { CheckpointReference, ControlRun, ControlState, PublicAgentKeyRecord, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { OutboundWorker } from "./worker.js";

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function directory(){const dir=mkdtempSync(join(tmpdir(),"laun-disaster-"));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
async function gateway(dataDir:string,serviceKey:string){
 const reservation=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response()});const port=reservation.port!;reservation.stop(true);
 const child=Bun.spawn([process.execPath,"apps/gateway/src/index.ts"],{cwd:resolve(import.meta.dir,"../../.."),env:{PATH:process.env.PATH,HOME:directory(),GATEWAY_BIND:"127.0.0.1",GATEWAY_PORT:String(port),GATEWAY_TOKEN:serviceKey,DATA_DIR:dataDir,LAUN_DEMO:"true",LAUN_TRUSTED_LOCAL:"false",OPENSHELL_ENABLED:"false",LAUN_LEGACY_API:"false"},stdout:"ignore",stderr:"pipe"});
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;child.kill("SIGTERM");await child.exited;};cleanups.push(stop);
 const url=`http://127.0.0.1:${port}`;
 for(let i=0;;i++){try{if((await fetch(`${url}/health`)).ok)break;}catch{}if(i>200)throw new Error(`disposable gateway failed: ${await new Response(child.stderr).text()}`);await Bun.sleep(10);}
 const request=async<T>(path:string,key:string,body?:unknown,method=body===undefined?"GET":"POST"):Promise<T>=>{
  const response=await fetch(`${url}${path}`,{method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw new Error(`gateway ${path}: HTTP ${response.status} ${await response.text()}`);return await response.json() as T;
 };
 return {url,request,stop};
}

test("offline backup restores a real gateway identity and Pi thread on a replacement yard without replay",async()=>{
 const original=directory(),backup=join(directory(),"backup"),replacement=join(directory(),"replacement"),serviceKey=randomUUID();
 let app=await gateway(original,serviceKey);
 const identity=await app.request<{key:string;record:PublicAgentKeyRecord}>("/keys",serviceKey,{label:"Recovery owner"});const principalId=identity.record.principalId!;expect(principalId).toMatch(/^user_[0-9a-f]{32}$/);
 const enrolled=await app.request<{worker:WorkerRecord;key:string}>("/api/v2/workers",identity.key,{name:"Original yard"});
 const mower=await app.request<{id:string}>("/api/v2/mowers",identity.key,{name:"Durable Clover",model:"faux/faux-1",workerId:enrolled.worker.id});
 const thread=await app.request<ThreadRecord>("/api/v2/threads",identity.key,{mowerId:mower.id,title:"Survives replacement"});
 let yard=new OutboundWorker({controllerUrl:app.url,workerKey:enrolled.key,dataDir:directory(),inferenceMode:"controller",runtime:createPiRuntime({trustedLocal:true})});cleanups.push(()=>yard.close());
 const first=await app.request<ControlRun>(`/api/v2/threads/${thread.id}/messages`,identity.key,{text:"History before the server was replaced",requestId:"before-disaster"});await yard.tick();await yard.whenIdle();expect((await app.request<{run:ControlRun}>(`/api/v2/runs/${first.id}`,identity.key)).run.status).toBe("done");
 await yard.close();await app.stop();
 await createControlBackup({dataDir:original,destination:backup,confirmOffline:true});const restored=await restoreControlBackup({backupDir:backup,targetDir:replacement,confirmOffline:true});expect(restored.principals.some(p=>p.principalId===principalId)).toBe(true);expect(restored.safety.revokedHumanKeys).toBe(1);expect(restored.safety.revokedWorkers).toBe(1);
 app=await gateway(replacement,serviceKey);
 expect((await fetch(`${app.url}/api/v2/state`,{headers:{authorization:`Bearer ${identity.key}`}})).status).toBe(401);
 const rotated=await app.request<{key:string}>("/keys",serviceKey,{label:"Recovered owner",principalId});
 const state=await app.request<ControlState>("/api/v2/state",rotated.key);expect(state.threads.some(t=>t.id===thread.id)).toBe(true);expect(state.runs.every(r=>!["queued","running","waiting_permission"].includes(r.status))).toBe(true);
 const next=await app.request<{worker:WorkerRecord;key:string}>("/api/v2/workers",rotated.key,{name:"Replacement yard"});
 yard=new OutboundWorker({controllerUrl:app.url,workerKey:next.key,dataDir:directory(),inferenceMode:"controller",runtime:createPiRuntime({trustedLocal:true})});const replacementYard=yard;cleanups.push(()=>replacementYard.close());await yard.tick();
 const reference=await app.request<CheckpointReference>(`/api/v2/threads/${thread.id}/checkpoint-reference`,rotated.key);
 await app.request(`/api/v2/threads/${thread.id}/move`,rotated.key,{workerId:next.worker.id,expectedWorkerId:enrolled.worker.id,checkpointSha256:reference.sha256,confirmedStopped:true,confirmedOmissions:true});
 const second=await app.request<ControlRun>(`/api/v2/threads/${thread.id}/messages`,rotated.key,{text:"Continue after replacement with previous history",requestId:"after-disaster"});await yard.tick();await yard.whenIdle();expect((await app.request<{run:ControlRun}>(`/api/v2/runs/${second.id}`,rotated.key)).run.status).toBe("done");
 const archive=await app.request<{files:Array<{content:string}>}>(`/api/v2/threads/${thread.id}/checkpoint`,rotated.key);const content=archive.files.map(f=>Buffer.from(f.content,"base64").toString("utf8")).join("\n");expect(content).toContain("History before the server was replaced");expect(content).toContain("Continue after replacement with previous history");
 for(const key of [serviceKey,identity.key,rotated.key,enrolled.key,next.key])expect(content.includes(key)).toBe(false);
},30_000);

test("SIGTERM fences a remote active lease and preserves later accepted input on actual gateway restart",async()=>{
 const data=directory(),serviceKey=randomUUID();let app=await gateway(data,serviceKey);
 const identity=await app.request<{key:string}>("/keys",serviceKey,{label:"Shutdown owner"}),yard=await app.request<{worker:WorkerRecord;key:string}>("/api/v2/workers",identity.key,{name:"Stopped yard"});
 const mower=await app.request<{id:string}>("/api/v2/mowers",identity.key,{name:"Persistent Fern",model:"faux/faux-1",workerId:yard.worker.id});const thread=await app.request<ThreadRecord>("/api/v2/threads",identity.key,{mowerId:mower.id});
 const first=await app.request<ControlRun>(`/api/v2/threads/${thread.id}/messages`,identity.key,{text:"in progress before shutdown",requestId:"shutdown-active"});const queued=await app.request<ControlRun>(`/api/v2/threads/${thread.id}/messages`,identity.key,{text:"durable later intent",requestId:"shutdown-queued"});
 const polled=await app.request<{job:{run:ControlRun}}>("/api/v2/worker/poll",yard.key,{capacity:1,activeRunIds:[],inferenceMode:"controller",checkpointVersion:"pi-durable@1.5.2",durabilityAdapter:{adapter:"pi-durable@1.5.2",version:1}});expect(polled.job.run.id).toBe(first.id);
 await app.stop();app=await gateway(data,serviceKey);
 const active=(await app.request<{run:ControlRun}>(`/api/v2/runs/${first.id}`,identity.key)).run;expect(active.status).toBe("interrupted");expect(active.cancelRequested).toBe(true);expect((await app.request<{run:ControlRun}>(`/api/v2/runs/${queued.id}`,identity.key)).run.status).toBe("queued");
 const stale=await fetch(`${app.url}/api/v2/worker/heartbeat`,{method:"POST",headers:{authorization:`Bearer ${yard.key}`,"content-type":"application/json"},body:JSON.stringify({runId:first.id,generation:polled.job.run.generation})});expect(stale.status).toBe(409);
 expect((await app.request<{job:unknown}>("/api/v2/worker/poll",yard.key,{capacity:1,activeRunIds:[],inferenceMode:"controller",durabilityAdapter:{adapter:"pi-durable@1.5.2",version:1}})).job).toBeNull();
},15_000);
