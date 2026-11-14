import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MowerRecord, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { ControlStore } from "./store.js";
import { Database } from "bun:sqlite";
const alice={id:"alice",admin:false},bob={id:"bob",admin:false},admin={id:"service",admin:true};
const stores:ControlStore[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(){const dir=mkdtempSync(join(tmpdir(),"laun-control-"));dirs.push(dir);const path=join(dir,"control.sqlite");const store=new ControlStore(path);stores.push(store);return {store,path};}
function fixture(store:ControlStore){const mower=store.createMower(alice,{name:"Fern"});const thread=store.createThread(alice,{mowerId:mower.id,title:"My task"});return {mower,thread};}
const local:WorkerRecord={id:"local",ownerId:"service",name:"Local",capacity:2,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};

test("older control binary rejects future storage before changing its schema or journal mode",()=>{
 const dir=mkdtempSync(join(tmpdir(),"laun-future-schema-"));dirs.push(dir);const path=join(dir,"control.sqlite");
 let future=new Database(path);future.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schema','999'); CREATE TABLE future_data(id TEXT PRIMARY KEY); INSERT INTO future_data VALUES('preserved')");future.close();
 expect(()=>new ControlStore(path)).toThrow("unsupported control database schema");future=new Database(path,{readonly:true});
 try{expect(future.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:"future_data"},{name:"metadata"}]);expect(future.query("PRAGMA journal_mode").get()).toEqual({journal_mode:"delete"});expect(future.query("SELECT * FROM future_data").get()).toEqual({id:"preserved"});}finally{future.close();}
});

test("bounded newest/older history and replay cursors do not skip large durable events",()=>{
 const {store}=setup(),{thread}=fixture(store);const ids:number[]=[];
 for(let i=0;i<8;i++)ids.push(store.event(thread.id,"system",{text:`${i}:${"x".repeat(900_000)}`}).sequence);
 const latest=store.history(alice,thread.id);expect(latest.events.length).toBeLessThan(8);expect(latest.events.at(-1)?.sequence).toBe(ids.at(-1));expect(latest.hasEarlier).toBe(true);
 const previous=store.history(alice,thread.id,latest.previousCursor);expect([...previous.events,...latest.events].map(e=>e.sequence)).toEqual(ids);expect(previous.hasEarlier).toBe(false);
 let cursor=0;const seen:number[]=[];for(;;){const page=store.events(alice,thread.id,cursor);if(!page.events.length)break;seen.push(...page.events.map(e=>e.sequence));cursor=page.nextCursor;}expect(seen).toEqual(ids);
 expect(()=>store.history(bob,thread.id)).toThrow("not found");expect(()=>store.history(alice,thread.id,-1)).toThrow("cursor");
});

test("mower purpose is snapshotted with admitted work and unsupported steering is explicit",()=>{
 const {store}=setup();const mower=store.createMower(alice,{name:"Documentation mower",instructions:"Maintain the project runbooks."}),thread=store.createThread(alice,{mowerId:mower.id});
 const first=store.submit(alice,thread.id,{text:"first",requestId:"instructions-one"});mower.instructions="Review release evidence.";store.put("mower",mower);
 const second=store.submit(alice,thread.id,{text:"second",requestId:"instructions-two"});expect(store.run(first.id).instructions).toBe("Maintain the project runbooks.");expect(second.instructions).toBe("Review release evidence.");
 expect(()=>store.submit(alice,thread.id,{text:"steer",requestId:"unsupported",mode:"steer"})).toThrow("steering must be explicitly supported");expect(store.threadRuns(alice,thread.id)).toHaveLength(2);
});

test("a queue from before model snapshots remains stopped instead of using a changed mower default",()=>{
 const {store,path}=setup(),{thread}=fixture(store),run=store.submit(alice,thread.id,{text:"Old queued input",requestId:"old-model"});store.close();stores.splice(stores.indexOf(store),1);
 const previous=new Database(path);previous.exec("ALTER TABLE runs DROP COLUMN instructions; ALTER TABLE runs DROP COLUMN model");previous.close();
 const migrated=new ControlStore(path);stores.push(migrated);expect(migrated.run(run.id).status).toBe("interrupted");expect(migrated.run(run.id).model).toBeUndefined();expect(migrated.run(run.id).cancelRequested).toBe(true);expect(migrated.claim(local)).toBeNull();
});

describe("transactional control registry",()=>{
  test("names, profiles and FIFO submissions survive reopen with ownership enforced",()=>{
    const {store,path}=setup();const {mower,thread}=fixture(store);
    const first=store.submit(alice,thread.id,{text:"first",requestId:"one"});const second=store.submit(alice,thread.id,{text:"second",requestId:"two"});
    expect(store.submit(alice,thread.id,{text:"first",requestId:"one"}).id).toBe(first.id);
    expect(()=>store.submit(alice,thread.id,{text:"different",requestId:"one"})).toThrow("different input");
    expect(()=>store.get("thread",thread.id,bob)).toThrow("not found");expect(store.list("thread",bob)).toEqual([]);
    const reloaded=new ControlStore(path);stores.push(reloaded);
    expect(reloaded.get<MowerRecord>("mower",mower.id,alice).name).toBe("Fern");
    const job=reloaded.claim(local)!;expect(job.run.id).toBe(first.id);expect(reloaded.claim(local)).toBeNull();
    reloaded.finish(first.id,"local",job.run.generation,"done","first complete");
    expect(reloaded.claim(local)?.run.id).toBe(second.id);
    expect(reloaded.events(alice,thread.id,0).events.filter(e=>e.kind==="message")).toHaveLength(2);
  });
  test("profile revisions are immutable and threads retain their snapshots",()=>{
    const {store}=setup();const {mower,thread}=fixture(store);const first=store.profile(mower.profileId,1,alice);
    const next=store.createProfile(alice,{mode:"auto",rules:[]},first);
    expect(next.id).toBe(first.id);expect(next.version).toBe(2);expect(store.profile(first.id,1).mode).toBe("manual");
    expect(store.get<ThreadRecord>("thread",thread.id).profileVersion).toBe(1);
    expect(()=>store.profile(first.id,1,bob)).toThrow("not found");
  });
  test("lease generations fence old effects and expired leases require reconciliation",()=>{
    const {store}=setup();const {thread}=fixture(store);store.put("worker",local);
    const run=store.submit(alice,thread.id,{text:"work",requestId:"one"});const job=store.claim(local)!;
    expect(()=>store.fence(run.id,"other",job.run.generation)).toThrow("stale");
    store.db.query("UPDATE runs SET lease_until='2000-01-01T00:00:00Z' WHERE id=?").run(run.id);
    expect(store.interruptExpired()).toBe(1);expect(store.run(run.id).status).toBe("interrupted");
    expect(store.claim(local)).toBeNull();expect(()=>store.finish(run.id,"local",job.run.generation,"done")).toThrow("stale");
  });
  test("enrollment keys are hashed, scoped and revocable",()=>{
    const {store}=setup();const {worker,key}=store.registerWorker(alice,{name:"Workshop",capacity:2});
    expect(store.authenticateWorker(key)?.id).toBe(worker.id);expect(store.authenticateWorker(key+"wrong")).toBeNull();
    expect(JSON.stringify(store.list("worker",alice))).not.toContain(key);
    const row=store.db.query("SELECT hash FROM worker_auth WHERE id=?").get(worker.id) as {hash:string};expect(row.hash).not.toBe(key);
    worker.status="revoked";store.put("worker",worker);expect(store.authenticateWorker(key)).toBeNull();
  });
  test("children cannot inherit a broader target profile",()=>{
    const {store}=setup();const {thread}=fixture(store);
    const broad=store.createProfile(alice,{name:"Broad",mode:"auto",rules:[{operation:"network.connect",resource:"https://example.com",effect:"allow"}]});
    const mower=store.createMower(alice,{name:"Broad mower",profileId:broad.id,profileVersion:broad.version});
    expect(()=>store.createThread(alice,{mowerId:mower.id,title:"child",parentThreadId:thread.id})).toThrow("exceeds");
  });
});

test("permission adviser has one bounded reserved slot beside a parked capacity-one run",()=>{
 const {store}=setup();const {thread}=fixture(store);const normal={...local,capacity:1};
 store.submit(alice,thread.id,{text:"ordinary",requestId:"ordinary"});const first=store.claim(normal)!;store.setRunStatus(first.run.id,"waiting_permission");
 const profile=store.createProfile(alice,{name:"Adviser",mode:"isolated",rules:[]});const adviser=store.createMower(alice,{name:"Gatekeeper",role:"adviser",profileId:profile.id,profileVersion:1});
 const a=store.createThread(alice,{mowerId:adviser.id,title:"Advice"}),b=store.createThread(alice,{mowerId:adviser.id,title:"Other advice"});
 store.submit(alice,a.id,{text:"Help with permission",requestId:"advice"});store.submit(alice,b.id,{text:"Other",requestId:"other"});
 expect(store.claim(normal)).toBeNull(); // A display role alone never reserves capacity.
 store.db.exec("CREATE TABLE permission_advisers(owner_id TEXT PRIMARY KEY,mower_id TEXT NOT NULL,thread_id TEXT NOT NULL,profile_id TEXT NOT NULL,profile_version INTEGER NOT NULL)");
 store.db.query("INSERT INTO permission_advisers VALUES(?,?,?,?,?)").run(alice.id,adviser.id,a.id,profile.id,profile.version);
 expect(store.claim(normal)?.thread.id).toBe(a.id);expect(store.claim(normal)).toBeNull();
});
