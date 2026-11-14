import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxAssistantMessage,fauxProvider} from "@earendil-works/pi-ai/providers/faux";
import {createPiRuntime} from "@laun/runtime";
import {ControlStore} from "./store.js";
import {ControlService} from "./service.js";

const resources:Array<{dir:string;store:ControlStore;service:ControlService}>=[];
afterEach(async()=>{for(const f of resources.splice(0).reverse()){await f.service.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}});
const owner={id:"local-durability-owner",admin:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"laun-local-ledger-")),store=new ControlStore(join(dir,"control.sqlite")),models=createModels(),provider=fauxProvider();models.setProvider(provider.provider);
 const runtime=createPiRuntime({trustedLocal:true,models}),service=new ControlService({store,runtime,dataDir:dir,mode:"trusted-local",minFreeDiskBytes:0});
 const mower=store.createMower(owner,{name:"Durable Fern",model:"faux/faux-1"}),thread=store.createThread(owner,{mowerId:mower.id});const f={dir,store,service,provider,thread};resources.push(f);return f;
}
async function until(check:()=>boolean){const deadline=Date.now()+10_000;while(!check()){if(Date.now()>deadline)throw new Error("local durability condition timed out");await Bun.sleep(5);}}

test("local Pi centrally commits before inference and rebuilds conversation without local cache or final checkpoint",async()=>{
 const f=fixture();let restoredContext="";
 const committed=()=>Number((f.store.db.query("SELECT COUNT(*) n FROM durable_commits WHERE thread_id=?").get(f.thread.id) as {n:number}).n);
 f.provider.setResponses([
  async()=>{expect(committed()).toBeGreaterThan(1);return fauxAssistantMessage("FIRST_LOCAL_SERVER_LEDGER_ANSWER");},
  async context=>{restoredContext=JSON.stringify(context);expect(committed()).toBeGreaterThan(1);return fauxAssistantMessage("RESTORED_LOCAL_SERVER_LEDGER_ANSWER");},
 ]);
 const first=f.store.submit(owner,f.thread.id,{text:"FIRST_LOCAL_SERVER_LEDGER_INPUT",requestId:"first"});await f.service.tick();await until(()=>f.store.run(first.id).status==="done");expect(f.provider.state.callCount).toBe(1);
 const head=committed();expect(head).toBeGreaterThan(1);
 // Simulate complete local-cache loss without permitting the final checkpoint
 // to supply history. The acknowledged SQLite ledger is the only source.
 rmSync(join(f.dir,"threads",f.thread.id),{recursive:true,force:true});f.store.db.query("DELETE FROM checkpoints WHERE thread_id=?").run(f.thread.id);
 const second=f.store.submit(owner,f.thread.id,{text:"Continue the server-owned history",requestId:"second"});await f.service.tick();await until(()=>f.store.run(second.id).status==="done");
 expect(f.provider.state.callCount).toBe(2);expect(committed()).toBeGreaterThan(head);expect(restoredContext).toContain("FIRST_LOCAL_SERVER_LEDGER_INPUT");expect(restoredContext).toContain("FIRST_LOCAL_SERVER_LEDGER_ANSWER");expect(restoredContext).toContain("Continue the server-owned history");
});

test("a local central commit failure prevents provider admission and later queued work",async()=>{
 const f=fixture();f.provider.setResponses([fauxAssistantMessage("MUST_NOT_BE_CALLED")]);
 f.store.db.exec("CREATE TRIGGER reject_local_commit BEFORE INSERT ON durable_commits WHEN NEW.sequence>1 BEGIN SELECT RAISE(ABORT,'fixture rejects central commit'); END");
 const first=f.store.submit(owner,f.thread.id,{text:"Fail before inference",requestId:"first"}),later=f.store.submit(owner,f.thread.id,{text:"Keep later intent queued",requestId:"later"});
 await f.service.tick();await until(()=>f.store.run(first.id).status==="interrupted");await f.service.close();
 expect(f.provider.state.callCount).toBe(0);expect(f.store.run(later.id).status).toBe("queued");expect(f.store.db.query("SELECT COUNT(*) n FROM inference_calls").get()).toEqual({n:0});expect(f.store.db.query("SELECT COUNT(*) n FROM durable_commits").get()).toEqual({n:1});
});
