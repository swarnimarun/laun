import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { formatAgentKey } from "../packages/protocol/src/index.js";
const demo=process.argv.includes("--demo"),trusted=process.argv.includes("--trusted-local");
if(!demo&&!trusted&&process.env.OPENSHELL_ENABLED!=="true"){
 console.error("Choose --demo for an explicit scripted provider, --trusted-local for real host execution, or configure OPENSHELL_ENABLED=true.");process.exit(1);
}
const directory=resolve(process.env.LAUN_LOCAL_DATA??".laun-local");mkdirSync(directory,{recursive:true,mode:0o700});
const credentialsPath=resolve(directory,"access.json");
const credentials=existsSync(credentialsPath)?JSON.parse(readFileSync(credentialsPath,"utf8")) as {service:string;key:string}:{service:randomBytes(32).toString("base64url"),key:formatAgentKey(randomBytes(4).toString("hex"),randomBytes(32).toString("base64url"))};
if(!existsSync(credentialsPath))writeFileSync(credentialsPath,JSON.stringify(credentials),{mode:0o600});
const port=process.env.GATEWAY_PORT??"8080";
console.log(`Laun: http://127.0.0.1:${port}/app\nAgent key: ${credentials.key}\nMode: ${demo?"explicit demonstration provider":trusted?"trusted local host execution":"OpenShell"}\nData: ${directory}\n`);
const child=Bun.spawn([process.execPath,"apps/gateway/src/index.ts"],{cwd:resolve(import.meta.dir,".."),env:{...process.env,GATEWAY_TOKEN:credentials.service,LAUN_KEY:credentials.key,DATA_DIR:directory,
 LAUN_TRUSTED_LOCAL:trusted||demo?"true":"false",LAUN_DEMO:demo?"true":"false",GATEWAY_PORT:port},stdin:"inherit",stdout:"inherit",stderr:"inherit"});
for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>child.kill(signal));
process.exitCode=await child.exited;
