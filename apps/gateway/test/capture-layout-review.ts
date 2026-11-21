/** Capture layout-review evidence. This records defects; it is not a visual pass/fail suite. */
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ControlState } from "@laun/protocol";
import { DEMO_PROMPTS } from "../../../packages/runtime/test/demo-fixture.js";
import { startDemoFixture } from "./demo-fixture.js";

const root=resolve(import.meta.dir,"../../..");
const output=resolve(process.env.LAUN_LAYOUT_SHOTS || "/tmp/laun-layout-review");
const measurements:unknown[]=[];
await mkdir(output,{recursive:true});
const fixture=await startDemoFixture();
let executablePath=process.env.CHROMIUM_PATH;
if(!executablePath&&existsSync("/nix/store")) {
  const paths=await Array.fromAsync(new Bun.Glob("*chromium*/bin/chromium").scan({cwd:"/nix/store",absolute:true}));
  executablePath=paths.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
}
const browser=await chromium.launch({executablePath,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]}).catch(async error=>{await fixture.close();throw error;});
const {context,page}=await(async()=>{
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:"reduce"});
    return{context,page:await context.newPage()};
  }catch(error){await browser.close();await fixture.close();throw error;}
})();
const errors:string[]=[];
page.on("pageerror",error=>errors.push(error.message.replaceAll(fixture.key,"[KEY]")));
const state=async():Promise<ControlState>=>{
  const response=await context.request.get(`${fixture.url}/api/v2/state`,{headers:{authorization:`Bearer ${fixture.key}`}});
  assert(response.ok(),"demo state readable");return response.json();
};
const closeModal=async()=>{if(await page.locator("#modal").isVisible())await page.locator("#modal-close").click();};
const submitModal=async()=>{await page.locator("#modal-submit").click();await page.waitForFunction(()=>!document.querySelector<HTMLDialogElement>("#modal")?.open||!!document.querySelector("#modal-error")?.textContent?.trim());if(await page.locator("#modal").isVisible())throw Error((await page.locator("#modal-error").textContent())||"Demo form did not submit");};
const tab=async(name:string)=>{
  if(!await page.locator("#inspector").isVisible())await page.locator("#inspector-toggle").click();
  await page.getByRole("tab",{name:new RegExp(`^${name}`)}).click();
};
const openThread=async(id:string,title:string)=>{
  await page.evaluate(value=>{location.hash=`#/threads/${value}`;},id);
  await page.locator("#thread-title").filter({hasText:title}).waitFor({state:"visible"});
};
const send=async(text:string)=>{await page.locator("#message-input").fill(text);await page.locator("#send-button").click();};
const answer=async(text:string)=>page.locator("#messages .message.assistant .message-content").filter({hasText:text}).last().waitFor({state:"visible",timeout:30_000});
const capture=async(name:string)=>{
  await page.waitForFunction(()=>!document.querySelector('#toast-region')?.childElementCount);
  const original=page.viewportSize()!;
  const cases:Record<string,number[][]>={
    'welcome.png':[[1440,900],[768,768],[390,667]],
    'setup.png':[[1440,900],[1024,768],[390,667],[320,568]],
    'workspace-desktop.png':[[1440,900],[1200,768],[1199,768],[1024,768],[800,768],[799,768],[667,375],[390,667],[320,568]],
    'approval.png':[[1440,900],[1024,768],[390,667],[320,568]],
    'gatekeeper.png':[[1440,900],[390,667]],
    'workspace-mobile.png':[[390,667],[320,568]],
  };
  for(const [width,height] of cases[name]||[]){
    await page.setViewportSize({width,height});await page.waitForTimeout(120);
    if(name==='approval.png'&&!await page.locator('#inspector').isVisible())await page.locator('#inspector-toggle').click();
    const shot=name.replace('.png','')+'-'+width+'x'+height+'.png';
    assert(!(await page.locator('body').innerText()).includes(fixture.key),'no credential in screenshot');
    await page.screenshot({path:join(output,shot),animations:'disabled',caret:'hide'});
    const data=await page.evaluate(()=>{
      const rect=(e:Element)=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const shown=(e:Element)=>{const r=e.getBoundingClientRect();const st=getComputedStyle(e);return r.width>0&&r.height>0&&st.visibility!=='hidden'&&e.checkVisibility();};
      const controls=[...document.querySelectorAll('button,input,select,textarea,[role=tab]')].filter(shown).map(e=>({id:e.id||null,text:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,90),...rect(e),fontSize:getComputedStyle(e).fontSize,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
      const regions=[...document.querySelectorAll('.login-view,.login-art,.login-content,.workspace,.sidebar,.conversation-panel,.conversation-header,.header-heading,.header-actions,.readiness-banner,.messages,.composer-wrap,.composer,.inspector,.inspector-tabs,.inspector-content,.modal,.modal-header,.modal-fields,.modal-actions')].filter(shown).map(e=>({selector:e.id||e.className,...rect(e),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
      const fonts=[...document.querySelectorAll('p,small,time,label,.field-hint,.state-pill,.detail-grid dt,.detail-grid dd,.composer-footnote,.item-card strong')].filter(shown).map(e=>({text:e.textContent?.trim().slice(0,90),font:getComputedStyle(e).fontSize,color:getComputedStyle(e).color,...rect(e)}));
      const selects=[...document.querySelectorAll('select')].filter(shown).map(e=>{const st=getComputedStyle(e);const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d')!;ctx.font=st.font;const text=e.selectedOptions[0]?.text||'';return{id:e.id,text,width:e.clientWidth,textWidth:ctx.measureText(text).width,padding:parseFloat(st.paddingLeft)+parseFloat(st.paddingRight)};});
      return{viewport:{width:innerWidth,height:innerHeight},page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},controls,regions,fonts,selects};
    });
    measurements.push({shot,...data});
    console.log('Captured '+shot);
  }
  await page.setViewportSize(original);await page.waitForTimeout(120);
};
const addMower=async(name:string,purpose:string,profile:string)=>{
  await page.locator("#new-mower-button").click();
  await page.locator("#field-name").fill(name);
  await page.locator("#field-model").fill("faux/faux-1");
  await page.locator("#field-profile").selectOption(profile);
  await page.locator("#field-instructions").fill(purpose);
  await submitModal();
  const mower=(await state()).mowers.find(item=>item.name===name);assert(mower);return mower;
};
try {
  await page.goto(`${fixture.url}/app`,{waitUntil:"networkidle"});
  await page.evaluate(() => document.fonts.ready);
  await capture("welcome.png");
  await page.locator("#auth-key").fill(fixture.key);
  await page.locator("#login-form").evaluate((form:HTMLFormElement)=>form.requestSubmit());
  await page.locator("#workspace").waitFor({state:"visible"});
  await page.locator("#workspace-info").click();
  await page.getByRole("button",{name:"Set up primary Groundskeeper",exact:true}).click();
  await page.locator("#field-setup-name").fill("Groundskeeper");
  await page.locator("#field-setup-title").fill("Release garden");
  await page.locator("#field-setup-model").selectOption("faux/faux-1");
  await page.locator("#field-setup-yard").selectOption("local");
  await page.locator("#modal-submit").click();
  await page.locator("#field-setup-write").waitFor({state:"visible"});
  assert.equal(await page.locator("#field-setup-write").inputValue(),"ask");
  await capture("setup.png");
  await page.locator("#modal-submit").click();
  await submitModal();
  const configured=await state();
  assert.equal(configured.runs.length,0,"setup has no model calls");
  const primary=configured.threads.find(thread=>thread.title==="Release garden");assert(primary);
  const profile=`${primary.profileId}:${primary.profileVersion}`;
  const clover=await addMower("Clover","Review plans carefully. Return concise findings and explain what still needs real-world qualification.",profile);
  await addMower("Juniper","Write clear release notes. Ask before changing files and keep edits small.",profile);
  await openThread(primary.id,primary.title);
  await send(DEMO_PROMPTS.plan);
  await answer("A small plan with clear owners");
  await tab("Overview");
  await capture("workspace-desktop.png");
  await tab("Tasks");
  await page.getByRole("button",{name:"Delegate a task ↗",exact:true}).click();
  await page.locator("#field-task-name").fill("Review the release plan");
  await page.locator("#field-task-mower").selectOption(clover.id);
  await page.locator("#field-task-goal").fill(DEMO_PROMPTS.review);
  await submitModal();
  await page.waitForFunction(async({url,key})=>{const response=await fetch(`${url}/api/v2/state`,{headers:{authorization:`Bearer ${key}`}});const data=await response.json();return data.tasks.some((task:{status:string})=>task.status==="done");},{url:fixture.url,key:fixture.key},{timeout:30_000});
  const task=(await state()).tasks.find(item=>item.title==="Review the release plan");assert(task);
  const child=(await state()).threads.find(thread=>thread.id===task.threadId);assert(child);
  await openThread(child.id,child.title);
  await send(DEMO_PROMPTS.followup);
  await answer("Before a real VPS rollout");
  await tab("Tasks");
  await capture("delegation.png");
  await openThread(primary.id,primary.title);
  await tab("Overview");

  await page.locator("#new-thread-button").click();
  await page.locator("#field-title").fill("Release brief");
  await page.locator("#field-mower").selectOption(primary.mowerId);
  await page.locator("#field-goal").fill(DEMO_PROMPTS.write);
  await submitModal();
  await tab("Permissions");
  const request=page.locator("#inspector-content .item-card").filter({has:page.locator(".approval-detail").filter({hasText:"RELEASE_NOTES.md"})});
  await request.waitFor({state:"visible",timeout:30_000});
  await capture("approval.png");
  const before=await state();
  await request.getByRole("button",{name:"Discuss with Gatekeeper",exact:true}).click();
  await page.locator("#field-advice-feedback").fill(DEMO_PROMPTS.advice);
  await submitModal();
  await page.getByRole("button",{name:"Review guardrail proposal",exact:true}).last().waitFor({state:"visible",timeout:30_000});
  await tab("Overview");
  const after=await state();
  for(const profile of before.profiles)assert.deepEqual(after.profiles.filter(item=>item.id===profile.id),before.profiles.filter(item=>item.id===profile.id),"Gatekeeper does not revise an existing profile");
  const adviser=after.mowers.find(item=>item.role==="adviser");assert(adviser);
  assert.equal(after.profiles.find(item=>item.id===adviser.profileId)?.rules.length,0,"managed Gatekeeper has no tools");
  assert(after.approvals.some(item=>item.status==="pending"),"advice never approves the action");
  assert(!existsSync(join(fixture.directory,"threads",before.approvals.find(item=>item.status==="pending")!.action.threadId,"work/RELEASE_NOTES.md")),"pending write has no file effect");
  await capture("gatekeeper.png");

  // A real enrollment record, deliberately offline: no fake connected VPS or credential screenshot.
  const enrolled=await context.request.post(`${fixture.url}/api/v2/workers`,{headers:{authorization:`Bearer ${fixture.key}`},data:{name:"Cedar VPS",capacity:2,labels:["awaiting-connection"]}});
  assert(enrolled.ok());
  await page.locator("#refresh-button").click();
  await openThread(child.id,child.title);
  await tab("Yards");
  await page.getByText("Cedar VPS",{exact:true}).waitFor({state:"visible"});
  await capture("yards.png");
  await openThread(child.id,child.title);
  await page.setViewportSize({width:430,height:932});
  await page.locator('#workspace[data-layout="compact"]').waitFor();
  if(await page.locator("#inspector").isVisible())await page.locator("#inspector-close").click();
  assert.equal(await page.locator("#inspector-toggle").getAttribute("aria-expanded"),"false");
  await page.locator("#composer").waitFor({state:"visible"});
  await capture("workspace-mobile.png");
  await Bun.write(join(output,'measurements.json'),JSON.stringify(measurements,null,2)+'\n');
  assert.deepEqual(errors,[],"no browser exceptions");
  console.log(`Captured ${measurements.length} layout evidence screenshots and measurements in ${output}. Scripted local demo; no provider, Telegram, or VPS calls.`);
} catch(error) {
  console.error((await page.locator("#modal-error").textContent().catch(()=>""))?.replaceAll(fixture.key,"[KEY]") || "Documentation capture stopped before the next screenshot.");
  await page.screenshot({path:"/tmp/laun-demo-capture-error.png"}).catch(()=>{});
  throw new Error((error instanceof Error?error.message:String(error)).replaceAll(fixture.key,"[KEY]"));
} finally {
  await closeModal().catch(()=>{});
  await context.close();await browser.close();await fixture.close();
}
