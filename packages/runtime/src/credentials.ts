import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Controller-only credential file. Never place this below sessionDir/workspaceRoot. */
export class FileCredentialStore implements CredentialStore {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private load(): Record<string, Credential> {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("cannot read provider credential store"); }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("invalid provider credential store JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider credential store");
    for (const credential of Object.values(value)) {
      if (!credential || typeof credential !== "object" || !["api_key", "oauth"].includes(credential.type)) throw new Error("invalid provider credential record");
      if (credential.type === "api_key" && credential.key !== undefined && typeof credential.key !== "string") throw new Error("invalid API key credential record");
      if (credential.type === "oauth" && (typeof credential.access !== "string" || typeof credential.refresh !== "string" || typeof credential.expires !== "number")) throw new Error("invalid OAuth credential record");
    }
    return value as Record<string, Credential>;
  }
  private async ordered<T>(change: () => T | Promise<T>): Promise<T> {
    const result = this.serial.then(change, change);
    this.serial = result.catch(() => {});
    return result;
  }
  private save(credentials: Record<string, Credential>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(credentials, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
    } catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  }
  read(providerId: string): Promise<Credential | undefined> {
    return this.ordered(() => { const values = this.load(); return Object.hasOwn(values, providerId) ? structuredClone(values[providerId]) : undefined; });
  }
  list(): Promise<readonly CredentialInfo[]> {
    return this.ordered(() => Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type })));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.ordered(async () => {
      const credentials = this.load();
      const value = await fn(structuredClone(credentials[providerId]));
      if (value !== undefined) {
        Object.defineProperty(credentials, providerId, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
        this.save(credentials);
      }
      return structuredClone(credentials[providerId]);
    });
  }
  delete(providerId: string): Promise<void> {
    return this.ordered(() => { const credentials = this.load(); delete credentials[providerId]; this.save(credentials); });
  }
}
