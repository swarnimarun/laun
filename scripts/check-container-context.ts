import {randomBytes,randomUUID} from "node:crypto";
import {copyFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";

/** Real builder matching against synthetic private state; never copies live keys. */
export async function checkContainerContext(options:{engine:string[];buildArgs?:string[];repoDir?:string;baseImage?:string}){
  if(!options.engine.length||options.engine.some(value=>typeof value!=="string"||!value||value.includes("\0")))throw new Error("an explicit container engine argv is required");
  const repository=resolve(options.repoDir??join(import.meta.dir,"..")),base=options.baseImage??"docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d";
  if(!/^[A-Za-z0-9:/@._-]+$/.test(base))throw new Error("invalid fixed test base image");
  const root=mkdtempSync(join(tmpdir(),"laun-container-context-")),context=join(root,"context"),tag=`localhost/laun-context-proof:${randomUUID()}`;
  mkdirSync(context,{mode:0o700});copyFileSync(join(repository,".dockerignore"),join(context,".dockerignore"));
  const privatePaths=[
    ".laun-local/access.json",".laun-local/control.sqlite",".laun-local/control.sqlite-wal",".laun-local/keys.json","unknown-private-root/debug.txt",
    ...[".aws",".ssh",".pi",".config",".agents",".codex",".git",".jj",".laun-local",".laun",".cache",".local",".pi-subagents","node_modules","dist","data","sessions","checkpoints","runtime-recovery","journal","backups","exports","bridge-data","worker-data"].map(directory=>`apps/context-fixture/${directory}/private-state`),
    ...["auth.json","credentials.json","access.json","keys.json","worker.env","bridge.env",".env",".env.local","private.env","id_rsa","id_ed25519","private.key","private.pem","private.crt","private.p12","private.pfx","control.sqlite","control.sqlite-shm","control.sqlite3-wal","control.db","control.db-wal","session.jsonl","history.ndjson","service.log","backup.tar","backup.tar.gz","backup.tgz","backup.zip","tsconfig.tsbuildinfo"].map(file=>`packages/context-fixture/${file}`),
    "vendor/openshell-sdk/dist/.aws/credentials","vendor/openshell-sdk/dist/.codex/private-state","vendor/openshell-sdk/dist/auth.json","vendor/openshell-sdk/dist/credentials.json","vendor/openshell-sdk/dist/control.sqlite-wal","deploy/.ssh/id_ed25519",
  ];
  const keptPaths=["package.json","bun.lock","tsconfig.json","tsconfig.base.json","apps/context-fixture/src/auth.ts","packages/context-fixture/src/index.ts","vendor/openshell-sdk/dist/index.js","deploy/openshell/install-cli.sh","deploy/openshell/policy.yaml"];
  const sentinel=randomBytes(32).toString("hex");
  for(const file of privatePaths){const path=join(context,file);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,sentinel,{mode:0o600,flag:"wx"});}
  for(const file of keptPaths){const path=join(context,file);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,"source fixture\n",{mode:0o600,flag:"wx"});}
  const command=(args:string[],timeoutMs=120_000)=>Bun.spawn([...options.engine,...args],{env:process.env,stdout:"pipe",stderr:"pipe",timeout:timeoutMs});
  let built=false;
  try{
    const probe=`import {existsSync} from "node:fs";const absent=${JSON.stringify(privatePaths)}.every(path=>!existsSync("/context/"+path));const kept=${JSON.stringify(keptPaths)}.every(path=>existsSync("/context/"+path));if(!absent||!kept)throw new Error("container context boundary failed");console.log(JSON.stringify({privateSentinelsAbsent:absent,sourceAuthTsRetained:existsSync("/context/apps/context-fixture/src/auth.ts"),vendorDistRetained:existsSync("/context/vendor/openshell-sdk/dist/index.js")}));`;
    const dockerfile=join(root,"Dockerfile.context");writeFileSync(dockerfile,`FROM ${base}\nCOPY . /context\nRUN ${JSON.stringify(["bun","-e",probe])}\n`,{mode:0o600});
    const child=command(["build",...(options.buildArgs??[]),"--no-cache","--force-rm","-t",tag,"-f",dockerfile,context]);
    const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(exitCode!==0){const log=join(tmpdir(),`laun-context-failure-${randomUUID()}.log`);writeFileSync(log,`${stdout}\n${stderr}`,{mode:0o600});throw new Error(`container context proof failed (exit ${exitCode}); engine diagnostics retained privately: ${log}`);}
    built=true;
    if(!stdout.includes('"privateSentinelsAbsent":true')||!stdout.includes('"vendorDistRetained":true')||!stdout.includes('"sourceAuthTsRetained":true'))throw new Error("builder did not emit the expected context proof");
    return{privateSentinelsAbsent:true,privateSentinelCount:privatePaths.length,sourceAuthTsRetained:true,vendorDistRetained:true,actualBuilderUsed:true};
  }finally{
    // A failing intermediate image can contain only synthetic values. Remove
    // this exact proof image; never prune unrelated images or builder caches.
    if(built){const removed=command(["image","rm","--force",tag],30_000);await Promise.all([new Response(removed.stdout).text(),new Response(removed.stderr).text(),removed.exited]);}
    rmSync(root,{recursive:true,force:true});
  }
}

if(import.meta.main)try{
  const configured=process.env.LAUN_CONTEXT_ENGINE_ARGV;let engine:string[];
  try{engine=configured?JSON.parse(configured) as string[]:["docker"];}catch{throw new Error("LAUN_CONTEXT_ENGINE_ARGV must be a JSON argv array");}
  if(!Array.isArray(engine))throw new Error("LAUN_CONTEXT_ENGINE_ARGV must be a JSON argv array");
  const buildArgs=process.env.LAUN_CONTEXT_BUILD_ARGV?JSON.parse(process.env.LAUN_CONTEXT_BUILD_ARGV)as string[]:[];
  if(!Array.isArray(buildArgs)||buildArgs.some(value=>typeof value!=="string"||!value||value.includes("\0")))throw new Error("LAUN_CONTEXT_BUILD_ARGV must be a JSON argv array");
  console.log(JSON.stringify(await checkContainerContext({engine,buildArgs})));
}catch(error){console.error(error instanceof Error?error.message:"container context verification failed");process.exitCode=1;}
