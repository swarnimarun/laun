import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createToolBroker } from "@laun/broker";
import { ControlService, ControlStore, handleControlRequest, handleTelegramConnectorRequest } from "@laun/control";
import { createPiRuntime, createPiInference } from "@laun/runtime";
import { parseAllowlist, type BrokerConnection, type ControlPrincipal } from "@laun/protocol";
import type { GatewayConfig } from "./config.js";

export function createControl(cfg:GatewayConfig,env:NodeJS.ProcessEnv=process.env){
  const flag=(name:string)=>{const value=env[name]??"false";if(value!=="true"&&value!=="false")throw new Error(`${name} must be true or false`);return value==="true";};
  const integer=(name:string,fallback:number,min:number,max:number)=>{const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be ${min}-${max}`);return value;};
  const openshell=flag("OPENSHELL_ENABLED"),trusted=flag("LAUN_TRUSTED_LOCAL"),demo=flag("LAUN_DEMO"),allowLoopback=flag("LAUN_MCP_ALLOW_LOOPBACK"),legacyEnabled=flag("LAUN_LEGACY_API");
  const capacity=integer("LAUN_LOCAL_CAPACITY",2,1,16),maxFamilyTokens=integer("MAX_FAMILY_TOKENS",100_000,0,1_000_000_000);
  const cpuLimit=Number(env.OPENSHELL_CPU_LIMIT??2),memoryMiB=integer("OPENSHELL_MEMORY_MIB",1024,64,65536);
  if(!Number.isFinite(cpuLimit)||cpuLimit<0.1||cpuLimit>64||Math.abs(Math.round(cpuLimit*1000)-cpuLimit*1000)>4*Number.EPSILON*Math.max(1,Math.abs(cpuLimit*1000)))throw new Error("OPENSHELL_CPU_LIMIT must be 0.1-64 CPUs with millicpu precision");
  if(openshell&&!env.OPENSHELL_SANDBOX_IMAGE?.trim())throw new Error("OPENSHELL_SANDBOX_IMAGE required for isolated control runtime");
  const store=new ControlStore(join(cfg.dataDir,"control.sqlite"));
  const runtime=openshell||trusted?createPiRuntime({trustedLocal:trusted,openshellEnabled:openshell,enableFaux:demo,
    cleanupRoot:resolve(cfg.dataDir,"control"),
    authFile:env.PI_AUTH_FILE??join(homedir(),".pi","agent","auth.json"),
    openshell:openshell?{image:env.OPENSHELL_SANDBOX_IMAGE??"",bin:env.OPENSHELL_BIN,policyFile:env.OPENSHELL_V2_POLICY,cpuLimit,memoryMiB}:undefined,
    maxTurns:32,timeoutMs:600_000}):undefined;
  const service=new ControlService({store,runtime,dataDir:join(cfg.dataDir,"control"),mode:openshell?"isolated":trusted?"trusted-local":"unconfigured",
    inference:runtime?.inference??createPiInference({authFile:env.PI_AUTH_FILE??join(homedir(),".pi","agent","auth.json"),enableFaux:demo,timeoutMs:600_000}),
    capacity,maxFamilyTokens,minFreeDiskBytes:integer("LAUN_MIN_FREE_DISK_MIB",512,0,1_048_576)*1024*1024,maxConcurrentRuns:cfg.maxConcurrentRuns??4,defaultModel:demo?"faux/faux-1":env.MODEL??"opencode-go/muse-spark-1.3-contributor"});
  const resolveSecret=(ref:string)=>/^MCP_[A-Z0-9_]+$/.test(ref)?env[ref]:undefined;
  const broker=createToolBroker({authorize:(context,operation,resource,args,signal)=>service.authorize(context,{operation,resource,arguments:args,signal}),
    assertActive:(context,signal)=>{signal?.throwIfAborted();service.assertActiveContext(context);},
    loadConnection:connectionId=>{try{return store.get<BrokerConnection>("connection",connectionId);}catch{return undefined;}},
    saveConnection:c=>store.saveConnection(c),saveCatalog:(expected,catalog)=>store.saveCatalog(expected,catalog),resolveSecret,allowLoopback});
  service.broker=broker;
  const telegram={serviceToken:env.LAUN_TELEGRAM_BRIDGE_TOKEN?.trim()||cfg.gatewayToken,botId:env.LAUN_TELEGRAM_BOT_ID?.trim()||env.TELEGRAM_BOT_TOKEN?.split(":")[0]||"",
    allowlist:parseAllowlist(env.TELEGRAM_ALLOWLIST_IDS),allowChats:parseAllowlist(env.TELEGRAM_ALLOWLIST_CHAT_IDS),defaultModel:service.options.defaultModel};
  return {service,store,legacyEnabled,handle:async(req:Request,principal:ControlPrincipal|null)=>
    await handleTelegramConnectorRequest(service,req,telegram,principal)??handleControlRequest(service,req,principal,{resolveSecret,allowLoopback}),
    close:async()=>{await service.close();store.close();}};
}
