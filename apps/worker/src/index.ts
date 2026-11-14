import { createPiRuntime } from "@laun/runtime";
import { loadWorkerConfig } from "./config.js";
import { OutboundWorker } from "./worker.js";
export { loadWorkerConfig, controllerUrl } from "./config.js";
export { OutboundWorker, type WorkerOptions } from "./worker.js";
export { WorkerJournal, type RunJournal } from "./journal.js";
export { WorkerClient, WorkerHttpError, WorkerTransportError } from "./client.js";

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log("Laun outbound yard worker\n\nEnroll a yard in the app, then set LAUN_CONTROLLER_URL and LAUN_WORKER_KEY.\nChoose OPENSHELL_ENABLED=true with OPENSHELL_SANDBOX_IMAGE, or explicitly\nchoose LAUN_TRUSTED_LOCAL=true for development. LAUN_WORKER_DIR stores\nper-thread sessions and the durable event outbox. Use --once for one poll.");
  } else {
    let worker: OutboundWorker | undefined;
    try {
      const config = loadWorkerConfig();
      worker = new OutboundWorker({ ...config, runtime: createPiRuntime(config.runtime), log: (line) => console.error(`[yard] ${line}`) });
      const close = () => { void worker?.close().finally(() => process.exit(0)); };
      process.once("SIGINT", close); process.once("SIGTERM", close);
      console.log(`[yard] connected configuration ready (${config.runtime.openshellEnabled ? "isolated" : "trusted-local"})`);
      if (process.argv.includes("--once")) { await worker.tick(); await worker.whenIdle(); await worker.close(); }
      else await worker.run();
    } catch (error) {
      console.error(`[yard] ${(error as Error).message}`); await worker?.close(); process.exitCode = 1;
    }
  }
}
