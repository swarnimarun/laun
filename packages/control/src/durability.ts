import type { RuntimeDurabilityEnvelope, RuntimeDurabilityPage, RuntimeDurabilityRecord, WorkerRecord } from "@laun/protocol";
import { ControlError, ControlStore, canonical, hash, now, record, text } from "./store.js";

export interface StoredDurabilityRecord {thread_id:string;sequence:number;request_id:string;fingerprint:string;adapter:string;version:number;body:string;created_at:string}
const MAX_BATCH=2*1024*1024,MAX_SNAPSHOT=48*1024*1024,MAX_THREAD=128*1024*1024;
const totals=new WeakMap<ControlStore,Map<string,number>>();
function canonicalEnvelope(value:unknown):{envelope:RuntimeDurabilityEnvelope;body:string;bytes:number}{
 const e=record(value);if(Object.keys(e).some(k=>!["adapter","version","payload"].includes(k))||typeof e.adapter!=="string"||!/^[-a-zA-Z0-9._@]{1,80}$/.test(e.adapter)||e.version!==1)throw new ControlError("invalid durable adapter envelope");
 const payload=record(e.payload);if(!["snapshot","commits"].includes(String(payload.kind)))throw new ControlError("unsupported durable record kind");
 let body:string;try{body=canonical(e);}catch{throw new ControlError("invalid durable JSON structure");}
 const bytes=Buffer.byteLength(body);if(bytes>(payload.kind==="snapshot"?MAX_SNAPSHOT:MAX_BATCH))throw new ControlError("durable record exceeds its size limit",413);
 return {envelope:e as unknown as RuntimeDurabilityEnvelope,body,bytes};
}
export function validateStoredDurabilityRecord(row:StoredDurabilityRecord):RuntimeDurabilityRecord{
 if(!Number.isSafeInteger(row.sequence)||row.sequence<1||typeof row.request_id!=="string"||!/^[0-9a-f]{64}$/.test(row.request_id)||typeof row.body!=="string"||!Number.isFinite(Date.parse(row.created_at)))throw new ControlError("invalid stored durable record");
 const {envelope,body}=canonicalEnvelope(JSON.parse(row.body));
 if(row.body!==body||row.adapter!==envelope.adapter||row.version!==envelope.version||row.fingerprint!==hash(body)||row.request_id!==hash(canonical({expectedSequence:row.sequence-1,envelope})))throw new ControlError("durable record identity mismatch");
 if((row.sequence===1)!==(record(envelope.payload).kind==="snapshot"))throw new ControlError("durable journal must begin with one snapshot");
 return {sequence:row.sequence,requestId:row.request_id,envelope};
}
function fenced(store:ControlStore,worker:WorkerRecord,input:Record<string,unknown>){
 const run=store.fence(text(input.runId,"runId",100),worker.id,Number(input.generation));
 store.assertThreadAuthority(store.get("thread",run.threadId));
 if(run.cancelRequested||store.get<WorkerRecord>("worker",worker.id).status==="revoked")throw new ControlError("durable writer is cancelled or revoked",409);
 return run;
}
export function loadDurableRecords(store:ControlStore,worker:WorkerRecord,input:unknown):RuntimeDurabilityPage{
 const b=record(input),run=fenced(store,worker,b),after=Number(b.afterSequence);
 if(!Number.isSafeInteger(after)||after<0)throw new ControlError("invalid durable cursor");
 const head=(store.db.query("SELECT MAX(sequence) n FROM durable_commits WHERE thread_id=?").get(run.threadId) as {n:number|null}).n??0;
 if(after>head)throw new ControlError("durable cursor is ahead of the server",409);
 const records:RuntimeDurabilityRecord[]=[];let bytes=0;
 for(const row of store.db.query("SELECT * FROM durable_commits WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT 100").iterate(run.threadId,after) as Iterable<StoredDurabilityRecord>){
  const size=Buffer.byteLength(row.body);if(records.length&&bytes+size>4*1024*1024)break;
  records.push(validateStoredDurabilityRecord(row));bytes+=size;
 }
 const next=records.at(-1)?.sequence??after;
 return {records,headSequence:head,nextSequence:next,hasMore:next<head};
}
export function appendDurableRecord(store:ControlStore,worker:WorkerRecord,input:unknown):{sequence:number}{
 const b=record(input),expected=Number(b.expectedSequence),requestId=text(b.requestId,"requestId",128);
 if(!Number.isSafeInteger(expected)||expected<0)throw new ControlError("invalid durable head");
 const {envelope,body,bytes}=canonicalEnvelope(b.envelope),fingerprint=hash(body);
 if(requestId!==hash(canonical({expectedSequence:expected,envelope})))throw new ControlError("durable request fingerprint mismatch");
 let cache=totals.get(store);if(!cache){cache=new Map();totals.set(store,cache);}
 const result=store.transaction(()=>{
  const run=fenced(store,worker,b);
  const prior=store.db.query("SELECT * FROM durable_commits WHERE thread_id=? AND request_id=?").get(run.threadId,requestId) as StoredDurabilityRecord|null;
  if(prior){if(prior.fingerprint!==fingerprint||prior.sequence!==expected+1)throw new ControlError("durable receipt conflict",409);validateStoredDurabilityRecord(prior);return {sequence:prior.sequence,threadId:run.threadId,total:undefined};}
  const previous=store.db.query("SELECT sequence,adapter,version FROM durable_commits WHERE thread_id=? ORDER BY sequence DESC LIMIT 1").get(run.threadId) as {sequence:number;adapter:string;version:number}|null;
  const head=previous?.sequence??0;if(head!==expected)throw new ControlError("durable writer head changed",409);
  if(previous&&(previous.adapter!==envelope.adapter||previous.version!==envelope.version))throw new ControlError("durable adapter cannot change within a thread",409);
  if((head===0)!==(record(envelope.payload).kind==="snapshot"))throw new ControlError("durable journal requires one initial snapshot",409);
  const used=cache!.get(run.threadId)??Number((store.db.query("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) n FROM durable_commits WHERE thread_id=?").get(run.threadId) as {n:number}).n);
  if(used+bytes>MAX_THREAD)throw new ControlError("thread durable journal quota reached; preserve its history before starting a new thread",507);
  const sequence=head+1;store.db.query("INSERT INTO durable_commits VALUES(?,?,?,?,?,?,?,?)").run(run.threadId,sequence,requestId,fingerprint,envelope.adapter,envelope.version,body,now());
  return {sequence,threadId:run.threadId,total:used+bytes};
 });
 if(result.total!==undefined)cache.set(result.threadId,result.total);
 return {sequence:result.sequence};
}
