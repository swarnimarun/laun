import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createPiInference, createPiRuntime } from "@laun/runtime";
import type { AgentRuntime, RuntimeInferenceService, RuntimeInferenceEnvelope } from "@laun/protocol";
import { ControlService } from "./service.js";
import { ControlStore } from "./store.js";
import { createRunInferenceClient } from "./inference.js";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const owner={id:"local-inference-owner",admin:false};
function setup(runtime:AgentRuntime,inference?:RuntimeInferenceService){
  const dir=mkdtempSync(join(tmpdir(),"laun-local-inference-")),store=new ControlStore(join(dir,"control.sqlite"));
  const service=new ControlService({store,runtime,inference,dataDir:dir,mode:"trusted-local",minFreeDiskBytes:0});
  const mower=store.createMower(owner,{name:"Clover",model:"faux/faux-1"}),thread=store.createThread(owner,{mowerId:mower.id});
  cleanup.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,service,mower,thread};
}
async function until(predicate:()=>boolean){const end=Date.now()+10_000;while(!predicate()){if(Date.now()>end)throw new Error("local inference timed out");await Bun.sleep(5);}}

test("local Pi defaults to fenced controller inference and accounts one provider admission/usage",async()=>{
  const runtime=createPiRuntime({trustedLocal:true,enableFaux:true}),c=setup(runtime);
  expect(c.service.options.inference).toBe(runtime.inference);
  const run=c.store.submit(owner,c.thread.id,{text:"A local centrally accounted answer",requestId:"one"});
  c.mower.model="unconfigured/later-model";c.store.put("mower",c.mower);
  await c.service.tick();await until(()=>c.store.run(run.id).status==="done");
  expect(c.store.run(run.id).summary).toContain("A local centrally accounted answer");
  expect(c.store.db.query("SELECT status,COUNT(*) n FROM inference_calls GROUP BY status").all()).toEqual([{status:"done",n:1}]);
  const usage=c.store.events(owner,c.thread.id).events.filter(event=>event.payload.event?.type==="usage");
  expect(usage).toHaveLength(1);expect(usage[0]!.payload.source).toBe("inference-controller");expect(usage[0]!.payload.event?.type==="usage"&&usage[0]!.payload.event.totalTokens).toBeGreaterThan(0);
});

test("local Pi provider failure has one charge receipt with no SDK retry or native fallback",async()=>{
  const native=createModels(),poison=fauxProvider();native.setProvider(poison.provider);poison.setResponses([fauxAssistantMessage("NATIVE_FALLBACK_MUST_NOT_RUN")]);
  const actual=createPiInference({enableFaux:true});let calls=0;
  const inference:RuntimeInferenceService={...actual,async *stream(){calls++;throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");}};
  const c=setup(createPiRuntime({trustedLocal:true,models:native,maxTurns:2}),inference);
  const run=c.store.submit(owner,c.thread.id,{text:"Do not retry uncertain inference",requestId:"fail"}),later=c.store.submit(owner,c.thread.id,{text:"Later remains queued",requestId:"later"});
  await c.service.tick();await until(()=>c.store.run(run.id).status==="interrupted");
  expect(calls).toBe(1);expect(poison.state.callCount).toBe(0);expect(c.store.run(later.id).status).toBe("queued");
  expect(c.store.db.query("SELECT status,COUNT(*) n FROM inference_calls GROUP BY status").all()).toEqual([{status:"interrupted",n:1}]);
  expect(JSON.stringify(c.store.events(owner,c.thread.id))).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
});

test("a local duplicate model request is refused before a second provider admission",async()=>{
  let calls=0;const inference:RuntimeInferenceService={async describe(){return {adapter:"fixture",version:1,payload:{}};},async *stream(_model,_request,_signal,onUsage){calls++;await onUsage?.({inputTokens:5,outputTokens:2,totalTokens:7});yield {adapter:"fixture",version:1,payload:{answer:"done"}};}};
  const idle:AgentRuntime={async run(){return {status:"done"};},cancel(){},close(){}};
  const c=setup(idle,inference),queued=c.store.submit(owner,c.thread.id,{text:"Manual local admission",requestId:"one"}),job=c.store.claim(c.store.get("worker","local"))!;
  const client=createRunInferenceClient(c.service,{runId:queued.id,generation:job.run.generation,workerId:"local"});
  const request={requestId:"a".repeat(64),envelope:{adapter:"fixture",version:1 as const,payload:{context:"bounded"}}};
  const result:RuntimeInferenceEnvelope[]=[];for await(const frame of client.stream(request))result.push(frame);
  expect(result).toHaveLength(1);expect(()=>client.stream(request)).toThrow("already admitted");expect(calls).toBe(1);
  expect(c.store.db.query("SELECT COUNT(*) n FROM inference_calls").get()).toEqual({n:1});
  expect(c.store.events(owner,c.thread.id).events.filter(event=>event.payload.event?.type==="usage")).toHaveLength(1);
});

test("an eagerly admitted local stream cancels before its first provider read",async()=>{
  let calls=0;const inference:RuntimeInferenceService={async describe(){return {adapter:"fixture",version:1,payload:{}};},async *stream(){calls++;yield {adapter:"fixture",version:1,payload:{}};}};
  const idle:AgentRuntime={async run(){return {status:"done"};},cancel(){},close(){}};
  const c=setup(idle,inference),queued=c.store.submit(owner,c.thread.id,{text:"Stop before consuming",requestId:"one"}),job=c.store.claim(c.store.get("worker","local"))!;
  const stop=new AbortController(),client=createRunInferenceClient(c.service,{runId:queued.id,generation:job.run.generation,workerId:"local"},stop.signal);
  const stream=client.stream({requestId:"a".repeat(64),envelope:{adapter:"fixture",version:1,payload:{context:"bounded"}}});
  expect(c.store.db.query("SELECT status FROM inference_calls").get()).toEqual({status:"admitted"});stop.abort();
  expect(c.store.db.query("SELECT status FROM inference_calls").get()).toEqual({status:"interrupted"});expect(c.store.run(queued.id).status).toBe("interrupted");expect(calls).toBe(0);
  await stream[Symbol.asyncIterator]().return?.();
});

test("crossing storage reserve after local placement stops before provider cost or receipt",async()=>{
  const native=createModels(),provider=fauxProvider();native.setProvider(provider.provider);provider.setResponses([fauxAssistantMessage("must not run")]);
  const actual=createPiRuntime({trustedLocal:true,models:native});let service:ControlService;
  const runtime:AgentRuntime={...actual,run:async(input,callbacks)=>{service.options.minFreeDiskBytes=Number.MAX_SAFE_INTEGER;return await actual.run(input,callbacks);}};
  const c=setup(runtime);service=c.service;
  const run=c.store.submit(owner,c.thread.id,{text:"Reserve changes before model dispatch",requestId:"one"});
  await c.service.tick();await until(()=>["interrupted","error"].includes(c.store.run(run.id).status));
  expect(provider.state.callCount).toBe(0);expect(c.store.db.query("SELECT COUNT(*) n FROM inference_calls").get()).toEqual({n:0});
  expect(c.service.readiness().storage?.acceptingWork).toBe(false);
});
