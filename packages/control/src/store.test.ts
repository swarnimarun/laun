import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MowerRecord, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { ControlStore } from "./store.js";
const alice={id:"alice",admin:false},bob={id:"bob",admin:false},admin={id:"service",admin:true};
const stores:ControlStore[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(){const dir=mkdtempSync(join(tmpdir(),"laun-control-"));dirs.push(dir);const path=join(dir,"control.sqlite");const store=new ControlStore(path);stores.push(store);return {store,path};}
function fixture(store:ControlStore){const mower=store.createMower(alice,{name:"Fern"});const thread=store.createThread(alice,{mowerId:mower.id,title:"My task"});return {mower,thread};}
const local:WorkerRecord={id:"local",ownerId:"service",name:"Local",capacity:2,labels:[],status:"online",createdAt:new Date().toISOString(),local:true};

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
