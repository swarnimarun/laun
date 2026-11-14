import { expect, test } from "bun:test";
import { inspectDiskReserve, requireDiskReserve } from "./admission.js";
test("real disk headroom is inspectable and exhaustion returns a typed admission failure",()=>{
 const healthy=inspectDiskReserve(import.meta.dir,0);expect(healthy.acceptingWork).toBe(true);expect(healthy.freeBytes).toBeGreaterThan(0);
 const blocked=inspectDiskReserve(import.meta.dir,Number.MAX_SAFE_INTEGER);expect(blocked.acceptingWork).toBe(false);expect(blocked.freeBytes).toBeGreaterThan(0);
 try{requireDiskReserve(import.meta.dir,Number.MAX_SAFE_INTEGER);throw new Error("expected storage failure");}catch(error){expect((error as {status:number}).status).toBe(507);}
});
