import { afterEach, expect, test } from "bun:test";
import type { BrokerConnection, BrokerContext, PermissionOperation } from "@laun/protocol";
import { catalogStorageIdentity, createToolBroker, pinEndpoint, toolDigest, toolResource } from "./index.js";

const servers:Array<{stop(force?:boolean):void}>=[];
afterEach(()=>{for(const server of servers.splice(0))server.stop(true);});
const context:BrokerContext={principalId:"owner",workspaceId:"workspace",mowerId:"mower",threadId:"thread",runId:"run",generation:1};
const definition={name:"effect",inputSchema:{type:"object",properties:{text:{type:"string"}}}};
function gate(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),waiting=new Promise<void>(resolve=>{release=resolve;});return {entered,release,async wait(){enter();await waiting;}};}
function fixture(legacy=false){
  const traffic:Array<{method:string;authorization:string|null}>=[],rpc:string[]=[];
  const hooks:{initialize?:()=>Promise<void>;list?:()=>Promise<void>;call?:()=>Promise<void>;save?:()=>Promise<void>}={};
  const server=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){
    traffic.push({method:request.method,authorization:request.headers.get("authorization")});
    if(request.method==="DELETE")return new Response(null,{status:204});
    const value=await request.json() as {id:string;method:string};rpc.push(value.method);
    if(value.method==="initialize"){await hooks.initialize?.();return Response.json({jsonrpc:"2.0",id:value.id,result:{protocolVersion:"2025-11-25",capabilities:{},serverInfo:{name:"fixture",version:"1"}}},{headers:{"mcp-session-id":"session"}});}
    if(value.method==="notifications/initialized")return new Response(null,{status:202});
    if(value.method==="tools/list"){await hooks.list?.();return Response.json({jsonrpc:"2.0",id:value.id,result:{tools:[definition]}});}
    if(value.method==="tools/call"){await hooks.call?.();return Response.json({jsonrpc:"2.0",id:value.id,result:{content:[{type:"text",text:"effect completed"}]}});}
    return new Response(null,{status:400});
  }});servers.push(server);
  const connection:BrokerConnection={id:"connection",ownerId:context.principalId,workspaceId:context.workspaceId,name:"Original",transport:"http",url:`http://127.0.0.1:${server.port}/mcp`,allowLocal:true,enabled:true,secretRef:"MCP_ORIGINAL",...(legacy?{protocolVersion:"2025-11-25" as const}:{})};
  const records=new Map([[connection.id,connection]]),authorizations:PermissionOperation[]=[];
  let parked:PermissionOperation|undefined,approval=gate(),dns:ReturnType<typeof gate>|undefined,secret:ReturnType<typeof gate>|undefined,active=true;
  const secretRefs:string[]=[];
  const broker=createToolBroker({allowLoopback:true,loadConnection:id=>records.get(id),saveConnection:value=>{records.set(value.id,value);},
    saveCatalog:async(expected,catalog)=>{await hooks.save?.();const latest=records.get(expected.id);if(!latest||catalogStorageIdentity(latest)!==catalogStorageIdentity(expected))throw new Error("connector changed before catalog commit");const merged={...latest,...catalog};records.set(merged.id,merged);return merged;},
    assertActive:ctx=>{if(!active||ctx.generation!==1)throw new Error("run authority revoked");},
    authorize:async(_ctx,operation)=>{authorizations.push(operation);if(operation===parked)await approval.wait();},
    resolveEndpoint:async(...args)=>{await dns?.wait();return await pinEndpoint(...args);},
    resolveSecret:async reference=>{secretRefs.push(reference);await secret?.wait();return `private-${reference}`;},
  });
  return {broker,records,traffic,rpc,hooks,connection,authorizations,secretRefs,
    park(operation:PermissionOperation){parked=operation;return approval;},holdDns(){dns=gate();return dns;},holdSecret(){secret=gate();return secret;},revoke(){active=false;}};
}
async function catalog(f:ReturnType<typeof fixture>){return (await f.broker.discover(context,f.connection.id)).tools![0]!;}

test.each(["mcp.invoke","network.connect"] as const)("disable while %s approval is parked causes no new traffic or secret lookup",async operation=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,secretBefore=f.secretRefs.length,approval=f.park(operation);
  f.authorizations.length=0;
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{text:"effect"},tool.schemaDigest);
  await approval.entered;f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,enabled:false});approval.release();
  await expect(pending).rejects.toThrow("disabled");expect(f.traffic).toHaveLength(before);expect(f.secretRefs).toHaveLength(secretBefore);
  expect(f.authorizations.filter(value=>value==="mcp.invoke")).toHaveLength(1);
});

test.each(["url","secretRef","allowLocal","protocolVersion","catalog"] as const)("changing %s while tool approval waits invalidates the selected authority",async field=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,approval=f.park("mcp.invoke");
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{text:"effect"},tool.schemaDigest);await approval.entered;
  const next={...f.records.get(f.connection.id)!};
  if(field==="url")next.url+="?changed=1";else if(field==="secretRef")next.secretRef="MCP_DIFFERENT";else if(field==="allowLocal")next.allowLocal=false;else if(field==="protocolVersion")next.protocolVersion="2025-11-25";
  else{const changed={...definition,description:"different effect"},digest=toolDigest(next,changed);next.tools=[{...tool,definition:changed,schemaDigest:digest,resource:toolResource(next.id,tool.name,digest)}];}
  f.records.set(next.id,next);approval.release();await expect(pending).rejects.toThrow(/changed|schema/);expect(f.traffic).toHaveLength(before);
});

test("a connection disabled during DNS pinning is rejected before credential acquisition or HTTP",async()=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,secrets=f.secretRefs.length,dns=f.holdDns();
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest);await dns.entered;
  f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,enabled:false});dns.release();
  await expect(pending).rejects.toThrow("disabled");expect(f.traffic).toHaveLength(before);expect(f.secretRefs).toHaveLength(secrets);
});

test("credential-reference changes during secret lookup never send the old or replacement credential",async()=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,secrets=f.secretRefs.length,secret=f.holdSecret();
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest);await secret.entered;
  f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,secretRef:"MCP_REPLACEMENT"});secret.release();
  await expect(pending).rejects.toThrow("changed");expect(f.traffic).toHaveLength(before);expect(f.secretRefs.slice(secrets)).toEqual(["MCP_ORIGINAL"]);
});

test("run authority revocation during secret lookup is a no-grant check and stops dispatch",async()=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,secret=f.holdSecret();f.authorizations.length=0;
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest);await secret.entered;f.revoke();secret.release();
  await expect(pending).rejects.toThrow("authority revoked");expect(f.traffic).toHaveLength(before);expect(f.authorizations).toEqual(["mcp.invoke","network.connect"]);
});

test("cancellation during parked approval does not wait for the authorizer or dispatch",async()=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,approval=f.park("mcp.invoke"),abort=new AbortController();
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest,abort.signal);await approval.entered;abort.abort();
  await expect(pending).rejects.toThrow(/cancel|abort/i);expect(f.traffic).toHaveLength(before);approval.release();
});

test.each(["disabled","cancelled"] as const)("%s after legacy initialize prevents notification, tool call and credential-bearing cleanup",async action=>{
  const f=fixture(true),tool=await catalog(f),before=f.traffic.length,init=gate(),abort=new AbortController();f.hooks.initialize=()=>init.wait();
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest,abort.signal);await init.entered;
  if(action==="disabled")f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,enabled:false});else abort.abort();init.release();
  await expect(pending).rejects.toThrow(/disabled|cancel|abort/i);await Bun.sleep(10);
  expect(f.traffic).toHaveLength(before+1);expect(f.rpc.filter(method=>method==="tools/call")).toHaveLength(0);
});

test("read-only discovery retains a concurrent connector rename",async()=>{
  const f=fixture(),list=gate();f.hooks.list=()=>list.wait();
  const pending=f.broker.discover(context,f.connection.id);await list.entered;f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,name:"Renamed while listing"});list.release();
  expect((await pending).name).toBe("Renamed while listing");expect(f.records.get(f.connection.id)?.name).toBe("Renamed while listing");
});

test("logical credential changes invalidate previously discovered tool digests before approval",async()=>{
  const f=fixture(),tool=await catalog(f),before=f.traffic.length,approvals=f.authorizations.length;
  const changed={...f.records.get(f.connection.id)!,secretRef:"MCP_NEW"};expect(toolDigest(changed,definition)).not.toBe(tool.schemaDigest);f.records.set(changed.id,changed);
  await expect(f.broker.invoke(context,changed.id,tool.name,{},tool.schemaDigest)).rejects.toThrow("schema changed");expect(f.traffic).toHaveLength(before);expect(f.authorizations).toHaveLength(approvals);
});

test("discovery requires atomic storage instead of falling back to a stale whole-record save",async()=>{
  const f=fixture();let authorizations=0;
  const broker=createToolBroker({allowLoopback:true,loadConnection:()=>f.connection,saveConnection:()=>{},authorize:async()=>{authorizations++;}});
  await expect(broker.discover(context,f.connection.id)).rejects.toThrow("atomic connector catalog storage");expect(f.traffic).toHaveLength(0);expect(authorizations).toBe(0);
});

test.each(["disabled","renamed"] as const)("atomic catalog publication handles a connection %s while its writer is suspended",async change=>{
  const f=fixture(),save=gate();f.hooks.save=()=>save.wait();
  const pending=f.broker.discover(context,f.connection.id);await save.entered;
  f.records.set(f.connection.id,{...f.records.get(f.connection.id)!,...(change==="disabled"?{enabled:false}:{name:"Renamed at atomic commit"})});save.release();
  if(change==="disabled"){await expect(pending).rejects.toThrow("changed before catalog commit");expect(f.records.get(f.connection.id)?.enabled).toBe(false);expect(f.records.get(f.connection.id)?.tools).toBeUndefined();}
  else{expect((await pending).name).toBe("Renamed at atomic commit");expect(f.records.get(f.connection.id)?.name).toBe("Renamed at atomic commit");}
});

test("an older discovery cannot overwrite a competing catalog publication",async()=>{
  const f=fixture(),save=gate();let writes=0;f.hooks.save=async()=>{if(++writes===1)await save.wait();};
  const older=f.broker.discover(context,f.connection.id);await save.entered;
  const newer=await f.broker.discover(context,f.connection.id);save.release();
  await expect(older).rejects.toThrow("changed before catalog commit");expect(f.records.get(f.connection.id)).toEqual(newer);
});

test("abort closes an in-flight tool request without retrying an already dispatched effect",async()=>{
  const f=fixture(),tool=await catalog(f),call=gate(),abort=new AbortController();f.hooks.call=()=>call.wait();
  const pending=f.broker.invoke(context,f.connection.id,tool.name,{},tool.schemaDigest,abort.signal);await call.entered;abort.abort();
  await expect(pending).rejects.toThrow(/cancel|abort/i);expect(f.rpc.filter(method=>method==="tools/call")).toHaveLength(1);call.release();
});
