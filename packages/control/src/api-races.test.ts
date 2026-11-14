import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./store.js";
import { ControlService } from "./service.js";
import { handleControlRequest } from "./http.js";
import type { BrokerConnection, MowerRecord } from "@laun/protocol";
const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner={id:"owner",admin:false};
function fixture(){const dir=mkdtempSync(join(tmpdir(),"laun-api-race-")),store=new ControlStore(join(dir,"control.sqlite")),service=new ControlService({store,dataDir:dir,mode:"unconfigured"});cleanup.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,service};}
function slow(path:string,method:string,key?:string){let send!:(value:unknown)=>void;const stream=new ReadableStream<Uint8Array>({start(controller){send=value=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();};}});return {request:new Request(`http://controller/api/v2${path}`,{method,body:stream,headers:{"content-type":"application/json",...(key?{authorization:`Bearer ${key}`}:{})}}),send};}
function request(path:string,method:string,body:unknown){return new Request(`http://controller/api/v2${path}`,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});}

test("a poll authenticated before revocation cannot revive its credential after a delayed body",async()=>{
 const c=fixture(),{worker,key}=c.store.registerWorker(owner,{name:"Revoked while reading"});const held=slow("/worker/poll","POST",key),response=handleControlRequest(c.service,held.request,null);await Bun.sleep(0);
 worker.status="revoked";c.store.put("worker",worker);held.send({activeRunIds:[],capacity:1,durabilityAdapter:{adapter:"fixture@1",version:1}});
 expect((await response).status).toBe(401);expect(c.store.authenticateWorker(key)).toBeNull();expect(c.store.get<any>("worker",worker.id).status).toBe("revoked");
});

test("a delayed mower rename cannot overwrite a concurrent archive or its stopped state",async()=>{
 const c=fixture(),mower=c.store.createMower(owner,{name:"Before"}),thread=c.store.createThread(owner,{mowerId:mower.id});const held=slow(`/mowers/${mower.id}`,"PATCH"),response=handleControlRequest(c.service,held.request,owner);await Bun.sleep(0);
 expect((await handleControlRequest(c.service,request(`/mowers/${mower.id}`,"PATCH",{archived:true}),owner)).status).toBe(200);held.send({name:"Renamed"});expect((await response).status).toBe(200);
 expect(c.store.get<MowerRecord>("mower",mower.id).archivedAt).toBeDefined();expect(c.store.get<any>("thread",thread.id).stoppedAt).toBeDefined();
});

test("a delayed connector rename preserves a newer disable and administrator credential binding",async()=>{
 const c=fixture(),connection:BrokerConnection={id:"connection",ownerId:owner.id,workspaceId:"default",name:"Old",transport:"http",url:"https://old.example/mcp",enabled:true};c.store.saveConnection(connection);
 const held=slow("/connections/connection","PATCH"),response=handleControlRequest(c.service,held.request,owner);await Bun.sleep(0);
 expect((await handleControlRequest(c.service,request("/connections/connection","PATCH",{url:"https://new.example/mcp",secretRef:"MCP_ADMIN_BINDING",enabled:false}),{id:"service",admin:true})).status).toBe(200);held.send({name:"New display name"});expect((await response).status).toBe(200);
 const latest=c.store.get<BrokerConnection>("connection",connection.id);expect(latest.enabled).toBe(false);expect(latest.url).toBe("https://new.example/mcp");expect(latest.secretRef).toBe("MCP_ADMIN_BINDING");expect(latest.name).toBe("New display name");
});
