import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@laun/protocol";
import { loadConfig } from "./config.js";
import { checkoutRepo, createHandler, normalizeRepo, type GooseRunner } from "./server.js";

/** Poll `cond` every 25ms until true or `timeoutMs` elapses (throws). */
async function pollFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function authed(path: string, body: unknown, token = "t"): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A committed git repo usable as a file:// clone source (offline). */
function initSourceRepo(dir: string): string {
  const src = join(dir, "src-repo");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "hello.txt"), "hi\n");
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: src, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "add", "."]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init"]);
  return src;
}

describe("normalizeRepo", () => {
  test("absent repo is unset", () => {
    expect(normalizeRepo(undefined)).toBeUndefined();
    expect(normalizeRepo(null)).toBeUndefined();
  });

  test("rejects bad shapes with 400", () => {
    for (const bad of ["", "   ", 42, "-evil", "x".repeat(2001), "a\0b", "has\nnewline"]) {
      let status = 0;
      try {
        normalizeRepo(bad);
      } catch (e) {
        status = (e as { status?: number }).status ?? 0;
      }
      expect(status).toBe(400);
    }
  });

  test("accepts URLs and scp-like remotes", () => {
    expect(normalizeRepo("https://example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(normalizeRepo("  file:///tmp/r  ")).toBe("file:///tmp/r");
    expect(normalizeRepo("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });
});

describe("checkoutRepo", () => {
  test("URL clones shallow into an empty workdir", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-repo-"));
    const src = initSourceRepo(dir);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    checkoutRepo(work, `file://${src}`);
    expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("hi\n");
    expect(existsSync(join(work, ".git"))).toBe(true);
    const shallow = spawnSync("git", ["-C", work, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" });
    expect(shallow.stdout.trim()).toBe("true");
  });

  test("populated workdir skips (idempotent, never wipes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-repo-skip-"));
    const src = initSourceRepo(dir);
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "sentinel.txt"), "keep\n");
    checkoutRepo(work, `file://${src}`);
    expect(readFileSync(join(work, "sentinel.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(work, ".git"))).toBe(false);
  });

  test("escape shapes and missing paths are refused (400)", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-repo-esc-"));
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    // Existing dir, but reaches it via `..`: escape, refused. NOTE: the
    // first entry is raw string concat, not join() — join normalizes the
    // `..` away before checkoutRepo ever sees it.
    for (const bad of [`${work}/../other`, "../evil", "/nonexistent/laun-repo-xyz", "just some words"]) {
      let status = 0;
      try {
        checkoutRepo(work, bad);
      } catch (e) {
        status = (e as { status?: number }).status ?? 0;
      }
      expect(status).toBe(400);
    }
  });

  test("clone failure is loud (500)", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-repo-fail-"));
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    let status = 0;
    let message = "";
    try {
      checkoutRepo(work, "file:///nonexistent/laun-repo-xyz");
    } catch (e) {
      status = (e as { status?: number }).status ?? 0;
      message = (e as Error).message;
    }
    expect(status).toBe(500);
    expect(message).toMatch(/checkout/i);
  });
});

describe("POST /run with repo", () => {
  function handler(dir: string) {
    return createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: "true",
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
    });
  }

  test("checks out before the agent starts; failure never wedges the slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-run-repo-"));
    const src = initSourceRepo(dir);
    const h = handler(dir);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "r1", prompt: "hi", repo: `file://${src}` }));
      expect(res.status).toBe(200);
      await res.text();
      expect(readFileSync(join(dir, "r1", "work", "hello.txt"), "utf8")).toBe("hi\n");
      // Bad repo: loud 400, slot stays free for the retry.
      const bad = await h.handleRun(authed("/run", { sessionId: "r2", prompt: "hi", repo: "../evil" }));
      expect(bad.status).toBe(400);
      expect(h.busy.size).toBe(0);
      // Failed clone: loud 500, slot stays free.
      const fail = await h.handleRun(authed("/run", { sessionId: "r3", prompt: "hi", repo: "file:///nonexistent/laun-repo-xyz" }));
      expect(fail.status).toBe(500);
      expect(h.busy.size).toBe(0);
    } finally {
      h.close();
    }
  });

  test("invalid runtime is 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-run-rt-"));
    const h = handler(dir);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "s1", prompt: "hi", runtime: "bogus" }));
      expect(res.status).toBe(400);
    } finally {
      h.close();
    }
  });
});

describe("ACP runtime wiring", () => {
  function gooseHandler(dir: string, runner: GooseRunner, extra: Record<string, unknown> = {}) {
    return createHandler(
      {
        port: 0,
        gatewayToken: "t",
        sessionDir: dir,
        // If pi ever spawned, this binary would fail the run loudly —
        // its absence from every assertion below proves routing.
        piBin: "laun-definitely-not-a-binary",
        defaultModel: "m",
        openshellEnabled: false,
        openshellPrefix: [],
        defaultTimeoutMs: 30_000,
        gooseUrl: "http://127.0.0.1:9",
        gooseSecret: "fake-secret-for-tests",
        ...extra,
      } as Parameters<typeof createHandler>[0],
      { gooseRunner: runner },
    );
  }

  test("goose runtime routes to runGoose with prompt/workdir; pi never spawns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-"));
    const seen: Array<{ prompt: string; workdir: string }> = [];
    const runner: GooseRunner = async (opts) => {
      seen.push({ prompt: opts.prompt, workdir: opts.config.workdir });
      opts.onEvent({ type: "approval_request", sessionId: opts.sessionId, requestId: "g-1", reason: "permission requested: shell" });
      opts.onEvent({ type: "done", sessionId: opts.sessionId });
      return { sawError: false, sawDone: true, aborted: false, timedOut: false };
    };
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "do the thing", runtime: "goose" }));
      expect(res.status).toBe(200);
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.prompt).toBe("do the thing");
      expect(seen[0]!.workdir.endsWith(join("g1", "work"))).toBe(true);
      // Permission mapped to approval_request; pi never spawned (no
      // "failed to start agent", terminal done present).
      expect(events.some((e) => e.type === "approval_request" && e.requestId === "g-1")).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
      expect(h.busy.size).toBe(0);
    } finally {
      h.close();
    }
  });

  test("dots runtime uses the same adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-dots-"));
    let calls = 0;
    const runner: GooseRunner = async (opts) => {
      calls++;
      opts.onEvent({ type: "done", sessionId: opts.sessionId });
      return { sawError: false, sawDone: true, aborted: false, timedOut: false };
    };
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "d1", prompt: "hi", runtime: "dots" }));
      expect(res.status).toBe(200);
      await res.text();
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });

  test("unconfigured goose fails loudly without calling the runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-nocfg-"));
    let calls = 0;
    const runner: GooseRunner = async (opts) => {
      calls++;
      opts.onEvent({ type: "done", sessionId: opts.sessionId });
      return { sawError: false, sawDone: true, aborted: false, timedOut: false };
    };
    const h = gooseHandler(dir, runner, { gooseUrl: "", gooseSecret: "" });
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "hi", runtime: "goose" }));
      expect(res.status).toBe(200); // stream starts, then the run errors loudly
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(calls).toBe(0);
      expect(events.some((e) => e.type === "error" && (e.message ?? "").includes("not configured"))).toBe(true);
      expect(h.busy.size).toBe(0);
    } finally {
      h.close();
    }
  });

  test("POST /approvals acks a live goose permission (200)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-appr-live-"));
    let emitted = false;
    const runner: GooseRunner = (opts) =>
      new Promise((resolve) => {
        opts.onEvent({ type: "approval_request", sessionId: opts.sessionId, requestId: "g-live", reason: "perm" });
        emitted = true; // onEvent recorded the entry synchronously above
        opts.signal?.addEventListener("abort", () =>
          resolve({ sawError: true, sawDone: false, aborted: true, timedOut: false }),
        );
      });
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "hi", runtime: "goose" }));
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => emitted, "goose permission event");
      const ok = await h.handleApprovals(authed("/approvals", { sessionId: "g1", requestId: "g-live", decision: "approve" }));
      expect(ok.status).toBe(200);
      await h.handleAbort(authed("/abort", { sessionId: "g1" }));
      await textP;
      expect(h.busy.size).toBe(0);
    } finally {
      h.close();
    }
  }, 20_000);

  test("approve after goose run end is 404, not 200 (stale pending cleared)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-appr-stale-"));
    const runner: GooseRunner = async (opts) => {
      opts.onEvent({ type: "approval_request", sessionId: opts.sessionId, requestId: "g-9", reason: "perm" });
      opts.onEvent({ type: "done", sessionId: opts.sessionId });
      return { sawError: false, sawDone: true, aborted: false, timedOut: false };
    };
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "hi", runtime: "goose" }));
      expect(res.status).toBe(200);
      await res.text(); // run ended; finally dropped the session entry
      expect(h.busy.size).toBe(0);
      const stale = await h.handleApprovals(authed("/approvals", { sessionId: "g1", requestId: "g-9", decision: "deny" }));
      expect(stale.status).toBe(404);
      const unknown = await h.handleApprovals(authed("/approvals", { sessionId: "g1", requestId: "nope", decision: "deny" }));
      expect(unknown.status).toBe(404);
    } finally {
      h.close();
    }
  });

  test("abort stops a goose run and frees the slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-abort-"));
    const runner: GooseRunner = (opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ sawError: true, sawDone: false, aborted: true, timedOut: false }),
        );
      });
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "hi", runtime: "goose" }));
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => h.busy.has("g1"), "goose run start");
      const abortRes = await h.handleAbort(authed("/abort", { sessionId: "g1" }));
      expect(abortRes.status).toBe(200);
      const events = (await textP).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "status" && e.message === "aborted by user")).toBe(true);
      expect(h.busy.size).toBe(0);
    } finally {
      h.close();
    }
  }, 20_000);

  test("steer on a goose run is 409 with a clear message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-goose-steer-"));
    const runner: GooseRunner = (opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ sawError: true, sawDone: false, aborted: true, timedOut: false }),
        );
      });
    const h = gooseHandler(dir, runner);
    try {
      const res = await h.handleRun(authed("/run", { sessionId: "g1", prompt: "hi", runtime: "goose" }));
      const textP = res.text();
      await pollFor(() => h.busy.has("g1"), "goose run start");
      const steerRes = await h.handleSteer(authed("/steer", { sessionId: "g1", text: "left" }));
      expect(steerRes.status).toBe(409);
      expect(((await steerRes.json()) as { error: string }).error).toMatch(/goose/i);
      await h.handleAbort(authed("/abort", { sessionId: "g1" }));
      await textP;
    } finally {
      h.close();
    }
  }, 20_000);
});

describe("executor config additions", () => {
  test("approval timeout defaults to 5m and parses", () => {
    expect(loadConfig({ GATEWAY_TOKEN: "s" } as NodeJS.ProcessEnv).approvalTimeoutMs).toBe(300_000);
    expect(loadConfig({ GATEWAY_TOKEN: "s", APPROVAL_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv).approvalTimeoutMs).toBe(5000);
    for (const v of ["99", "0", "-1", "nope", "3600001"]) {
      expect(() => loadConfig({ GATEWAY_TOKEN: "s", APPROVAL_TIMEOUT_MS: v } as NodeJS.ProcessEnv)).toThrow("APPROVAL_TIMEOUT_MS");
    }
  });

  test("goose env loads; bad URL fails closed", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s", GOOSE_URL: "http://127.0.0.1:3284", GOOSE_SECRET: "sek" } as NodeJS.ProcessEnv);
    expect(cfg.gooseUrl).toBe("http://127.0.0.1:3284");
    expect(cfg.gooseSecret).toBe("sek");
    expect(loadConfig({ GATEWAY_TOKEN: "s" } as NodeJS.ProcessEnv).gooseUrl).toBe("");
    expect(() => loadConfig({ GATEWAY_TOKEN: "s", GOOSE_URL: "not a url" } as NodeJS.ProcessEnv)).toThrow("GOOSE_URL");
    expect(() => loadConfig({ GATEWAY_TOKEN: "s", GOOSE_URL: "ftp://x" } as NodeJS.ProcessEnv)).toThrow("GOOSE_URL");
  });
});
