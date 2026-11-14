import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {startDemoFixture} from './demo-fixture.ts';
import {strict as assert} from 'node:assert';
const fixture=await startDemoFixture();
let executablePath=process.env.CHROMIUM_PATH;
if (!executablePath && existsSync('/nix/store')) {
 const paths=await Array.fromAsync(new Bun.Glob('*chromium*/bin/chromium').scan({cwd:'/nix/store',absolute:true}));
 executablePath=paths.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
}
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
 const page=await browser.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});await page.goto(fixture.url+'/app');await page.evaluate(()=>document.fonts.ready);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'login overflow '+width);
  assert(await page.evaluate(()=>document.fonts.check('16px Newsreader')&&document.fonts.check('14px "DM Sans"')),'fonts loaded');
  assert(await page.locator('#connect-button').evaluate(e=>{const r=e.getBoundingClientRect();return r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}),'login form fits '+width);
  if(width===1440)await page.screenshot({path:'docs/images/welcome.png',fullPage:true});
 }
 await page.locator('#auth-key').fill(fixture.key);await page.locator('#login-form').evaluate((f:HTMLFormElement)=>f.requestSubmit());await page.locator('#workspace').waitFor({state:'visible'});
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(100);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'workspace overflow '+width);
  assert(await page.locator('#empty-start-button').isVisible(),'empty action visible '+width);
  assert(await page.locator('.empty-art img').evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0),'illustration loaded');
 }
 await page.locator('#new-mower-button').click();await page.locator('#modal').waitFor({state:'visible'});
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  assert(await page.locator('#modal').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'dialog fits '+width);
 }
 assert.deepEqual(errors,[]);console.log('Design audit passed: login, fonts, image, workspace and dialog at 320, 390, 768, 1024 and 1440px.');
}finally{await browser.close();await fixture.close();}
