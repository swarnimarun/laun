import {afterEach,describe,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {HostCleanupPlan,RuntimeThreadCleanupResult,ThreadRecord,WorkerRecord} from "@laun/protocol";
import {ControlError,ControlStore,now} from "./store.js";
import {beginThreadPurge,continueThreadPurge,listHostCleanupPlans,previewThreadPurge} from "./retention.js";
import {approveHostCleanupPlan,claimHostCleanup,finishHostCleanup,heartbeatHostCleanup,previewHostCleanupPlan,revokeHostCleanupPlan,validateHostCleanupPlan,fenceWorkerCleanup} from "./cleanup.js";
import {createControlBackup,restoreControlBackup} from "./backup.js";

const owner={id:`user_${"a".repeat(32)}`,admin:false},other={id:`user_${"b".repeat(32)}`,admin:false},admin={id:"service",admin:true};
const disposals:Array<()=>void>=[];afterEach(()=>{for(const dispose of disposals.splice(0).reverse())dispose();});
const ok:RuntimeThreadCleanupResult={verified:true,removedPaths:2,removedSandboxes:1,outstanding:[]};
function status(fn:()=>unknown){try{fn();return 200;}catch(error){return(error as ControlError).status;}}
function fixture(local=false,complete=true){
  const dir=mkdtempSync(join(tmpdir(),"laun-host-cleanup-")),store=new ControlStore(join(dir,"control.sqlite"));disposals.push(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let worker:WorkerRecord;if(local){worker={id:"local",ownerId:"service",name:"Local yard",labels:["local"],capacity:1,status:"online",createdAt:now(),local:true};store.put("worker",worker);}else{worker=store.registerWorker(owner,{name:"Reviewed yard"}).worker;store.heartbeat(worker.id);worker=store.get<WorkerRecord>("worker",worker.id);}
  const mower=store.createMower(owner,{name:"Clover",workerId:worker.id}),thread=store.createThread(owner,{mowerId:mower.id});thread.archivedAt=thread.stoppedAt=now();store.put("thread",thread);
  let purge=beginThreadPurge(store,owner,thread.id,{requestId:"remove-controller",expectedDigest:previewThreadPurge(store,owner,thread.id).digest,confirmedStopped:true,confirmedControllerCopyOnly:true});
  if(complete)while(purge.status!=="done")purge=continueThreadPurge(store,owner,purge.id);
  const plan=listHostCleanupPlans(store,owner,purge.id)[0]!;
  const approve=()=>approveHostCleanupPlan(store,owner,plan.id,{expectedDigest:previewHostCleanupPlan(store,owner,plan.id).digest,confirmedStopped:true,confirmedDeleteHostCopies:true});
  const mutate=(fn:(plan:HostCleanupPlan)=>void)=>{const current=previewHostCleanupPlan(store,owner,plan.id).plan;fn(current);store.db.query("UPDATE host_cleanup_plans SET body=? WHERE id=?").run(JSON.stringify(current),plan.id);};
  return{dir,store,worker,mower,thread,purge,plan,approve,mutate};
}

describe("separate explicit host deletion approval",()=>{
  test("controller-only purge is never deletion authority; owner review binds the exact host plan",()=>{
    const f=fixture();expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();expect(previewHostCleanupPlan(f.store,owner,f.plan.id).warnings.join()).toContain("separate destructive approval");
    expect(status(()=>previewHostCleanupPlan(f.store,other,f.plan.id))).toBe(404);
    const review=previewHostCleanupPlan(f.store,owner,f.plan.id);
    expect(status(()=>approveHostCleanupPlan(f.store,admin,f.plan.id,{expectedDigest:review.digest,confirmedStopped:true,confirmedDeleteHostCopies:true}))).toBe(403);
    expect(status(()=>approveHostCleanupPlan(f.store,owner,f.plan.id,{expectedDigest:review.digest,confirmedStopped:true,confirmedDeleteHostCopies:false as true}))).toBe(400);
    f.mutate(plan=>{plan.outstanding=["changed host review"];});expect(()=>approveHostCleanupPlan(f.store,owner,f.plan.id,{expectedDigest:review.digest,confirmedStopped:true,confirmedDeleteHostCopies:true})).toThrow("preview changed");
    const approved=f.approve();expect(approved.approvedBy).toBe(owner.id);expect(approved.status).toBe("pending");expect(Date.parse(approved.approvalExpiresAt!)-Date.parse(approved.approvedAt!)).toBeLessThanOrEqual(600_001);
    const retry=approveHostCleanupPlan(f.store,owner,f.plan.id,{expectedDigest:approved.approvalDigest!,confirmedStopped:true,confirmedDeleteHostCopies:true});expect(retry.approvedAt).toBe(approved.approvedAt);
    const job=claimHostCleanup(f.store,f.worker.id)!;expect(job).toMatchObject({planId:f.plan.id,threadId:f.thread.id,placementIds:[]});expect(Object.keys(job).sort()).toEqual(["generation","leaseUntil","placementIds","planId","threadId"]);expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();
  });
  test("controller batches must finish and only the assigned currently registered worker may act",()=>{
    const f=fixture(false,false);expect(()=>f.approve()).toThrow("finish removal");let purge=f.purge;while(purge.status!=="done")purge=continueThreadPurge(f.store,owner,purge.id);f.approve();
    const stranger=f.store.registerWorker(other,{name:"Other yard"}).worker;f.store.heartbeat(stranger.id);expect(claimHostCleanup(f.store,stranger.id)).toBeNull();const job=claimHostCleanup(f.store,f.worker.id)!;
    expect(status(()=>heartbeatHostCleanup(f.store,stranger.id,job.planId,job.generation))).toBe(403);expect(status(()=>finishHostCleanup(f.store,stranger.id,job.planId,job.generation,ok))).toBe(403);
    const worker=f.store.get<WorkerRecord>("worker",f.worker.id);worker.status="revoked";f.store.put("worker",worker);expect(status(()=>heartbeatHostCleanup(f.store,worker.id,job.planId,job.generation))).toBe(403);expect(status(()=>finishHostCleanup(f.store,worker.id,job.planId,job.generation,ok))).toBe(403);
  });
  test("verified complete output is immutable and idempotent; ordinary or unknown failure stays blocked",()=>{
    const f=fixture();f.approve();const job=claimHostCleanup(f.store,f.worker.id)!,heartbeat=heartbeatHostCleanup(f.store,f.worker.id,job.planId,job.generation);expect(heartbeat.cancelRequested).toBe(false);
    for(const output of[{verified:false,removedPaths:0,removedSandboxes:0,outstanding:[]},{verified:true,removedPaths:1,removedSandboxes:0,outstanding:["unverified guest labels remain"]}]satisfies RuntimeThreadCleanupResult[]){
      const current=previewHostCleanupPlan(f.store,owner,f.plan.id).plan,currentJob=current.status==="running"?{generation:current.generation!}:claimHostCleanup(f.store,f.worker.id)!;
      const blocked=finishHostCleanup(f.store,f.worker.id,f.plan.id,currentJob.generation,output);expect(blocked.status).toBe("blocked");expect(blocked.approvedAt).toBeUndefined();expect(blocked.outstanding!.length).toBeGreaterThan(0);expect(finishHostCleanup(f.store,f.worker.id,f.plan.id,currentJob.generation,output)).toEqual(blocked);expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();f.approve();
    }
    const final=claimHostCleanup(f.store,f.worker.id)!,done=finishHostCleanup(f.store,f.worker.id,f.plan.id,final.generation,ok);expect(done.status).toBe("done");expect(done.verified).toBe(true);expect(done.leaseUntil).toBeUndefined();expect(done.approvedAt).toBeUndefined();expect(finishHostCleanup(f.store,f.worker.id,f.plan.id,final.generation,ok)).toEqual(done);expect(status(()=>finishHostCleanup(f.store,f.worker.id,f.plan.id,final.generation,{...ok,removedPaths:3}))).toBe(409);expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();
  });
  test("expired approval or lease never replays; each retry needs a fresh owner review",()=>{
    const f=fixture();f.approve();f.mutate(plan=>{plan.approvedAt=new Date(Date.now()-700_000).toISOString();plan.approvalExpiresAt=new Date(Date.now()-100_000).toISOString();});expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();let review=previewHostCleanupPlan(f.store,owner,f.plan.id);expect(review.plan.status).toBe("blocked");expect(review.plan.approvedAt).toBeUndefined();
    f.approve();const first=claimHostCleanup(f.store,f.worker.id)!;f.mutate(plan=>{plan.leaseUntil=new Date(Date.now()-1).toISOString();});expect(status(()=>heartbeatHostCleanup(f.store,f.worker.id,f.plan.id,first.generation))).toBe(409);review=previewHostCleanupPlan(f.store,owner,f.plan.id);expect(review.plan.status).toBe("blocked");expect(review.plan.outstanding!.join()).toContain("outcome may be unknown");expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();
    f.approve();const next=claimHostCleanup(f.store,f.worker.id)!;expect(next.generation).toBeGreaterThan(first.generation);expect(status(()=>finishHostCleanup(f.store,f.worker.id,f.plan.id,first.generation,ok))).toBe(409);expect(finishHostCleanup(f.store,f.worker.id,f.plan.id,next.generation,ok).status).toBe("done");
  });
  test("approval withdrawal fences a running deletion and requires new review",()=>{
    const f=fixture();f.approve();const job=claimHostCleanup(f.store,f.worker.id)!,review=previewHostCleanupPlan(f.store,owner,f.plan.id);const blocked=revokeHostCleanupPlan(f.store,owner,f.plan.id,{expectedDigest:review.digest});expect(blocked.status).toBe("blocked");expect(blocked.approvedAt).toBeUndefined();expect(status(()=>heartbeatHostCleanup(f.store,f.worker.id,f.plan.id,job.generation))).toBe(409);expect(status(()=>finishHostCleanup(f.store,f.worker.id,f.plan.id,job.generation,ok))).toBe(409);expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();
  });
  test("local controller cleanup follows the same explicit approval and lease path",()=>{
    const f=fixture(true);expect(claimHostCleanup(f.store,"local")).toBeNull();f.approve();const job=claimHostCleanup(f.store,"local")!;expect(job.threadId).toBe(f.thread.id);expect(heartbeatHostCleanup(f.store,"local",f.plan.id,job.generation).cancelRequested).toBe(false);expect(finishHostCleanup(f.store,"local",f.plan.id,job.generation,ok).status).toBe("done");
  });
  test("malformed results never complete a plan and no host paths can enter the command",()=>{
    const f=fixture();f.approve();const job=claimHostCleanup(f.store,f.worker.id)!;for(const output of[{...ok,verified:undefined},{...ok,removedPaths:-1},{...ok,outstanding:new Array(101).fill("unbounded")},{...ok,path:"/arbitrary"}])expect(status(()=>finishHostCleanup(f.store,f.worker.id,job.planId,job.generation,output as RuntimeThreadCleanupResult))).toBe(400);expect(previewHostCleanupPlan(f.store,owner,f.plan.id).plan.status).toBe("running");
    const forged={...f.plan,status:"done",verified:false,removedPaths:0,removedSandboxes:0,outstanding:[],resultDigest:"a".repeat(64),finishedGeneration:1};expect(()=>validateHostCleanupPlan(forged)).toThrow("lacks verification");
  });
  test("known credentials in diagnostic failures are redacted before persistence",()=>{
    const f=fixture(),previous=process.env.LAUN_CLEANUP_FIXTURE_SECRET,secret="private-cleanup-fixture-credential";process.env.LAUN_CLEANUP_FIXTURE_SECRET=secret;try{f.approve();const job=claimHostCleanup(f.store,f.worker.id)!;const blocked=finishHostCleanup(f.store,f.worker.id,job.planId,job.generation,{verified:false,removedPaths:0,removedSandboxes:0,outstanding:[`transport failed with ${secret}`]});expect(blocked.outstanding!.join()).toContain("[REDACTED]");expect(JSON.stringify(f.store.db.query("SELECT * FROM host_cleanup_plans").all())).not.toContain(secret);}finally{if(previous===undefined)delete process.env.LAUN_CLEANUP_FIXTURE_SECRET;else process.env.LAUN_CLEANUP_FIXTURE_SECRET=previous;}
  });
  test("redaction growth and repeated failures remain bounded readable blocked reports",()=>{
    const f=fixture(),previous=process.env.LAUN_CLEANUP_FIXTURE_SECRET;process.env.LAUN_CLEANUP_FIXTURE_SECRET="fixture8";try{f.approve();const job=claimHostCleanup(f.store,f.worker.id)!,blocked=finishHostCleanup(f.store,f.worker.id,job.planId,job.generation,{verified:false,removedPaths:0,removedSandboxes:0,outstanding:new Array(100).fill("fixture8".repeat(125))});expect(blocked.status).toBe("blocked");expect(blocked.outstanding!.every(message=>message.length<=1000)).toBe(true);expect(Buffer.byteLength(JSON.stringify(blocked.outstanding))).toBeLessThan(32768);expect(blocked.outstanding!.at(-1)).toContain("Additional diagnostics omitted");expect(previewHostCleanupPlan(f.store,owner,f.plan.id).plan.status).toBe("blocked");}finally{if(previous===undefined)delete process.env.LAUN_CLEANUP_FIXTURE_SECRET;else process.env.LAUN_CLEANUP_FIXTURE_SECRET=previous;}
  });
  test("worker trust changes atomically invalidate approval and lease while retaining diagnostics",()=>{
    const f=fixture();f.approve();const job=claimHostCleanup(f.store,f.worker.id)!;f.store.transaction(()=>{expect(fenceWorkerCleanup(f.store,f.worker.id,"Worker trust changed; review the host again.")).toBe(1);});const blocked=previewHostCleanupPlan(f.store,owner,f.plan.id).plan;expect(blocked.status).toBe("blocked");expect(blocked.approvedAt).toBeUndefined();expect(blocked.generation).toBeGreaterThan(job.generation);expect(status(()=>finishHostCleanup(f.store,f.worker.id,f.plan.id,job.generation,ok))).toBe(409);expect(claimHostCleanup(f.store,f.worker.id)).toBeNull();
    f.store.transaction(()=>fenceWorkerCleanup(f.store,f.worker.id,"Second trust change"));expect(previewHostCleanupPlan(f.store,owner,f.plan.id).plan.outstanding).toEqual(["Second trust change","Worker trust changed; review the host again."]);
    f.approve();const next=claimHostCleanup(f.store,f.worker.id)!;finishHostCleanup(f.store,f.worker.id,f.plan.id,next.generation,ok);expect(fenceWorkerCleanup(f.store,f.worker.id,"Later rotation")).toBe(0);
  });
  test("draining or an invalid, future or stale heartbeat blocks every new cleanup claim",()=>{
    const f=fixture();f.approve();const worker=f.store.get<WorkerRecord>("worker",f.worker.id);worker.drainingAt=now();f.store.put("worker",worker);expect(claimHostCleanup(f.store,worker.id)).toBeNull();delete worker.drainingAt;
    for(const lastSeenAt of[undefined,"invalid-date",new Date(Date.now()+60000).toISOString(),new Date(Date.now()-70000).toISOString()]){worker.lastSeenAt=lastSeenAt;f.store.put("worker",worker);expect(claimHostCleanup(f.store,worker.id)).toBeNull();}
    worker.lastSeenAt=now();f.store.put("worker",worker);const job=claimHostCleanup(f.store,worker.id)!;worker.drainingAt=now();f.store.put("worker",worker);expect(heartbeatHostCleanup(f.store,worker.id,job.planId,job.generation).cancelRequested).toBe(false);expect(finishHostCleanup(f.store,worker.id,job.planId,job.generation,ok).status).toBe("done");
  });
  test.each([false,true])("backup restore revokes approved%s host cleanup without replay",async running=>{
    const f=fixture();f.approve();if(running)claimHostCleanup(f.store,f.worker.id);const backup=join(f.dir,"backup"),target=join(f.dir,"restored");await createControlBackup({dataDir:f.dir,destination:backup,confirmOffline:true});await restoreControlBackup({backupDir:backup,targetDir:target,confirmOffline:true});
    const restored=new ControlStore(join(target,"control.sqlite"));try{const plan=previewHostCleanupPlan(restored,owner,f.plan.id).plan;expect(plan.status).toBe("blocked");for(const field of["approvedAt","approvedBy","approvalDigest","approvalExpiresAt","leaseUntil"]as const)expect(plan[field]).toBeUndefined();const worker=restored.get<WorkerRecord>("worker",f.worker.id);worker.status="online";worker.lastSeenAt=now();restored.put("worker",worker);expect(claimHostCleanup(restored,worker.id)).toBeNull();}finally{restored.close();}
  });
});
