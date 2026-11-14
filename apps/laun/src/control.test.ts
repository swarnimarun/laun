import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ControlService,
  ControlStore,
  handleControlRequest,
} from "@laun/control";
import type {
  ControlApproval,
  ControlRun,
  MowerRecord,
  StoredProfile,
  ThreadRecord,
  WorkerRecord,
} from "@laun/protocol";
import { main, type Io } from "./index.js";
import { saveNamedTarget, loadTarget } from "./config.js";
import { yardSetupCommand } from "./yard-cli.js";
import { GatewayClient } from "./client.js";

describe("durable v2 CLI through real controller HTTP routes", () => {
  let directory: string, store: ControlStore, service: ControlService;
  let server: ReturnType<typeof Bun.serve>, mcp: ReturnType<typeof Bun.serve>;
  let env: NodeJS.ProcessEnv;
  let onRequest: ((path: string) => void) | undefined;
  let routeResponse: ((path: string) => Response | undefined) | undefined;
  const owner = { id: "cli-owner", admin: true };
  const key = "private-cli-fixture-key";
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const invoke = async (argv: string[]) => {
    const output: string[] = [],
      errors: string[] = [];
    const io: Io = {
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      write: (text) => output.push(text),
    };
    const code = await main(argv, env, io);
    return {
      code,
      output,
      errors,
      data: () => JSON.parse(output.at(-1) ?? "null") as any,
    };
  };
  const mower = () =>
    store.createMower(owner, {
      name: crypto.randomUUID(),
      role: "director",
      model: "fixture/model",
    });
  const thread = (m = mower()) =>
    store.createThread(owner, { mowerId: m.id, title: "Fixture thread" });
  const submit = (t = thread()) =>
    store.submit(owner, t.id, {
      text: "Durable work",
      requestId: crypto.randomUUID(),
    });
  const inputFile = async (body: unknown) => {
    const path = join(directory, `${crypto.randomUUID()}.json`);
    await writeFile(path, JSON.stringify(body));
    return path;
  };

  beforeEach(async () => {
    onRequest = undefined;
    routeResponse = undefined;
    requests.length = 0;
    directory = await mkdtemp(join(tmpdir(), "laun-cli-v2-"));
    store = new ControlStore(join(directory, "control.sqlite"));
    service = new ControlService({
      store,
      dataDir: directory,
      mode: "unconfigured",
      defaultModel: "fixture/model",
    });
    mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const b = (await request.json()) as { id: string };
        return Response.json({
          jsonrpc: "2.0",
          id: b.id,
          result: {
            tools: [
              {
                name: "echo",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
        });
      },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        onRequest?.(path);
        const body =
          request.method === "GET"
            ? undefined
            : await request
                .clone()
                .json()
                .catch(() => undefined);
        requests.push({ path, method: request.method, body });
        const override = routeResponse?.(path);
        if (override) return override;
        if (
          path === "/keys" &&
          request.method === "POST" &&
          request.headers.get("authorization") ===
            "Bearer fixture-service-secret"
        ) {
          const b = body as { label?: string; principalId?: string };
          return Response.json({
            key: "one-time-human-key",
            record: {
              id: "replacement",
              label: b.label ?? "",
              createdAt: new Date().toISOString(),
              principalId: b.principalId ?? "new-owner",
            },
          });
        }
        return handleControlRequest(
          service,
          request,
          request.headers.get("authorization") === `Bearer ${key}`
            ? owner
            : null,
          { allowLoopback: true },
        );
      },
    });
    env = {
      HOME: directory,
      LAUN_HOST: "127.0.0.1",
      LAUN_PORT: String(server.port),
      LAUN_KEY: key,
    };
  });
  afterEach(async () => {
    server.stop(true);
    mcp.stop(true);
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("named target, mower defaults, thread submission receipts and real ownership routes", async () => {
    saveNamedTarget(
      "fixture",
      { host: "127.0.0.1", port: server.port!, key, scheme: "http" },
      directory,
    );
    env.LAUN_HOST = "unreachable.invalid";
    const created = await invoke([
      "mower",
      "new",
      "Fern",
      "--role",
      "director",
      "--instructions",
      "Review carefully.",
      "--target",
      "fixture",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const m = created.data() as MowerRecord;
    expect(m.model).toBe("fixture/model");
    env.LAUN_HOST = "127.0.0.1";
    expect(
      (
        await invoke(["mower", "set", m.id, "--name", "Fern Two", "--json"])
      ).data().name,
    ).toBe("Fern Two");
    const createdThread = await invoke([
      "thread",
      "new",
      m.id,
      "Durable research",
      "--json",
    ]);
    expect(createdThread.code).toBe(0);
    const t = createdThread.data() as ThreadRecord;
    const one = await invoke([
      "thread",
      "say",
      t.id,
      "A stable input",
      "--request-id",
      "retry-input",
      "--json",
    ]);
    expect(one.data().instructions).toBe("Review carefully.");
    expect(
      (
        await invoke([
          "mower",
          "set",
          m.id,
          "--instructions",
          "Use a checklist.",
          "--json",
        ])
      ).code,
    ).toBe(0);
    const two = await invoke([
      "thread",
      "say",
      t.id,
      "A stable input",
      "--request-id",
      "retry-input",
      "--json",
    ]);
    expect(one.data().id).toBe(two.data().id);
    expect(two.data().instructions).toBe("Review carefully.");
    expect(
      (
        await invoke([
          "thread",
          "say",
          t.id,
          "Changed input",
          "--request-id",
          "retry-input",
        ])
      ).code,
    ).toBe(1);
    const fresh = await invoke(["thread", "say", t.id, "UUID input", "--json"]);
    expect(fresh.data().requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.data().instructions).toBe("Use a checklist.");
    const literalHelp = await invoke([
      "thread",
      "say",
      t.id,
      "--json",
      "--",
      "--help",
    ]);
    expect(literalHelp.code).toBe(0);
    expect(literalHelp.data().prompt).toBe("--help");
    expect(
      (await invoke(["thread", "ls", "--mower", m.id, "--json"])).data(),
    ).toHaveLength(1);
    expect(
      (await invoke(["thread", "say", t.id, "unquoted", "extra"])).code,
    ).toBe(2);
  });

  test("v2 login saves identity without touching disabled legacy routes or echoing its key", async () => {
    const result = await invoke([
      "agent",
      "auth",
      "--host",
      "127.0.0.1",
      "--port",
      String(server.port),
      "--key",
      key,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.data().api).toBe("v2");
    expect(result.data().principalId).toBe(owner.id);
    expect(loadTarget(directory)?.key).toBe(key);
    expect(result.output.join(" ")).not.toContain(key);
    expect(
      requests.some((request) => request.path.startsWith("/sessions")),
    ).toBe(false);
  });

  test("login never downgrades wrong credentials, an outage or a broken v2 state endpoint", async () => {
    const args = [
      "agent",
      "auth",
      "--host",
      "127.0.0.1",
      "--port",
      String(server.port),
      "--key",
      key,
      "--json",
    ];
    expect(
      (await invoke([...args.slice(0, -2), "wrong-key", "--json"])).code,
    ).toBe(1);
    expect(loadTarget(directory)).toBeNull();
    routeResponse = (path) =>
      path === "/api/v2/me"
        ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
        : undefined;
    expect((await invoke(args)).code).toBe(1);
    expect(loadTarget(directory)).toBeNull();
    routeResponse = (path) =>
      path === "/api/v2/me"
        ? Response.json({ error: "legacy disabled" }, { status: 410 })
        : undefined;
    expect((await invoke(args)).code).toBe(1);
    routeResponse = (path) =>
      path === "/api/v2/me" ? Response.json({}) : undefined;
    expect((await invoke(args)).code).toBe(1);
    routeResponse = (path) =>
      path === "/api/v2/state"
        ? Response.json({ error: "missing v2 state" }, { status: 404 })
        : undefined;
    expect((await invoke(args)).code).toBe(1);
    expect(loadTarget(directory)).toBeNull();
    expect(
      requests.some((request) => request.path.startsWith("/sessions")),
    ).toBe(false);
  });

  test("doctor qualifies authenticated remote-only execution without claiming verified model auth", async () => {
    const { worker } = store.registerWorker(owner, {
      name: "Online remote",
      capacity: 1,
    });
    store.heartbeat(worker.id);
    const result = await invoke(["doctor"]);
    expect(result.code).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("no local runtime; online remote yards: 1");
    expect(text).toContain("remote-yard provider credentials are unverified");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(text).not.toContain(key);
  });

  test("onboarding CLI reviews structured choices, creates once without work, and preserves primary CAS", async () => {
    service.listModels = async () => [
      {
        id: "fixture/model",
        name: "Configured fixture",
        provider: "fixture",
        configured: true,
      },
    ];
    const { worker } = store.registerWorker(owner, {
      name: "Onboarding yard",
      capacity: 1,
    });
    worker.status = "online";
    worker.lastSeenAt = new Date().toISOString();
    worker.inferenceMode = "controller";
    worker.durabilityAdapter = { adapter: "pi-durable@1.5.2", version: 1 };
    worker.checkpointVersion = "pi-durable@1.5.2";
    store.put("worker", worker);
    const file = await inputFile({
      name: "Primary Groundskeeper",
      title: "The big picture",
      model: "fixture/model",
      workerId: worker.id,
      mode: "manual",
      workspaceWrite: "ask",
      processExecute: "deny",
      delegation: "ask",
    });
    const first = await invoke([
      "onboard",
      "new",
      "--file",
      file,
      "--request-id",
      "stable-primary",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const setup = first.data().setup;
    expect(first.data().created).toBe(true);
    expect(service.state(owner).runs).toEqual([]);
    const profile = store.profile(setup.profileId, setup.profileVersion, owner);
    expect(profile.rules).toHaveLength(6);
    expect(
      profile.rules.find((rule) => rule.operation === "process.execute")
        ?.effect,
    ).toBe("deny");
    const repeated = await invoke([
      "onboard",
      "new",
      "--file",
      file,
      "--request-id",
      "stable-primary",
      "--json",
    ]);
    expect(repeated.code).toBe(0);
    expect(repeated.data().setup).toEqual(setup);
    expect(
      (await invoke(["onboard", "status", "--json"])).data().setup
        .primaryThreadId,
    ).toBe(setup.primaryThreadId);
    expect(
      (
        await invoke([
          "onboard",
          "select",
          setup.primaryMowerId,
          setup.primaryThreadId,
        ])
      ).code,
    ).toBe(1);
    const selected = await invoke([
      "onboard",
      "select",
      setup.primaryMowerId,
      setup.primaryThreadId,
      "--from-revision",
      "1",
      "--json",
    ]);
    expect(selected.code).toBe(0);
    expect(selected.data().created).toBe(false);
    expect(selected.data().setup.revision).toBe(2);
    expect(service.state(owner).runs).toEqual([]);
    expect(
      (
        await invoke([
          "onboard",
          "new",
          "--file",
          await inputFile({ model: "fixture/model", allowAll: true }),
        ])
      ).code,
    ).toBe(2);
  });
  test("controller-copy CLI requires exact preview and separate confirmations, then resumes bounded removal", async () => {
    const original = thread();
    for (let sequence = 0; sequence < 8; sequence++)
      store.event(original.id, "message", {
        role: "user",
        text: `Private history ${sequence}`,
      });
    expect(
      (await invoke(["thread", "archive", original.id, "--json"])).code,
    ).toBe(0);
    const previewResult = await invoke([
      "thread",
      "purge-preview",
      original.id,
      "--json",
    ]);
    expect(previewResult.code).toBe(0);
    const preview = previewResult.data();
    expect(preview.eligible).toBe(true);
    const beforePosts = requests.filter((request) =>
      request.path.endsWith("/purge"),
    ).length;
    expect(
      (
        await invoke([
          "thread",
          "purge",
          original.id,
          "--digest",
          preview.digest,
        ])
      ).code,
    ).toBe(2);
    expect(
      requests.filter((request) => request.path.endsWith("/purge")),
    ).toHaveLength(beforePosts);
    expect(
      (
        await invoke([
          "thread",
          "purge",
          original.id,
          "--digest",
          "a".repeat(64),
          "--confirmed-stopped",
          "--controller-copy-only",
        ])
      ).code,
    ).toBe(1);
    const begun = await invoke([
      "thread",
      "purge",
      original.id,
      "--digest",
      preview.digest,
      "--confirmed-stopped",
      "--controller-copy-only",
      "--json",
    ]);
    expect(begun.code).toBe(0);
    let job = begun.data();
    expect(job.status).toBe("removing");
    expect(
      (
        await invoke([
          "thread",
          "say",
          original.id,
          "Do not resurrect this thread",
        ])
      ).code,
    ).toBe(1);
    expect(
      (await invoke(["purge", "ls", "--json"]))
        .data()
        .map((entry: { id: string }) => entry.id),
    ).toContain(job.id);
    for (let batch = 0; batch < 40 && job.status !== "done"; batch++) {
      const next = await invoke([
        "purge",
        "continue",
        job.id,
        "--max-rows",
        "2",
        "--json",
      ]);
      expect(next.code).toBe(0);
      job = next.data();
    }
    expect(job.status).toBe("done");
    expect(job.removed.events).toBeGreaterThanOrEqual(8);
    expect(
      (await invoke(["purge", "status", job.id, "--json"])).data().status,
    ).toBe("done");
    expect(
      (await invoke(["purge", "host-copies", job.id, "--json"])).data(),
    ).toEqual([]);
    expect(
      (await invoke(["purge", "continue", job.id, "--max-rows", "257"])).code,
    ).toBe(2);
  });
  test("host-copy CLI separates read-only review from exact stopped-host approval and withdrawal", async () => {
    const { worker } = store.registerWorker(owner, { name: "Reviewed offline host" });
    const original = store.createThread(owner, { mowerId: store.createMower(owner, { name: "Disposable remote mower", workerId: worker.id, model: "fixture/model" }).id, title: "Disposable host-copy history" });
    store.submit(owner, original.id, { text: "No inference needed", requestId: "host-copy-fixture" });
    await invoke(["thread", "archive", original.id]);
    const preview = (await invoke(["thread", "purge-preview", original.id, "--json"])).data();
    let job = (await invoke(["thread", "purge", original.id, "--digest", preview.digest, "--confirmed-stopped", "--controller-copy-only", "--json"])).data();
    for (let n = 0; n < 30 && job.status !== "done"; n++) job = (await invoke(["purge", "continue", job.id, "--json"])).data();
    expect(job.status).toBe("done");
    const plan = (await invoke(["purge", "host-copies", job.id, "--json"])).data().find((value: { workerId: string }) => value.workerId === worker.id);
    expect(plan.approvedAt).toBeUndefined();
    const reviewed = await invoke(["host-copy", "review", plan.id, "--json"]);
    expect(reviewed.code).toBe(0); const review = reviewed.data(); expect(review.plan.id).toBe(plan.id); expect(review.digest).toMatch(/^[a-f0-9]{64}$/);
    const posts = () => requests.filter(request => request.path.endsWith(`/host-copies/${plan.id}/approve`));
    expect(posts()).toHaveLength(0);
    expect((await invoke(["host-copy", "approve", plan.id, "--digest", review.digest])).code).toBe(2);
    expect((await invoke(["host-copy", "approve", plan.id, "--digest", review.digest, "--confirmed-stopped"])).code).toBe(2);
    expect(posts()).toHaveLength(0);
    expect((await invoke(["host-copy", "approve", plan.id, "--digest", "f".repeat(64), "--confirmed-stopped", "--delete-host-copies"])).code).toBe(1);
    const approved = await invoke(["host-copy", "approve", plan.id, "--digest", review.digest, "--confirmed-stopped", "--delete-host-copies", "--json"]);
    expect(approved.code).toBe(0); expect(approved.data().approvedAt).toBeDefined(); expect(approved.data().status).toBe("pending"); expect(approved.data().verified).not.toBe(true);
    expect(posts().at(-1)?.body).toEqual({ expectedDigest: review.digest, confirmedStopped: true, confirmedDeleteHostCopies: true });
    expect((await invoke(["host-copy", "revoke", plan.id])).code).toBe(2);
    expect((await invoke(["host-copy", "revoke", plan.id, "--digest", review.digest])).code).toBe(1);
    const fresh = (await invoke(["host-copy", "review", plan.id, "--json"])).data(); expect(fresh.digest).not.toBe(review.digest);
    const withdrawn = await invoke(["host-copy", "revoke", plan.id, "--digest", fresh.digest, "--json"]);
    expect(withdrawn.code).toBe(0); expect(withdrawn.data().status).toBe("blocked"); expect(withdrawn.data().approvedAt).toBeUndefined(); expect(withdrawn.data().outstanding.join(" ")).toContain("withdrawn");
    expect(requests.filter(request => request.path.endsWith(`/host-copies/${plan.id}/revoke`)).at(-1)?.body).toEqual({ expectedDigest: fresh.digest });
    expect((await invoke(["host-copy", "review", plan.id])).output.join("\n")).toContain("a controller status does not prove physical shutdown");
  });
  test("yard maintenance CLI preserves stable affinity, shows rotation key only once and requires fresh reconnect", async () => {
    const enrolled = await invoke([
      "yard",
      "enroll",
      "Maintained yard",
      "--capacity",
      "2",
      "--json",
    ]);
    expect(enrolled.code).toBe(0);
    const original = enrolled.data(),
      worker = original.worker as WorkerRecord;
    worker.reportedCapacity = 2;
    worker.durabilityAdapter = { adapter: "fixture@1", version: 1 };
    worker.checkpointVersion = "fixture@1";
    worker.inferenceMode = "controller";
    store.put("worker", worker);
    store.heartbeat(worker.id);
    const m = store.createMower(owner, {
        name: "Maintenance mower",
        model: "fixture/model",
        workerId: worker.id,
      }),
      a = store.createThread(owner, {
        mowerId: m.id,
        title: "Active maintenance attempt",
      }),
      b = store.createThread(owner, {
        mowerId: m.id,
        title: "Retained queued intent",
      });
    const active = store.submit(owner, a.id, {
      text: "Controlled active fixture",
      requestId: crypto.randomUUID(),
    });
    store.claim(worker);
    const queued = store.submit(owner, b.id, {
      text: "Keep this queued placement",
      requestId: crypto.randomUUID(),
    });
    expect(
      (await invoke(["yard", "drain", worker.id, "--json"])).data().drainingAt,
    ).toBeDefined();
    expect(store.claim(worker)).toBeNull();
    expect(store.run(active.id).status).toBe("running");
    expect(store.run(queued.id).status).toBe("queued");
    expect((await invoke(["yard", "resume", worker.id])).code).toBe(0);
    const posts = requests.filter((request) =>
      request.path.endsWith("/rotate"),
    ).length;
    expect(
      (await invoke(["yard", "rotate", worker.id, "--from-version", "1"])).code,
    ).toBe(2);
    expect(
      requests.filter((request) => request.path.endsWith("/rotate")),
    ).toHaveLength(posts);
    const rotated = await invoke([
      "yard",
      "rotate",
      worker.id,
      "--from-version",
      "1",
      "--confirmed-stopped",
      "--json",
    ]);
    expect(rotated.code).toBe(0);
    const replacement = rotated.data();
    expect(replacement.worker.id).toBe(worker.id);
    expect(replacement.worker.credentialVersion).toBe(2);
    expect(replacement.worker.drainingAt).toBeDefined();
    expect(replacement.interruptedRunIds).toEqual([active.id]);
    expect(store.authenticateWorker(original.key)).toBeNull();
    expect(store.authenticateWorker(replacement.key)?.id).toBe(worker.id);
    expect(store.run(queued.id).status).toBe("queued");
    const request = (secret: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/v2/worker/poll`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          activeRunIds: [],
          capacity: 2,
          inferenceMode: "controller",
          checkpointVersion: "fixture@1",
          durabilityAdapter: { adapter: "fixture@1", version: 1 },
        }),
      });
    expect((await request(original.key)).status).toBe(401);
    expect((await invoke(["yard", "resume", worker.id])).code).toBe(1);
    const reconnected = await request(replacement.key);
    expect(reconnected.status).toBe(200);
    expect(((await reconnected.json()) as { job: unknown }).job).toBeNull();
    expect((await invoke(["yard", "resume", worker.id])).code).toBe(0);
    const claim = await request(replacement.key);
    expect(
      (
        (await claim.json()) as {
          job: { run: { id: string }; thread: { workerId: string } };
        }
      ).job.run.id,
    ).toBe(queued.id);
    const listed = await invoke(["yard", "ls", "--json"]);
    expect(listed.output.join("\n")).not.toContain(original.key);
    expect(listed.output.join("\n")).not.toContain(replacement.key);
    expect(JSON.stringify(requests)).not.toContain(replacement.key);
    expect(
      (
        await invoke([
          "yard",
          "rotate",
          worker.id,
          "--from-version",
          "1",
          "--confirmed-stopped",
        ])
      ).code,
    ).toBe(1);
  });

  test("doctor reports closed storage admission without invoking a provider", async () => {
    const workspace = service.state(owner);
    workspace.readiness.storage = {
      freeBytes: 1,
      minimumBytes: 512 * 1024 * 1024,
      acceptingWork: false,
      message: "Below reserve",
    };
    routeResponse = (path) =>
      path === "/api/v2/state" ? Response.json(workspace) : undefined;
    const result = await invoke(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.output.join("\n")).toContain("Storage admission is closed");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("doctor rejects queued-without-capacity and configured-model absence", async () => {
    expect((await invoke(["doctor"])).code).toBe(1);
    const workspace = service.state(owner);
    workspace.readiness = {
      runtime: true,
      mode: "trusted-local",
      message: "Explicit test runtime",
      durableJournal: true,
    };
    let configured = false;
    routeResponse = (path) =>
      path === "/api/v2/state"
        ? Response.json(workspace)
        : path === "/api/v2/models"
          ? Response.json({
              models: [
                {
                  id: "test/model",
                  provider: "test",
                  name: "Test",
                  configured,
                },
              ],
            })
          : undefined;
    expect((await invoke(["doctor"])).code).toBe(1);
    configured = true;
    expect((await invoke(["doctor"])).code).toBe(0);
    expect(requests.some((request) => request.path === "/health")).toBe(false);
  });

  test("yard SSH setup fails closed without controller inference and never enrolls implicitly", async () => {
    const source = join(directory, "source");
    await mkdir(join(source, "apps/worker/src"), { recursive: true });
    for (const [path, body] of [
      ["package.json", "{}"],
      ["bun.lock", "{}"],
      ["apps/worker/src/index.ts", "// worker"],
      [
        "apps/worker/src/capabilities.json",
        await Bun.file(
          join(import.meta.dir, "../../worker/src/capabilities.json"),
        ).text(),
      ],
    ])
      await writeFile(join(source, path!), body!);
    const config = await inputFile({
      OPENSHELL_BIN: "/usr/local/bin/openshell",
      OPENSHELL_SANDBOX_IMAGE: "pi:qualified",
      XDG_CONFIG_HOME: "/etc/laun/yard",
    });
    const result = await invoke([
      "yard",
      "setup",
      "ssh",
      "ubuntu@yard.example",
      "-i",
      "/private/id",
      "--controller-url",
      "https://control.example",
      "--config",
      config,
      "--source-dir",
      source,
    ]);
    expect(result.code).toBe(2);
    expect(result.errors.join(" ")).toContain("does not advertise");
    expect(
      requests.some(
        (request) =>
          request.path === "/api/v2/workers" && request.method === "POST",
      ),
    ).toBe(false);
  });

  test("yard SSH setup enrolls, transfers scoped source/key and qualifies its own heartbeat", async () => {
    const source = join(directory, "source");
    await mkdir(join(source, "apps/worker/src"), { recursive: true });
    for (const [path, body] of [
      ["package.json", "{}"],
      ["bun.lock", "{}"],
      ["apps/worker/src/index.ts", "// worker"],
      [
        "apps/worker/src/capabilities.json",
        await Bun.file(
          join(import.meta.dir, "../../worker/src/capabilities.json"),
        ).text(),
      ],
    ])
      await writeFile(join(source, path!), body!);
    const config = await inputFile({
      OPENSHELL_BIN: "/usr/local/bin/openshell",
      OPENSHELL_SANDBOX_IMAGE: "pi:qualified",
      XDG_CONFIG_HOME: "/etc/laun/yard",
    });
    routeResponse = (path) =>
      path === "/api/v2/state"
        ? Response.json({
            ...service.state(owner),
            readiness: { ...service.readiness(), inferenceRelay: true },
          })
        : undefined;
    const output: string[] = [];
    let privateInput = "",
      calls = 0;
    const result = await yardSetupCommand(
      [
        "ssh",
        "ubuntu@yard.example",
        "-i",
        "/private/id",
        "--name",
        "Installed yard",
        "--controller-url",
        "https://control.example",
        "--config",
        config,
        "--source-dir",
        source,
        "--json",
      ],
      new GatewayClient(`http://127.0.0.1:${server.port}`, key),
      { out: (line) => output.push(line), err: (line) => output.push(line) },
      {
        runner: async (argv, options) => {
          calls++;
          privateInput += options?.stdin ?? "";
          expect(argv.join(" ")).not.toContain("LAUN_WORKER_KEY");
          if (calls === 3) {
            const workerKey = privateInput.match(
              /LAUN_WORKER_KEY="([^"]+)"/,
            )?.[1];
            const poll = await fetch(
              `http://127.0.0.1:${server.port}/api/v2/worker/poll`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${workerKey}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  activeRunIds: [],
                  inferenceMode: "controller",
                  checkpointVersion: "pi-durable@1.5.2",
                  durabilityAdapter: {
                    adapter: "pi-durable@1.5.2",
                    version: 1,
                  },
                }),
              },
            );
            expect(poll.ok).toBe(true);
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(result).toBe(0);
    const installed = JSON.parse(output.at(-1)!);
    expect(installed.heartbeat).toBe(true);
    expect(installed.inference).toBe("controller");
    const workerKey = privateInput.match(/LAUN_WORKER_KEY="([^"]+)"/)?.[1];
    expect(workerKey).toBeString();
    expect(output.join(" ")).not.toContain(workerKey!);
    expect(output.join(" ")).not.toContain(key);
  });

  test("yard SSH failure revokes the newly enrolled key and never prints it", async () => {
    const source = join(directory, "source");
    await mkdir(join(source, "apps/worker/src"), { recursive: true });
    for (const [path, body] of [
      ["package.json", "{}"],
      ["bun.lock", "{}"],
      ["apps/worker/src/index.ts", "// worker"],
      [
        "apps/worker/src/capabilities.json",
        await Bun.file(
          join(import.meta.dir, "../../worker/src/capabilities.json"),
        ).text(),
      ],
    ])
      await writeFile(join(source, path!), body!);
    const config = await inputFile({
      OPENSHELL_BIN: "/usr/local/bin/openshell",
      OPENSHELL_SANDBOX_IMAGE: "pi:qualified",
      XDG_CONFIG_HOME: "/etc/laun/yard",
    });
    routeResponse = (path) =>
      path === "/api/v2/state"
        ? Response.json({
            ...service.state(owner),
            readiness: { ...service.readiness(), inferenceRelay: true },
          })
        : undefined;
    let secret = "";
    const promise = yardSetupCommand(
      [
        "ssh",
        "yard.example",
        "-i",
        "/private/id",
        "--controller-url",
        "https://control.example",
        "--config",
        config,
        "--source-dir",
        source,
      ],
      new GatewayClient(`http://127.0.0.1:${server.port}`, key),
      { out() {}, err() {} },
      {
        runner: async (_argv, options) => {
          secret =
            options?.stdin?.match(/LAUN_WORKER_KEY="([^"]+)"/)?.[1] ?? "";
          return {
            code: 1,
            stdout: secret,
            stderr: `fixture installation error ${secret}`,
          };
        },
      },
    );
    await expect(promise).rejects.toThrow("[redacted worker key]");
    expect(store.authenticateWorker(secret)).toBeNull();
    expect(store.list<WorkerRecord>("worker", owner)[0]!.status).toBe(
      "revoked",
    );
  });

  test("profile JSON revisions are compare-and-swap and assignment does not rewrite old threads", async () => {
    const m = mower(),
      t = thread(m);
    const path = await inputFile({
      name: "Work only",
      mode: "manual",
      rules: [],
    });
    const p = (
      await invoke(["profile", "new", "--file", path, "--json"])
    ).data() as StoredProfile;
    expect(
      (
        await invoke([
          "mower",
          "set",
          m.id,
          "--profile",
          p.id,
          "--version",
          "1",
          "--json",
        ])
      ).code,
    ).toBe(0);
    expect(store.get<ThreadRecord>("thread", t.id).profileId).toBe(m.profileId);
    const revision = await inputFile({ mode: "isolated", rules: [] });
    expect(
      (
        await invoke([
          "profile",
          "revise",
          p.id,
          "--file",
          revision,
          "--base",
          "1",
          "--json",
        ])
      ).data().version,
    ).toBe(2);
    expect(
      (
        await invoke([
          "profile",
          "revise",
          p.id,
          "--file",
          revision,
          "--base",
          "1",
        ])
      ).code,
    ).toBe(1);
    expect(
      (await invoke(["profile", "revise", p.id, "--file", revision])).code,
    ).toBe(2);
    expect(
      (
        await invoke(["profile", "revoke", p.id, "--version", "1", "--json"])
      ).data().revokedAt,
    ).toBeString();
    const bad = await inputFile([]);
    expect((await invoke(["profile", "new", "--file", bad])).code).toBe(2);
  });

  test("explicit thread profile and yard lifecycle uses reviewed CAS and never submits work", async () => {
    const m = mower(),
      t = thread(m),
      target = store.createProfile(owner, {
        name: "Reviewed narrow profile",
        mode: "isolated",
        rules: [],
      });
    const profileArgs = [
      "thread",
      "profile",
      t.id,
      target.id,
      "--version",
      "1",
      "--from-profile",
      t.profileId,
      "--from-version",
      String(t.profileVersion),
      "--json",
    ];
    expect((await invoke(profileArgs)).code).toBe(2);
    const rebased = await invoke([...profileArgs, "--confirmed-stopped"]);
    expect(rebased.code).toBe(0);
    expect(rebased.data().thread.profileId).toBe(target.id);
    expect(rebased.data().thread.stoppedAt).toBeString();
    expect((await invoke([...profileArgs, "--confirmed-stopped"])).code).toBe(
      1,
    );
    const { worker } = store.registerWorker(owner, {
      name: "Migration target",
    });
    store.heartbeat(worker.id);
    const moved = await invoke([
      "thread",
      "move",
      t.id,
      worker.id,
      "--from-yard",
      "none",
      "--confirmed-stopped",
      "--json",
    ]);
    expect(moved.code).toBe(0);
    expect(moved.data().thread.workerId).toBe(worker.id);
    expect(moved.data().thread.placementId).toBeString();
    expect(store.threadRuns(owner, t.id)).toHaveLength(0);
  });

  test("interrupted work never reports completion or resumes without explicit reconciliation", async () => {
    const t = thread(),
      r = submit(t);
    store.setRunStatus(r.id, "interrupted");
    const later = submit(t);
    const watched = await invoke([
      "thread",
      "watch",
      t.id,
      "--poll-ms",
      "10",
      "--timeout",
      "100ms",
      "--json",
    ]);
    expect(watched.code).toBe(3);
    expect(watched.data().run.status).toBe("interrupted");
    const before = requests.length;
    expect((await invoke(["thread", "resume", r.id])).code).toBe(2);
    expect(requests.length).toBe(before);
    expect(
      (
        await invoke([
          "thread",
          "resume",
          r.id,
          "--confirmed-stopped",
          "--json",
        ])
      ).data().status,
    ).toBe("queued");
    store.setRunStatus(r.id, "interrupted");
    expect(
      (
        await invoke([
          "thread",
          "abandon",
          r.id,
          "--confirmed-stopped",
          "--json",
        ])
      ).data().status,
    ).toBe("cancelled");
    expect(store.run(later.id).status).toBe("cancelled");
    expect(
      (await invoke(["thread", "watch", t.id, "--timeout", "50ms", "--json"]))
        .code,
    ).toBe(1);
  });

  test("watch times out on queued work, drains events and distinguishes failure", async () => {
    const t = thread(),
      r = submit(t);
    const queued = await invoke([
      "thread",
      "watch",
      t.id,
      "--poll-ms",
      "10",
      "--timeout",
      "30ms",
      "--json",
    ]);
    expect(queued.code).toBe(2);
    expect(queued.errors.join(" ")).toContain("may still be running");
    store.setRunStatus(r.id, "done");
    const complete = await invoke(["thread", "watch", t.id, "--json"]);
    expect(complete.code).toBe(0);
    expect(complete.data().run.status).toBe("done");
    store.setRunStatus(r.id, "error");
    expect(
      (await invoke(["thread", "watch", t.id, "--run", r.id, "--json"])).code,
    ).toBe(1);
    expect(
      (await invoke(["thread", "watch", t.id, "--run", "missing", "--json"]))
        .code,
    ).toBe(1);
  });

  test("watch uses thread-scoped and pinned run APIs beyond global history limits", async () => {
    const old = submit();
    store.setRunStatus(old.id, "interrupted");
    const other = thread();
    store.transaction(() => {
      for (let i = 0; i < 1005; i++) {
        const run = store.submit(owner, other.id, {
          text: `Historic ${i}`,
          requestId: `history-${i}`,
        });
        store.setRunStatus(run.id, "done");
      }
    });
    const result = await invoke(["thread", "watch", old.threadId, "--json"]);
    expect(result.code).toBe(3);
    expect(result.data().run.id).toBe(old.id);
    expect(
      requests.some(
        (request) => request.path === `/threads/${old.threadId}/runs`,
      ),
    ).toBe(false);
    expect(
      requests.some(
        (request) => request.path === `/api/v2/threads/${old.threadId}/runs`,
      ),
    ).toBe(true);
    expect(requests.some((request) => request.path === "/api/v2/state")).toBe(
      false,
    );
    expect(
      (
        await invoke([
          "thread",
          "watch",
          old.threadId,
          "--run",
          old.id,
          "--json",
        ])
      ).code,
    ).toBe(3);
    expect(
      requests.some((request) => request.path === `/api/v2/runs/${old.id}`),
    ).toBe(true);
  });

  test("logs drain multiple server pages and stable cursors avoid repeat output", async () => {
    const t = thread();
    store.transaction(() => {
      for (let i = 0; i < 1101; i++)
        store.event(t.id, "system", { text: `Record ${i}` });
    });
    const first = await invoke(["thread", "log", t.id, "--json"]);
    expect(first.code).toBe(0);
    const entries = first.output.map((line) => JSON.parse(line));
    expect(entries.filter((item) => item.type === "event")).toHaveLength(1101);
    const cursor = entries.at(-1).nextCursor;
    const tail = await invoke([
      "thread",
      "log",
      t.id,
      "--after",
      String(cursor),
      "--json",
    ]);
    expect(tail.output).toHaveLength(1);
    expect(tail.data()).toEqual({ type: "cursor", nextCursor: cursor });
  });

  test("follow-up admitted during the final log drain prevents stale completion", async () => {
    const t = thread(),
      initial = submit(t);
    store.setRunStatus(initial.id, "done");
    let eventReads = 0;
    onRequest = (path) => {
      if (path === `/api/v2/threads/${t.id}/events` && ++eventReads === 3)
        store.submit(owner, t.id, {
          text: "Follow-up during final drain",
          requestId: "final-drain-race",
        });
    };
    const result = await invoke([
      "thread",
      "watch",
      t.id,
      "--poll-ms",
      "10",
      "--timeout",
      "80ms",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(
      result.output.some((line) =>
        line.includes("Follow-up during final drain"),
      ),
    ).toBe(true);
    expect(
      result.output.some((line) => JSON.parse(line).type === "status"),
    ).toBe(false);
  });

  test("structured input rejects a FIFO promptly instead of waiting for a writer", async () => {
    if (process.platform === "win32") return;
    const path = join(directory, "payload.fifo");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const result = await invoke(["profile", "new", "--file", path]);
    expect(result.code).toBe(2);
    expect(result.errors.join(" ")).toContain("regular JSON file");
  });

  test("JSON stdin is accepted without shell parsing and credentials are not echoed on refusal", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "index.ts"),
        "profile",
        "new",
        "--file=-",
        "--json",
      ],
      {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(
      JSON.stringify({
        name: "From stdin $(literal)",
        mode: "isolated",
        rules: [],
      }),
    );
    child.stdin.end();
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(output).name).toBe("From stdin $(literal)");
    expect(errors).toBe("");
    env.LAUN_KEY = "unrecognized-key";
    const denied = await invoke(["mower", "ls", "--json"]);
    expect(denied.code).toBe(1);
    expect(denied.output).toHaveLength(0);
    expect(denied.errors.join(" ")).not.toContain(env.LAUN_KEY);
  });

  test("checkpoint export is private, owner-bound, and refuses replacement", async () => {
    const t = thread();
    const output = join(directory, "checkpoint.json");
    const archive = {
      version: 1,
      threadId: t.id,
      runtimeVersion: "fixture/1",
      createdAt: new Date().toISOString(),
      files: [],
      omittedPaths: ["work/node_modules/"],
    };
    store.db
      .query("INSERT INTO checkpoints VALUES(?,?,?)")
      .run(t.id, JSON.stringify(archive), archive.createdAt);
    expect(
      (await invoke(["thread", "checkpoint", t.id, "--out", output, "--json"]))
        .code,
    ).toBe(0);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(archive);
    expect(
      (await invoke(["thread", "checkpoint", t.id, "--out", output])).code,
    ).toBe(1);
    expect((await invoke(["thread", "checkpoint", t.id, "--json"])).code).toBe(
      2,
    );
    expect(await readFile(output, "utf8")).not.toContain(key);
  });

  test("yard enrollment is the only command returning the one-time worker credential", async () => {
    const enrolled = await invoke([
      "yard",
      "enroll",
      "Remote yard",
      "--capacity",
      "2",
      "--labels",
      "ci,linux",
      "--json",
    ]);
    const value = enrolled.data();
    expect(value.key).toMatch(/^yard_/);
    expect(value.worker.capacity).toBe(2);
    const listed = await invoke(["yard", "ls", "--json"]);
    expect(listed.output.join("")).not.toContain(value.key);
    expect(
      (await invoke(["yard", "revoke", value.worker.id, "--json"])).data()
        .status,
    ).toBe("revoked");
    expect(store.authenticateWorker(value.key)).toBeNull();
  });

  test("delegation and handoff retain goal without granting authority", async () => {
    const m = mower(),
      parent = thread(m);
    const delegated = await invoke([
      "task",
      "delegate",
      parent.id,
      "Inspect the source",
      "--mower",
      m.id,
      "--request-id",
      "delegate-one",
      "--json",
    ]);
    const value = delegated.data();
    expect(delegated.code).toBe(0);
    expect(value.thread.parentThreadId).toBe(parent.id);
    const repeated = await invoke([
      "task",
      "delegate",
      parent.id,
      "Inspect the source",
      "--mower",
      m.id,
      "--request-id",
      "delegate-one",
      "--json",
    ]);
    expect(repeated.data().task.id).toBe(value.task.id);
    const handed = await invoke([
      "task",
      "handoff",
      value.task.id,
      m.id,
      "--json",
    ]);
    expect(handed.code).toBe(0);
    expect(handed.data().run.prompt).toBe("Inspect the source");
    expect(
      (await invoke(["task", "ls", "--parent", parent.id, "--json"])).data(),
    ).toHaveLength(1);
  });

  test("MCP JSON configuration, actual discovery and explicit disable", async () => {
    const file = await inputFile({
      name: "Tools",
      url: `http://127.0.0.1:${mcp.port}/mcp`,
      protocolVersion: "2026-07-28",
      allowLocal: true,
    });
    const added = await invoke(["connector", "add", "--file", file, "--json"]);
    expect(added.code).toBe(0);
    const c = added.data();
    const discovered = await invoke(["connector", "discover", c.id, "--json"]);
    expect(discovered.code).toBe(0);
    expect(discovered.data().tools[0].name).toBe("echo");
    expect(
      (await invoke(["connector", "disable", c.id, "--json"])).data().enabled,
    ).toBe(false);
  });

  test("approval previews and typed adviser inspection remain separate from grants", async () => {
    const m = mower(),
      t = thread(m),
      r = submit(t);
    store.setRunStatus(r.id, "waiting_permission");
    const a: ControlApproval = {
      id: "approval_fixture",
      ownerId: owner.id,
      action: {
        id: "action_fixture",
        principalId: owner.id,
        workspaceId: t.workspaceId,
        mowerId: m.id,
        threadId: t.id,
        runId: r.id,
        operation: "process.execute",
        resource: "workspace:own",
        argumentsDigest: "digest",
      },
      profileId: t.profileId,
      profileVersion: t.profileVersion,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      detail: '{"command":"pwd"}',
    };
    store.requestApproval(a, "fixture");
    expect(
      (await invoke(["approval", "ls", "--json"])).data()[0].detail,
    ).toContain("pwd");
    const discussion = await invoke([
      "advice",
      "ask",
      a.id,
      "Ask before future commands",
      "--json",
    ]);
    expect(discussion.code).toBe(0);
    const advice = await invoke([
      "advice",
      "get",
      discussion.data().run.id,
      "--json",
    ]);
    expect(advice.code).toBe(0);
    expect(advice.data().status).toBe("queued");
    expect(store.approval(a.id).status).toBe("pending");
    a.detail = "";
    store.updateApproval(a);
    const before = requests.filter((request) =>
      request.path.endsWith(a.id),
    ).length;
    expect((await invoke(["approval", "allow", a.id])).code).toBe(2);
    expect(
      requests.filter((request) => request.path.endsWith(a.id)).length,
    ).toBe(before);
    expect(
      (await invoke(["approval", "deny", a.id, "--json"])).data().status,
    ).toBe("denied");
  });

  test("key replacement explicitly retains a stable principal and legacy help stays available", async () => {
    env.GATEWAY_TOKEN = "fixture-service-secret";
    const replacement = await invoke([
      "keys",
      "create",
      "--label",
      "Rotated browser",
      "--principal",
      "stable-user",
    ]);
    expect(replacement.code).toBe(0);
    expect(requests.at(-1)?.body).toEqual({
      label: "Rotated browser",
      principalId: "stable-user",
    });
    expect((await invoke(["whoami", "--json"])).data()).toEqual({
      principalId: owner.id,
      admin: true,
    });
    const help = await invoke(["--help"]);
    expect(help.output[0]).toContain("Legacy sessions");
    expect(help.output[0]).toContain("laun mower");
    expect(
      (await invoke(["thread", "say", "id", "secret", "--unrecognized"])).code,
    ).toBe(2);
  });
});
