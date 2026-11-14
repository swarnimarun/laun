import type { RuntimeInferenceRequest, WorkerRecord } from "@laun/protocol";
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
    const calls=service.store.db.query("SELECT COUNT(*) n,SUM(CASE WHEN status='admitted' THEN 1 ELSE 0 END) active FROM inference_calls WHERE run_id=?").get(runId) as {n:number;active:number|null};
    if(calls.n>=256)throw new ControlError("model request limit reached",429);
    if(calls.active)throw new ControlError("a prior model request has an unresolved outcome",409);
    const at=now();
    service.store.db.query("INSERT INTO inference_calls VALUES(?,?,?,?,'admitted',?,?)").run(runId,generation,requestId,fingerprint,at,at);
    return {run,request:{requestId,envelope} as unknown as RuntimeInferenceRequest};
  });
}

/** NDJSON is opaque to the gateway; only the selected runtime knows its payload. */
export function streamInference(service:ControlService,req:Request,worker:WorkerRecord,input:unknown):Response{
  if(!service.options.inference)throw new ControlError("controller inference is not configured",503);
  const {run,request}=admitInference(service,worker,input);
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,req.signal]);
  const encoder=new TextEncoder();let total=0,finished=false,cancelled=false;
  const check=()=>{
    const fresh=service.store.fence(run.id,worker.id,run.generation);
    service.store.assertThreadAuthority(service.store.get("thread",run.threadId));
    if(fresh.cancelRequested||signal.aborted)throw new ControlError("model request cancelled",409);
    const currentWorker=service.store.get<WorkerRecord>("worker",worker.id);
    if(currentWorker.status==="revoked")throw new ControlError("yard revoked",403);
  };
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
  const iterator=service.options.inference.stream(run.model!,request,signal,usage=>{
    check();
    service.store.transaction(()=>{
      const event={type:"usage" as const,sessionId:run.threadId,...usage};
      service.store.event(run.threadId,"agent",{event,source:"inference-controller"},run.id);
      service.enforceBudget(service.store.get("thread",run.threadId),run,event);
    });
  })[Symbol.asyncIterator]();
  const lease=setInterval(()=>{try{check();}catch{abort.abort();}},500);lease.unref();
  const cleanup=()=>{clearInterval(lease);abort.abort();};
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        check();const next=await iterator.next();check();
        if(next.done){settle("done");cleanup();controller.enqueue(encoder.encode('{"type":"done"}\n'));controller.close();return;}
        const chunk=encoder.encode(JSON.stringify({type:"frame",frame:next.value})+"\n");
        total+=chunk.byteLength;if(chunk.byteLength>2_097_152||total>32*1024*1024)throw new ControlError("model response limit reached",413);
        controller.enqueue(chunk);
      }catch{
        settle("interrupted");cleanup();void iterator.return?.().catch(()=>{});
        if(!cancelled){controller.enqueue(encoder.encode('{"type":"error","error":"Controller model stream interrupted; reconcile before resuming"}\n'));controller.close();}
      }
    },
    async cancel(){cancelled=true;settle("interrupted");cleanup();await iterator.return?.();},
  });
  return new Response(stream,{headers:{"content-type":"application/x-ndjson","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
