import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";

test("disabled legacy API also prevents background resume and preserves legacy state",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"laun-inert-v1-"));let executions=0;
 const executor=Bun.serve({port:0,hostname:"127.0.0.1",fetch(){executions++;return new Response("",{status:500});}});
 try{
  const sessions=new SessionStore(directory),session=sessions.create({goal:"legacy running task",model:"fixture",runtime:"pi"});sessions.setStatus(session.id,"running");
  const original=readFileSync(join(directory,"index.json"),"utf8");
  createGateway({port:8080,gatewayToken:"fixture",executorUrl:`http://127.0.0.1:${executor.port}`,dataDir:directory,publicDir:directory,autoResume:true,stallMs:0},sessions,undefined,{legacyEnabled:false});
  await Bun.sleep(30);expect(executions).toBe(0);expect(sessions.get(session.id)?.status).toBe("running");expect(readFileSync(join(directory,"index.json"),"utf8")).toBe(original);
 }finally{executor.stop(true);rmSync(directory,{recursive:true,force:true});}
});
