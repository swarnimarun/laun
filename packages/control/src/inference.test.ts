import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService } from "./service.js";
import { ControlStore } from "./store.js";
import { handleControlRequest } from "./http.js";
import type { RuntimeInferenceService } from "@laun/protocol";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner={id:"relay-owner",admin:false};
function setup(inference?:RuntimeInferenceService){
 const directory=mkdtempSync(join(tmpdir(),"laun-relay-")),store=new ControlStore(join(directory,"control.sqlite"));
 const service=new ControlService({store,inference,dataDir:directory,mode:"unconfigured"});
 const {worker,key}=store.registerWorker(owner,{name:"Remote"});
 const mower=store.createMower(owner,{name:"Clover",model:"server/model",workerId:worker.id});
 const thread=store.createThread(owner,{mowerId:mower.id});
 const submitted=store.submit(owner,thread.id,{text:"Do work",requestId:"one"});store.claim(worker);
 const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:r=>handleControlRequest(service,r,null)});
 cleanup.push(async()=>{server.stop(true);await service.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const request=(path:string,body:unknown,credential=key)=>fetch(`http://127.0.0.1:${server.port}/api/v2/worker/${path}`,{method:"POST",headers:{authorization:`Bearer ${credential}`,"content-type":"application/json"},body:JSON.stringify(body)});
 const run=store.run(submitted.id),base={runId:run.id,generation:run.generation};
 const call={...base,request:{requestId:"a".repeat(64),envelope:{adapter:"fixture",version:1,payload:{text:"context"}}}};
 return {store,service,worker,key,mower,thread,run,base,call,request};
}

test("relay uses the admitted server model, accounts usage centrally, and never recharges a duplicate",async()=>{
 let charges=0;const models:string[]=[];
 const c=setup({listModels:async()=>[],describe:async model=>{models.push(model);return {adapter:"fixture",version:1,payload:{id:model}};},async *stream(model,request,signal,onUsage){
  models.push(model);charges++;expect(request.requestId).toBe("a".repeat(64));expect(signal?.aborted).toBe(false);
  yield {adapter:"fixture",version:1,payload:{text:"first"}};
  await onUsage?.({inputTokens:7,outputTokens:3,totalTokens:10,costUsd:0.01});
  yield {adapter:"fixture",version:1,payload:{text:"last"}};
 }});
 c.mower.model="changed/later";c.store.put("mower",c.mower);
 const describe=await c.request("inference-describe",{...c.base,model:"attacker/model"});expect(describe.status).toBe(200);
 const response=await c.request("inference",{...c.call,model:"attacker/model",apiKey:"never-forward"});
 expect(response.status).toBe(200);const lines=(await response.text()).trim().split("\n").map(s=>JSON.parse(s));
 expect(lines.map(l=>l.type)).toEqual(["frame","frame","done"]);expect(models).toEqual(["server/model","server/model"]);expect(charges).toBe(1);
 const duplicate=await c.request("inference",c.call);expect(duplicate.status).toBe(409);expect(charges).toBe(1);
 const usage={type:"usage",sessionId:c.thread.id,totalTokens:999};
 expect((await c.request("events",{...c.base,sequence:0,event:usage})).status).toBe(200);
 const stored=c.store.events(owner,c.thread.id).events.filter(e=>e.payload.event?.type==="usage");expect(stored).toHaveLength(1);expect(stored[0]!.payload.event).toMatchObject({totalTokens:10});
 expect(c.service.readiness().inferenceRelay).toBe(true);
});

test("provider failure leaves an inert admission and blocks later queued work",async()=>{
 let calls=0;const c=setup({listModels:async()=>[],describe:async()=>({adapter:"fixture",version:1,payload:{}}),async *stream(){calls++;yield {adapter:"fixture",version:1,payload:{text:"partial"}};throw new Error("provider SECRET must not escape");}});
 const later=c.store.submit(owner,c.thread.id,{text:"Later",requestId:"two"});
 const response=await c.request("inference",c.call),body=await response.text();expect(body).toContain('"type":"error"');expect(body).not.toContain("SECRET");
 expect(c.store.run(c.run.id).status).toBe("interrupted");expect(c.store.run(later.id).status).toBe("queued");expect(c.store.claim(c.worker)).toBeNull();expect(calls).toBe(1);
 expect(c.store.db.query("SELECT status FROM inference_calls").get()).toEqual({status:"interrupted"});
});

test("revoked yards, stale generations and unconfigured inference fail before a charge",async()=>{
 let calls=0;const c=setup({listModels:async()=>[],describe:async()=>({adapter:"fixture",version:1,payload:{}}),async *stream(){calls++;yield {adapter:"fixture",version:1,payload:{}};}});
 expect((await c.request("inference",{...c.call,generation:c.run.generation+1})).status).toBe(409);
 expect((await c.request("inference",c.call,"wrong" )).status).toBe(401);
 c.worker.status="revoked";c.store.put("worker",c.worker);expect((await c.request("inference",c.call)).status).toBe(401);expect(calls).toBe(0);
 const off=setup();expect((await off.request("inference",off.call)).status).toBe(503);expect(off.service.readiness().inferenceRelay).toBe(false);
});

test("disconnect aborts the provider and records interrupted rather than replayable work",async()=>{
 let aborted=false;const c=setup({listModels:async()=>[],describe:async()=>({adapter:"fixture",version:1,payload:{}}),async *stream(_m,_r,signal){
  try{yield {adapter:"fixture",version:1,payload:{text:"first"}};await new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new Error("aborted"));return;}signal?.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));},{once:true});});}finally{aborted=true;}
 }});
 const response=await c.request("inference",c.call);const reader=response.body!.getReader();await reader.read();await reader.cancel();
 for(let i=0;i<200&&c.store.run(c.run.id).status!=="interrupted";i++)await Bun.sleep(5);
 expect(c.store.run(c.run.id).status).toBe("interrupted");expect(aborted).toBe(true);
});
