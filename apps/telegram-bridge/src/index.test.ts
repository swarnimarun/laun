import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { createBot } from "./bot.js";
import type { GatewayClient } from "./client.js";
import {
  BRIDGE_DISABLED_MESSAGE,
  TELEGRAM_PLACEHOLDER_TOKEN,
  isTelegramTokenDisabled,
  loadConfig,
} from "./config.js";
import { decodeApproval, encodeApproval, renderChunks, TG_MAX, usageLine } from "./format.js";

describe("bridge config", () => {
  test("gateway token is required; bot token is optional (disabled-by-default)", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow("GATEWAY_TOKEN");
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "b" } as NodeJS.ProcessEnv),
    ).toThrow("GATEWAY_TOKEN");
    expect(loadConfig({ GATEWAY_TOKEN: "g" } as NodeJS.ProcessEnv).botToken).toBe("");
  });

  test("parses allowlist", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "b",
      GATEWAY_TOKEN: "g",
      TELEGRAM_ALLOWLIST_IDS: "123, 456",
    } as NodeJS.ProcessEnv);
    expect(cfg.allowlist).toEqual(["123", "456"]);
  });
});

describe("format", () => {
  test("approval payload round-trips", () => {
    const enc = encodeApproval("abc123", "req-9", "approve");
    expect(decodeApproval(enc)).toEqual({ sessionId: "abc123", requestId: "req-9", decision: "approve" });
    expect(decodeApproval("bogus")).toBeNull();
  });

  test("renderChunks batches + caps length", () => {
    const events = [
      { type: "text", sessionId: "s", delta: "hello" },
      { type: "tool_call", sessionId: "s", name: "bash" },
      { type: "tool_result", sessionId: "s", name: "bash", ok: true },
      { type: "status", sessionId: "s", status: "running" },
      { type: "done", sessionId: "s", summary: "all good" },
    ] as never;
    const chunks = renderChunks(events);
    expect(chunks.join("\n")).toContain("hello");
    expect(chunks.join("\n")).toContain("🔧 bash");
    expect(chunks.join("\n")).toContain("✅ done");
    expect(chunks.every((c) => c.length <= TG_MAX)).toBe(true);
  });

  test("long text is truncated to the Telegram cap", () => {
    const big = { type: "text", sessionId: "s", delta: "x".repeat(TG_MAX + 100) } as never;
    const chunks = renderChunks([big]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(TG_MAX);
  });

  test("thinking renders with 💭", () => {
    const chunks = renderChunks([{ type: "thinking", sessionId: "s", delta: "considering options" }] as never);
    expect(chunks.join("\n")).toContain("💭");
    expect(chunks.join("\n")).toContain("considering options");
  });

  test("usage renders one compact line", () => {
    const chunks = renderChunks([
      {
        type: "usage",
        sessionId: "s",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.001,
      },
    ] as never);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("📊");
    expect(chunks[0]).toContain("100");
    expect(chunks[0]).toContain("50");
    expect(usageLine({})).toBe("📊 usage");
  });

  test("unknown event types are skipped, never crash", () => {
    const chunks = renderChunks([
      { type: "text", sessionId: "s", delta: "hi" },
      { type: "from_the_future", sessionId: "s" },
      null,
      undefined,
    ] as never);
    expect(chunks.join("\n")).toContain("hi");
  });
});

describe("disabled-by-default", () => {
  test("documented placeholder matches deploy/.env.example", () => {
    expect(TELEGRAM_PLACEHOLDER_TOKEN).toBe("123456:ABC-your-bot-token-from-BotFather");
    const example = readFileSync(new URL("../../../deploy/.env.example", import.meta.url), "utf8");
    expect(example).toContain(TELEGRAM_PLACEHOLDER_TOKEN);
  });

  test("isTelegramTokenDisabled", () => {
    expect(isTelegramTokenDisabled(undefined)).toBe(true);
    expect(isTelegramTokenDisabled(null)).toBe(true);
    expect(isTelegramTokenDisabled("")).toBe(true);
    expect(isTelegramTokenDisabled("   ")).toBe(true);
    expect(isTelegramTokenDisabled(TELEGRAM_PLACEHOLDER_TOKEN)).toBe(true);
    expect(isTelegramTokenDisabled(`  ${TELEGRAM_PLACEHOLDER_TOKEN}\n`)).toBe(true);
    expect(isTelegramTokenDisabled("123456:ABC-real-token-here")).toBe(false);
  });

  test("missing token exits 0 with the disabled line", async () => {
    const r = await runBridge(undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(BRIDGE_DISABLED_MESSAGE);
  }, 30_000);

  test("placeholder token exits 0 with the disabled line (no login attempt)", async () => {
    // A real login attempt with this token would fail auth (exit != 0), so a
    // clean exit 0 proves we never called Telegram.
    const r = await runBridge(TELEGRAM_PLACEHOLDER_TOKEN);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(BRIDGE_DISABLED_MESSAGE);
  }, 30_000);
});

const LANE_ROOT = new URL("../../..", import.meta.url).pathname;

async function runBridge(token: string | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env["TELEGRAM_BOT_TOKEN"];
  if (token !== undefined) env["TELEGRAM_BOT_TOKEN"] = token;
  const proc = Bun.spawn(["bun", "apps/telegram-bridge/src/index.ts"], {
    cwd: LANE_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout ?? undefined).text(),
    new Response(proc.stderr ?? undefined).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("bridge bot", () => {
  test("/log replies with the last n rendered events in order", async () => {
    const events = [
      { type: "text", sessionId: "s1", delta: "first line" },
      { type: "thinking", sessionId: "s1", delta: "pondering" },
      { type: "usage", sessionId: "s1", inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
      { type: "text", sessionId: "s1", delta: "second line" },
      { type: "error", sessionId: "s1", message: "boom" },
    ];
    const { bot, sent } = stubBot({ getLog: async () => ({ events: events as never, next: events.length }) });
    await bot.handleUpdate(textUpdate("/log s1 3", 4));
    const body = sent.map((s) => s.text).join("\n");
    expect(body).not.toContain("first line");
    expect(body).not.toContain("pondering");
    const ui = body.indexOf("📊");
    const si = body.indexOf("second line");
    const bi = body.indexOf("boom");
    expect(ui).toBeGreaterThanOrEqual(0);
    expect(si).toBeGreaterThan(ui);
    expect(bi).toBeGreaterThan(si);
  });

  test("/log defaults to 10 and skips unknown types", async () => {
    const events: unknown[] = [];
    for (let i = 0; i < 12; i++) events.push({ type: "text", sessionId: "s", delta: `line-${i}` });
    events.splice(5, 0, { type: "from_the_future", sessionId: "s" });
    const { bot, sent } = stubBot({
      getLog: async () => ({ events: events as never, next: events.length }),
    });
    await bot.handleUpdate(textUpdate("/log s9", 4));
    const lines = sent.map((s) => s.text).join("\n").split("\n");
    expect(lines).toContain("line-11");
    expect(lines).toContain("line-3");
    expect(lines).not.toContain("line-0");
    expect(lines).not.toContain("line-1");
    expect(lines).not.toContain("line-2");
  });

  test("/log names the 50-event cap instead of silently truncating", async () => {
    const events: unknown[] = [];
    for (let i = 0; i < 60; i++) events.push({ type: "text", sessionId: "s", delta: `line-${i}` });
    const { bot, sent } = stubBot({
      getLog: async () => ({ events: events as never, next: events.length }),
    });
    await bot.handleUpdate(textUpdate("/log s 100", 4));
    const body = sent.map((s) => s.text).join("\n");
    expect(body).toContain("(showing last 50 of 100 requested)");
    expect(body).toContain("line-59");
    expect(body).not.toContain("line-0");
  });

  test("/log without an id shows usage", async () => {
    const { bot, sent } = stubBot({});
    await bot.handleUpdate(textUpdate("/log", 4));
    expect(sent.map((s) => s.text).join("\n")).toContain("usage: /log");
  });

  test("busy 409 follow-up reply stays graceful and actionable", async () => {
    const busy = new Error("gateway 409: busy") as Error & { status: number };
    busy.status = 409;
    const { bot, sent } = stubBot({
      createSession: async () => ({
        id: "sess9",
        goal: "build thing",
        model: "m",
        runtime: "pi",
        status: "pending",
        createdAt: "",
        updatedAt: "",
      }),
      getSession: async () => ({
        session: {
          id: "sess9",
          goal: "build thing",
          model: "m",
          runtime: "pi",
          status: "running",
          createdAt: "",
          updatedAt: "",
        },
        pendingApprovals: [],
      }),
      sendMessage: async () => {
        throw busy;
      },
      getLog: async () => ({ events: [{ type: "done", sessionId: "sess9", summary: "ok" }], next: 1 }),
    });
    await bot.handleUpdate(textUpdate("/new build thing", 4));
    await bot.handleUpdate(textUpdate("keep going"));
    const body = sent.map((s) => s.text).join("\n");
    expect(body).toContain("sess9");
    expect(body).toContain("busy");
    expect(body).toContain("/status sess9");
    expect(body).toContain("/log sess9");
    expect(body).toContain("not sent");
    expect(body).toContain("try again shortly");
  });

  test("non-409 send failure still replies gracefully", async () => {
    const failed = new Error("gateway 500: boom") as Error & { status: number };
    failed.status = 500;
    const { bot, sent } = stubBot({
      createSession: async () => ({
        id: "sess7",
        goal: "other",
        model: "m",
        runtime: "pi",
        status: "pending",
        createdAt: "",
        updatedAt: "",
      }),
      getSession: async () => ({
        session: {
          id: "sess7",
          goal: "other",
          model: "m",
          runtime: "pi",
          status: "running",
          createdAt: "",
          updatedAt: "",
        },
        pendingApprovals: [],
      }),
      sendMessage: async () => {
        throw failed;
      },
      getLog: async () => ({ events: [{ type: "done", sessionId: "sess7", summary: "ok" }], next: 1 }),
    });
    await bot.handleUpdate(textUpdate("/new other", 4));
    await bot.handleUpdate(textUpdate("keep going"));
    expect(sent.map((s) => s.text).join("\n")).toContain("send failed");
  });
});

interface SentCall {
  method: string;
  text: string;
}

function stubBot(gw: Partial<GatewayClient>): { bot: ReturnType<typeof createBot>; sent: SentCall[] } {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    GATEWAY_TOKEN: "g",
    TELEGRAM_ALLOWLIST_IDS: "123",
    BRIDGE_POLL_MS: "500",
  } as NodeJS.ProcessEnv);
  const bot = createBot(cfg, gw as unknown as GatewayClient);
  bot.botInfo = { id: 1, is_bot: true, first_name: "test", username: "testbot" } as never;
  const sent: SentCall[] = [];
  const capture: Transformer = async (_prev, method, payload) => {
    if (method === "sendMessage") {
      const text = (payload as { text?: unknown }).text;
      sent.push({ method, text: typeof text === "string" ? text : "" });
      return {
        ok: true,
        result: { message_id: sent.length, chat: { id: 7, type: "private" }, date: 1700000000, text: "" },
      } as never;
    }
    return { ok: true, result: true } as never;
  };
  bot.api.config.use(capture);
  return { bot, sent };
}

let updateSeq = 1;

function textUpdate(text: string, commandLength?: number): Update {
  const id = updateSeq++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1700000000,
      chat: { id: 7, type: "private" },
      from: { id: 123, is_bot: false, first_name: "tester" },
      text,
      ...(commandLength !== undefined
        ? { entities: [{ offset: 0, length: commandLength, type: "bot_command" }] }
        : {}),
    },
  } as unknown as Update;
}
