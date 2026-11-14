import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeDurabilityEnvelope, RuntimeDurabilityPage } from "@laun/protocol";
import { ControlService } from "./service.js";
import { ControlStore, canonical, hash } from "./store.js";
import { handleControlRequest } from "./http.js";

const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"laun-server-ledger-")),store=new ControlStore(join(dir,"control.sqlite")),service=new ControlService({store,dataDir:dir,mode:"unconfigured"});
 const owner={id:"owner",admin:false},{worker,key}=store.registerWorker(owner,{name:"Owner yard"});
 const mower=store.createMower(owner,{name:"Clover",workerId:worker.id}),thread=store.createThread(owner,{mowerId:mower.id}),run=store.submit(owner,thread.id,{text:"Durable work",requestId:"one"});store.claim(worker);
 cleanup.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const request=(method:string,body:unknown,auth=key)=>handleControlRequest(service,new Request(`http://controller/api/v2/worker/${method}`,{method:"POST",headers:{authorization:`Bearer ${auth}`,"content-type":"application/json"},body:JSON.stringify(body)}),null);
 const base=()=>({runId:run.id,generation:store.run(run.id).generation});
 const append=(expectedSequence:number,envelope:RuntimeDurabilityEnvelope,extra:Record<string,unknown>={})=>request("durable-append",{...base(),expectedSequence,envelope,requestId:hash(canonical({expectedSequence,envelope})),...extra});
 return {store,service,owner,worker,key,thread,run,request,append,base};
}
const snapshot:RuntimeDurabilityEnvelope={adapter:"fixture@1",version:1,payload:{kind:"snapshot",files:[]}};
const batch:RuntimeDurabilityEnvelope={adapter:"fixture@1",version:1,payload:{kind:"commits",batches:[{seq:1,writes:[]}]}};

test("server journals acknowledge one immutable prefix and deduplicate exact commit receipts",async()=>{
 const c=fixture();expect((await c.append(0,snapshot)).status).toBe(200);expect(await (await c.append(0,snapshot)).json()).toEqual({sequence:1});
 expect(await (await c.append(1,batch)).json()).toEqual({sequence:2});expect((await c.append(1,{...batch,payload:{kind:"commits",batches:[],different:true}})).status).toBe(409);
 const page=await (await c.request("durable-load",{...c.base(),afterSequence:0})).json() as RuntimeDurabilityPage;expect(page.headSequence).toBe(2);expect(page.nextSequence).toBe(2);expect(page.hasMore).toBe(false);expect(page.records.map(r=>r.envelope)).toEqual([snapshot,batch]);
 expect((await c.append(2,snapshot)).status).toBe(409);expect((await c.append(2,{...batch,adapter:"different@1"})).status).toBe(409);
});

test("older manual yard workers cannot dispatch without a durable journal capability",async()=>{
 const c=fixture();expect((await c.request("poll",{activeRunIds:[]})).status).toBe(409);
 expect((await c.request("poll",{activeRunIds:[],durabilityAdapter:{adapter:"fixture@1",version:1}})).status).toBe(200);
});

test("stale, revoked, cancelled and cross-owner writers cannot advance the durable prefix",async()=>{
 const c=fixture();await c.append(0,snapshot);const old=c.base();
 c.store.setRunStatus(c.run.id,"queued");c.store.claim(c.worker);expect(c.base().generation).toBe(old.generation+1);
 expect((await c.request("durable-load",{...old,afterSequence:0})).status).toBe(409);
 const stranger=c.store.registerWorker({id:"stranger",admin:false},{name:"Stranger yard"});expect((await c.request("durable-load",{...c.base(),afterSequence:0},stranger.key)).status).toBe(409);
 expect((await c.request("durable-load",{...c.base(),afterSequence:0},"human-key-is-not-a-yard-key")).status).toBe(401);
 c.store.cancel(c.owner,c.thread.id);expect((await c.append(1,batch)).status).toBe(409);expect((c.store.db.query("SELECT COUNT(*) n FROM durable_commits").get() as {n:number}).n).toBe(1);
 c.worker.status="revoked";c.store.put("worker",c.worker);expect((await c.request("durable-load",{...c.base(),afterSequence:0})).status).toBe(401);
});

test("invalid fingerprints, cursor gaps and oversized ordinary commits are rejected before persistence",async()=>{
 const c=fixture();expect((await c.append(0,batch)).status).toBe(409);expect((await c.append(0,snapshot,{requestId:"0".repeat(64)})).status).toBe(400);
 await c.append(0,snapshot);expect((await c.request("durable-load",{...c.base(),afterSequence:2})).status).toBe(409);expect((await c.request("durable-load",{...c.base(),afterSequence:-1})).status).toBe(400);
 expect((await c.append(1,{...batch,payload:{kind:"commits",batches:[],padding:"x".repeat(2*1024*1024)}})).status).toBe(413);expect((c.store.db.query("SELECT COUNT(*) n FROM durable_commits").get() as {n:number}).n).toBe(1);
});

test("server history survives controller reopen without making a model call or admitting another run",async()=>{
 const c=fixture();await c.append(0,snapshot);await c.append(1,batch);
 const path=(c.store.db.query("PRAGMA database_list").get() as {file:string}).file;
 const reader=new ControlStore(path);try{expect((reader.db.query("SELECT sequence FROM durable_commits ORDER BY sequence").all() as {sequence:number}[]).map(r=>r.sequence)).toEqual([1,2]);expect(reader.threadRuns(c.owner,c.thread.id)).toHaveLength(1);}finally{reader.close();}
});
