/** Disposable documentation server. Never loads provider credentials or an existing installation. */
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDemoFixtureRuntime } from "../../../packages/runtime/test/demo-fixture.js";
import { startBrowserFixture } from "./fixture.js";

export async function startDemoFixture() {
  return startBrowserFixture(resolve(import.meta.dir,"../../.."),{
    runtime:createDemoFixtureRuntime(),approvalTimeoutMs:30*60_000,
  });
}

if (import.meta.main) {
  const fixture=await startDemoFixture();
  const access=join(fixture.directory,"access.json");
  try{await writeFile(access,JSON.stringify({url:fixture.url,key:fixture.key})+"\n",{mode:0o600});}
  catch(error){await fixture.close();throw error;}
  console.log(`Scripted local demonstration: ${fixture.url}/app\nPrivate temporary access file: ${access}\nNo provider, Telegram, or VPS connection is used. Stop with Ctrl-C to remove all demonstration data.`);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await fixture.close();process.exit(0);};
  for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void close();});
}
