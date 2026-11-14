import {afterEach,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {AgentRuntime,ThreadRecord} from "@laun/protocol";
import {createPiRuntime} from "@laun/runtime";
import {ControlStore,now} from "./store.js";
import {ControlService} from "./service.js";
import {beginThreadPurge,continueThreadPurge,listHostCleanupPlans,previewThreadPurge} from "./retention.js";
import {approveHostCleanupPlan,previewHostCleanupPlan,revokeHostCleanupPlan} from "./cleanup.js";

const owner={id:`user_${"c".repeat(32)}`,admin:false};
const resources:Array<{service:ControlService;store:ControlStore;dir:string}>=[];
afterEach(async()=>{for(const f of resources.splice(0).reverse()){await f.service.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}});
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error("maintenance condition timed out");await Bun.sleep(10);}}
function fixture(runtimeFactory:(dir:string)=>AgentRuntime){
 const dir=mkdtempSync(join(tmpdir(),"laun-maintenance-")),store=new ControlStore(join(dir,"control.sqlite"));
 const runtime=runtimeFactory(dir),service=new ControlService({store,runtime,dataDir:dir,mode:"trusted-local",minFreeDiskBytes:0});
 const mower=store.createMower(owner,{name:"Clover"}),thread=store.createThread(owner,{mowerId:mower.id});
 const f={dir,store,service,runtime,mower,thread};resources.push(f);return f;
}
function removeController(f:ReturnType<typeof fixture>){
 const thread=f.store.get<ThreadRecord>("thread",f.thread.id);thread.workerId="local";thread.archivedAt=thread.stoppedAt=now();f.store.put("thread",thread);
 let purge=beginThreadPurge(f.store,owner,thread.id,{requestId:"controller-only",expectedDigest:previewThreadPurge(f.store,owner,thread.id).digest,confirmedStopped:true,confirmedControllerCopyOnly:true});
 while(purge.status!=="done")purge=continueThreadPurge(f.store,owner,purge.id);
 return listHostCleanupPlans(f.store,owner,purge.id)[0]!;
}
function approve(f:ReturnType<typeof fixture>,planId:string){return approveHostCleanupPlan(f.store,owner,planId,{expectedDigest:previewHostCleanupPlan(f.store,owner,planId).digest,confirmedStopped:true,confirmedDeleteHostCopies:true});}

test("local controller deletion needs its separate host approval and removes only its managed thread",async()=>{
 const f=fixture(dir=>createPiRuntime({trustedLocal:true,cleanupRoot:dir}));
 const target=join(f.dir,"threads",f.thread.id),other=join(f.dir,"threads","another-thread");
 for(const root of[target,other]){mkdirSync(join(root,"work"),{recursive:true,mode:0o700});mkdirSync(join(root,"session"),{mode:0o700});writeFileSync(join(root,"work","kept.txt"),"fixture",{mode:0o600});}
 const plan=removeController(f);await f.service.tick();await Bun.sleep(30);expect(existsSync(target)).toBe(true);expect(previewHostCleanupPlan(f.store,owner,plan.id).plan.status).toBe("pending");
 approve(f,plan.id);await f.service.tick();await until(()=>["done","blocked"].includes(previewHostCleanupPlan(f.store,owner,plan.id).plan.status));
 expect(previewHostCleanupPlan(f.store,owner,plan.id).plan).toMatchObject({status:"done",outstanding:[]});
 expect(existsSync(target)).toBe(false);expect(existsSync(join(other,"work","kept.txt"))).toBe(true);expect(previewHostCleanupPlan(f.store,owner,plan.id).plan.verified).toBe(true);
});

test("withdrawal cancels local deletion without accepting a late verified result",async()=>{
 let started=false,aborted=false;
 const f=fixture(()=>({async run(){return{status:"done"};},cancel(){},close(){},async cleanupThread(input){started=true;await new Promise<void>(resolve=>{input.signal!.addEventListener("abort",()=>{aborted=true;resolve();},{once:true});});return{verified:true,removedPaths:1,removedSandboxes:0,outstanding:[]};}}));
 const plan=removeController(f);approve(f,plan.id);await f.service.tick();await until(()=>started);
 revokeHostCleanupPlan(f.store,owner,plan.id,{expectedDigest:previewHostCleanupPlan(f.store,owner,plan.id).digest});
 await until(()=>aborted);expect(previewHostCleanupPlan(f.store,owner,plan.id).plan.status).toBe("blocked");
 await f.service.tick();expect(previewHostCleanupPlan(f.store,owner,plan.id).plan.verified).not.toBe(true);
});

test("local host maintenance waits for idle execution and defers new model claims until finished",async()=>{
 let running=false,cleaning=false,releaseRun!:()=>void,releaseCleanup!:()=>void,calls=0;
 const f=fixture(()=>({async run(){calls++;running=true;if(calls===1)await new Promise<void>(resolve=>{releaseRun=resolve;});running=false;return{status:"done"};},cancel(){},close(){},async cleanupThread(){cleaning=true;await new Promise<void>(resolve=>{releaseCleanup=resolve;});return{verified:true,removedPaths:0,removedSandboxes:0,outstanding:[]};}}));
 const plan=removeController(f),other=f.store.createThread(owner,{mowerId:f.mower.id});
 const first=f.store.submit(owner,other.id,{requestId:"before-maintenance",text:"first"});await f.service.tick();await until(()=>running);approve(f,plan.id);await f.service.tick();expect(cleaning).toBe(false);
 releaseRun();await until(()=>f.store.run(first.id).status==="done");await f.service.tick();await until(()=>cleaning);
 const second=f.store.submit(owner,other.id,{requestId:"during-maintenance",text:"later"});await f.service.tick();expect(f.store.run(second.id).status).toBe("queued");expect(calls).toBe(1);
 releaseCleanup();await until(()=>previewHostCleanupPlan(f.store,owner,plan.id).plan.status==="done");await until(()=>f.store.run(second.id).status==="done");expect(calls).toBe(2);
});

test("graceful controller stop records uncertain active work and preserves queued intent across reopen",async()=>{
 let started=false;
 const f=fixture(()=>({async run(_input,callbacks){started=true;await callbacks.authorize({operation:"process.execute",resource:"workspace:own",arguments:{command:"fixture requires approval"}});return{status:"done"};},cancel(){},close(){}}));
 const active=f.store.submit(owner,f.thread.id,{requestId:"active",text:"active"}),queued=f.store.submit(owner,f.thread.id,{requestId:"queued",text:"queued"});
 await f.service.tick();await until(()=>started&&f.store.approvals(owner).some(a=>a.status==="pending"));await f.service.close();
 expect(f.store.run(active.id).status).toBe("interrupted");expect(f.store.run(active.id).cancelRequested).toBe(true);expect(f.store.run(queued.id).status).toBe("queued");expect(f.store.approvals(owner).every(a=>a.status!=="pending")).toBe(true);
 const reopened=new ControlStore(f.store.path);try{expect(reopened.run(active.id).status).toBe("interrupted");expect(reopened.run(queued.id).status).toBe("queued");}finally{reopened.close();}
});
