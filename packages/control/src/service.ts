import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { evaluatePermission } from "@laun/policy";
import { isAgentEvent } from "@laun/protocol";
import type { AgentRuntime, BrokerConnection, ControlApproval, ControlContext, ControlPrincipal, ControlRun, ControlState, MowerRecord,
  PermissionAction, RuntimePermissionRequest, StoredProfile, TaskRecord, ThreadRecord, WorkerJob, WorkerRecord } from "@laun/protocol";
import { ControlError, ControlStore, canonical, hash, id, now, record, text } from "./store.js";

export interface BrokerSurface {
  discover(context:ControlContext,connectionId:string):Promise<BrokerConnection>;
  invoke(context:ControlContext,connectionId:string,tool:string,args:unknown,digest:string):Promise<unknown>;
}
export interface ControlOptions {
  store:ControlStore; runtime?:AgentRuntime; dataDir:string; mode:ControlState["readiness"]["mode"];
  capacity?:number; approvalTimeoutMs?:number; maxFamilyTokens?:number;
  broker?:BrokerSurface; bootstrap?:boolean;
  defaultModel?:string;
}
const owner = (ownerId:string):ControlPrincipal=>({id:ownerId,admin:false});
const sleep = (ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function intentPreview(value:unknown):string{
  const clean=(v:unknown,key=""):unknown=>{
    if(/secret|password|authorization|api.?key|access.?token|refresh.?token/i.test(key))return "[redacted credential]";
    if(key==="content"&&typeof v==="string"&&v.length>4000)return `[${v.length} characters; SHA-256 ${hash(v)}]`;
    if(Array.isArray(v))return v.map(item=>clean(item));
    if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x,k)]));
    return v;
  };
  const preview=JSON.stringify(clean(value),null,2)??"null";
  if(preview.length>65_536)throw new ControlError("permission intent is too large to inspect; split the action",413);
  return preview;
}

export class ControlService {
  readonly store:ControlStore;
  private runtime?:AgentRuntime;
  broker?:BrokerSurface;
  private timer:ReturnType<typeof setInterval>;
  private active=new Map<string,{job:WorkerJob;controller:AbortController}>();
  private ticking=false;
  private closed=false;
  private jobs=new Set<Promise<void>>();
  constructor(readonly options:ControlOptions){
    this.store=options.store;this.runtime=options.runtime;this.broker=options.broker;
    mkdirSync(options.dataDir,{recursive:true,mode:0o700});
    if(this.runtime){
      const worker:WorkerRecord={id:"local",ownerId:"service",name:"Local yard",labels:["local"],capacity:options.capacity??2,status:"online",lastSeenAt:now(),createdAt:now(),local:true};
      try {worker.createdAt=this.store.get<WorkerRecord>("worker","local").createdAt;}catch{}
      this.store.put("worker",worker);
    }
    this.timer=setInterval(()=>{void this.tick().catch(e=>console.error("[control] scheduler:",e.message));},250);
    this.timer.unref();
  }
  readiness():ControlState["readiness"]{
    return {runtime:!!this.runtime,mode:this.options.mode,defaultModel:this.options.defaultModel,message:this.runtime ?
      this.options.mode==="isolated"?"Pi runtime tools execute through OpenShell":"Trusted local execution: tools can access this user’s host; use isolated VPS mode for containment":
      "No local runtime configured. Enroll a yard or enable explicit trusted local/OpenShell execution."};
  }
  async listModels(){return await this.runtime?.listModels?.()??[];}
  state(p:ControlPrincipal):ControlState{
    const workers=this.store.list<WorkerRecord>("worker",p);
    if(!workers.some(w=>w.id==="local")&&this.runtime)workers.push(this.store.get("worker","local"));
    return {mowers:this.store.list("mower",p),threads:this.store.list("thread",p),runs:this.store.runs(p),profiles:this.store.list("profile",p),
      workers,tasks:this.store.list("task",p),approvals:this.store.approvals(p),connections:this.store.list("connection",p),readiness:this.readiness()};
  }
  context(run:ControlRun):ControlContext{
    const thread=this.store.get<ThreadRecord>("thread",run.threadId);return {principalId:thread.ownerId,workspaceId:thread.workspaceId,mowerId:thread.mowerId,threadId:thread.id,runId:run.id};
  }
  private profiles(thread:ThreadRecord):StoredProfile[]{
    const result:StoredProfile[]=[];let current:ThreadRecord|undefined=thread;const seen=new Set<string>();
    while(current){if(seen.has(current.id)||seen.size>8)throw new ControlError("invalid thread ancestry",403);seen.add(current.id);
      result.push(this.store.profile(current.profileId,current.profileVersion));current=current.parentThreadId?this.store.get<ThreadRecord>("thread",current.parentThreadId):undefined;}
    return result;
  }
  async authorize(context:ControlContext,request:RuntimePermissionRequest,callId:string=id()):Promise<void>{
    const run=this.store.run(context.runId);const thread=this.store.get<ThreadRecord>("thread",context.threadId);
    if(run.threadId!==thread.id||thread.ownerId!==context.principalId||thread.mowerId!==context.mowerId||thread.workspaceId!==context.workspaceId)throw new ControlError("action identity mismatch",403);
    const action:PermissionAction={id:`${callId}_g${run.generation}`,...context,operation:request.operation,resource:request.resource,argumentsDigest:hash(canonical(request.arguments))};
    const evaluate=()=>{
      const current=this.store.run(run.id);
      if(current.generation!==run.generation)throw new ControlError("stale run generation",409);
      if(current.cancelRequested||!["running","waiting_permission"].includes(current.status)||request.signal?.aborted)throw new ControlError("run cancelled or inactive",409);
      if(!current.leaseUntil||Date.parse(current.leaseUntil)<=Date.now())throw new ControlError("run lease expired",409);
      const profiles=this.profiles(thread);
      const verdicts=profiles.map(profile=>evaluatePermission(profile,action,{nowMs:Date.now(),revoked:!!profile.revokedAt}));
      const denial=verdicts.find(v=>v.effect==="deny");if(denial)throw new ControlError(`permission denied: ${denial.reason} (${action.operation} ${action.resource})`,403);
      return {profiles,needsApproval:verdicts.some(v=>v.effect==="ask")};
    };
    let {profiles,needsApproval}=evaluate();
    if(!needsApproval)return;
    const primary=profiles[0]!;
    let approval=this.store.requestApproval({id:id(),ownerId:thread.ownerId,action,profileId:primary.id,profileVersion:primary.version,status:"pending",createdAt:now(),detail:intentPreview(request.arguments),
      expiresAt:new Date(Date.now()+(this.options.approvalTimeoutMs??300_000)).toISOString()},hash(canonical(action)));
    this.store.setRunStatus(run.id,"waiting_permission");
    if(primary.mode==="auto")this.store.event(thread.id,"system",{text:`Gatekeeper: ${action.operation} needs permission for ${action.resource}. You can allow this action once, deny it, or propose a narrow profile revision. I will keep this action paused while other threads continue.`,approvalId:approval.id,adviser:true},run.id);
    try { for(;;){
      ({profiles,needsApproval}=evaluate());
      approval=this.store.approval(approval.id);
      if(approval.status==="approved"){
        this.store.transaction(()=>{
          evaluate();const fresh=this.store.approval(approval.id);
          if(fresh.status!=="approved"||Date.parse(fresh.expiresAt)<=Date.now())throw new ControlError("approval expired or already used",403);
          // Every ancestor is reevaluated above. Approval covers this exact action
          // through all ask ceilings; it cannot override any explicit deny.
          fresh.status="consumed";this.store.updateApproval(fresh);this.store.setRunStatus(run.id,"running");
          this.store.event(thread.id,"approval",{approvalId:fresh.id,status:"consumed"},run.id);
        });return;
      }
      if(["denied","expired","consumed"].includes(approval.status))throw new ControlError(`permission ${approval.status}`,403);
      if(Date.parse(approval.expiresAt)<=Date.now()){
        approval.status="expired";this.store.updateApproval(approval);throw new ControlError("permission request expired",403);
      }
      await sleep(100);
    } } finally {
      const current=this.store.run(run.id);
      if(current.generation===run.generation&&current.status==="waiting_permission"){
        const fresh=this.store.approval(approval.id);
        if(fresh.status==="pending"){fresh.status="expired";this.store.updateApproval(fresh);}
        const pending=this.store.approvals(owner(thread.ownerId)).some(a=>a.action.runId===run.id&&a.status==="pending");
        if(!pending)this.store.setRunStatus(run.id,"running");
      }
    }
  }
  async tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{
      this.store.interruptExpired();this.reconcileTasks();
      if(!this.runtime)return;
      const worker=this.store.get<WorkerRecord>("worker","local");
      this.store.heartbeat(worker.id);
      while(this.active.size<worker.capacity){const job=this.store.claim(worker);if(!job)break;
        const controller=new AbortController();this.active.set(job.run.id,{job,controller});
        const promise=this.execute(job,controller).catch(e=>console.error("[control] execution cleanup:",e.message));
        this.jobs.add(promise);void promise.finally(()=>this.jobs.delete(promise));}
    }finally{this.ticking=false;}
  }
  private async execute(job:WorkerJob,controller:AbortController){
    const {run,thread,mower}=job;const runtime=this.runtime!;
    const heartbeat=setInterval(()=>{
      try{this.store.heartbeat("local",run.id,run.generation);if(this.store.run(run.id).cancelRequested){controller.abort();void runtime.cancel(thread.id);}}
      catch{controller.abort();void runtime.cancel(thread.id);}
    },1000);heartbeat.unref();
    try{
      const base=resolve(this.options.dataDir,"threads",thread.id);mkdirSync(base,{recursive:true,mode:0o700});
      const context=this.context(run);
      const result=await runtime.run({threadId:thread.id,runId:run.id,prompt:run.prompt,model:mower.model,workspaceRoot:join(base,"work"),sessionDir:join(base,"session")},{
        emit:event=>{this.store.fence(run.id,"local",run.generation);if(event.sessionId!==thread.id||!isAgentEvent(event))throw new ControlError("invalid runtime event",502);
          this.store.event(thread.id,"agent",{event},run.id);this.enforceBudget(thread,run,event);},
        authorize:request=>this.authorize(context,{...request,signal:request.signal??controller.signal}),
        invokeTool:(name,args,signal)=>this.invoke(context,name,args,signal),
      });
      this.store.finish(run.id,"local",run.generation,result.status,result.summary);
    }catch(error){
      try{this.store.finish(run.id,"local",run.generation,controller.signal.aborted?"cancelled":"error",(error as Error).message);}catch{}
    }finally{clearInterval(heartbeat);this.active.delete(run.id);this.reconcileTasks();void this.tick();}
  }
  enforceBudget(thread:ThreadRecord,run:ControlRun,event:unknown){
    const max=this.options.maxFamilyTokens??100_000;if(max<=0||!record(event)||record(event).type!=="usage")return;
    let root=thread;while(root.parentThreadId)root=this.store.get("thread",root.parentThreadId);
    const family=new Set<string>([root.id]);let changed=true;const all=this.store.list<ThreadRecord>("thread",owner(thread.ownerId));
    while(changed){changed=false;for(const t of all)if(t.parentThreadId&&family.has(t.parentThreadId)&&!family.has(t.id)){family.add(t.id);changed=true;}}
    let tokens=0;for(const t of family){const rows=this.store.db.query("SELECT payload FROM events WHERE thread_id=? AND kind='agent'").all(t) as {payload:string}[];
      for(const row of rows){const e=JSON.parse(row.payload).event;if(e?.type==="usage")tokens+=Math.max(0,Number(e.totalTokens??((e.inputTokens??0)+(e.outputTokens??0)))||0);}}
    if(tokens>max){this.cancelTree(owner(thread.ownerId),root.id);this.store.event(root.id,"system",{text:`Family token budget exceeded (${tokens}/${max})`},run.id);}
  }
  cancelTree(p:ControlPrincipal,threadId:string){
    this.store.cancel(p,threadId);for(const active of this.active.values())if(active.job.thread.id===threadId){active.controller.abort();void this.runtime?.cancel(threadId);}
    for(const child of this.store.list<ThreadRecord>("thread",p).filter(t=>t.parentThreadId===threadId))this.cancelTree(p,child.id);
  }
  async invoke(context:ControlContext,name:string,input:unknown,signal?:AbortSignal):Promise<unknown>{
    const p=owner(context.principalId);const run=this.store.run(context.runId,p);const source=this.store.get<ThreadRecord>("thread",context.threadId,p);
    if(run.threadId!==source.id||source.mowerId!==context.mowerId||source.workspaceId!==context.workspaceId)throw new ControlError("tool context identity mismatch",403);
    if(run.cancelRequested||!["running","waiting_permission"].includes(run.status))throw new ControlError("run inactive",409);
    const assertCurrent=()=>{const current=this.store.run(run.id,p);if(current.generation!==run.generation||current.cancelRequested||!current.leaseUntil||Date.parse(current.leaseUntil)<=Date.now()||!["running","waiting_permission"].includes(current.status))throw new ControlError("stale run generation",409);};
    assertCurrent();
    const b=record(input??{});
    if(name==="mower_list")return this.store.list<MowerRecord>("mower",p);
    if(name==="mcp_list")return this.store.list<BrokerConnection>("connection",p).filter(c=>c.enabled!==false).map(c=>({id:c.id,name:c.name,tools:c.tools??[]}));
    if(name==="task_status"){
      const tasks=this.store.list<TaskRecord>("task",p).filter(t=>t.parentThreadId===source.id||t.threadId===source.id);
      if(b.taskId){const task=tasks.find(t=>t.id===b.taskId);if(!task)throw new ControlError("task outside thread scope",404);return task;}return tasks;
    }
    if(name==="mower_spawn"){
      // Authorization is repeated at the central API boundary even for a remote worker.
      await this.authorize(context,{operation:"mower.spawn",resource:"mowers:own",arguments:b,signal});
      const goal=text(b.goal,"goal",32_000);const requestId=text(b.requestId??`${run.id}:${hash(canonical(b))}`,"requestId",256);
      const result=this.store.receipt(p,`spawn:${requestId}`,hash(canonical(b)),()=>{
        assertCurrent();
        let mower:MowerRecord;
        if(b.mowerId)mower=this.store.get("mower",String(b.mowerId),p);
        else mower=this.store.createMower(p,{name:text(b.name??`Mower ${id().slice(0,6)}`,"name",80),model:this.store.get<MowerRecord>("mower",source.mowerId,p).model,
          profileId:source.profileId,profileVersion:source.profileVersion});
        const thread=this.store.createThread(p,{mowerId:mower.id,title:b.title??goal.slice(0,120),parentThreadId:source.id});
        const childRun=this.store.submit(p,thread.id,{text:goal,requestId:`task:${requestId}`.slice(0,128)});
        const task:TaskRecord={id:id(),ownerId:p.id,parentThreadId:source.id,threadId:thread.id,mowerId:mower.id,title:goal.slice(0,160),status:"queued",createdAt:now(),updatedAt:now(),handoffCount:0};
        this.store.put("task",task);this.store.event(source.id,"task",{taskId:task.id,threadId:thread.id,text:`Delegated: ${task.title}`},run.id);
        return {task,thread,run:childRun,mower};
      });void this.tick();return result;
    }
    if(name==="thread_message"){
      assertCurrent();
      const target=this.store.get<ThreadRecord>("thread",text(b.threadId,"threadId",100),p);
      if(target.id!==source.id && target.parentThreadId!==source.id)throw new ControlError("messages are limited to this thread and its direct children",403);
      return this.store.submit(p,target.id,{text:b.text,requestId:text(b.requestId,"requestId",128)});
    }
    if(name==="task_handoff"){
      await this.authorize(context,{operation:"task.handoff",resource:"tasks:own",arguments:b,signal});
      assertCurrent();
      return this.handoff(p,text(b.taskId,"taskId",100),b,source.id);
    }
    if(name==="mcp_call"){
      if(!this.broker)throw new ControlError("MCP broker unavailable",503);
      const connectionId=text(b.connectionId,"connectionId",100);this.store.get("connection",connectionId,p);
      assertCurrent();
      return this.broker.invoke(context,connectionId,text(b.tool,"tool",256),b.arguments??{},text(b.schemaDigest,"schemaDigest",64));
    }
    throw new ControlError("unknown broker tool",404);
  }
  handoff(p:ControlPrincipal,taskId:string,input:unknown,parentId?:string){
    const b=record(input);const requestId=text(b.requestId,"requestId",128);
    return this.store.receipt(p,`handoff:${requestId}`,hash(canonical({taskId,...b})),()=>{
      const task=this.store.get<TaskRecord>("task",taskId,p);if(parentId&&task.parentThreadId!==parentId)throw new ControlError("task outside delegation scope",403);
      if(["done","cancelled"].includes(task.status))throw new ControlError("task already settled",409);
      const live=this.store.runs(p).some(r=>r.threadId===task.threadId&&["running","waiting_permission"].includes(r.status));
      if(live)throw new ControlError("cancel and settle active task before handoff",409);
      if(this.store.runs(p).some(r=>r.threadId===task.threadId&&r.status==="interrupted"))throw new ControlError("reconcile interrupted task before handoff",409);
      if(task.handoffCount>=8)throw new ControlError("handoff limit reached",409);
      const next=this.store.createThread(p,{mowerId:text(b.mowerId,"mowerId",100),title:task.title,parentThreadId:task.parentThreadId});
      this.store.cancel(p,task.threadId);
      task.threadId=next.id;task.mowerId=next.mowerId;task.handoffCount++;task.status="queued";task.updatedAt=now();this.store.put("task",task);
      const run=this.store.submit(p,next.id,{text:task.title,requestId:`handoff:${requestId}`.slice(0,128)});return {task,thread:next,run};
    });
  }
  private reconcileTasks(){
    const admin={id:"service",admin:true};
    for(const task of this.store.list<TaskRecord>("task",admin)){
      if(["done","error","cancelled"].includes(task.status))continue;
      const runs=this.store.runs(owner(task.ownerId)).filter(r=>r.threadId===task.threadId);const latest=runs[0];if(!latest)continue;
      if(["running","waiting_permission"].includes(latest.status)){if(task.status!=="running"){task.status="running";this.store.put("task",task);}continue;}
      if(!["done","error","cancelled"].includes(latest.status))continue;
      this.store.transaction(()=>{
        task.status=latest.status as TaskRecord["status"];task.result=latest.summary??latest.status;task.updatedAt=now();this.store.put("task",task);
        this.store.event(task.parentThreadId,"task",{taskId:task.id,threadId:task.threadId,status:task.status,text:task.result});
        // Durable result receipt is visible without restarting the child.
      });
    }
  }
  async close(){this.closed=true;clearInterval(this.timer);for(const a of this.active.values())a.controller.abort();await this.runtime?.close();await Promise.allSettled([...this.jobs]);}
}
