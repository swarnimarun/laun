import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualifyPackagedControl } from "./qualify-packaged-control.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function engine(foreign = false) {
  const root = mkdtempSync("/tmp/laun-release-smoke-fixture-"); roots.push(root);
  const bin = join(root, "engine"), log = join(root, "argv.jsonl"), container = join(root, "container.json"), volume = join(root, "volume.json");
  writeFileSync(bin, `#!${process.execPath}
import{appendFileSync,writeFileSync,readFileSync}from'node:fs';
const a=process.argv.slice(2),label='laun.release-qualification';appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='run'&&a.includes('--rm')){console.log(a.includes('pi')?'1.5.2':'openshell 0.1.8');process.exit(0);}
if(a[0]==='volume'&&a[1]==='create'){const v=a[a.indexOf('--label')+1];writeFileSync(${JSON.stringify(volume)},JSON.stringify([{Labels:{[label]:v.split('=')[1]}}]));console.log(a.at(-1));process.exit(0);}
if(a[0]==='run'){
 const v=a[a.indexOf('--label')+1],key=a.find(x=>x.startsWith('LAUN_KEY=')).slice(9),token=a.find(x=>x.startsWith('GATEWAY_TOKEN=')).slice(14);
 writeFileSync(${JSON.stringify(container)},JSON.stringify([{Config:{Labels:{[label]:${foreign}?'foreign':v.split('=')[1]}}}]));
 console.error('simulatedpartialstart '+key+' '+token+' '+key.split('_').slice(2).join('_'));process.exit(1);
}
if(a[0]==='inspect'){console.log(readFileSync(${JSON.stringify(container)},'utf8'));process.exit(0);}
if(a[0]==='volume'&&a[1]==='inspect'){console.log(readFileSync(${JSON.stringify(volume)},'utf8'));process.exit(0);}
if(a[0]==='rm'||(a[0]==='volume'&&a[1]==='rm'))process.exit(0);
process.exit(9);
`); chmodSync(bin, 0o700);
  return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) };
}
test("a partially-created failed-start container is removed only after exact label verification, with credentials redacted", async () => {
  const fake = engine(); let message = "";
  try { await qualifyPackagedControl({ engine: [fake.bin], image: "fixture:image" }); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("simulatedpartialstart"); expect(message).toContain("[REDACTED]");
  const calls = fake.calls(), run = calls.find(args => args[0] === "run" && args.includes("-d"))!;
  for (const value of run.filter(value => value.startsWith("LAUN_KEY=") || value.startsWith("GATEWAY_TOKEN="))) expect(message).not.toContain(value.slice(value.indexOf("=") + 1));
  expect(calls.some(args => args[0] === "inspect")).toBe(true); expect(calls.some(args => args[0] === "rm" && args[1] === "--force")).toBe(true);
  expect(calls.some(args => args[0] === "volume" && args[1] === "rm")).toBe(true);
});
test("a foreign resource at the generated name is preserved when its proof label does not match", async () => {
  const fake = engine(true);
  await expect(qualifyPackagedControl({ engine: [fake.bin], image: "fixture:image" })).rejects.toThrow("simulatedpartialstart");
  expect(fake.calls().some(args => args[0] === "rm")).toBe(false);
});
