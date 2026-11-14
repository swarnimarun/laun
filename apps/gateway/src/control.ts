import { join } from "node:path";
import { homedir } from "node:os";
import { createToolBroker } from "@laun/broker";
import { ControlService, ControlStore, handleControlRequest } from "@laun/control";
import { createPiRuntime } from "@laun/runtime";
import type { BrokerConnection, ControlPrincipal } from "@laun/protocol";
import type { GatewayConfig } from "./config.js";

export function createControl(cfg:GatewayConfig,env:NodeJS.ProcessEnv=process.env){
  const flag=(name:string)=>{const value=env[name]??"false";if(value!=="true"&&value!=="false")throw new Error(`${name} must be true or false`);return value==="true";};
  const integer=(name:string,fallback:number,min:number,max:number)=>{const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be ${min}-${max}`);return value;};
  const openshell=flag("OPENSHELL_ENABLED"),trusted=flag("LAUN_TRUSTED_LOCAL"),demo=flag("LAUN_DEMO"),allowLoopback=flag("LAUN_MCP_ALLOW_LOOPBACK");
  const capacity=integer("LAUN_LOCAL_CAPACITY",2,1,16),maxFamilyTokens=integer("MAX_FAMILY_TOKENS",100_000,0,1_000_000_000);
  if(openshell&&!env.OPENSHELL_SANDBOX_IMAGE?.trim())throw new Error("OPENSHELL_SANDBOX_IMAGE required for isolated control runtime");
  const store=new ControlStore(join(cfg.dataDir,"control.sqlite"));
  const runtime=openshell||trusted?createPiRuntime({trustedLocal:trusted,openshellEnabled:openshell,enableFaux:demo,
    authFile:env.PI_AUTH_FILE??join(homedir(),".pi","agent","auth.json"),
    openshell:openshell?{image:env.OPENSHELL_SANDBOX_IMAGE??"",bin:env.OPENSHELL_BIN,policyFile:env.OPENSHELL_V2_POLICY}:undefined,
    maxTurns:32,timeoutMs:600_000}):undefined;
  const service=new ControlService({store,runtime,dataDir:join(cfg.dataDir,"control"),mode:openshell?"isolated":trusted?"trusted-local":"unconfigured",
    capacity,maxFamilyTokens,defaultModel:demo?"faux/faux-1":env.MODEL??"opencode-go/muse-spark-1.3-contributor"});
  const resolveSecret=(ref:string)=>/^MCP_[A-Z0-9_]+$/.test(ref)?env[ref]:undefined;
  const broker=createToolBroker({authorize:(context,operation,resource,args)=>service.authorize(context,{operation,resource,arguments:args}),
    loadConnection:connectionId=>{try{return store.get<BrokerConnection>("connection",connectionId);}catch{return undefined;}},
    saveConnection:c=>store.saveConnection(c),resolveSecret,allowLoopback});
  service.broker=broker;
  return {service,store,handle:(req:Request,principal:ControlPrincipal|null)=>handleControlRequest(service,req,principal,{resolveSecret,allowLoopback}),
    close:async()=>{await service.close();store.close();}};
}
