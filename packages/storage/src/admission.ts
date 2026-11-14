import { statfsSync } from "node:fs";
import type {DiskReserve} from "@laun/protocol";
export type {DiskReserve} from "@laun/protocol";
export class StorageAdmissionError extends Error {readonly status=507;}
/** Admission headroom, not a filesystem quota or a substitute for host limits. */
export function inspectDiskReserve(path:string,minimumBytes=512*1024*1024):DiskReserve{
 if(!Number.isSafeInteger(minimumBytes)||minimumBytes<0)throw new Error("invalid storage reserve");
 const stat=statfsSync(path,{bigint:true}),free=stat.bavail*stat.bsize;
 const freeBytes=Number(free>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):free);
 const inodesExhausted=stat.files>0n&&stat.ffree===0n,acceptingWork=freeBytes>=minimumBytes&&!inodesExhausted;
 return {freeBytes,minimumBytes,acceptingWork,message:acceptingWork?undefined:inodesExhausted?"Controller storage has no free file entries; free space before admitting more work":`Storage reserve reached: ${Math.floor(freeBytes/1048576)} MiB free; ${Math.ceil(minimumBytes/1048576)} MiB required before admitting more work`};
}
export function requireDiskReserve(path:string,minimumBytes?:number):DiskReserve{
 const result=inspectDiskReserve(path,minimumBytes);if(!result.acceptingWork)throw new StorageAdmissionError(result.message);return result;
}
