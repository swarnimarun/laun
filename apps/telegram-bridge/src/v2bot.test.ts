import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createV2Bot, v2DeliveryFor } from "./v2bot.js";
import { TelegramInbox } from "./v2inbox.js";
import type { BridgeConfig } from "./config.js";
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const info = {
  id: 123,
  is_bot: true as const,
  first_name: "Laun fixture",
  username: "laun_fixture",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
function configuration(gatewayUrl: string): BridgeConfig {
  const dataDir = mkdtempSync("/tmp/laun-grammy-admission-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    botToken: "123:" + "a".repeat(40),
    gatewayToken: "fixture-bridge-authority",
    gatewayUrl,
    allowlist: ["1"],
    defaultModel: "fixture/model",
    pollMs: 500,
    controlV2: true,
    dataDir,
    inboxKey: "stable-private-fixture-inbox-key-" + "x".repeat(32),
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("fake Telegram polling timed out");
    await Bun.sleep(5);
  }
}
const incoming = (update_id: number, text: string) => ({
  update_id,
  message: {
    message_id: update_id,
    date: 1,
    from: { id: 1, is_bot: false, first_name: "Owner" },
    chat: { id: 1, type: "private" as const, first_name: "Owner" },
    text,
  },
});

test("real grammY polling never acknowledges an update whose private inbox admission failed, then redelivers after restart", async () => {
  const offsets: number[] = [];
  let acknowledged = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/v2/"))
        return Response.json(
          { error: "controller temporarily unavailable" },
          { status: 503 },
        );
      const method = path.split("/").at(-1);
      if (method === "getMe") return Response.json({ ok: true, result: info });
      if (method === "deleteWebhook")
        return Response.json({ ok: true, result: true });
      if (method === "getUpdates") {
        const body = (await request.json()) as { offset?: number };
        const offset = Number(body.offset ?? 0);
        offsets.push(offset);
        if (offset > 101) acknowledged = true;
        await Bun.sleep(5);
        return Response.json({
          ok: true,
          result: acknowledged
            ? []
            : [incoming(101, "Keep this accepted intent durable")],
        });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  cleanups.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`,
    cfg = configuration(url),
    bot = createV2Bot(cfg, { client: { apiRoot: url, timeoutSeconds: 2 } });
  cleanups.push(async () => {
    if (bot.isRunning()) await bot.stop();
    await v2DeliveryFor(bot)?.stop();
  });
  const path = join(cfg.dataDir!, "inbox.sqlite"),
    db = new Database(path);
  db.transaction(() => {
    const insert = db.query(
      "INSERT INTO updates(bot_id,update_id,fingerprint,body,status) VALUES('123',?,?,?,'rejected')",
    );
    for (let index = 1000; index < 11000; index++)
      insert.run(index, "old-fingerprint", "rejected-encrypted-fixture");
  }).immediate();
  db.close();
  await expect(bot.start()).rejects.toThrow("could not be durably accepted");
  expect(acknowledged).toBe(false);
  expect(offsets.every((offset) => offset <= 101)).toBe(true);
  const maintenance = new Database(path);
  maintenance.query("DELETE FROM updates").run();
  maintenance.close();
  const restarted = createV2Bot(cfg, {
    client: { apiRoot: url, timeoutSeconds: 2 },
  });
  cleanups.push(async () => {
    if (restarted.isRunning()) await restarted.stop();
    await v2DeliveryFor(restarted)?.stop();
  });
  const polling = restarted.start();
  await until(() => acknowledged);
  const inbox = new TelegramInbox(path, cfg.inboxKey!);
  const accepted = inbox.pending();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.updateId).toBe(101);
  expect(accepted[0]!.text).toBe("Keep this accepted intent durable");
  inbox.close();
  await restarted.stop();
  await polling;
  await v2DeliveryFor(restarted)?.stop();
});

test("edited/media updates become minimal durable guidance and commands addressed to another bot are ignored", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "offline fixture" }, { status: 503 }),
  });
  cleanups.push(() => server.stop(true));
  const cfg = configuration(`http://127.0.0.1:${server.port}`),
    bot = createV2Bot(cfg, { botInfo: info });
  cleanups.push(() => v2DeliveryFor(bot)!.stop());
  await bot.handleUpdate(incoming(201, "Original immutable intent"));
  await bot.handleUpdate({
    update_id: 202,
    edited_message: {
      message_id: 201,
      date: 1,
      edit_date: 2,
      from: { id: 1, is_bot: false, first_name: "Owner" },
      chat: { id: 1, type: "private", first_name: "Owner" },
      text: "Edited secret goal must not become new work",
    },
  });
  await bot.handleUpdate({
    update_id: 203,
    message: {
      message_id: 203,
      date: 2,
      from: { id: 1, is_bot: false, first_name: "Owner" },
      chat: { id: -100, type: "supergroup", title: "Allowed elsewhere" },
      message_thread_id: 7,
      photo: [
        {
          file_id: "private-photo",
          file_unique_id: "photo",
          width: 1,
          height: 1,
        },
      ],
      caption: "Private attachment caption must stay out of agent input",
    },
  });
  await bot.handleUpdate(
    incoming(204, "/new@another_bot Do not start paid work"),
  );
  await bot.handleUpdate(
    incoming(206, "/new@another_bot! Still belongs to another bot"),
  );
  await bot.handleUpdate(
    incoming(205, "/new@LAUN_FIXTURE Addressed to this mower crew"),
  );
  const inbox = new TelegramInbox(
      join(cfg.dataDir!, "inbox.sqlite"),
      cfg.inboxKey!,
    ),
    pending = inbox.pending();
  expect(pending.map((update) => update.updateId)).toEqual([
    201, 202, 203, 205,
  ]);
  expect(pending[1]).toMatchObject({ notice: "edited", chatId: "1" });
  expect(pending[2]).toMatchObject({
    notice: "unsupported",
    chatId: "-100",
    topicId: "7",
  });
  expect(JSON.stringify(pending)).not.toContain("Edited secret");
  expect(JSON.stringify(pending)).not.toContain("Private attachment");
  expect(JSON.stringify(pending)).not.toContain("private-photo");
  inbox.close();
});
