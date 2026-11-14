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

test("denial feedback reaches replanning without granting authority, and stop withdraws queued intent",async()=>{
 let feedback="",effects=0;
 const runtime:AgentRuntime={async run(input,callbacks){try{await callbacks.authorize({operation:"process.execute",resource:"workspace:own",arguments:{command:"unwanted operation"}});effects++;}catch(error){feedback=(error as Error).message;}return {status:"done",summary:"Used an allowed alternative"};},cancel(){},close(){}};
 const {store,service,thread,mower}=setup(runtime),profile=store.profile(mower.profileId,mower.profileVersion);
 const first=store.submit(p,thread.id,{text:"work",requestId:"feedback-one"});await service.tick();await until(()=>store.approvals(p).some(a=>a.status==="pending"));
 let a=store.approvals(p).find(a=>a.status==="pending")!;
 const response=await handleControlRequest(service,request(`/approvals/${a.id}`,{decision:"deny",continuation:"replan",feedback:"Use the existing local files instead."}),p);expect(response.status).toBe(200);
 await until(()=>store.run(first.id).status==="done");expect(effects).toBe(0);expect(feedback).toContain("Use the existing local files instead.");expect(feedback).toContain("permissions remain unchanged");expect(store.profile(profile.id,profile.version)).toEqual(profile);
 const second=store.submit(p,thread.id,{text:"another",requestId:"feedback-two"});const queued=store.submit(p,thread.id,{text:"later",requestId:"feedback-three"});await service.tick();await until(()=>store.approvals(p).some(a=>a.status==="pending"));a=store.approvals(p).find(a=>a.status==="pending")!;
 expect((await handleControlRequest(service,request(`/approvals/${a.id}`,{decision:"deny",continuation:"stop",feedback:"Stop this task."}),p)).status).toBe(200);
 await until(()=>store.run(second.id).status==="cancelled");expect(store.run(queued.id).status).toBe("cancelled");expect(store.get<any>("thread",thread.id).stoppedAt).toBeDefined();expect(effects).toBe(0);
});

test("real scheduler waits for an exact action approval, consumes it, and drains FIFO",async()=>{
 let effects=0;const runtime:AgentRuntime={run:async(input,callbacks)=>{try{await callbacks.authorize({operation:"process.execute",resource:"workspace:own",arguments:{command:input.prompt}});}catch{return {status:"error",summary:"Known permission denial; no command started"};}effects++;await callbacks.emit({type:"text",sessionId:input.threadId,delta:`finished ${input.prompt}`});return {status:"done",summary:input.prompt};},cancel(){},close(){}};
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
 expect((await handleControlRequest(service,request("/mowers",{name:"Fake capacity exemption",role:"adviser"}),p)).status).toBe(403);
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
 expect(store.claim(worker)).toBeNull();expect(store.run(run.id).status).toBe("cancelled");expect(store.run(run.id).cancelRequested).toBe(true);
});

test("child results are delivered once to a director queue and never revive a stopped thread",async()=>{
 const {service,store,thread,mower}=setup();const worker:WorkerRecord={id:"local",ownerId:p.id,name:"test",capacity:2,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};store.put("worker",worker);
 const response=await handleControlRequest(service,request("/tasks",{parentThreadId:thread.id,mowerId:mower.id,goal:"child work",requestId:"child-result"}),p);const created=await response.json() as any;
 const job=store.claim(worker)!;store.finish(job.run.id,worker.id,job.run.generation,"done","Child produced a result");
 await service.tick();await service.tick();
 expect(store.runs(p).filter(r=>r.requestId===`task-result:${created.task.id}`)).toHaveLength(1);
 const other=store.createThread(p,{mowerId:mower.id,title:"Stopped director"});
 const taskResponse=await handleControlRequest(service,request("/tasks",{parentThreadId:other.id,mowerId:mower.id,goal:"stop child",requestId:"stopped-child"}),p);const otherTask=await taskResponse.json() as any;
 service.cancelTree(p,other.id);await service.tick();
 expect(store.runs(p).filter(r=>r.requestId===`task-result:${otherTask.task.id}`)).toHaveLength(0);
});

test("reconciled interrupted work can be abandoned without replay",async()=>{
 const {service,store,thread}=setup();const run=store.submit(p,thread.id,{text:"unknown effect",requestId:"abandon-original"});store.setRunStatus(run.id,"interrupted");
 const rejected=await handleControlRequest(service,request(`/runs/${run.id}/abandon`,{}),p);expect(rejected.status).toBe(409);
 const abandoned=await handleControlRequest(service,request(`/runs/${run.id}/abandon`,{confirmedStopped:true}),p);expect(abandoned.status).toBe(200);expect(store.run(run.id).status).toBe("cancelled");
 const next=store.submit(p,thread.id,{text:"new independent work",requestId:"after-abandon"});expect(next.status).toBe("queued");
});

test("allowing general commands cannot bypass a workspace write denial",async()=>{
 const {service,store,thread,mower}=setup();const profile=store.profile(mower.profileId,1,p);profile.rules=[{operation:"process.execute",resource:"workspace:own",effect:"allow"},{operation:"workspace.read",resource:"workspace:own",effect:"allow"},{operation:"workspace.write",resource:"workspace:own",effect:"deny"}];
 store.db.query("UPDATE objects SET body=? WHERE kind='profile' AND id=?").run(JSON.stringify(profile),`${profile.id}:1`);
 const worker:WorkerRecord={id:"local",ownerId:p.id,name:"test",capacity:1,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};
 const run=store.submit(p,thread.id,{text:"blocked shell write",requestId:"shell-bypass"});store.claim(worker);
 await expect(service.authorize(service.context(store.run(run.id)),{operation:"process.execute",resource:"workspace:own",arguments:{command:"echo bypass > file"}})).rejects.toThrow("explicit_deny");
 expect(store.approvals(p)).toHaveLength(0);
});

test("a non-admin cannot redirect an administrator-bound connector credential",async()=>{
 const {service,store}=setup();store.saveConnection({id:"bound",ownerId:p.id,workspaceId:"default",name:"Bound",transport:"http",url:"https://trusted.example/mcp",secretRef:"MCP_TEST_SECRET"});
 const req=new Request("http://local/api/v2/connections/bound",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({url:"https://other.example/mcp"})});
 const response=await handleControlRequest(service,req,p);expect(response.status).toBe(403);
 expect(store.get<any>("connection","bound",p).url).toBe("https://trusted.example/mcp");
});

test("uncertain sandbox shutdown blocks later work instead of becoming an ordinary error",async()=>{
 let calls=0;const runtime:AgentRuntime={run:async()=>{calls++;return {status:"interrupted",summary:"Sandbox stop was not verified"};},cancel(){},close(){}};
 const {store,service,thread}=setup(runtime);const a=store.submit(p,thread.id,{text:"uncertain",requestId:"unknown"});const b=store.submit(p,thread.id,{text:"later",requestId:"later"});
 await service.tick();await until(()=>store.run(a.id).status==="interrupted");await service.tick();expect(calls).toBe(1);expect(store.run(b.id).status).toBe("queued");
});
