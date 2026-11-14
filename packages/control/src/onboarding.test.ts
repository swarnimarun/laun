import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntime, MowerRecord, StoredProfile, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { ControlStore } from "./store.js";
import { ControlService } from "./service.js";
import { configureOnboarding, onboardingStatus } from "./onboarding.js";
import { evaluatePermission } from "@laun/policy";

const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner={id:"owner",admin:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"laun-onboarding-")),store=new ControlStore(join(dir,"control.sqlite"));let calls=0;
 const runtime:AgentRuntime={durabilityAdapter:{adapter:"fixture@1",version:1},checkpointVersion:"fixture@1",async listModels(){return [{id:"configured/model",name:"Configured model",provider:"configured",configured:true}];},async run(){calls++;throw new Error("setup must not submit work");},cancel(){},close(){}};
 const service=new ControlService({store,runtime,dataDir:dir,mode:"trusted-local"});cleanup.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,service,calls:()=>calls};
}
const choices={requestId:"setup-one",name:"Groundskeeper",title:"The big picture",model:"configured/model",workerId:"local",mode:"auto",workspaceWrite:"ask",processExecute:"ask",delegation:"ask"};

test("reviewed starter choices create one primary director without a model call, task or automatic grant",async()=>{
 const c=fixture(),result=await configureOnboarding(c.service,owner,choices);expect(result.created).toBe(true);
 const mower=c.store.get<MowerRecord>("mower",result.setup.primaryMowerId,owner),thread=c.store.get<ThreadRecord>("thread",result.setup.primaryThreadId,owner),profile=c.store.profile(result.setup.profileId,result.setup.profileVersion,owner);
 expect(mower.role).toBe("director");expect(thread.parentThreadId).toBeUndefined();expect(profile.rules).toHaveLength(6);expect(profile.mode).toBe("auto");expect(c.store.runs(owner)).toHaveLength(0);expect(c.calls()).toBe(0);expect(c.store.approvals(owner)).toHaveLength(0);
 const verdict=evaluatePermission(profile,{id:"action",principalId:owner.id,mowerId:mower.id,threadId:thread.id,runId:"run",workspaceId:thread.workspaceId,operation:"network.connect",resource:"https://example.com",argumentsDigest:"a".repeat(64)},{nowMs:Date.now()});expect(verdict.effect).toBe("deny");
 expect((await onboardingStatus(c.service,owner)).setup).toEqual(result.setup);expect((await onboardingStatus(c.service,{id:"other",admin:false})).setup).toBeUndefined();
});

test("accepted setup retries survive an offline yard and changed payloads cannot create duplicate authority",async()=>{
 const c=fixture(),result=await configureOnboarding(c.service,owner,choices),worker=c.store.get<WorkerRecord>("worker","local");worker.status="offline";c.store.put("worker",worker);
 expect(await configureOnboarding(c.service,owner,choices)).toEqual(result);await expect(configureOnboarding(c.service,owner,{...choices,name:"Changed"})).rejects.toThrow("idempotency");
 worker.status="online";c.store.put("worker",worker);await expect(configureOnboarding(c.service,owner,{...choices,requestId:"different"})).rejects.toThrow("already exists");expect(c.store.list<MowerRecord>("mower",owner)).toHaveLength(1);expect(c.store.list<StoredProfile>("profile",owner)).toHaveLength(1);
});

test("explicit primary selection checks the reviewed revision and never rewrites existing thread permissions",async()=>{
 const c=fixture(),first=await configureOnboarding(c.service,owner,choices),mower=c.store.createMower(owner,{name:"Second director",role:"director",model:"configured/model",workerId:"local"}),thread=c.store.createThread(owner,{mowerId:mower.id});
 const selected=await configureOnboarding(c.service,owner,{requestId:"select",mowerId:mower.id,threadId:thread.id,expectedRevision:first.setup.revision});expect(selected.created).toBe(false);expect(selected.setup.revision).toBe(2);expect(c.store.get<ThreadRecord>("thread",thread.id).profileVersion).toBe(thread.profileVersion);
 await expect(configureOnboarding(c.service,owner,{requestId:"stale",mowerId:mower.id,threadId:thread.id,expectedRevision:1})).rejects.toThrow("changed");expect(c.store.runs(owner)).toHaveLength(0);
});

test("unconfigured models and unqualified or foreign yards fail before creating records",async()=>{
 const c=fixture();await expect(configureOnboarding(c.service,owner,{...choices,model:"unconfigured/model"})).rejects.toThrow("configured on this controller");
 const foreign=c.store.registerWorker({id:"other",admin:false},{name:"Foreign"});await expect(configureOnboarding(c.service,owner,{...choices,workerId:foreign.worker.id})).rejects.toThrow("not found");
 const remote=c.store.registerWorker(owner,{name:"Own remote"});c.store.heartbeat(remote.worker.id);await expect(configureOnboarding(c.service,owner,{...choices,workerId:remote.worker.id})).rejects.toThrow("controller inference");
 expect(c.store.list<MowerRecord>("mower",owner)).toHaveLength(0);expect(c.store.list<StoredProfile>("profile",owner)).toHaveLength(0);expect(c.calls()).toBe(0);
});
