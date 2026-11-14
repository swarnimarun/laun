import type { ControlPrincipal, MowerRecord, OnboardingResult, OnboardingStatus, OwnerOnboarding, ThreadRecord, WorkerRecord } from "@laun/protocol";
import type { ControlService } from "./service.js";
import { canonical, ControlError, hash, now, record, text } from "./store.js";
import { effectiveThreadWorkerId } from "./lifecycle.js";

function initialize(service:ControlService){service.store.db.exec("CREATE TABLE IF NOT EXISTS owner_onboarding(owner_id TEXT PRIMARY KEY,body TEXT NOT NULL)");}
export function ownerOnboarding(service:ControlService,principal:ControlPrincipal):OwnerOnboarding|undefined{
 initialize(service);const row=service.store.db.query("SELECT body FROM owner_onboarding WHERE owner_id=?").get(principal.id) as {body:string}|null;
 return row?JSON.parse(row.body) as OwnerOnboarding:undefined;
}
export async function onboardingStatus(service:ControlService,principal:ControlPrincipal):Promise<OnboardingStatus>{
 const p={id:principal.id,admin:false},workers=service.store.list<WorkerRecord>("worker",p);
 if(service.readiness().runtime&&!workers.some(w=>w.local))workers.push(service.store.get("worker","local"));
 return {setup:ownerOnboarding(service,p),models:await service.listModels(),workers};
}
function yard(service:ControlService,p:ControlPrincipal,workerId:string):WorkerRecord{
 const worker=service.store.get<WorkerRecord>("worker",workerId);
 if(!worker.local&&worker.ownerId!==p.id)throw new ControlError("worker not found",404);
 const age=worker.lastSeenAt?Date.now()-Date.parse(worker.lastSeenAt):Infinity;
 if(worker.status!=="online"||worker.drainingAt||age< -5000||age>60_000||!Number.isFinite(age))throw new ControlError("select an accepting yard with a recent authenticated heartbeat",409);
 if(worker.local){if(!service.readiness().runtime)throw new ControlError("local execution is not configured",409);}
 else if(!worker.durabilityAdapter||worker.inferenceMode!=="controller")throw new ControlError("select a yard with controller inference and acknowledged durable journals",409);
 return worker;
}
/** Explicit human choices create authority. Setup never calls a provider or submits work. */
export async function configureOnboarding(service:ControlService,principal:ControlPrincipal,input:unknown):Promise<OnboardingResult>{
 initialize(service);const b=record(input),p={id:principal.id,admin:false},requestId=text(b.requestId,"requestId",128),fingerprint=hash(canonical(b)),key=`onboarding:${requestId}`;
 const receipt=service.store.db.query("SELECT fingerprint,body FROM receipts WHERE owner_id=? AND key=?").get(p.id,key) as {fingerprint:string;body:string}|null;
 if(receipt){if(receipt.fingerprint!==fingerprint)throw new ControlError("idempotency key conflict",409);return JSON.parse(receipt.body);}
 service.store.admissionGuard?.();
 const select=b.mowerId!==undefined||b.threadId!==undefined;
 const allowed=select?["requestId","mowerId","threadId","expectedRevision"]:["requestId","name","title","model","workerId","mode","workspaceWrite","processExecute","delegation"];
 if(Object.keys(b).some(k=>!allowed.includes(k)))throw new ControlError("unknown onboarding fields");
 let model:string,workerId:string;
 if(select){const mower=service.store.get<MowerRecord>("mower",text(b.mowerId,"mowerId",100),p),thread=service.store.get<ThreadRecord>("thread",text(b.threadId,"threadId",100),p);
  if(mower.role!=="director"||mower.archivedAt||thread.archivedAt||thread.parentThreadId||thread.mowerId!==mower.id)throw new ControlError("choose an active director and one of its top-level threads",409);
  service.store.assertThreadAuthority(thread);model=mower.model;workerId=effectiveThreadWorkerId(service.store,thread)??"";
 }else{model=text(b.model,"model",256);workerId=text(b.workerId,"workerId",100);}
 yard(service,p,workerId);
 if(!(await service.listModels()).some(m=>m.id===model&&m.configured))throw new ControlError("choose a model configured on this controller; no model call was made",409);
 return service.store.receipt(p,key,fingerprint,()=>{
  const previous=ownerOnboarding(service,p);yard(service,p,workerId);
  if(previous&&(!select||b.expectedRevision!==previous.revision))throw new ControlError("primary director already exists or changed; review its current revision before selecting another",409);
  let mower:MowerRecord,thread:ThreadRecord;
  if(select){mower=service.store.get("mower",String(b.mowerId),p);thread=service.store.get("thread",String(b.threadId),p);if(mower.archivedAt||thread.archivedAt||thread.parentThreadId||thread.mowerId!==mower.id||mower.role!=="director"||mower.model!==model||effectiveThreadWorkerId(service.store,thread)!==workerId)throw new ControlError("primary director changed",409);service.store.assertThreadAuthority(thread);}
  else{
   const mode=b.mode??"manual",write=b.workspaceWrite??"ask",process=b.processExecute??"ask",delegation=b.delegation??"ask";
   if(!["manual","auto","isolated"].includes(String(mode))||!["ask","allow"].includes(String(write))||!["ask","deny"].includes(String(process))||!["ask","deny"].includes(String(delegation)))throw new ControlError("invalid starter guardrail choices");
   const name=text(b.name??"Groundskeeper","name",80);
   const profile=service.store.createProfile(p,{name:`${name} guardrails`,mode,rules:[
    {operation:"workspace.read",resource:"workspace:own",effect:"allow"},{operation:"workspace.write",resource:"workspace:own",effect:write},
    {operation:"process.execute",resource:"workspace:own",effect:process},{operation:"mower.spawn",resource:"mowers:own",effect:delegation},
    {operation:"task.handoff",resource:"tasks:own",effect:delegation},{operation:"connector.send",resource:"threads:own",effect:delegation},
   ]});
   mower=service.store.createMower(p,{name,role:"director",model,workerId,profileId:profile.id,profileVersion:profile.version,
    instructions:"Coordinate the user's work. Delegate bounded tasks when authorized, follow up on child results, and keep the user informed. Permission preferences never replace enforced profiles."});
   thread=service.store.createThread(p,{mowerId:mower.id,title:b.title??"The big picture"});
  }
  const at=now(),setup:OwnerOnboarding={ownerId:p.id,primaryMowerId:mower.id,primaryThreadId:thread.id,profileId:thread.profileId,profileVersion:thread.profileVersion,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??at,updatedAt:at};
  service.store.db.query("INSERT INTO owner_onboarding VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET body=excluded.body").run(p.id,JSON.stringify(setup));
  service.store.event(thread.id,"system",{text:"Selected as your primary director. No work has been submitted; reviewed guardrails apply when you send a goal.",setupRevision:setup.revision});
  return {setup,created:!select};
 });
}
