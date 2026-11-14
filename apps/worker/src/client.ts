import { controllerUrl } from "./config.js";
import type { RuntimeInferenceEnvelope, RuntimeInferenceRequest, WorkerInferenceStreamItem } from "@laun/protocol";

export class WorkerHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class WorkerTransportError extends Error {}

export class WorkerClient {
  private endpoint: string;
  constructor(endpoint: string, private key: string, private fetcher: typeof fetch = fetch) { this.endpoint = controllerUrl(endpoint); }
  async *inference(base:{runId:string;generation:number},request:RuntimeInferenceRequest,signal?:AbortSignal):AsyncIterable<RuntimeInferenceEnvelope>{
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),600_000);timer.unref();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{
      const response=await this.fetcher(`${this.endpoint}/api/v2/worker/inference`,{method:"POST",redirect:"error",signal:AbortSignal.any([deadline.signal,...(signal?[signal]:[])]),
        headers:{"content-type":"application/json",authorization:`Bearer ${this.key}`},body:JSON.stringify({...base,request})});
      if(!response.ok)throw new WorkerHttpError(`Controller refused model stream (HTTP ${response.status}); reconcile before retrying`,response.status);
      if(!response.body||!response.headers.get("content-type")?.startsWith("application/x-ndjson"))throw new WorkerTransportError("Invalid controller model stream");
      reader=response.body.getReader();const decoder=new TextDecoder("utf-8",{fatal:true});let pending="",bytes=0,done=false;
      for(;;){
        const part=await reader.read();if(part.done)break;
        bytes+=part.value.byteLength;if(bytes>32*1024*1024)throw new WorkerTransportError("Controller model stream exceeds limit");
        pending+=decoder.decode(part.value,{stream:true});
        for(;;){const end=pending.indexOf("\n");if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(line.length>2_097_152||done)throw new WorkerTransportError("Invalid controller model frame");
          const value=JSON.parse(line) as WorkerInferenceStreamItem;
          if(value.type==="done"){done=true;continue;}
          if(value.type!=="frame"||!value.frame||typeof value.frame.adapter!=="string"||value.frame.version!==1)throw new WorkerTransportError("Controller model stream interrupted; reconcile before resuming");
          yield value.frame;
        }
        if(pending.length>2_097_152)throw new WorkerTransportError("Controller model frame exceeds limit");
      }
      pending+=decoder.decode();if(pending.length||!done)throw new WorkerTransportError("Controller model stream ended without confirmation");
    }catch(error){
      if(error instanceof WorkerHttpError||error instanceof WorkerTransportError)throw error;
      if(signal?.aborted)throw new WorkerHttpError("worker model request cancelled",499);
      throw new WorkerTransportError("Controller model transport failed; execution stopped pending reconciliation");
    }finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});reader?.releaseLock();}
  }
  async request<T>(method: string, body: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    timer.unref();
    const signals = [controller.signal, ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.endpoint}/api/v2/worker/${method}`, { method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` }, body: JSON.stringify(body) });
      } catch {
        if (options.signal?.aborted) throw new WorkerHttpError("worker request cancelled", 499);
        throw new WorkerTransportError("controller transport failed or timed out; execution stopped pending reconciliation");
      }
      if (!response.body) throw new WorkerTransportError("controller returned no response body");
      const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = ""; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > (method==="checkpoint-download"?64*1024*1024:2_097_152)) throw new WorkerTransportError("controller response exceeds size limit");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new WorkerTransportError("controller returned invalid JSON"); }
      if (!response.ok) {
        const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `controller HTTP ${response.status}`;
        throw new WorkerHttpError(message.split(this.key).join("[REDACTED]"), response.status);
      }
      return value as T;
    } catch (error) {
      if (error instanceof WorkerHttpError || error instanceof WorkerTransportError) throw error;
      if (options.signal?.aborted) throw new WorkerHttpError("worker request cancelled", 499);
      throw new WorkerTransportError("controller response interrupted; outcome requires reconciliation");
    } finally { clearTimeout(timer); }
  }
}
