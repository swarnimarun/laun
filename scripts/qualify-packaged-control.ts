import { randomBytes, randomUUID } from "node:crypto";
import { formatAgentKey, parseAgentKey, type ControlRun, type ControlState, type GatewayMe, type ThreadCheckpoint } from "../packages/protocol/src/index.js";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function bounded(stream: ReadableStream<Uint8Array>, max = 2_097_152): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; check(bytes <= max, "qualification response exceeded its bound"); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Disposable explicit-demo qualification. No production model or isolation claim. */
export async function qualifyPackagedControl(options: { engine: string[]; image: string; hostNetwork?: boolean }) {
  check(options.engine.length && options.engine.every(v => typeof v === "string" && v && !v.includes("\0")), "explicit container engine argv required");
  check(/^[A-Za-z0-9][A-Za-z0-9:/@._-]{0,511}$/.test(options.image), "invalid qualification image reference");
  const attempt = randomUUID(), container = `laun-v2-smoke-${attempt}`, volume = `laun-v2-smoke-data-${attempt}`, label = "laun.release-qualification";
  const token = randomBytes(32).toString("base64url"), key = formatAgentKey(randomBytes(4).toString("hex"), randomBytes(32).toString("base64url"));
  const secrets = [token, key, parseAgentKey(key)!.secret], clean = (message: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), message);
  let base = "";
  async function command(args: string[], timeout = 60_000): Promise<string> {
    const child = Bun.spawn([...options.engine, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
    const [stdout, stderr, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
    check(code === 0, clean(`container qualification command failed (${args[0]}, exit${code}): ${stderr.slice(-1200)}`)); return stdout.trim();
  }
  async function request<T>(path: string, body?: unknown, auth = key, expected?: number): Promise<T> {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check(response.status === (expected ?? (body === undefined ? 200 : 201)) || (expected === undefined && response.ok), `packaged ${path} returned HTTP${response.status}`);
    check(response.body, "packaged response body missing"); return JSON.parse(await bounded(response.body, path.endsWith("/checkpoint") ? 64 * 1024 * 1024 : 2_097_152)) as T;
  }
  async function ready() {
    const deadline = Date.now() + 45_000;
    for (;;) {
      try { const state = await request<ControlState>("/api/v2/state"); check(state.readiness.runtime && state.readiness.durableJournal && state.readiness.inferenceRelay && state.readiness.mode === "trusted-local" && state.readiness.defaultModel === "faux/faux-1", "packaged explicit-demo v2 runtime was not ready"); return; }
      catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(200); }
    }
  }
  async function publishedAddress(port: number): Promise<void> {
    if (!options.hostNetwork) {
      const binding = await command(["port", container, "8080/tcp"]), match = binding.match(/^127\.0\.0\.1:(\d+)$/);
      check(match, "qualification port was not bound exclusively to loopback"); port = Number(match[1]);
    }
    check(port > 0 && port <= 65535, "invalid qualification port"); base = `http://127.0.0.1:${port}`;
  }
  async function completed(threadId: string, runId: string): Promise<ControlRun> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const { runs } = await request<{ runs: ControlRun[] }>(`/api/v2/threads/${threadId}/runs`), run = runs.find(value => value.id === runId);
      check(run, "packaged accepted run disappeared");
      if (run.status === "done") return run;
      check(!["error", "interrupted", "cancelled"].includes(run.status), `packaged demo run ended ${run.status}`);
      check(Date.now() < deadline, "packaged demo run did not settle"); await Bun.sleep(100);
    }
  }
  function archiveContains(archive: ThreadCheckpoint, markers: string[]) {
    check(archive.runtimeVersion === "pi-durable@1.5.2" && archive.files.length > 0, "packaged durable archive runtime/files missing");
    const content = archive.files.map(file => Buffer.from(file.content, "base64").toString("utf8")).join("\n");
    for (const marker of markers) check(content.includes(marker), "packaged Pi history was not retained across reopen");
    for (const secret of secrets) check(!content.includes(secret) && !JSON.stringify(archive).includes(secret), "credential leaked into packaged thread archive");
  }
  try {
    check(/\b1\.5\.2\b/.test(await command(["run", "--rm", options.image, "pi", "--version"])), "packaged Pi version mismatch");
    check(/\b0\.1\.8\b/.test(await command(["run", "--rm", options.image, "openshell", "--version"])), "packaged OpenShell version mismatch");
    await command(["volume", "create", "--label", `${label}=${attempt}`, volume]);
    let port = 8080;
    if (options.hostNetwork) { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) }); port = probe.port!; probe.stop(true); }
    await command(["run", "-d", "--name", container, "--label", `${label}=${attempt}`, ...(options.hostNetwork ? ["--network", "host"] : ["-p", "127.0.0.1:0:8080"]),
      "-v", `${volume}:/data`, "-e", `GATEWAY_PORT=${port}`, "-e", `GATEWAY_BIND=${options.hostNetwork ? "127.0.0.1" : "0.0.0.0"}`, "-e", `GATEWAY_TOKEN=${token}`, "-e", `LAUN_KEY=${key}`,
      "-e", "DATA_DIR=/data", "-e", "LAUN_DEMO=true", "-e", "LAUN_TRUSTED_LOCAL=true", "-e", "OPENSHELL_ENABLED=false", "-e", "LAUN_LEGACY_API=false", "-e", "PI_AUTH_FILE=/nonexistent/qualification-has-no-provider-credentials",
      options.image, "sh", "-c", "chmod 700 /data && exec bun apps/gateway/src/index.ts"]);
    await publishedAddress(port); await ready();
    await request("/api/v2/state", undefined, "", 401); await request("/api/v2/state", undefined, "wrong-synthetic-key", 401);
    const me = await request<GatewayMe>("/api/v2/me"); check(!me.admin && !!me.principalId, "packaged human identity mismatch");
    const stranger = await request<{ key: string }>("/keys", { label: "synthetic isolated owner" }, token); check(parseAgentKey(stranger.key), "packaged new owner key format mismatch"); secrets.push(stranger.key, parseAgentKey(stranger.key)!.secret);
    const mower = await request<{ id: string }>("/api/v2/mowers", { name: "Packaged qualification mower", model: "faux/faux-1", role: "director" });
    const thread = await request<{ id: string }>("/api/v2/threads", { mowerId: mower.id, title: "Disposable packaged durable thread" });
    await request(`/api/v2/threads/${thread.id}/events`, undefined, stranger.key, 404);
    const firstMarker = `PACKAGED_FIRST_${randomUUID()}`, secondMarker = `PACKAGED_SECOND_${randomUUID()}`;
    const firstInput = { text: firstMarker, requestId: "packaged-first" };
    const first = await request<ControlRun>(`/api/v2/threads/${thread.id}/messages`, firstInput);
    check((await completed(thread.id, first.id)).summary?.includes(firstMarker), "packaged actual Pi demo response missing");
    archiveContains(await request<ThreadCheckpoint>(`/api/v2/threads/${thread.id}/checkpoint`), [firstMarker]);
    await command(["stop", "--time", "15", container]); await command(["start", container]); await publishedAddress(port); await ready();
    check((await request<GatewayMe>("/api/v2/me")).principalId === me.principalId, "packaged owner identity changed across restart");
    check((await request<ControlRun>(`/api/v2/threads/${thread.id}/messages`, firstInput)).id === first.id, "packaged retry created another run after restart");
    const second = await request<ControlRun>(`/api/v2/threads/${thread.id}/messages`, { text: secondMarker, requestId: "packaged-second" });
    check((await completed(thread.id, second.id)).summary?.includes(secondMarker), "packaged reopened actual Pi response missing");
    archiveContains(await request<ThreadCheckpoint>(`/api/v2/threads/${thread.id}/checkpoint`), [firstMarker, secondMarker]);
    const events = await request<unknown>(`/api/v2/threads/${thread.id}/events`); for (const secret of secrets) check(!JSON.stringify(events).includes(secret), "credential leaked into packaged event history");
    const inspect = `const{Database}=await import('bun:sqlite');const db=new Database('/data/control.sqlite',{readonly:true});console.log(JSON.stringify({ledger:db.query('SELECT COUNT(*) n FROM durable_commits WHERE thread_id=?').get(${JSON.stringify(thread.id)}).n,calls:db.query('SELECT COUNT(*) n FROM inference_calls WHERE run_id IN(?,?) AND status=?').get(${JSON.stringify(first.id)},${JSON.stringify(second.id)},'done').n,runs:db.query('SELECT COUNT(*) n FROM runs WHERE thread_id=?').get(${JSON.stringify(thread.id)}).n}));db.close();`;
    const persisted = JSON.parse(await command(["exec", container, "bun", "-e", inspect]));
    check(persisted.ledger > 1 && persisted.calls === 2 && persisted.runs === 2, `packaged central proof failed (ledger=${persisted.ledger}, admissions=${persisted.calls}, runs=${persisted.runs})`);
    return { ok: true, fixture: "explicit-faux-provider", authenticatedV2: true, ownerIsolation: true, durablePiReopen: true, stableInputReceipt: true, controllerInferenceAdmissions: 2, credentialsAbsentFromThreadArtifacts: true, isolatedExecutionQualified: false };
  } catch (error) { throw new Error(clean(error instanceof Error ? error.message : "packaged qualification failed")); }
  finally {
    // Cleanup names and labels are unique to this attempt; never prune an
    // engine or remove a volume/container lacking the exact proof label.
    // A failed start can still leave a created container. Always inspect the
    // unique name, but remove it only when its ownership label matches.
    try { const value = JSON.parse(await command(["inspect", container])); if (value[0]?.Config?.Labels?.[label] === attempt) await command(["rm", "--force", container]); } catch {}
    try { const value = JSON.parse(await command(["volume", "inspect", volume])); if (value[0]?.Labels?.[label] === attempt) await command(["volume", "rm", volume]); } catch {}
  }
}

if (import.meta.main) try {
  const engine = process.env.LAUN_SMOKE_ENGINE_ARGV ? JSON.parse(process.env.LAUN_SMOKE_ENGINE_ARGV) as string[] : ["docker"];
  check(Array.isArray(engine), "LAUN_SMOKE_ENGINE_ARGV must be a JSON argv array");
  check(process.env.LAUN_SMOKE_IMAGE, "LAUN_SMOKE_IMAGE is required");
  const hostNetwork = process.env.LAUN_SMOKE_HOST_NETWORK ?? "false"; check(["true", "false"].includes(hostNetwork), "LAUN_SMOKE_HOST_NETWORK must be true or false");
  console.log(JSON.stringify(await qualifyPackagedControl({ engine, image: process.env.LAUN_SMOKE_IMAGE, hostNetwork: hostNetwork === "true" })));
} catch (error) { console.error(error instanceof Error ? error.message : "packaged control qualification failed"); process.exitCode = 1; }
