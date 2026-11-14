import { createToolBroker, proposePermissionChange } from "@laun/broker";
import { canDelegateProfile } from "@laun/policy";
import { isAgentEvent } from "@laun/protocol";
import { checkpointReference } from "@laun/storage";
import type { BrokerConnection, ControlPrincipal, MowerRecord, StoredProfile, TaskRecord, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { ControlService } from "./service.js";
import { inspectAdvice, requestAdvice, redactAdviceText } from "./adviser.js";
import { streamInference } from "./inference.js";
import { rebaseThreadProfile, moveThreadWorker } from "./lifecycle.js";
import { canonical, ControlError, hash, id, now, record, text } from "./store.js";

export interface ControlHttpOptions { allowLoopback?:boolean; resolveSecret?:(ref:string)=>string|undefined }
async function body(req:Request){
  const path=new URL(req.url).pathname;
  const limit=path.endsWith("/worker/checkpoint")?64*1024*1024:path.includes("/worker/")?2_097_152:262_144;
  const decoder=new TextDecoder("utf-8",{fatal:true});let raw="",bytes=0;
  if(req.body){const reader=req.body.getReader();try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
    if(bytes>limit){await reader.cancel();throw new ControlError("request body too large",413);}raw+=decoder.decode(chunk.value,{stream:true});}raw+=decoder.decode();
  }finally{reader.releaseLock();}}
  try{return record(JSON.parse(raw||"{}"));}catch(error){if(error instanceof ControlError)throw error;throw new ControlError("invalid JSON body");}
}
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function handleControlRequest(service:ControlService,req:Request,p:ControlPrincipal|null,options:ControlHttpOptions={}):Promise<Response>{
  const url=new URL(req.url);const path=url.pathname.replace(/^\/api\/v2/,"");const store=service.store;
  try{
    if(path.startsWith("/worker/")){
      const key=req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];const worker=key?store.authenticateWorker(key):null;
      if(!worker)return reply({error:"unauthorized worker"},401);
      const b=await body(req);if(req.method!=="POST")throw new ControlError("method not allowed",405);
      if(path==="/worker/poll"){
        if(b.inferenceMode!==undefined){if(b.inferenceMode!=="controller"&&b.inferenceMode!=="local")throw new ControlError("invalid inference mode");worker.inferenceMode=b.inferenceMode;store.put("worker",worker);}
        if(b.checkpointVersion!==undefined){if(typeof b.checkpointVersion!=="string"||b.checkpointVersion.length>100||!/^[-a-zA-Z0-9@._]+$/.test(b.checkpointVersion))throw new ControlError("invalid checkpoint runtime version");worker.checkpointVersion=b.checkpointVersion;store.put("worker",worker);}
        store.heartbeat(worker.id);
        const activeIds=Array.isArray(b.activeRunIds)?b.activeRunIds:[];
        if(activeIds.length>16||activeIds.some(v=>typeof v!=="string"))throw new ControlError("invalid activeRunIds");
        const existing=store.runs({id:worker.ownerId,admin:false}).find(r=>r.workerId===worker.id&&["running","waiting_permission"].includes(r.status)&&!activeIds.includes(r.id)&&r.leaseUntil&&Date.parse(r.leaseUntil)>Date.now());
        if(existing){const thread=store.get<ThreadRecord>("thread",existing.threadId);const snapshot=store.checkpoint(thread.id);return reply({job:{run:existing,thread,mower:store.get("mower",thread.mowerId),checkpoint:snapshot?checkpointReference(snapshot,thread.id):undefined}});}
        return reply({job:store.claim(worker,30_000,service.options.maxConcurrentRuns??4)});
      }
      const runId=text(b.runId,"runId",100),generation=Number(b.generation);
      const run=store.fence(runId,worker.id,generation);
      if(path==="/worker/inference-describe"){
        if(!service.options.inference||!run.model)throw new ControlError("controller inference unavailable",503);
        store.assertThreadAuthority(store.get("thread",run.threadId));if(run.cancelRequested)throw new ControlError("run cancelled",409);
        return reply({envelope:await service.options.inference.describe(run.model,req.signal)});
      }
      if(path==="/worker/inference")return streamInference(service,req,worker,b);
      if(path==="/worker/checkpoint"){
        if(typeof b.checkpoint!=="string")throw new ControlError("checkpoint manifest required");
        const checkpoint=b.checkpoint;const reference=checkpointReference(checkpoint,run.threadId);
        store.transaction(()=>{store.fence(runId,worker.id,generation);store.db.query("INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at").run(run.threadId,checkpoint,now());});
        return reply({checkpoint:reference});
      }
      if(path==="/worker/checkpoint-download"){
        const row=store.db.query("SELECT body FROM checkpoints WHERE thread_id=?").get(run.threadId) as {body:string}|null;
        if(!row)throw new ControlError("checkpoint not found",404);return reply({checkpoint:row.body});
      }
      if(path==="/worker/heartbeat"){store.heartbeat(worker.id,run.id,generation);return reply({cancelRequested:run.cancelRequested});}
      if(path==="/worker/events"){
        if(!Number.isSafeInteger(b.sequence)||Number(b.sequence)<0||!isAgentEvent(b.event)||b.event.sessionId!==run.threadId)throw new ControlError("invalid worker event");
        const event=b.event;
        store.transaction(()=>{
          const row=store.db.query("SELECT next_sequence FROM worker_sequences WHERE run_id=? AND generation=?").get(runId,generation) as {next_sequence:number}|null;
          const expected=row?.next_sequence??0;if(Number(b.sequence)>expected)throw new ControlError(`event sequence gap; expected ${expected}`,409);
          store.receipt({id:worker.ownerId,admin:false},`event:${runId}:${generation}:${b.sequence}`,hash(canonical(event)),()=>{
            if(Number(b.sequence)!==expected)throw new ControlError("event sequence conflict",409);
            // Central inference already records authoritative usage. A yard's
            // duplicate accounting cannot charge the family twice.
            const relayed=event.type==="usage"&&!!store.db.query("SELECT 1 FROM inference_calls WHERE run_id=? AND generation=? LIMIT 1").get(runId,generation);
            const stored=relayed?{accounted:true}:store.event(run.threadId,"agent",{event},runId);if(!relayed)service.enforceBudget(store.get("thread",run.threadId),run,event);
            store.db.query("INSERT INTO worker_sequences VALUES(?,?,?) ON CONFLICT(run_id,generation) DO UPDATE SET next_sequence=excluded.next_sequence").run(runId,generation,expected+1);return stored;
          });
        });
        return reply({accepted:true});
      }
      if(path==="/worker/authorize"){
        const operation=text(b.operation,"operation",80);const resource=text(b.resource,"resource",4096);
        await service.authorize(service.context(run),{operation:operation as never,resource,arguments:b.arguments,signal:req.signal},text(b.actionId,"actionId",128));
        store.fence(runId,worker.id,generation);return reply({authorized:true});
      }
      if(path==="/worker/invoke")return reply({result:await service.invoke(service.context(run),text(b.name,"name",80),b.arguments,req.signal)});
      if(path==="/worker/interrupted"){
        store.transaction(()=>{store.setRunStatus(run.id,"interrupted");store.expireRunApprovals(run.id);store.event(run.threadId,"system",{status:"interrupted",text:typeof b.summary==="string"?b.summary.slice(0,1000):"Worker interrupted; reconcile before resuming"},run.id);});
        return reply({run:store.run(run.id)});
      }
      if(path==="/worker/finish"){
        if(!["done","error","cancelled"].includes(String(b.status)))throw new ControlError("invalid result status");
        return reply({run:store.finish(runId,worker.id,generation,b.status as "done"|"error"|"cancelled",b.summary===undefined?undefined:text(b.summary,"summary"))});
      }
      throw new ControlError("worker endpoint not found",404);
    }
    if(!p)return reply({error:"unauthorized"},401);
    if(path==="/me"&&req.method==="GET")return reply({principalId:p.id,admin:p.admin});
    if(path==="/state"&&req.method==="GET")return reply(service.state(p));
    if(path==="/models"&&req.method==="GET")return reply({models:await service.listModels()});
    const directRun=path.match(/^\/runs\/([A-Za-z0-9_-]+)$/);
    if(directRun&&req.method==="GET")return reply({run:store.run(directRun[1]!,p)});
    const threadRuns=path.match(/^\/threads\/([A-Za-z0-9_-]+)\/runs$/);
    if(threadRuns&&req.method==="GET")return reply({runs:store.threadRuns(p,threadRuns[1]!)});
    if(path==="/mowers"&&req.method==="POST"){const b=await body(req);return reply(store.createMower(p,{...b,model:b.model??service.options.defaultModel}),201);}
    if(path==="/threads"&&req.method==="POST")return reply(store.createThread(p,await body(req)),201);
    if(path==="/profiles"&&req.method==="POST")return reply(store.createProfile(p,await body(req)),201);
    if(path==="/workers"&&req.method==="POST")return reply(store.registerWorker(p,await body(req)),201);
    const lifecyclePath=path.match(/^\/threads\/([A-Za-z0-9_-]+)\/(profile|move)$/);
    if(lifecyclePath&&req.method==="POST")return reply(lifecyclePath[2]==="profile"?rebaseThreadProfile(store,p,lifecyclePath[1]!,await body(req)):moveThreadWorker(store,p,lifecyclePath[1]!,await body(req)));
    const checkpointPath=path.match(/^\/threads\/([A-Za-z0-9_-]+)\/(checkpoint|checkpoint-reference)$/);
    if(checkpointPath&&req.method==="GET"){
      store.get("thread",checkpointPath[1]!,p);const row=store.db.query("SELECT body FROM checkpoints WHERE thread_id=?").get(checkpointPath[1]!) as {body:string}|null;
      if(!row)throw new ControlError("checkpoint not yet available",404);if(checkpointPath[2]==="checkpoint-reference")return reply(checkpointReference(row.body,checkpointPath[1]!));return new Response(row.body,{headers:{"content-type":"application/json","cache-control":"no-store"}});
    }
    let m=path.match(/^\/mowers\/([a-zA-Z0-9_-]+)$/);
    if(m&&req.method==="PATCH"){
      const mower=store.get<MowerRecord>("mower",m[1]!,p);const b=await body(req);
      if(b.name!==undefined){const name=text(b.name,"name",80);if(store.list<MowerRecord>("mower",{id:mower.ownerId,admin:false}).some(other=>other.id!==mower.id&&!other.archivedAt&&other.name.toLowerCase()===name.toLowerCase()))throw new ControlError("mower name already exists",409);mower.name=name;}
      if(b.model!==undefined)mower.model=text(b.model,"model",256);
      if(b.instructions!==undefined){if(b.instructions!==null&&typeof b.instructions!=="string")throw new ControlError("instructions must be text");mower.instructions=typeof b.instructions==="string"&&b.instructions.trim()?text(b.instructions,"instructions",16000):undefined;}
      if(b.workerId!==undefined){if(b.workerId!==null&&b.workerId!==""){const worker=store.get<WorkerRecord>("worker",String(b.workerId));if(!worker.local&&worker.ownerId!==mower.ownerId)throw new ControlError("worker not found",404);if(worker.status==="revoked")throw new ControlError("worker revoked",409);}mower.workerId=b.workerId?String(b.workerId):undefined;}
      if(b.profileId!==undefined){const profile=store.profile(text(b.profileId,"profileId",100),Number(b.profileVersion),p);if(profile.revokedAt)throw new ControlError("profile revoked",409);mower.profileId=profile.id;mower.profileVersion=profile.version;}
      if(b.archived===true)mower.archivedAt=now();store.put("mower",mower);
      if(b.archived===true)for(const thread of store.list<ThreadRecord>("thread",{id:mower.ownerId,admin:false}).filter(t=>t.mowerId===mower.id))service.cancelTree({id:mower.ownerId,admin:false},thread.id);
      return reply(mower);
    }
    m=path.match(/^\/profiles\/([a-zA-Z0-9_-]+)\/(revisions|revoke)$/);
    if(m&&req.method==="POST"){
      const previous=store.latestProfile(m[1]!,p);const b=await body(req);
      if(m[2]==="revisions"){if(b.expectedBaseVersion!==previous.version)throw new ControlError("profile changed; reload and review the latest revision",409);return reply(store.createProfile(p,b,previous),201);}
      const version=b.version===undefined?previous.version:Number(b.version);const profile=store.profile(m[1]!,version,p);profile.revokedAt=now();
      store.db.query("UPDATE objects SET body=? WHERE kind='profile' AND id=?").run(JSON.stringify(profile),`${profile.id}:${version}`);
      service.cancelProfile(profile.id,version);
      return reply(profile);
    }
    m=path.match(/^\/threads\/([a-zA-Z0-9_-]+)\/(events|messages|cancel|archive)$/);
    if(m){
      const threadId=m[1]!;store.get("thread",threadId,p);
      if(m[2]==="events"&&req.method==="GET"){
        if(url.searchParams.has("before")||url.searchParams.has("tail")){
          if(url.searchParams.has("after")||(url.searchParams.has("tail")&&url.searchParams.get("tail")!=="true"))throw new ControlError("choose a valid before/tail history cursor or after replay cursor");
          return reply(store.history(p,threadId,url.searchParams.has("before")?Number(url.searchParams.get("before")):undefined));
        }
        const after=Number(url.searchParams.get("after")??0);if(!Number.isSafeInteger(after)||after<0)throw new ControlError("invalid event cursor");return reply(store.events(p,threadId,after));
      }
      if(m[2]==="messages"&&req.method==="POST"){const run=store.submit(p,threadId,await body(req));void service.tick();return reply(run,202);}
      if(m[2]==="cancel"&&req.method==="POST"){service.cancelTree(p,threadId);return reply({accepted:true});}
      if(m[2]==="archive"&&req.method==="POST"){service.cancelTree(p,threadId);const thread=store.get<ThreadRecord>("thread",threadId,p);thread.archivedAt=now();store.put("thread",thread);return reply(thread);}
    }
    m=path.match(/^\/runs\/([a-zA-Z0-9_-]+)\/resume$/);
    if(m&&req.method==="POST"){
      const b=await body(req);const run=store.run(m[1]!,p);
      if(run.status!=="interrupted")throw new ControlError("run is not interrupted",409);
      if(b.confirmedStopped!==true)throw new ControlError("confirm previous execution has stopped before resuming",409);
      store.setRunStatus(run.id,"queued");store.db.query("UPDATE runs SET cancel_requested=0,lease_until=NULL WHERE id=?").run(run.id);
      store.event(run.threadId,"system",{text:"Operator reconciled interrupted execution; resuming durable request"},run.id);void service.tick();return reply(store.run(run.id));
    }
    m=path.match(/^\/runs\/([a-zA-Z0-9_-]+)\/abandon$/);
    if(m&&req.method==="POST"){
      const b=await body(req);const run=store.run(m[1]!,p);
      if(run.status!=="interrupted"||b.confirmedStopped!==true)throw new ControlError("confirm interrupted execution has stopped before abandoning it",409);
      store.transaction(()=>{store.cancel(p,run.threadId);store.db.query("UPDATE runs SET status='cancelled',generation=generation+1,lease_until=NULL,updated_at=? WHERE id=?").run(now(),run.id);store.expireRunApprovals(run.id);
        store.event(run.threadId,"system",{text:"Operator abandoned the reconciled attempt without replay",status:"cancelled"},run.id);});return reply(store.run(run.id));
    }
    m=path.match(/^\/advice\/([A-Za-z0-9_-]+)$/);
    if(m&&req.method==="GET")return reply(inspectAdvice(service,p,m[1]!));
    m=path.match(/^\/approvals\/([a-zA-Z0-9_-]+)(\/proposal|\/advice)?$/);
    if(m&&req.method==="POST"){
      const b=await body(req);const a=store.approval(m[1]!,p);
      if(m[2]==="/advice")return reply(requestAdvice(service,p,a.id,text(b.feedback,"feedback",4000),{requestId:b.requestId===undefined?undefined:text(b.requestId,"requestId",128)}),202);
      if(m[2]==="/proposal")return reply(proposePermissionChange(store.profile(a.profileId,a.profileVersion,p),a.action,text(b.feedback,"feedback",2000)));
      if(b.continuation!==undefined&&!["replan","stop"].includes(String(b.continuation)))throw new ControlError("invalid continuation");
      const decided=store.decide(p,a.id,b.decision,{feedback:b.feedback===undefined?undefined:redactAdviceText(text(b.feedback,"feedback",4000)),continuation:b.continuation as "replan"|"stop"|undefined});
      if(decided.status==="denied"&&decided.continuation==="stop")service.cancelTree(p,decided.action.threadId);
      return reply(decided);
    }
    if(path==="/tasks"&&req.method==="POST"){
      const b=await body(req);const parent=store.get<ThreadRecord>("thread",text(b.parentThreadId,"parentThreadId",100),p);const goal=text(b.goal,"goal",32_000);
      const taskTitle=b.name===undefined?goal.slice(0,160):text(b.name,"task name",160);
      const taskOwner={id:parent.ownerId,admin:false};
      const result=store.receipt(p,`user-task:${text(b.requestId,"requestId",128)}`,hash(canonical(b)),()=>{
        const mower=b.mowerId?store.get<MowerRecord>("mower",String(b.mowerId),taskOwner):store.createMower(taskOwner,{name:b.name??`Mower ${id().slice(0,6)}`,profileId:parent.profileId,profileVersion:parent.profileVersion,model:store.get<MowerRecord>("mower",parent.mowerId,taskOwner).model});
        const child=store.createThread(taskOwner,{mowerId:mower.id,title:taskTitle,parentThreadId:parent.id});
        const run=store.submit(taskOwner,child.id,{text:goal,requestId:String(b.requestId)});
        const task:TaskRecord={id:id(),ownerId:parent.ownerId,parentThreadId:parent.id,threadId:child.id,mowerId:mower.id,title:taskTitle,goal,status:"queued",createdAt:now(),updatedAt:now(),handoffCount:0};store.put("task",task);
        store.event(parent.id,"task",{taskId:task.id,threadId:child.id,text:`Delegated: ${task.title}`});return {task,thread:child,run};});
      void service.tick();return reply(result,201);
    }
    m=path.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/handoff$/);
    if(m&&req.method==="POST"){const result=service.handoff(p,m[1]!,await body(req));void service.tick();return reply(result);}
    m=path.match(/^\/workers\/([a-zA-Z0-9_-]+)\/revoke$/);
    if(m&&req.method==="POST"){
      const worker=store.get<WorkerRecord>("worker",m[1]!,p);if(worker.local)throw new ControlError("disable local runtime in server configuration");worker.status="revoked";store.put("worker",worker);
      for(const run of store.runs(p).filter(r=>r.workerId===worker.id&&["running","waiting_permission"].includes(r.status))){store.setRunStatus(run.id,"interrupted");store.expireRunApprovals(run.id);}return reply(worker);
    }
    if(path==="/connections"&&req.method==="POST"){
      const b=await body(req);const endpoint=new URL(text(b.url,"url",4096));if(endpoint.username||endpoint.password||endpoint.hash||!["http:","https:"].includes(endpoint.protocol))throw new ControlError("invalid credential-free HTTP endpoint");
      if(b.secretRef!==undefined&&!/^MCP_[A-Z0-9_]+$/.test(String(b.secretRef)))throw new ControlError("secretRef must name a controller MCP_ environment secret");
      if(b.secretRef&&!p.admin)throw new ControlError("only the installation administrator can bind controller credential references",403);
      if(b.protocolVersion!==undefined&&!["2026-07-28","2025-11-25"].includes(String(b.protocolVersion)))throw new ControlError("invalid MCP protocol version");
      const connection:BrokerConnection={id:id(),ownerId:p.id,workspaceId:"default",name:text(b.name,"name",80),transport:"http",url:endpoint.href,
        protocolVersion:b.protocolVersion as BrokerConnection["protocolVersion"],secretRef:b.secretRef?String(b.secretRef):undefined,allowLocal:b.allowLocal===true,enabled:true};
      store.saveConnection(connection);return reply(connection,201);
    }
    m=path.match(/^\/connections\/([a-zA-Z0-9_-]+)(\/discover)?$/);
    if(m){
      const connection=store.get<BrokerConnection>("connection",m[1]!,p);
      if(!m[2]&&req.method==="PATCH"){
        const b=await body(req);const before=canonical({url:connection.url,protocol:connection.protocolVersion,secret:connection.secretRef});
        if(b.name!==undefined)connection.name=text(b.name,"name",80);
        if(b.url!==undefined){const endpoint=new URL(text(b.url,"url",4096));if(endpoint.username||endpoint.password||endpoint.hash||!["http:","https:"].includes(endpoint.protocol))throw new ControlError("invalid endpoint");connection.url=endpoint.href;}
        if(b.protocolVersion!==undefined){if(!["2026-07-28","2025-11-25"].includes(String(b.protocolVersion)))throw new ControlError("invalid MCP protocol version");connection.protocolVersion=b.protocolVersion as BrokerConnection["protocolVersion"];}
        if(b.secretRef!==undefined&&String(b.secretRef)!==(connection.secretRef??"")){if(!p.admin)throw new ControlError("administrator required to bind controller credentials",403);if(b.secretRef&&!/^MCP_[A-Z0-9_]+$/.test(String(b.secretRef)))throw new ControlError("invalid secret reference");connection.secretRef=b.secretRef?String(b.secretRef):undefined;}
        if(b.allowLocal!==undefined)connection.allowLocal=b.allowLocal===true;
        if(b.enabled!==undefined)connection.enabled=b.enabled===true;
        if(connection.secretRef&&!p.admin&&before!==canonical({url:connection.url,protocol:connection.protocolVersion,secret:connection.secretRef}))throw new ControlError("administrator must rebind credentials for a changed endpoint",403);
        if(before!==canonical({url:connection.url,protocol:connection.protocolVersion,secret:connection.secretRef})){delete connection.tools;delete connection.catalogDigest;delete connection.discoveredAt;}
        store.saveConnection(connection);return reply(connection);
      }
      if(m[2]&&req.method==="POST"){
        // An authenticated operator explicitly requests read-only discovery.
        // This short-lived broker permits only this endpoint's network action;
        // it cannot authorize tool invocation or create a mower grant.
        const operatorBroker=createToolBroker({allowLoopback:options.allowLoopback,loadConnection:connectionId=>connectionId===connection.id?connection:undefined,
          saveConnection:value=>store.saveConnection(value),resolveSecret:ref=>options.resolveSecret?.(ref),
          authorize:async(_ctx,operation,resource)=>{if(operation!=="network.connect"||resource!==new URL(connection.url).origin)throw new ControlError("operator discovery scope exceeded",403);}});
        return reply(await operatorBroker.discover({principalId:connection.ownerId,workspaceId:connection.workspaceId,mowerId:"operator",threadId:"operator",runId:id()},connection.id));
      }
      if(req.method==="DELETE"){connection.enabled=false;store.saveConnection(connection);return reply(connection);}
    }
    throw new ControlError("not found",404);
  }catch(error){const e=error as Error&{status?:number};return reply({error:e.message},e.status??400);}
}
