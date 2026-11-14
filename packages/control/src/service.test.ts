import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, ControlApproval, ControlPrincipal, WorkerRecord } from "@laun/protocol";
import { ControlService } from "./service.js";
import { ControlStore } from "./store.js";
import { handleControlRequest } from "./http.js";
const p:ControlPrincipal={id:"alice",admin:false};
const services:ControlService[]=[],dirs:string[]=[];
afterEach(async()=>{for(const s of services.splice(0)){await s.close();s.store.close();}for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(runtime?:AgentRuntime){const dir=mkdtempSync(join(tmpdir(),"laun-control-service-"));dirs.push(dir);const store=new ControlStore(join(dir,"control.sqlite"));
 const service=new ControlService({store,runtime,dataDir:dir,mode:runtime?"trusted-local":"unconfigured",approvalTimeoutMs:2000});services.push(service);
 const mower=store.createMower(p,{name:"Fern"});const thread=store.createThread(p,{mowerId:mower.id,title:"Work"});return {store,service,mower,thread};}
async function until(fn:()=>boolean){const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw new Error("condition timed out");await Bun.sleep(10);}}
function request(path:string,value:unknown){return new Request(`http://local/api/v2${path}`,{method:"POST",body:JSON.stringify(value),headers:{"content-type":"application/json"}});}

test("real scheduler waits for an exact action approval, consumes it, and drains FIFO",async()=>{
 let effects=0;const runtime:AgentRuntime={run:async(input,callbacks)=>{await callbacks.authorize({operation:"process.execute",resource:"workspace:own",arguments:{command:input.prompt}});effects++;await callbacks.emit({type:"text",sessionId:input.threadId,delta:`finished ${input.prompt}`});return {status:"done",summary:input.prompt};},cancel(){},close(){}};
 const {store,service,thread}=setup(runtime);const a=store.submit(p,thread.id,{text:"first",requestId:"1"});const b=store.submit(p,thread.id,{text:"second",requestId:"2"});await service.tick();
 await until(()=>store.approvals(p).length===1);expect(effects).toBe(0);expect(store.run(b.id).status).toBe("queued");
 const approval=store.approvals(p)[0]!;expect(()=>store.decide({id:"bob",admin:false},approval.id,"approve")).toThrow("not found");store.decide(p,approval.id,"approve");
 await until(()=>store.run(a.id).status==="done"&&store.approvals(p).length===2);expect(effects).toBe(1);expect(store.approval(approval.id).status).toBe("consumed");
 store.decide(p,store.approvals(p).find(v=>v.status==="pending")!.id,"deny");await until(()=>store.run(b.id).status==="error");expect(effects).toBe(1);
});

test("profile revocation during permission wait wins over a recorded approve",async()=>{
 const {store,service,thread,mower}=setup();const worker:WorkerRecord={id:"local",ownerId:p.id,name:"test",capacity:1,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};
 store.put("worker",worker);const run=store.submit(p,thread.id,{text:"work",requestId:"1"});store.claim(worker);
 const waiting=service.authorize(service.context(store.run(run.id)),{operation:"process.execute",resource:"workspace:own",arguments:{command:"test"}});
 await until(()=>store.approvals(p).length>0);store.decide(p,store.approvals(p)[0]!.id,"approve");
 const response=await handleControlRequest(service,request(`/profiles/${mower.profileId}/revoke`,{version:1}),p);expect(response.status).toBe(200);
 await expect(waiting).rejects.toThrow("revoked");
});

test("old generation permission wait cannot authorize after reassignment",async()=>{
 const {store,service,thread}=setup();const worker:WorkerRecord={id:"local",ownerId:p.id,name:"test",capacity:1,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};store.put("worker",worker);
 const run=store.submit(p,thread.id,{text:"work",requestId:"1"});store.claim(worker);
 const waiting=service.authorize(service.context(store.run(run.id)),{operation:"process.execute",resource:"workspace:own",arguments:{command:"test"}});
 await until(()=>store.approvals(p).length>0);store.db.query("UPDATE runs SET generation=generation+1 WHERE id=?").run(run.id);
 await expect(waiting).rejects.toThrow("stale run generation");
});

test("API enforces owner boundaries and idempotent submissions",async()=>{
 const {service,store,thread}=setup();const bob={id:"bob",admin:false};
 expect((await handleControlRequest(service,new Request(`http://local/api/v2/threads/${thread.id}/events`),bob)).status).toBe(404);
 expect((await handleControlRequest(service,request(`/threads/${thread.id}/messages`,{text:"work",requestId:"key"}),p)).status).toBe(202);
 expect((await handleControlRequest(service,request(`/threads/${thread.id}/messages`,{text:"work",requestId:"key"}),p)).status).toBe(202);
 expect((await handleControlRequest(service,request(`/threads/${thread.id}/messages`,{text:"different",requestId:"key"}),p)).status).toBe(409);
 expect(store.runs(p)).toHaveLength(1);
 expect((await handleControlRequest(service,request("/connections",{name:"Leak",url:"https://example.com",secretRef:"MCP_GLOBAL_SECRET"}),p)).status).toBe(403);
});

test("handoff atomically withdraws old queued work and keeps one task owner",async()=>{
 const {service,store,thread,mower}=setup();
 const result=await handleControlRequest(service,request("/tasks",{parentThreadId:thread.id,mowerId:mower.id,goal:"handoff work",requestId:"task-1"}),p);
 expect(result.status).toBe(201);const created=await result.json() as any;
 const handed=service.handoff(p,created.task.id,{mowerId:mower.id,requestId:"handoff-1"});
 expect(store.run(created.run.id).status).toBe("cancelled");expect(store.run(handed.run.id).status).toBe("queued");
 expect(service.handoff(p,created.task.id,{mowerId:mower.id,requestId:"handoff-1"}).thread.id).toBe(handed.thread.id);
});

test("administrator delegation retains the parent owner's identities",async()=>{
 const {service,store,thread}=setup();
 const res=await handleControlRequest(service,request("/tasks",{parentThreadId:thread.id,name:"Child",goal:"work",requestId:"admin-task"}),{id:"service",admin:true});
 expect(res.status).toBe(201);const data=await res.json() as any;
 expect(data.task.ownerId).toBe(p.id);expect(data.thread.ownerId).toBe(p.id);expect(data.run.ownerId).toBe(p.id);
 expect(store.get("thread",data.thread.id,p)).toBeDefined();
});

test("chunked oversized requests are cancelled before unbounded decoding",async()=>{
 const {service}=setup();let cancelled=false;
 const req=new Request("http://local/api/v2/mowers",{method:"POST",body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("x".repeat(262145)));},cancel(){cancelled=true;}}),duplex:"half"} as RequestInit);
 const res=await handleControlRequest(service,req,p);expect(res.status).toBe(413);expect(cancelled).toBe(true);
});

test("worker sequences reject gaps and changed duplicates without losing event history",async()=>{
 const {service,store,thread,mower}=setup();const {worker,key}=store.registerWorker(p,{name:"Remote"});
 mower.workerId=worker.id;store.put("mower",mower);const run=store.submit(p,thread.id,{text:"work",requestId:"worker-events"});const job=store.claim(worker)!;
 const post=async(sequence:number,delta:string)=>{const req=request("/worker/events",{runId:run.id,generation:job.run.generation,sequence,event:{type:"text",sessionId:thread.id,delta}});req.headers.set("authorization",`Bearer ${key}`);return handleControlRequest(service,req,null);};
 expect((await post(1,"late")).status).toBe(409);expect((await post(0,"first")).status).toBe(200);expect((await post(0,"first")).status).toBe(200);
 expect((await post(0,"changed")).status).toBe(409);expect((await post(1,"second")).status).toBe(200);
 expect(store.events(p,thread.id).events.filter(e=>e.kind==="agent")).toHaveLength(2);
});

test("revocation blocks new admissions and queued dispatch before model cost",async()=>{
 const {service,store,thread,mower}=setup();const run=store.submit(p,thread.id,{text:"queued",requestId:"before"});
 const res=await handleControlRequest(service,request(`/profiles/${mower.profileId}/revoke`,{version:1}),p);expect(res.status).toBe(200);
 expect(()=>store.submit(p,thread.id,{text:"new",requestId:"after"})).toThrow("revoked");
 const worker:WorkerRecord={id:"local",ownerId:p.id,name:"test",capacity:1,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};
 expect(store.claim(worker)).toBeNull();expect(store.run(run.id).status).toBe("error");
});
