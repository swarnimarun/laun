import type { RuntimeInferenceClient, RuntimeInferenceEnvelope, RuntimeInferenceRequest, WorkerRecord } from "@laun/protocol";
import type { ControlService } from "./service.js";
import { canonical, ControlError, hash, now, record, text } from "./store.js";

/** Admit a charge once, before the provider sees it. No automatic replay/cache. */
export function admitInference(service:ControlService,worker:WorkerRecord,input:unknown){
  const b=record(input),runId=text(b.runId,"runId",100),generation=Number(b.generation);
  const request=record(b.request),requestId=text(request.requestId,"requestId",128);
  if(!/^[0-9a-f]{64}$/.test(requestId)||Object.keys(request).some(k=>!["requestId","envelope"].includes(k)))throw new ControlError("invalid inference request");
  const envelope=record(request.envelope),fingerprint=hash(canonical(envelope));
  return service.store.transaction(()=>{
    const run=service.store.fence(runId,worker.id,generation);
    service.store.assertThreadAuthority(service.store.get("thread",run.threadId));
    if(run.cancelRequested)throw new ControlError("run cancelled",409);
    if(!run.model)throw new ControlError("run has no admitted model",409);
    const existing=service.store.db.query("SELECT fingerprint FROM inference_calls WHERE run_id=? AND generation=? AND request_id=?").get(runId,generation,requestId);
    if(existing)throw new ControlError("model request was already admitted; reconcile instead of retrying a possible charge",409);
    service.store.admissionGuard?.();
    const calls=service.store.db.query("SELECT COUNT(*) n,SUM(CASE WHEN status='admitted' THEN 1 ELSE 0 END) active FROM inference_calls WHERE run_id=?").get(runId) as {n:number;active:number|null};
    if(calls.n>=256)throw new ControlError("model request limit reached",429);
    if(calls.active)throw new ControlError("a prior model request has an unresolved outcome",409);
    const at=now();
    service.store.db.query("INSERT INTO inference_calls VALUES(?,?,?,?,'admitted',?,?)").run(runId,generation,requestId,fingerprint,at,at);
    return {run,request:{requestId,envelope} as unknown as RuntimeInferenceRequest};
  });
}

export interface InferenceRunScope { runId: string; generation: number; workerId: string }
function fencedRun(service: ControlService, scope: InferenceRunScope, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const run = service.store.fence(scope.runId, scope.workerId, scope.generation);
  service.store.assertThreadAuthority(service.store.get("thread", run.threadId));
  if (run.cancelRequested) throw new ControlError("model request cancelled", 409);
  if (service.store.get<WorkerRecord>("worker", scope.workerId).status === "revoked") throw new ControlError("yard revoked", 403);
  return run;
}

/** Local and HTTP runtimes share the same fenced charge/usage boundary. */
export function createRunInferenceClient(service: ControlService, scope: InferenceRunScope, signal?: AbortSignal): RuntimeInferenceClient {
  const combined = (other?: AbortSignal) => signal && other ? AbortSignal.any([signal, other]) : signal ?? other;
  return {
    async describe(other) {
      const abort = combined(other), run = fencedRun(service, scope, abort);
      if (!service.options.inference || !run.model) throw new ControlError("controller inference is not configured", 503);
      service.store.admissionGuard?.();
      const envelope = await service.options.inference.describe(run.model, abort);
      fencedRun(service, scope, abort); return envelope;
    },
    stream(request, other) {
      const worker = service.store.get<WorkerRecord>("worker", scope.workerId);
      return admittedInferenceFrames(service, worker, { runId: scope.runId, generation: scope.generation, request }, combined(other));
    },
  };
}

/** Admission is eager: a duplicate fails before HTTP headers or provider cost. */
export function admittedInferenceFrames(service:ControlService,worker:WorkerRecord,input:unknown,parentSignal?:AbortSignal):AsyncIterableIterator<RuntimeInferenceEnvelope>{
  parentSignal?.throwIfAborted();
  if(!service.options.inference)throw new ControlError("controller inference is not configured",503);
  const {run,request}=admitInference(service,worker,input);
  const abort=new AbortController(),signal=abort.signal;
  const scope={runId:run.id,generation:run.generation,workerId:worker.id};
  let total=0,count=0,finished=false,usageRecorded=false;
  let lease:ReturnType<typeof setInterval>|undefined;
  let iterator:AsyncIterator<RuntimeInferenceEnvelope>|undefined;
  const check=()=>{fencedRun(service,scope,signal);};
  const settle=(status:"done"|"interrupted")=>{
    if(finished)return;finished=true;
    service.store.transaction(()=>{
      service.store.db.query("UPDATE inference_calls SET status=?,updated_at=? WHERE run_id=? AND generation=? AND request_id=? AND status='admitted'").run(status,now(),run.id,run.generation,request.requestId);
      if(status==="interrupted")try{
        service.store.fence(run.id,worker.id,run.generation);
        service.store.setRunStatus(run.id,"interrupted");service.store.expireRunApprovals(run.id);
        service.store.event(run.threadId,"system",{status:"interrupted",text:"Controller model stream ended without a confirmed outcome; reconcile before resuming"},run.id);
      }catch{/* A newer fence or completed run remains authoritative. */}
    });
  };
  const stop=(status:"done"|"interrupted")=>{
    try{settle(status);}finally{
      if(lease)clearInterval(lease);parentSignal?.removeEventListener("abort",cancel);
      abort.abort();void iterator?.return?.().catch(()=>{});
    }
  };
  const cancel=()=>{try{stop("interrupted");}catch{/* The caller still observes an aborted, unresolved admission. */}};
  parentSignal?.addEventListener("abort",cancel,{once:true});if(parentSignal?.aborted)cancel();
  if(!finished){lease=setInterval(()=>{try{check();}catch{cancel();}},500);lease.unref();}
  const next=async()=>{
    signal.throwIfAborted();
    return await new Promise<IteratorResult<RuntimeInferenceEnvelope>>((resolve,reject)=>{
      const cancelled=()=>reject(new ControlError("model stream cancelled",409));
      signal.addEventListener("abort",cancelled,{once:true});
      Promise.resolve().then(()=>iterator!.next()).then(resolve,reject).finally(()=>signal.removeEventListener("abort",cancelled));
      if(signal.aborted)cancelled();
    });
  };
  const produce=async function*(){
    try{
      check();
      iterator=service.options.inference!.stream(run.model!,request,signal,usage=>{
        check();if(usageRecorded)throw new ControlError("duplicate authoritative model usage",502);
        service.store.transaction(()=>{
          check();const event={type:"usage" as const,sessionId:run.threadId,...usage};
          service.store.event(run.threadId,"agent",{event,source:"inference-controller"},run.id);
          service.enforceBudget(service.store.get("thread",run.threadId),run,event);
        });usageRecorded=true;
      })[Symbol.asyncIterator]();
      for(;;){
        check();const frame=await next();check();
        if(frame.done){stop("done");return;}
        const bytes=Buffer.byteLength(JSON.stringify({type:"frame",frame:frame.value}))+1;
        total+=bytes;if(bytes>2_097_152||total>32*1024*1024||++count>100_000)throw new ControlError("model response limit reached",413);
        yield frame.value;
      }
    }finally{if(!finished)stop("interrupted");}
  };
  const source=produce();
  return {
    [Symbol.asyncIterator](){return this;},
    next:()=>source.next(),
    async return(){stop("interrupted");void source.return(undefined).catch(()=>{});return {done:true,value:undefined};},
    async throw(error){stop("interrupted");void source.return(undefined).catch(()=>{});throw error;},
  };
}

/** NDJSON framing is opaque; only the selected runtime interprets payloads. */
export function streamInference(service:ControlService,req:Request,worker:WorkerRecord,input:unknown):Response{
  const iterator=admittedInferenceFrames(service,worker,input,req.signal),encoder=new TextEncoder();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        const next=await iterator.next();
        if(next.done){controller.enqueue(encoder.encode('{"type":"done"}\n'));controller.close();return;}
        const chunk=encoder.encode(JSON.stringify({type:"frame",frame:next.value})+"\n");
        controller.enqueue(chunk);
      }catch{
        void iterator.return?.().catch(()=>{});
        if(!cancelled){controller.enqueue(encoder.encode('{"type":"error","error":"Controller model stream interrupted; reconcile before resuming"}\n'));controller.close();}
      }
    },
    async cancel(){cancelled=true;await iterator.return?.();},
  });
  return new Response(stream,{headers:{"content-type":"application/x-ndjson","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
