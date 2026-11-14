import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { canDelegateProfile, isPermissionProfile } from "@laun/policy";
import { checkpointReference } from "@laun/storage";
import type { BrokerConnection, ControlApproval, ControlPrincipal, ControlRun, ControlRunStatus,
  MowerRecord, StoredProfile, TaskRecord, ThreadEvent, ThreadRecord, WorkerJob, WorkerRecord } from "@laun/protocol";

export class ControlError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
export function text(value: unknown, label: string, max = 8000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ControlError(`${label} must be a nonempty string of at most ${max} chars`);
  return value.trim();
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlError("expected an object");
  return value as Record<string, unknown>;
}

type ObjectKind = "mower" | "thread" | "profile" | "worker" | "connection" | "task";
interface Owned { id: string; ownerId: string }
interface RunRow { id: string; owner_id: string; thread_id: string; request_id: string; prompt: string; status: ControlRunStatus;
  worker_id: string | null; generation: number; lease_until: string | null; created_at: string; updated_at: string;
  cancel_requested: number; summary: string | null; model:string|null;instructions:string|null }
interface EventRow {sequence:number;thread_id:string;run_id:string|null;created_at:string;kind:ThreadEvent["kind"];payload:string}
const eventFrom=(r:EventRow):ThreadEvent=>({sequence:r.sequence,threadId:r.thread_id,runId:r.run_id??undefined,createdAt:r.created_at,kind:r.kind,payload:JSON.parse(r.payload)});
function eventRows(rows:Iterable<EventRow>):EventRow[]{const kept:EventRow[]=[];let bytes=0;for(const row of rows){const size=Buffer.byteLength(row.payload)+512;if(kept.length&&bytes+size>4*1024*1024)break;kept.push(row);bytes+=size;}return kept;}
const runFrom = (r: RunRow): ControlRun => ({ id:r.id, ownerId:r.owner_id, threadId:r.thread_id, requestId:r.request_id, prompt:r.prompt,
  status:r.status, workerId:r.worker_id ?? undefined, generation:r.generation, leaseUntil:r.lease_until ?? undefined,
  createdAt:r.created_at, updatedAt:r.updated_at, cancelRequested:!!r.cancel_requested, summary:r.summary ?? undefined,model:r.model??undefined,instructions:r.instructions??undefined });

/** Transactional control metadata. Pi's own conversation files remain separate. */
export class ControlStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive:true, mode:0o700 });
      try{const fd=openSync(path,"ax",0o600);closeSync(fd);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
      chmodSync(path,0o600);
    }
    this.db = new Database(path, { create:true, strict:true });
    // Reject a future schema before CREATE/ALTER or journal changes. An old
    // binary must not partially initialize a database it cannot understand.
    try{
      if(this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()){
        const schema=this.db.query("SELECT value FROM metadata WHERE key='schema'").get() as {value:string}|null;
        if(schema&&schema.value!=="1")throw new Error("unsupported control database schema");
      }
    }catch(error){this.db.close();throw error;}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS worker_auth(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,request_id TEXT NOT NULL,
        prompt TEXT NOT NULL,status TEXT NOT NULL,worker_id TEXT,generation INTEGER NOT NULL DEFAULT 0,lease_until TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,summary TEXT,
        UNIQUE(thread_id,request_id));
      CREATE INDEX IF NOT EXISTS run_queue ON runs(status,created_at);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL,run_id TEXT,
        created_at TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS thread_events ON events(thread_id,sequence);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(run_id,fingerprint));
      CREATE TABLE IF NOT EXISTS receipts(owner_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner_id,key));
      CREATE TABLE IF NOT EXISTS worker_sequences(run_id TEXT NOT NULL,generation INTEGER NOT NULL,next_sequence INTEGER NOT NULL,PRIMARY KEY(run_id,generation));
      CREATE TABLE IF NOT EXISTS inference_calls(run_id TEXT NOT NULL,generation INTEGER NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,generation,request_id));
      CREATE TABLE IF NOT EXISTS routing(key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(thread_id TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,destination TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');`);
    const schema = this.db.query("SELECT value FROM metadata WHERE key='schema'").get() as {value:string}|null;
    if (schema && schema.value !== "1") throw new Error("unsupported control database schema");
    this.db.query("INSERT OR IGNORE INTO metadata VALUES('schema','1')").run();
    const columns=this.db.query("PRAGMA table_info(runs)").all() as {name:string}[];
    if(!columns.some(c=>c.name==="model"))this.db.exec("ALTER TABLE runs ADD COLUMN model TEXT");
    if(!columns.some(c=>c.name==="instructions"))this.db.exec("ALTER TABLE runs ADD COLUMN instructions TEXT");
    this.db.exec("UPDATE runs SET model=(SELECT json_extract(m.body,'$.model') FROM objects t JOIN objects m ON m.kind='mower' AND m.id=json_extract(t.body,'$.mowerId') WHERE t.kind='thread' AND t.id=runs.thread_id) WHERE model IS NULL");
    if(path!==":memory:")for(const file of [path,`${path}-wal`,`${path}-shm`])if(existsSync(file))chmodSync(file,0o600);
  }
  close() { this.db.close(); }
  transaction<T>(f:()=>T):T { return this.db.transaction(f).immediate(); }
  put<T extends Owned>(kind:ObjectKind, value:T) {
    this.db.query("INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,owner_id=excluded.owner_id").run(kind,value.id,value.ownerId,JSON.stringify(value));
  }
  get<T extends Owned>(kind:ObjectKind, objectId:string, principal?:ControlPrincipal):T {
    const row = this.db.query("SELECT body FROM objects WHERE kind=? AND id=?").get(kind,objectId) as {body:string}|null;
    if (!row) throw new ControlError(`${kind} not found`,404);
    const value = JSON.parse(row.body) as T;
    if (principal && !principal.admin && value.ownerId !== principal.id) throw new ControlError(`${kind} not found`,404);
    return value;
  }
  list<T extends Owned>(kind:ObjectKind, principal:ControlPrincipal):T[] {
    const rows = (principal.admin ? this.db.query("SELECT body FROM objects WHERE kind=?").all(kind) :
      this.db.query("SELECT body FROM objects WHERE kind=? AND owner_id=?").all(kind,principal.id)) as {body:string}[];
    return rows.map((r)=>JSON.parse(r.body));
  }
  profile(profileId:string, version:number, p?:ControlPrincipal):StoredProfile { return this.get("profile",`${profileId}:${version}`,p); }
  createProfile(p:ControlPrincipal,input:unknown, previous?:StoredProfile):StoredProfile {
    const b=record(input); const profileId=previous?.id.split(":")[0] ?? id();
    const value:StoredProfile={id:profileId,version:previous ? previous.version+1 : 1,mode:b.mode as StoredProfile["mode"],rules:b.rules as StoredProfile["rules"],
      name:previous?.name ?? text(b.name,"name",80),ownerId:previous?.ownerId ?? p.id,createdAt:now()};
    if (!isPermissionProfile(value)) throw new ControlError("invalid permission profile");
    // Store keys include the version, while wire IDs remain the stable profile ID.
    this.transaction(()=>{
      const key=`${profileId}:${value.version}`;
      const exists=this.db.query("SELECT id FROM objects WHERE kind='profile' AND id=?").get(key);
      if(exists) throw new ControlError("profile revision conflict",409);
      this.db.query("INSERT INTO objects VALUES('profile',?,?,?)").run(key,value.ownerId,JSON.stringify(value));
    });
    return value;
  }
  latestProfile(profileId:string,p:ControlPrincipal):StoredProfile {
    const all=this.list<StoredProfile>("profile",p).filter((v)=>v.id===profileId).sort((a,b)=>b.version-a.version);
    if(!all[0]) throw new ControlError("profile not found",404); return all[0];
  }
  assertThreadAuthority(thread:ThreadRecord){
    let current:ThreadRecord|undefined=thread;const seen=new Set<string>();
    while(current){if(seen.has(current.id)||seen.size>8)throw new ControlError("invalid ancestry",403);seen.add(current.id);
      if(current.archivedAt||this.get<MowerRecord>("mower",current.mowerId).archivedAt)throw new ControlError("thread or mower archived",409);
      if(this.profile(current.profileId,current.profileVersion).revokedAt)throw new ControlError("profile revoked",403);
      current=current.parentThreadId?this.get<ThreadRecord>("thread",current.parentThreadId):undefined;
    }
  }
  createMower(p:ControlPrincipal,input:unknown):MowerRecord {
    const b=record(input); const name=text(b.name,"name",80);
    if(b.instructions!==undefined&&b.instructions!==null&&typeof b.instructions!=="string")throw new ControlError("instructions must be text");
    const instructions=typeof b.instructions==="string"&&b.instructions.trim()?text(b.instructions,"instructions",16000):undefined;
    const role=b.role ?? "mower"; if(!["mower","director","adviser"].includes(role as string)) throw new ControlError("invalid role");
    return this.transaction(()=>{
      if(this.list<MowerRecord>("mower",p).some((m)=>!m.archivedAt && m.name.toLowerCase()===name.toLowerCase())) throw new ControlError("mower name already exists",409);
      const profile=b.profileId ? this.profile(text(b.profileId,"profileId",100),Number(b.profileVersion),p) : this.createProfile(p,{name:`${name} permissions`,mode:"manual",rules:[
        {operation:"workspace.read",resource:"workspace:own",effect:"allow"},{operation:"workspace.write",resource:"workspace:own",effect:"allow"},
        {operation:"process.execute",resource:"workspace:own",effect:"ask"},
        ...(role==="director" ? [{operation:"mower.spawn",resource:"mowers:own",effect:"ask"},{operation:"task.handoff",resource:"tasks:own",effect:"ask"},{operation:"connector.send",resource:"threads:own",effect:"ask"}] : [])]});
      if(profile.revokedAt) throw new ControlError("profile revoked",409);
      if(b.workerId){const worker=this.get<WorkerRecord>("worker",text(b.workerId,"workerId",100));if(!worker.local&&worker.ownerId!==p.id)throw new ControlError("worker not found",404);if(worker.status==="revoked")throw new ControlError("worker revoked",409);}
      const mower:MowerRecord={id:id(),ownerId:p.id,workspaceId:"default",name,role:role as MowerRecord["role"],model:text(b.model ?? "opencode-go/muse-spark-1.3-contributor","model",256),
        profileId:profile.id,profileVersion:profile.version,workerId:b.workerId ? String(b.workerId):undefined,createdAt:now(),instructions};
      this.put("mower",mower);return mower;
    });
  }
  createThread(p:ControlPrincipal,input:unknown):ThreadRecord {
    const b=record(input);const mower=this.get<MowerRecord>("mower",text(b.mowerId,"mowerId",100),p);
    if(mower.archivedAt) throw new ControlError("mower archived",409);
    if(this.profile(mower.profileId,mower.profileVersion,p).revokedAt)throw new ControlError("profile revoked",403);
    return this.transaction(()=>{
      if(b.parentThreadId){
        const parent=this.get<ThreadRecord>("thread",text(b.parentThreadId,"parentThreadId",100),p);
        this.assertThreadAuthority(parent);
        if(parent.ownerId!==mower.ownerId)throw new ControlError("child and parent must have the same owner",403);
        const ceiling=this.profile(parent.profileId,parent.profileVersion,p);const child=this.profile(mower.profileId,mower.profileVersion,p);
        if(!canDelegateProfile(ceiling,child)) throw new ControlError("child profile exceeds parent authority",403);
        let current:ThreadRecord|undefined=parent;let depth=0;
        while(current){if(++depth>=8) throw new ControlError("maximum delegation depth reached",409);current=current.parentThreadId?this.get<ThreadRecord>("thread",current.parentThreadId,p):undefined;}
        if(this.list<ThreadRecord>("thread",p).filter(t=>t.parentThreadId===parent.id).length>=16) throw new ControlError("maximum child count reached",409);
      }
      const thread:ThreadRecord={id:id(),ownerId:mower.ownerId,workspaceId:mower.workspaceId,mowerId:mower.id,title:text(b.title ?? "New thread","title",160),
        profileId:mower.profileId,profileVersion:mower.profileVersion,workerId:mower.workerId,parentThreadId:b.parentThreadId ? String(b.parentThreadId):undefined,createdAt:now(),updatedAt:now()};
      this.put("thread",thread);return thread;
    });
  }
  event(threadId:string,kind:ThreadEvent["kind"],payload:ThreadEvent["payload"],runId?:string):ThreadEvent {
    const at=now();const result=this.db.query("INSERT INTO events(thread_id,run_id,created_at,kind,payload) VALUES(?,?,?,?,?)").run(threadId,runId??null,at,kind,JSON.stringify(payload));
    return {sequence:Number(result.lastInsertRowid),threadId,runId,createdAt:at,kind,payload};
  }
  events(p:ControlPrincipal,threadId:string,after=0):{events:ThreadEvent[];nextCursor:number} {
    this.get<ThreadRecord>("thread",threadId,p);
    const rows=eventRows(this.db.query("SELECT * FROM events WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT 500").iterate(threadId,after) as Iterable<EventRow>);
    return {events:rows.map(eventFrom),nextCursor:rows.at(-1)?.sequence??after};
  }
  history(p:ControlPrincipal,threadId:string,before?:number):import("@laun/protocol").ThreadEventPage{
    this.get<ThreadRecord>("thread",threadId,p);
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new ControlError("invalid history cursor");
    const rows=eventRows((before===undefined?this.db.query("SELECT * FROM events WHERE thread_id=? ORDER BY sequence DESC LIMIT 500").iterate(threadId):this.db.query("SELECT * FROM events WHERE thread_id=? AND sequence<? ORDER BY sequence DESC LIMIT 500").iterate(threadId,before)) as Iterable<EventRow>);
    const oldest=rows.at(-1)?.sequence;
    if(oldest===undefined)return {events:[],nextCursor:0,hasEarlier:false};
    const newest=rows[0]!.sequence;const page={events:rows.reverse().map(eventFrom),nextCursor:newest};
    return {...page,previousCursor:oldest,hasEarlier:!!this.db.query("SELECT 1 FROM events WHERE thread_id=? AND sequence<? LIMIT 1").get(threadId,oldest)};
  }
  submit(p:ControlPrincipal,threadId:string,input:unknown,source:"user"|"task"="user"):ControlRun {
    const b=record(input);const prompt=text(b.text,"text",32_000);const requestId=text(b.requestId,"requestId",128);
    if(b.mode!==undefined&&b.mode!=="queue")throw new ControlError("this runtime accepts queued input; steering must be explicitly supported before it can interrupt a run",409);
    return this.transaction(()=>{
      const thread=this.get<ThreadRecord>("thread",threadId,p); if(thread.archivedAt)throw new ControlError("thread archived",409);
      const existing=this.db.query("SELECT * FROM runs WHERE thread_id=? AND request_id=?").get(threadId,requestId) as RunRow|null;
      if(existing){if(existing.prompt!==prompt)throw new ControlError("requestId was used for different input",409);return runFrom(existing);}
      this.assertThreadAuthority(thread);
      if(source==="task"&&thread.stoppedAt)throw new ControlError("thread stopped; awaiting direct user input",409);
      if(source==="user")delete thread.stoppedAt;
      const queued=this.db.query("SELECT COUNT(*) n FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_permission')").get(threadId) as {n:number};
      if(queued.n>=32)throw new ControlError("thread queue is full",429);
      const runId=id(),at=now();
      const mower=this.get<MowerRecord>("mower",thread.mowerId);
      this.db.query("INSERT INTO runs(id,owner_id,thread_id,request_id,prompt,status,created_at,updated_at,model,instructions) VALUES(?,?,?,?,?,'queued',?,?,?,?)").run(runId,thread.ownerId,threadId,requestId,prompt,at,at,mower.model,mower.instructions??null);
      this.event(threadId,source==="user"?"message":"system",source==="user"?{role:"user",text:prompt}:{text:prompt,source:"task"},runId);
      thread.updatedAt=at;this.put("thread",thread);
      return this.run(runId);
    });
  }
  run(runId:string,p?:ControlPrincipal):ControlRun {
    const row=this.db.query("SELECT * FROM runs WHERE id=?").get(runId) as RunRow|null;
    if(!row || (p&&!p.admin&&row.owner_id!==p.id))throw new ControlError("run not found",404); return runFrom(row);
  }
  runs(p:ControlPrincipal):ControlRun[]{
    const rows=(p.admin?this.db.query("SELECT * FROM runs WHERE status IN ('queued','running','waiting_permission','interrupted') OR rowid IN(SELECT rowid FROM runs ORDER BY created_at DESC,rowid DESC LIMIT 1000) ORDER BY created_at DESC,rowid DESC").all():
      this.db.query("SELECT * FROM runs WHERE owner_id=? AND (status IN ('queued','running','waiting_permission','interrupted') OR rowid IN(SELECT rowid FROM runs WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1000)) ORDER BY created_at DESC,rowid DESC").all(p.id,p.id)) as RunRow[];
    return rows.map(runFrom);
  }
  threadRuns(p:ControlPrincipal,threadId:string):ControlRun[]{this.get("thread",threadId,p);return (this.db.query("SELECT * FROM runs WHERE thread_id=? AND (status IN ('queued','running','waiting_permission','interrupted') OR rowid IN(SELECT rowid FROM runs WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1000)) ORDER BY created_at DESC,rowid DESC").all(threadId,threadId) as RunRow[]).map(runFrom);}
  claim(worker:WorkerRecord,leaseMs=30_000,fleetCapacity?:number):WorkerJob|null {
    return this.transaction(()=>{
      const active=this.db.query("SELECT thread_id FROM runs WHERE worker_id=? AND status IN ('running','waiting_permission')").all(worker.id) as {thread_id:string}[];
      const advisers=active.filter(r=>{const t=this.get<ThreadRecord>("thread",r.thread_id);return this.get<MowerRecord>("mower",t.mowerId).role==="adviser";}).length;
      const ordinary=active.length-advisers;
      const fleet=fleetCapacity===undefined?[]:this.db.query("SELECT thread_id FROM runs WHERE status IN ('running','waiting_permission')").all() as {thread_id:string}[];
      const fleetAdvisers=fleet.filter(r=>{const t=this.get<ThreadRecord>("thread",r.thread_id);return this.get<MowerRecord>("mower",t.mowerId).role==="adviser";}).length;
      const fleetOrdinary=fleet.length-fleetAdvisers;
      // One bounded adviser slot remains available while an ordinary run is
      // parked on permission, including yards configured with capacity one.
      if((ordinary>=worker.capacity&&advisers>=1) || worker.status==="revoked") return null;
      const candidates=this.db.query("SELECT r.* FROM runs r JOIN objects t ON t.kind='thread' AND t.id=r.thread_id JOIN objects m ON m.kind='mower' AND m.id=json_extract(t.body,'$.mowerId') WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM runs a WHERE a.thread_id=r.thread_id AND a.status IN ('running','waiting_permission','interrupted')) ORDER BY CASE WHEN json_extract(m.body,'$.role')='adviser' THEN 0 ELSE 1 END,r.created_at,r.rowid LIMIT 100").all() as RunRow[];
      for(const row of candidates){
        if(!worker.local && row.owner_id!==worker.ownerId)continue;
        const thread=this.get<ThreadRecord>("thread",row.thread_id); const mower=this.get<MowerRecord>("mower",thread.mowerId);
        if(mower.role==="adviser"?advisers>=1:ordinary>=worker.capacity)continue;
        if(fleetCapacity!==undefined&&(mower.role==="adviser"?fleetAdvisers>=1:fleetCapacity>0&&fleetOrdinary>=fleetCapacity))continue;
        try{this.assertThreadAuthority(thread);}catch(error){this.setRunStatus(row.id,"error");this.event(thread.id,"system",{status:"error",text:(error as Error).message},row.id);continue;}
        // Threads with remote history are host-pinned until explicit checkpoint restore exists.
        const previous=this.db.query("SELECT worker_id FROM runs WHERE thread_id=? AND worker_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(thread.id) as {worker_id:string}|null;
        if(thread.workerId){if(thread.workerId!==worker.id)continue;}
        else {if(previous && previous.worker_id!==worker.id)continue;
          if(!previous&&mower.workerId&&mower.workerId!==worker.id)continue;}
        // Persist the chosen binding before dispatch so clients do not need
        // bounded run history to discover the authoritative current host.
        if(!thread.workerId){thread.workerId=worker.id;this.put("thread",thread);}
        this.db.query("UPDATE runs SET status='running',worker_id=?,generation=generation+1,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(worker.id,new Date(Date.now()+leaseMs).toISOString(),now(),row.id);
        const run=this.run(row.id);this.event(thread.id,"system",{text:`Assigned to ${worker.name}`,status:"running"},run.id);
        const checkpoint=this.checkpoint(thread.id);
        return {run,thread,mower,checkpoint:checkpoint?checkpointReference(checkpoint,thread.id):undefined};
      }
      return null;
    });
  }
  fence(runId:string,workerId:string,generation:number):ControlRun {
    const run=this.run(runId);
    if(run.workerId!==workerId||run.generation!==generation||!["running","waiting_permission"].includes(run.status)||!run.leaseUntil||Date.parse(run.leaseUntil)<Date.now())throw new ControlError("stale run lease",409);
    return run;
  }
  heartbeat(workerId:string,runId?:string,generation?:number){
    return this.transaction(()=>{
      const w=this.get<WorkerRecord>("worker",workerId);if(w.status==="revoked")throw new ControlError("worker revoked",403);
      w.status="online";w.lastSeenAt=now();this.put("worker",w);
      if(runId){this.fence(runId,workerId,generation!);this.db.query("UPDATE runs SET lease_until=?,updated_at=? WHERE id=?").run(new Date(Date.now()+30_000).toISOString(),now(),runId);}
    });
  }
  finish(runId:string,workerId:string,generation:number,status:"done"|"error"|"cancelled",summary?:string){
    return this.transaction(()=>{
      const run=this.fence(runId,workerId,generation);
      const final=run.cancelRequested?"cancelled":status;
      this.db.query("UPDATE runs SET status=?,summary=?,lease_until=NULL,updated_at=? WHERE id=?").run(final,summary?.slice(0,8000)??null,now(),runId);
      this.event(run.threadId,"system",{status:final,text:summary??final},runId);
      this.expireRunApprovals(runId);
      return this.run(runId);
    });
  }
  setRunStatus(runId:string,status:ControlRunStatus){this.db.query("UPDATE runs SET status=?,updated_at=? WHERE id=?").run(status,now(),runId);}
  cancel(p:ControlPrincipal,threadId:string){
    const thread=this.get<ThreadRecord>("thread",threadId,p);
    this.transaction(()=>{
      thread.stoppedAt=now();this.put("thread",thread);
      this.db.query("UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE thread_id=? AND status IN ('queued','running','waiting_permission','interrupted')").run(now(),threadId);
      for(const run of this.runs(p).filter(r=>r.threadId===threadId&&r.cancelRequested))this.expireRunApprovals(run.id);
      this.event(threadId,"system",{text:"Cancellation requested"});
    });
  }
  interruptExpired(){
    return this.transaction(()=>{
      const rows=this.db.query("SELECT * FROM runs WHERE status IN ('running','waiting_permission') AND lease_until<?").all(now()) as RunRow[];
      for(const row of rows){this.db.query("UPDATE runs SET status='interrupted',updated_at=? WHERE id=?").run(now(),row.id);this.expireRunApprovals(row.id);this.event(row.thread_id,"system",{status:"interrupted",text:"Worker lease expired; reconcile before resuming"},row.id);}
      return rows.length;
    });
  }
  registerWorker(p:ControlPrincipal,input:unknown):{worker:WorkerRecord;key:string}{
    const b=record(input);const capacity=Number(b.capacity??1);if(!Number.isInteger(capacity)||capacity<1||capacity>16)throw new ControlError("capacity must be 1-16");
    const labels=b.labels??[];if(!Array.isArray(labels)||labels.length>16||labels.some(l=>typeof l!=="string"||l.length>64))throw new ControlError("invalid labels");
    const worker:WorkerRecord={id:id(),ownerId:p.id,name:text(b.name,"name",80),capacity,labels,status:"offline",createdAt:now(),local:false};
    const key=`yard_${worker.id}_${randomBytes(32).toString("base64url")}`;
    this.transaction(()=>{this.put("worker",worker);this.db.query("INSERT INTO worker_auth VALUES(?,?)").run(worker.id,hash(key));});return {worker,key};
  }
  authenticateWorker(key:string):WorkerRecord|null{
    const m=key.match(/^yard_([0-9a-f-]{36})_/);if(!m)return null;
    const row=this.db.query("SELECT hash FROM worker_auth WHERE id=?").get(m[1]!) as {hash:string}|null;if(!row)return null;
    if(!timingSafeEqual(Buffer.from(hash(key)),Buffer.from(row.hash)))return null;
    const w=this.get<WorkerRecord>("worker",m[1]!);return w.status==="revoked"?null:w;
  }
  approvals(p:ControlPrincipal):ControlApproval[]{
    const rows=(p.admin?this.db.query("SELECT body FROM approvals").all():this.db.query("SELECT body FROM approvals WHERE owner_id=?").all(p.id)) as {body:string}[];
    return rows.map(r=>JSON.parse(r.body));
  }
  approval(approvalId:string,p?:ControlPrincipal):ControlApproval{
    const row=this.db.query("SELECT body FROM approvals WHERE id=?").get(approvalId) as {body:string}|null;
    if(!row)throw new ControlError("approval not found",404);const a=JSON.parse(row.body) as ControlApproval;
    if(p&&!p.admin&&a.ownerId!==p.id)throw new ControlError("approval not found",404);return a;
  }
  requestApproval(value:ControlApproval,fingerprint:string):ControlApproval{
    return this.transaction(()=>{
      const existing=this.db.query("SELECT body FROM approvals WHERE run_id=? AND fingerprint=?").get(value.action.runId,fingerprint) as {body:string}|null;
      if(existing)return JSON.parse(existing.body);
      this.db.query("INSERT INTO approvals VALUES(?,?,?,?,?,?)").run(value.id,value.ownerId,value.action.runId,fingerprint,value.status,JSON.stringify(value));
      this.event(value.action.threadId,"approval",{approvalId:value.id,operation:value.action.operation,resource:value.action.resource,status:"pending"},value.action.runId);
      return value;
    });
  }
  updateApproval(a:ControlApproval){this.db.query("UPDATE approvals SET status=?,body=? WHERE id=?").run(a.status,JSON.stringify(a),a.id);}
  decide(p:ControlPrincipal,approvalId:string,decision:unknown,options:{feedback?:string;continuation?:"replan"|"stop"}={}):ControlApproval{
    if(decision!=="approve"&&decision!=="deny")throw new ControlError("decision must be approve or deny");
    if(options.feedback!==undefined)text(options.feedback,"feedback",4000);
    if(options.continuation!==undefined&&(decision!=="deny"||!["replan","stop"].includes(options.continuation)))throw new ControlError("continuation applies only to a denied request");
    return this.transaction(()=>{
      const a=this.approval(approvalId,p);if(a.status!=="pending")throw new ControlError("approval already settled",409);
      if(Date.parse(a.expiresAt)<=Date.now()){a.status="expired";this.updateApproval(a);return a;}
      const run=this.run(a.action.runId,p);if(run.cancelRequested||!["running","waiting_permission"].includes(run.status))throw new ControlError("run is no longer active",409);
      a.status=decision==="approve"?"approved":"denied";a.decidedAt=now();a.decidedBy=p.id;a.feedback=options.feedback;a.continuation=options.continuation;this.updateApproval(a);
      this.event(a.action.threadId,"approval",{approvalId:a.id,status:a.status,feedback:a.feedback,continuation:a.continuation},a.action.runId);return a;
    });
  }
  expireRunApprovals(runId:string){
    const rows=this.db.query("SELECT body FROM approvals WHERE run_id=? AND status IN ('pending','approved')").all(runId) as {body:string}[];
    for(const row of rows){const a=JSON.parse(row.body) as ControlApproval;a.status="expired";this.updateApproval(a);}
  }
  receipt<T>(p:ControlPrincipal,key:string,fingerprint:string,create:()=>T):T{
    return this.transaction(()=>{const row=this.db.query("SELECT fingerprint,body FROM receipts WHERE owner_id=? AND key=?").get(p.id,key) as {fingerprint:string;body:string}|null;
      if(row){if(row.fingerprint!==fingerprint)throw new ControlError("idempotency key conflict",409);return JSON.parse(row.body);}
      const value=create();this.db.query("INSERT INTO receipts VALUES(?,?,?,?)").run(p.id,key,fingerprint,JSON.stringify(value));return value;});
  }
  saveConnection(value:BrokerConnection){this.put("connection",value);}
  checkpoint(threadId:string):string|undefined{return (this.db.query("SELECT body FROM checkpoints WHERE thread_id=?").get(threadId) as {body:string}|null)?.body;}
}
