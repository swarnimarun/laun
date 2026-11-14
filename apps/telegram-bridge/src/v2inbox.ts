import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { TelegramInboundUpdate } from "@laun/protocol";

/** Encrypted durable bridge admission, including short-lived account link codes. */
export class TelegramInbox {
  private db: Database;
  private key: Buffer;
  constructor(path: string, keyMaterial: string) {
    if (keyMaterial.length < 32) throw new Error("bridge inbox encryption material must be at least 32 characters");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = createHash("sha256").update(keyMaterial).digest();
    this.db = new Database(path, { create: true, strict: true }); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS updates(bot_id TEXT NOT NULL,update_id INTEGER NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(bot_id,update_id));");
    // Validate pending ciphertext before acknowledging any new Telegram update.
    try { this.pending(); } catch (error) { this.db.close(); this.key.fill(0); throw error; }
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }
  private decrypt(value: string): string {
    try {
      const [iv, tag, body] = value.split(".");
      const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv!, "base64url")); cipher.setAuthTag(Buffer.from(tag!, "base64url"));
      return Buffer.concat([cipher.update(Buffer.from(body!, "base64url")), cipher.final()]).toString("utf8");
    } catch { throw new Error("Cannot decrypt queued Telegram updates; restore the matching BRIDGE_INBOX_KEY before starting"); }
  }
  enqueue(update: TelegramInboundUpdate): void {
    const raw = JSON.stringify({ botId: update.botId, updateId: update.updateId, userId: update.userId, chatId: update.chatId,
      ...(update.topicId ? { topicId: update.topicId } : {}), ...(update.text !== undefined ? { text: update.text } : { callbackData: update.callbackData }) });
    if (Buffer.byteLength(raw) > 65_536) throw new Error("Telegram update is too large");
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    this.db.transaction(() => {
      const previous = this.db.query("SELECT fingerprint FROM updates WHERE bot_id=? AND update_id=?").get(update.botId, update.updateId) as { fingerprint: string } | null;
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Telegram update ID conflict"); return; }
      const count = this.db.query("SELECT COUNT(*) n FROM updates").get() as { n: number };
      if (count.n >= 10_000) throw new Error("Telegram durable inbox is full; preserve it and restore controller connectivity");
      this.db.query("INSERT INTO updates(bot_id,update_id,fingerprint,body) VALUES(?,?,?,?)").run(update.botId, update.updateId, fingerprint, this.encrypt(raw));
    }).immediate();
  }
  pending(): TelegramInboundUpdate[] {
    return (this.db.query("SELECT body FROM updates WHERE status='pending' ORDER BY update_id LIMIT 32").all() as { body: string }[]).map((row) => JSON.parse(this.decrypt(row.body)));
  }
  accepted(update: TelegramInboundUpdate): void { this.db.query("DELETE FROM updates WHERE bot_id=? AND update_id=?").run(update.botId, update.updateId); }
  rejected(update: TelegramInboundUpdate): void { this.db.query("UPDATE updates SET status='rejected' WHERE bot_id=? AND update_id=?").run(update.botId, update.updateId); }
  retryRejected(): void { this.db.query("UPDATE updates SET status='pending' WHERE status='rejected'").run(); }
  close(): void { this.db.close(); this.key.fill(0); }
}
