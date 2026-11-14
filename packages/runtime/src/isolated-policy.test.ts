import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateIsolatedCommandPolicy, validatePolicy } from "@laun/policy";
import { DEFAULT_ISOLATED_POLICY, prepareIsolatedPolicy } from "./isolated-policy.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const egress = DEFAULT_ISOLATED_POLICY.replace("network_policies: {}", "network_policies: {bypass: {endpoints: [{host: example.com, port: 443, protocol: tcp}], binaries: [{path: /usr/bin/bash}]}}");
const middleware = DEFAULT_ISOLATED_POLICY.replace("network_middlewares: {}", 'network_middlewares: {proxy: {middleware: proxy, endpoints: {include: ["*"]}}}');

describe("supported v2 command policy ceiling", () => {
  test("default and narrower runtime roots require no unmediated network", () => {
    expect(validateIsolatedCommandPolicy(DEFAULT_ISOLATED_POLICY)).toEqual([]);
    expect(validateIsolatedCommandPolicy(DEFAULT_ISOLATED_POLICY.replace("[/usr, /lib", "[/usr/bin, /lib"))).toEqual([]);
    expect(validatePolicy(egress)).toEqual([]); expect(validateIsolatedCommandPolicy(egress).join(" ")).toContain("central MCP broker");
    expect(validatePolicy(middleware)).toEqual([]); expect(validateIsolatedCommandPolicy(middleware).join(" ")).toContain("network_middlewares");
  });
  test.each([
    ["network", egress], ["middleware", middleware],
    ["soft isolation", DEFAULT_ISOLATED_POLICY.replace("hard_requirement", "best_effort")],
    ["implicit working directory", DEFAULT_ISOLATED_POLICY.replace("include_workdir: false", "include_workdir: true")],
    ["host filesystem read", DEFAULT_ISOLATED_POLICY.replace("[/usr, /lib", "[/home, /usr, /lib")],
    ["host filesystem write", DEFAULT_ISOLATED_POLICY.replace("[/workspace, /tmp", "[/home, /workspace, /tmp")],
    ["path traversal", DEFAULT_ISOLATED_POLICY.replace("[/usr, /lib", "[/usr/../home, /lib")],
    ["implicit network", DEFAULT_ISOLATED_POLICY.replace("network_policies: {}\n", "")],
    ["root process", DEFAULT_ISOLATED_POLICY.replace("process: {}", "process: {run_as_user: 0}")],
    ["duplicate key", `${DEFAULT_ISOLATED_POLICY}\nnetwork_policies: {bypass: {}}\n`],
  ])("rejects %s custom policies before an execution boundary opens", (_label, raw) => { expect(validateIsolatedCommandPolicy(raw!)).not.toEqual([]); });
  test("validated operator bytes become a private immutable-by-name snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laun-policy-ceiling-")); dirs.push(dir); const source = join(dir, "operator.yaml"), state = join(dir, "state");
    await writeFile(source, DEFAULT_ISOLATED_POLICY);
    const prepared = await prepareIsolatedPolicy(state, source);
    expect(prepared.path).not.toBe(source); expect(prepared.sha256).toMatch(/^[0-9a-f]{64}$/); expect((await stat(prepared.path)).mode & 0o777).toBe(0o600);
    await writeFile(source, egress); expect(await readFile(prepared.path, "utf8")).toBe(DEFAULT_ISOLATED_POLICY);
    await expect(prepareIsolatedPolicy(state, source)).rejects.toThrow("central MCP broker");
    expect(await prepareIsolatedPolicy(state)).toEqual(prepared);
    await writeFile(prepared.path, egress); await expect(prepareIsolatedPolicy(state)).rejects.toThrow("does not match its digest");
  });
  test("symlink, oversized and malformed policy inputs fail without rewriting their sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laun-policy-input-")); dirs.push(dir); const source = join(dir, "source"), link = join(dir, "link"), state = join(dir, "state");
    await writeFile(source, DEFAULT_ISOLATED_POLICY); await symlink(source, link); await expect(prepareIsolatedPolicy(state, link)).rejects.toThrow();
    expect(await readFile(source, "utf8")).toBe(DEFAULT_ISOLATED_POLICY);
    await writeFile(source, "x".repeat(65537)); await expect(prepareIsolatedPolicy(state, source)).rejects.toThrow("64 KiB");
    await writeFile(source, "version: ["); await expect(prepareIsolatedPolicy(state, source)).rejects.toThrow("Unsupported v2");
  });
});
