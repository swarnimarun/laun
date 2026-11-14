import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ControlService,
  ControlStore,
  handleTelegramConnectorRequest,
  type TelegramConnectorOptions,
} from "@laun/control";
import type { ThreadRecord } from "@laun/protocol";
import type { BridgeConfig } from "./config.js";
import { V2GatewayClient } from "./v2client.js";
import { loadConfig } from "./config.js";
import { V2Delivery, type TelegramSender } from "./v2delivery.js";
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const owner = { id: `user_${"a".repeat(32)}`, admin: false };
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("delivery fixture timed out");
    await Bun.sleep(5);
  }
}
function fixture() {
  const data = mkdtempSync("/tmp/laun-v2-send-");
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const store = new ControlStore(join(data, "control.sqlite")),
    service = new ControlService({
      store,
      dataDir: join(data, "controller"),
      mode: "unconfigured",
      defaultModel: "fixture/model",
    }),
    options: TelegramConnectorOptions = {
      serviceToken: "bridge-private-authority",
      botId: "123",
      allowlist: ["1"],
      defaultModel: "fixture/model",
    };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return (
        (await handleTelegramConnectorRequest(
          service,
          request,
          options,
          request.headers.get("authorization") === "Bearer human-fixture"
            ? owner
            : null,
        )) ?? new Response("not found", { status: 404 })
      );
    },
  });
  cleanups.push(async () => {
    server.stop(true);
    await service.close();
    store.close();
  });
  const url = `http://127.0.0.1:${server.port}`,
    client = new V2GatewayClient(url, options.serviceToken, "123");
  let update = 0;
  const human = async (method: string, body?: unknown) => {
    const response = await fetch(`${url}/api/v2/identity/telegram-link`, {
      method,
      headers: {
        authorization: "Bearer human-fixture",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`human fixture HTTP${response.status}`);
    return response.json() as Promise<any>;
  };
  const send = (text: string) =>
    client.ingest({
      botId: "123",
      updateId: ++update,
      userId: "1",
      chatId: "1",
      text,
    });
  const clear = async () => {
    for (let n = 0; n < 20; n++) {
      const { deliveries } = await client.poll();
      if (!deliveries.length) return;
      for (const d of deliveries)
        await client.ack(d, { status: "delivered", messageId: "fixture" });
    }
    throw new Error("fixture outbox did not drain");
  };
  const link = async () => {
    const code = await human("POST");
    await send(`/link ${code.code}`);
    await clear();
  };
  const cfg: BridgeConfig = {
    botToken: "123:" + "t".repeat(40),
    gatewayUrl: url,
    gatewayToken: options.serviceToken,
    bridgeToken: options.serviceToken,
    inboxKey: "private-stable-fixture-inbox-key-" + "z".repeat(32),
    allowlist: ["1"],
    pollMs: 500,
    defaultModel: "fixture/model",
    controlV2: true,
    dataDir: join(data, "bridge"),
  };
  return {
    store,
    service,
    options,
    url,
    client,
    cfg,
    send,
    link,
    clear,
    human,
  };
}
function bridge(
  c: ReturnType<typeof fixture>,
  sender: TelegramSender,
  options: ConstructorParameters<typeof V2Delivery>[2] = {},
) {
  const delivery = new V2Delivery(c.cfg, sender, {
    minChatIntervalMs: 0,
    ...options,
  });
  cleanups.push(() => delivery.stop());
  return delivery;
}
test("v2 credentials require TLS outside loopback unless trusted network HTTP is explicitly configured", () => {
  const environment = {
    GATEWAY_TOKEN: "fixture-secret",
    LAUN_CONTROL_V2: "true",
  };
  for (const url of [
    "http://public.example:8080",
    "http://10.0.0.2:8080",
    "http://gateway:8080",
  ]) {
    expect(() => new V2GatewayClient(url, "secret", "123")).toThrow(
      "require HTTPS",
    );
    expect(() => loadConfig({ ...environment, GATEWAY_URL: url })).toThrow(
      "require HTTPS",
    );
    expect(
      loadConfig({
        ...environment,
        GATEWAY_URL: url,
        BRIDGE_ALLOW_INSECURE_NETWORK: "true",
      }).allowInsecureNetwork,
    ).toBe(true);
    expect(
      () =>
        new V2GatewayClient(url, "secret", "123", undefined, {
          allowInsecureNetwork: true,
        }),
    ).not.toThrow();
  }
  for (const url of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://public.example",
  ]) {
    expect(() => new V2GatewayClient(url, "secret", "123")).not.toThrow();
    expect(() =>
      loadConfig({ ...environment, GATEWAY_URL: url }),
    ).not.toThrow();
  }
  expect(() =>
    loadConfig({ ...environment, BRIDGE_ALLOW_INSECURE_NETWORK: "yes" }),
  ).toThrow("true or false");
  expect(
    () =>
      new V2GatewayClient(
        "https://user:secret@public.example",
        "secret",
        "123",
        undefined,
        { allowInsecureNetwork: true },
      ),
  ).toThrow("credentials");
  expect(
    loadConfig({
      GATEWAY_TOKEN: "legacy-fixture",
      GATEWAY_URL: "http://legacy.example",
    }).controlV2,
  ).toBe(false);
});

test("unlink during the throttle interval is revalidated immediately before send", async () => {
  const c = fixture();
  await c.link();
  await c.send("/help");
  let polls = 0,
    claimedSecond = false;
  const verifiedAt: number[] = [],
    sentAt: number[] = [],
    client = new V2GatewayClient(c.url, c.options.serviceToken, "123", (async (
      input,
      options,
    ) => {
      const response = await fetch(input, options);
      if (String(input).endsWith("/poll") && ++polls === 2)
        claimedSecond = true;
      if (String(input).endsWith("/verify")) verifiedAt.push(Date.now());
      return response;
    }) as typeof fetch),
    delivery = bridge(
      c,
      {
        sendMessage: async () => {
          sentAt.push(Date.now());
          return { message_id: sentAt.length };
        },
      },
      { client, minChatIntervalMs: 120 },
    );
  await delivery.pump();
  expect(sentAt).toHaveLength(1);
  await c.send("/help");
  const sending = delivery.pump();
  await until(() => claimedSecond);
  await c.human("DELETE", { userId: "1" });
  await sending;
  expect(verifiedAt).toHaveLength(2);
  expect(verifiedAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(100);
  expect(sentAt).toHaveLength(1);
  expect(
    c.store.db
      .query("SELECT COUNT(*) n FROM outbox WHERE status='cancelled'")
      .get(),
  ).toMatchObject({ n: 1 });
});
test("pre-send verification transport failure sends no message and redacts every configured secret", async () => {
  const c = fixture();
  await c.link();
  await c.send("/help");
  let sent = 0;
  const logs: string[] = [],
    client = new V2GatewayClient(c.url, c.options.serviceToken, "123", (async (
      input,
      options,
    ) =>
      String(input).endsWith("/verify")
        ? Response.json(
            {
              error: `unavailable ${c.cfg.botToken} ${c.cfg.gatewayToken} ${c.cfg.inboxKey}`,
            },
            { status: 503 },
          )
        : fetch(input, options)) as typeof fetch),
    delivery = bridge(
      c,
      {
        sendMessage: async () => {
          sent++;
          return { message_id: 1 };
        },
      },
      { client, log: (value) => logs.push(value) },
    );
  await delivery.pump();
  expect(sent).toBe(0);
  expect(
    c.store.db
      .query("SELECT COUNT(*) n FROM outbox WHERE status='sending'")
      .get(),
  ).toMatchObject({ n: 1 });
  for (const secret of [c.cfg.botToken, c.cfg.gatewayToken, c.cfg.inboxKey!])
    expect(logs.join("\n")).not.toContain(secret);
  await delivery.pump();
  expect(sent).toBe(0);
});
test("a known429 cannot let later answer chunks overtake the rejected first chunk", async () => {
  const c = fixture();
  await c.link();
  await c.send("/new preserve answer order");
  await c.clear();
  const thread = c.store.list<ThreadRecord>("thread", owner)[0]!,
    mower = c.store.get<any>("mower", thread.mowerId),
    full = "A".repeat(3500) + "B".repeat(3500) + "C".repeat(700);
  c.store.event(thread.id, "agent", {
    event: { type: "text", sessionId: thread.id, delta: full },
  });
  let calls = 0;
  const delivered: string[] = [],
    delivery = bridge(c, {
      sendMessage: async (_chat, text) => {
        calls++;
        if (calls === 1)
          throw { error_code: 429, parameters: { retry_after: 30 } };
        delivered.push(text);
        return { message_id: calls };
      },
    });
  await delivery.pump();
  expect(calls).toBe(1);
  await delivery.pump();
  expect(calls).toBe(1);
  expect(delivered).toEqual([]);
  c.store.db
    .query("UPDATE telegram_deliveries SET next_at='2000-01-01T00:00:00Z'")
    .run();
  for (let n = 0; n < 8; n++) await delivery.pump();
  expect(delivered.join("")).toBe(`[${mower.name} · ${thread.title}]\n${full}`);
  expect(delivered).toHaveLength(3);
});
