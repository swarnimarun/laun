import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, RuntimeResult } from "@laun/protocol";
import { ControlStore } from "./store.js";
import { ControlService } from "./service.js";
import { handleControlRequest } from "./http.js";

const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner={id:"owner",admin:false};
function fixture(runtime?:AgentRuntime){const dir=mkdtempSync(join(tmpdir(),"laun-storage-reserve-")),store=new ControlStore(join(dir,"control.sqlite")),service=new ControlService({store,runtime,dataDir:join(dir,"threads"),mode:runtime?"trusted-local":"unconfigured",minFreeDiskBytes:0});
 const mower=store.createMower(owner,{name:"Clover"}),thread=store.createThread(owner,{mowerId:mower.id});cleanup.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,service,mower,thread};}

test("storage reserve blocks new work but accepted receipts and cancellation remain available",async()=>{
 const c=fixture(),input={text:"Accepted before reserve",requestId:"original"},first=c.store.submit(owner,c.thread.id,input);c.service.options.minFreeDiskBytes=Number.MAX_SAFE_INTEGER;
 expect(c.service.readiness().storage?.acceptingWork).toBe(false);expect(c.store.submit(owner,c.thread.id,input).id).toBe(first.id);expect(()=>c.store.submit(owner,c.thread.id,{text:"New",requestId:"new"})).toThrow("Storage reserve reached");
 const response=await handleControlRequest(c.service,new Request(`http://controller/api/v2/threads/${c.thread.id}/messages`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"New",requestId:"new-http"})}),owner);expect(response.status).toBe(507);
 c.store.cancel(owner,c.thread.id);expect(c.store.run(first.id).status).toBe("cancelled");expect(c.store.runs(owner)).toHaveLength(1);
});

test("crossing the reserve interrupts active local work and keeps later accepted input queued",async()=>{
 let finish:((value:RuntimeResult)=>void)|undefined,started=0,cancelled=0;
 const runtime:AgentRuntime={run:async()=>{started++;return await new Promise<RuntimeResult>(resolve=>{finish=resolve;});},cancel(){cancelled++;finish?.({status:"cancelled"});},close(){finish?.({status:"cancelled"});}};
 const c=fixture(runtime),first=c.store.submit(owner,c.thread.id,{text:"Active",requestId:"active"}),later=c.store.submit(owner,c.thread.id,{text:"Later",requestId:"later"});await c.service.tick();
 for(let i=0;i<100&&!started;i++)await Bun.sleep(5);expect(started).toBe(1);c.service.options.minFreeDiskBytes=Number.MAX_SAFE_INTEGER;await c.service.tick();
 for(let i=0;i<100&&!cancelled;i++)await Bun.sleep(5);expect(cancelled).toBeGreaterThan(0);expect(c.store.run(first.id).status).toBe("interrupted");expect(c.store.run(later.id).status).toBe("queued");expect(started).toBe(1);
});

test("a remote-only controller also interrupts active yard leases when its storage reserve is crossed",async()=>{
 const c=fixture(),{worker}=c.store.registerWorker(owner,{name:"Remote yard"});const first=c.store.submit(owner,c.thread.id,{text:"Remote active",requestId:"active"});c.store.claim(worker);c.service.options.minFreeDiskBytes=Number.MAX_SAFE_INTEGER;await c.service.tick();
 expect(c.store.run(first.id).status).toBe("interrupted");expect(c.store.run(first.id).cancelRequested).toBe(true);expect(()=>c.store.fence(first.id,worker.id,1)).toThrow("stale");
});
