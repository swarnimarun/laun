import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Advisory single-writer guard; ambiguous live PID ownership fails closed. */
export function lockThread(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".laun-runtime-lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      return () => { try { if (JSON.parse(readFileSync(path, "utf8")).token === token) rmSync(path); } catch {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: { pid: number; token: string };
      try { previous = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("runtime writer lock is corrupt; inspect it before recovery"); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("invalid runtime writer lock");
      try { process.kill(previous.pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("cannot verify runtime writer ownership");
        // Only recover an unchanged stale lock. Another recovery winner gets
        // exclusive creation next; never remove a live writer deliberately.
        if (readFileSync(path, "utf8") !== JSON.stringify(previous)) throw new Error("runtime writer lock changed during recovery");
        rmSync(path);
        continue;
      }
      throw new Error("thread runtime already has a live writer");
    }
  }
  throw new Error("could not acquire thread runtime writer lock");
}
