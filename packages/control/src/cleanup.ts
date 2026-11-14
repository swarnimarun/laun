import type { ControlPrincipal, HostCleanupApproval, HostCleanupJob, HostCleanupPlan, HostCleanupReview, RuntimeThreadCleanupResult, WorkerRecord } from "@laun/protocol";
import { canonical, ControlError, ControlStore, hash, now, record, text } from "./store.js";
import { initializeRetention } from "./retention.js";
import { redactAdviceText } from "./adviser.js";

const APPROVAL_TTL = 10 * 60_000, DEFAULT_LEASE = 30_000;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const date = (value:unknown):value is string=>typeof value==="string"&&Number.isFinite(Date.parse(value));
function diagnostic(value:unknown,label:string):string{
  const clean=redactAdviceText(text(value,label,1000));if(clean.length<=1000)return clean;
  let kept="";for(const character of clean){if(kept.length+character.length>960)break;kept+=character;}return `${kept} [diagnostic shortened]`;
}
function save(store:ControlStore,plan:HostCleanupPlan):void{
  plan.updatedAt=now();store.db.query("UPDATE host_cleanup_plans SET body=? WHERE id=? AND owner_id=? AND worker_id=?").run(JSON.stringify(plan),plan.id,plan.ownerId,plan.workerId);
}
function clearApproval(plan:HostCleanupPlan):void{
  delete plan.approvedAt;delete plan.approvedBy;delete plan.approvalDigest;delete plan.approvalExpiresAt;delete plan.leaseUntil;
}
/** Shared by live operations and the offline archive validator. */
export function validateHostCleanupPlan(value:unknown):HostCleanupPlan{
  const b=record(value),allowed=new Set(["id","purgeId","ownerId","threadId","workerId","placementIds","unknownPlacements","status","createdAt","updatedAt","removedPaths","removedSandboxes","outstanding","verified","approvedAt","approvedBy","approvalDigest","approvalExpiresAt","generation","leaseUntil","finishedGeneration","resultDigest"]);
  if(Object.keys(b).some(key=>!allowed.has(key))||!uuid(b.id)||!uuid(b.purgeId)||!uuid(b.threadId)||typeof b.ownerId!=="string"||!b.ownerId||b.ownerId.length>128||typeof b.workerId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(b.workerId)||!Array.isArray(b.placementIds)||b.placementIds.length>100_000||b.placementIds.some(value=>!uuid(value))||new Set(b.placementIds).size!==b.placementIds.length||typeof b.unknownPlacements!=="boolean"||!["pending","running","done","blocked"].includes(String(b.status))||!date(b.createdAt)||!date(b.updatedAt))throw new ControlError("invalid stored host cleanup plan",409);
  for(const field of["removedPaths","removedSandboxes","generation","finishedGeneration"]as const)if(b[field]!==undefined&&(!Number.isSafeInteger(b[field])||Number(b[field])<0))throw new ControlError("invalid cleanup counters",409);
  if(b.outstanding!==undefined&&(!Array.isArray(b.outstanding)||b.outstanding.length>100||b.outstanding.some(value=>typeof value!=="string"||!value||value.length>1000||value.includes("\0"))))throw new ControlError("invalid cleanup outcome",409);
  if(b.verified!==undefined&&typeof b.verified!=="boolean")throw new ControlError("invalid cleanup verification",409);
  const approvalFields=[b.approvedAt,b.approvedBy,b.approvalDigest,b.approvalExpiresAt],hasApproval=approvalFields.some(value=>value!==undefined);
  if(hasApproval&&(!date(b.approvedAt)||typeof b.approvedBy!=="string"||b.approvedBy!==b.ownerId||typeof b.approvalDigest!=="string"||!/^[a-f0-9]{64}$/.test(b.approvalDigest)||!date(b.approvalExpiresAt)||Date.parse(b.approvalExpiresAt)<=Date.parse(b.approvedAt)||Date.parse(b.approvalExpiresAt)-Date.parse(b.approvedAt)>APPROVAL_TTL+1))throw new ControlError("invalid cleanup approval",409);
  if(b.leaseUntil!==undefined&&(!date(b.leaseUntil)||b.status!=="running"||!hasApproval||Date.parse(b.leaseUntil)>Date.parse(String(b.approvalExpiresAt))))throw new ControlError("invalid cleanup lease",409);
  if(b.status==="running"&&(!b.leaseUntil||!hasApproval||!Number.isSafeInteger(b.generation)||Number(b.generation)<1))throw new ControlError("cleanup has no active authority",409);
  if((b.status==="blocked"||b.status==="done")&&hasApproval)throw new ControlError("settled cleanup retains authorization",409);
  if(b.resultDigest!==undefined&&(typeof b.resultDigest!=="string"||!/^[a-f0-9]{64}$/.test(b.resultDigest)||!Number.isSafeInteger(b.finishedGeneration)))throw new ControlError("invalid cleanup receipt",409);
  if(b.status==="done"&&(b.verified!==true||!Array.isArray(b.outstanding)||b.outstanding.length||!Number.isSafeInteger(b.removedPaths)||!Number.isSafeInteger(b.removedSandboxes)||!b.resultDigest))throw new ControlError("cleanup completion lacks verification receipt",409);
  return b as unknown as HostCleanupPlan;
}
function load(store:ControlStore,planId:string,p?:ControlPrincipal):HostCleanupPlan{
  const row=store.db.query("SELECT * FROM host_cleanup_plans WHERE id=?").get(planId)as{owner_id:string;worker_id:string;thread_id:string;purge_id:string;body:string}|null;
  if(!row||p&&!p.admin&&row.owner_id!==p.id)throw new ControlError("host cleanup plan not found",404);
  const plan=validateHostCleanupPlan(JSON.parse(row.body));
  if(plan.ownerId!==row.owner_id||plan.workerId!==row.worker_id||plan.threadId!==row.thread_id||plan.purgeId!==row.purge_id)throw new ControlError("cleanup identity mismatch",409);return plan;
}
function completedPurge(store:ControlStore,plan:HostCleanupPlan):void{
  const row=store.db.query("SELECT owner_id,thread_id,body FROM thread_purges WHERE id=?").get(plan.purgeId)as{owner_id:string;thread_id:string;body:string}|null;
  const gone=store.db.query("SELECT owner_id,purge_id FROM purged_resources WHERE kind='thread' AND id=?").get(plan.threadId)as{owner_id:string;purge_id:string}|null;
  if(!row||row.owner_id!==plan.ownerId||row.thread_id!==plan.threadId||JSON.parse(row.body).job?.status!=="done"||gone?.owner_id!==plan.ownerId||gone.purge_id!==plan.purgeId||store.db.query("SELECT 1 FROM objects WHERE kind='thread' AND id=?").get(plan.threadId))throw new ControlError("finish removal of the controller copy before authorizing host cleanup",409);
}
function currentWorker(store:ControlStore,workerId:string,ownerId:string):WorkerRecord{
  const worker=store.get<WorkerRecord>("worker",workerId);
  if(worker.status==="revoked")throw new ControlError("cleanup worker revoked",403);
  if(worker.id!==workerId||(!worker.local&&worker.ownerId!==ownerId)||(worker.local&&worker.id!=="local"))throw new ControlError("cleanup worker outside owner scope",403);return worker;
}
function block(store:ControlStore,plan:HostCleanupPlan,message:string,preserve=false):void{
  plan.status="blocked";plan.outstanding=[...new Set([message,...(preserve?plan.outstanding??[]:[])])].slice(0,100);plan.generation=(plan.generation??0)+1;delete plan.resultDigest;delete plan.finishedGeneration;clearApproval(plan);save(store,plan);
}
/** Call inside credential-revocation/rotation transactions; it performs no host deletion. */
export function fenceWorkerCleanup(store:ControlStore,workerId:string,reason:string):number{
  initializeRetention(store);const message=diagnostic(reason,"cleanup trust-change reason");let changed=0;
  for(const row of store.db.query("SELECT id FROM host_cleanup_plans WHERE worker_id=? AND json_extract(body,'$.status')!='done' ORDER BY rowid").iterate(workerId)as Iterable<{id:string}>){const plan=load(store,row.id);block(store,plan,message,true);changed++;}return changed;
}
function expire(store:ControlStore,plan:HostCleanupPlan):boolean{
  if(plan.status!=="pending"&&plan.status!=="running")return false;
  if(plan.approvalExpiresAt&&Date.parse(plan.approvalExpiresAt)<=Date.now()){block(store,plan,"Host cleanup approval expired; review and approve this host again.");return true;}
  if(plan.status==="running"&&(!plan.leaseUntil||Date.parse(plan.leaseUntil)<=Date.now())){block(store,plan,"Host cleanup lease expired; prior deletion outcome may be unknown. Verify the host, then approve a fresh attempt.");return true;}
  return false;
}
export function previewHostCleanupPlan(store:ControlStore,p:ControlPrincipal,planId:string):HostCleanupReview{
  initializeRetention(store);return store.transaction(()=>{
    const plan=load(store,planId,p);expire(store,plan);
    return {plan,digest:hash(canonical(plan)),warnings:["Host cleanup is a separate destructive approval. Pending plans do not authorize deletion.","Confirm this yard is stopped and is the intended current host with its configured managed data root. Only verified Laun-owned paths and sandboxes may be removed; copied credentials, unknown hosts, exports and backups can retain other copies.",...(plan.unknownPlacements?["Older placement epochs were not fully recorded. The runtime must enumerate and verify every managed sandbox for this thread; unverified leftovers remain outstanding."]:[])]};
  });
}
export function approveHostCleanupPlan(store:ControlStore,p:ControlPrincipal,planId:string,input:HostCleanupApproval):HostCleanupPlan{
  initializeRetention(store);const b=record(input);
  if(Object.keys(b).some(key=>!["expectedDigest","confirmedStopped","confirmedDeleteHostCopies"].includes(key))||b.confirmedStopped!==true||b.confirmedDeleteHostCopies!==true||typeof b.expectedDigest!=="string"||!/^[a-f0-9]{64}$/.test(b.expectedDigest))throw new ControlError("review the exact host cleanup plan and explicitly confirm stopped execution and deletion of host copies");
  return store.transaction(()=>{
    const plan=load(store,planId,p);if(plan.ownerId!==p.id)throw new ControlError("an owner credential must approve host deletion",403);
    expire(store,plan);completedPurge(store,plan);currentWorker(store,plan.workerId,plan.ownerId);
    if(plan.status==="done"||plan.status==="running")throw new ControlError("host cleanup is already complete or leased",409);
    if(plan.approvalDigest===b.expectedDigest&&plan.approvedAt)return plan;
    if(hash(canonical(plan))!==b.expectedDigest)throw new ControlError("host cleanup preview changed; review it again",409);
    const approvedAt=Date.now(),at=new Date(approvedAt).toISOString();plan.status="pending";plan.approvedAt=at;plan.approvedBy=p.id;plan.approvalDigest=b.expectedDigest;plan.approvalExpiresAt=new Date(approvedAt+APPROVAL_TTL).toISOString();delete plan.leaseUntil;delete plan.outstanding;save(store,plan);return plan;
  });
}
export function revokeHostCleanupPlan(store:ControlStore,p:ControlPrincipal,planId:string,input:{expectedDigest:string}):HostCleanupPlan{
  initializeRetention(store);const b=record(input);if(Object.keys(b).some(key=>key!=="expectedDigest")||typeof b.expectedDigest!=="string"||!/^[a-f0-9]{64}$/.test(b.expectedDigest))throw new ControlError("review the exact cleanup plan before withdrawing approval");
  return store.transaction(()=>{const plan=load(store,planId,p);if(plan.ownerId!==p.id)throw new ControlError("an owner credential must withdraw host deletion approval",403);if(plan.status==="done")throw new ControlError("host cleanup already finished",409);if(hash(canonical(plan))!==b.expectedDigest)throw new ControlError("host cleanup preview changed; review it again",409);block(store,plan,"Host cleanup approval was withdrawn. An already started deletion may have completed; inspect the host before approving again.");return plan;});
}
export function claimHostCleanup(store:ControlStore,workerId:string,options:{leaseMs?:number}={}):HostCleanupJob|null{
  initializeRetention(store);const leaseMs=options.leaseMs??DEFAULT_LEASE;if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>120_000)throw new ControlError("invalid host cleanup lease");
  return store.transaction(()=>{
    for(const row of store.db.query("SELECT id FROM host_cleanup_plans WHERE worker_id=? AND json_extract(body,'$.status')='running' ORDER BY rowid LIMIT 2").iterate(workerId)as Iterable<{id:string}>){const plan=load(store,row.id);expire(store,plan);if(plan.status==="running")return null;}
    const rows=store.db.query("SELECT id FROM host_cleanup_plans WHERE worker_id=? AND json_extract(body,'$.status')='pending' AND json_extract(body,'$.approvedAt') IS NOT NULL ORDER BY rowid LIMIT 64").all(workerId)as Array<{id:string}>;
    for(const row of rows){const plan=load(store,row.id);expire(store,plan);if(plan.status!=="pending"||!plan.approvedAt)continue;
      completedPurge(store,plan);const worker=currentWorker(store,workerId,plan.ownerId);
      const heartbeatAge=worker.lastSeenAt?Date.now()-Date.parse(worker.lastSeenAt):NaN;
      if(worker.status!=="online"||worker.drainingAt||!worker.local&&(!Number.isFinite(heartbeatAge)||heartbeatAge< -5000||heartbeatAge>60_000))return null;
      plan.status="running";plan.generation=(plan.generation??0)+1;plan.leaseUntil=new Date(Math.min(Date.now()+leaseMs,Date.parse(plan.approvalExpiresAt!))).toISOString();delete plan.resultDigest;delete plan.finishedGeneration;save(store,plan);
      return {planId:plan.id,threadId:plan.threadId,placementIds:[...plan.placementIds],generation:plan.generation,leaseUntil:plan.leaseUntil};
    }return null;
  });
}
function fence(store:ControlStore,workerId:string,planId:string,generation:number):HostCleanupPlan{
  const plan=load(store,planId);if(plan.workerId!==workerId)throw new ControlError("host cleanup worker mismatch",403);currentWorker(store,workerId,plan.ownerId);
  if(!Number.isSafeInteger(generation)||generation<1||plan.generation!==generation||plan.status!=="running"||!plan.approvedAt||!plan.leaseUntil||Date.parse(plan.leaseUntil)<=Date.now()||Date.parse(plan.approvalExpiresAt!)<=Date.now())throw new ControlError("stale host cleanup lease; stop further deletion and request review",409);
  completedPurge(store,plan);return plan;
}
export function heartbeatHostCleanup(store:ControlStore,workerId:string,planId:string,generation:number):{cancelRequested:false;leaseUntil:string}{
  initializeRetention(store);return store.transaction(()=>{const plan=fence(store,workerId,planId,generation);store.heartbeat(workerId);plan.leaseUntil=new Date(Math.min(Date.now()+DEFAULT_LEASE,Date.parse(plan.approvalExpiresAt!))).toISOString();save(store,plan);return {cancelRequested:false,leaseUntil:plan.leaseUntil};});
}
function result(input:unknown):RuntimeThreadCleanupResult{
  const b=record(input);if(Object.keys(b).some(key=>!["verified","removedPaths","removedSandboxes","outstanding"].includes(key))||typeof b.verified!=="boolean"||!Number.isSafeInteger(b.removedPaths)||Number(b.removedPaths)<0||Number(b.removedPaths)>1_000_000_000||!Number.isSafeInteger(b.removedSandboxes)||Number(b.removedSandboxes)<0||Number(b.removedSandboxes)>100_000||!Array.isArray(b.outstanding)||b.outstanding.length>100)throw new ControlError("invalid host cleanup verification result");
  const outstanding:string[]=[];let bytes=0;
  for(const message of b.outstanding.map(value=>diagnostic(value,"cleanup outstanding item"))){const size=Buffer.byteLength(message);if(bytes+size>30_000){outstanding.push("Additional diagnostics omitted; inspect the host locally before approving another attempt.");break;}outstanding.push(message);bytes+=size;}
  return {verified:b.verified,removedPaths:Number(b.removedPaths),removedSandboxes:Number(b.removedSandboxes),outstanding};
}
export function finishHostCleanup(store:ControlStore,workerId:string,planId:string,generation:number,input:RuntimeThreadCleanupResult):HostCleanupPlan{
  initializeRetention(store);const output=result(input),resultDigest=hash(canonical(output));
  return store.transaction(()=>{
    const current=load(store,planId);if(current.workerId!==workerId)throw new ControlError("host cleanup worker mismatch",403);currentWorker(store,workerId,current.ownerId);
    if(["done","blocked"].includes(current.status)&&current.generation===generation&&current.finishedGeneration===generation){if(current.resultDigest!==resultDigest)throw new ControlError("cleanup result changed for a completed generation",409);return current;}
    const plan=fence(store,workerId,planId,generation);plan.removedPaths=output.removedPaths;plan.removedSandboxes=output.removedSandboxes;plan.outstanding=output.outstanding;plan.verified=output.verified;
    if(!output.verified&&!plan.outstanding.length)plan.outstanding=["Runtime could not verify the configured managed host boundary."];
    plan.status=output.verified&&!plan.outstanding.length?"done":"blocked";plan.finishedGeneration=generation;plan.resultDigest=resultDigest;clearApproval(plan);save(store,plan);return plan;
  });
}
