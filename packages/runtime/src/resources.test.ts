import { describe, expect, test } from "bun:test";
import { resolveResourceLimits, resourceProbe, validateResourceCapabilities, validateRetainedResources, verifyResourceProbe } from "./resources.js";

describe("verified OpenShell workload resources", () => {
  test("defaults and typed overrides have stable identities and bounded portable quantities", () => {
    const limits = resolveResourceLimits(); expect(limits).toMatchObject({ cpuMilli: 2000, memoryBytes: 1073741824, cpuArgument: "2", memoryArgument: "1Gi" });
    expect(resolveResourceLimits({ cpuLimit: 0.5, memoryMiB: 512 })).toMatchObject({ cpuMilli: 500, memoryBytes: 536870912, cpuArgument: "0.5", memoryArgument: "512Mi" });
    expect(resolveResourceLimits({ cpuLimit: 1.001 })).toMatchObject({ cpuMilli: 1001, cpuArgument: "1.001" });
    expect(resolveResourceLimits({ cpuLimit: 2, memoryMiB: 1024 }).sha256).toBe(limits.sha256); expect(resolveResourceLimits({ cpuLimit: 1 }).sha256).not.toBe(limits.sha256);
    for (const cpuLimit of [0, -1, NaN, Infinity, 65, 0.01, 1.1234, "2" as unknown as number]) expect(() => resolveResourceLimits({ cpuLimit })).toThrow("cpuLimit");
    for (const memoryMiB of [0, 63, 65537, 128.5, NaN, Infinity, "1024" as unknown as number]) expect(() => resolveResourceLimits({ memoryMiB })).toThrow("memoryMiB");
  });
  test("explicit unsupported driver resources fail; 0.1.8 absent domains still require the independent guest proof", () => {
    const info = (resource_capabilities?: unknown) => JSON.stringify({ status: "healthy", compute_drivers: [{ capabilities: resource_capabilities === undefined ? { driver_name: "podman", driver_version: "0.1.8" } : { resource_capabilities } }] });
    expect(() => validateResourceCapabilities(info())).not.toThrow(); expect(() => validateResourceCapabilities(info({ cpu: { limit_supported: true }, memory: { limit_supported: true } }))).not.toThrow();
    for (const value of [null, false, { cpu: { limit_supported: false } }, { memory: { limit_supported: false } }, { cpu: {} }, { memory: "unsupported" }]) expect(() => validateResourceCapabilities(info(value))).toThrow("Bounded isolated");
    for (const raw of ["{", "{}", '{"status":"disconnected"}', '{"status":"healthy","compute_drivers":[]}']) expect(() => validateResourceCapabilities(raw)).toThrow("Bounded isolated");
  });
  test("available retained specifications must remain within the reviewed limit label", () => {
    const limits = resolveResourceLimits(); expect(() => validateRetainedResources({}, limits)).not.toThrow();
    expect(() => validateRetainedResources({ resources: { cpu: "2000m", memory: "1024Mi" } }, limits)).not.toThrow();
    expect(() => validateRetainedResources({ resources: { cpu: "1.001", memory: "1Gi" } }, resolveResourceLimits({ cpuLimit: 1.001 }))).not.toThrow();
    expect(() => validateRetainedResources({ spec: { template: { resources: { limits: { cpu: "1", memory: "512Mi" } } } } }, limits)).not.toThrow();
    for (const resource of [null, {}, { cpu: "3", memory: "1Gi" }, { cpu: "2", memory: "2Gi" }, { cpu: "max", memory: "1Gi" }, { cpu: "2", memory: "max" }, { cpu: "0", memory: "1Gi" }]) expect(() => validateRetainedResources({ resources: resource }, limits)).toThrow("retained OpenShell");
  });
  test("every boundary proof requires finite positive own-cgroup quotas within both configured ceilings", () => {
    const limits = resolveResourceLimits();
    expect(() => verifyResourceProbe("LAUN_RESOURCE_OK 200000 100000 1073741824\nLAUN_BOUNDARY_OK", limits)).not.toThrow();
    expect(() => verifyResourceProbe("LAUN_RESOURCE_OK 100000 100000 536870912\nLAUN_BOUNDARY_OK", limits)).not.toThrow();
    for (const raw of ["LAUN_BOUNDARY_OK", "LAUN_RESOURCE_OK max 100000 max\nLAUN_BOUNDARY_OK", "LAUN_RESOURCE_OK 300000 100000 1073741824\nLAUN_BOUNDARY_OK", "LAUN_RESOURCE_OK 200000 100000 2147483648\nLAUN_BOUNDARY_OK", "LAUN_RESOURCE_OK 0 100000 1073741824\nLAUN_BOUNDARY_OK", "LAUN_RESOURCE_OK 200000 0 1073741824\nLAUN_BOUNDARY_OK"]) expect(() => verifyResourceProbe(raw, limits)).toThrow("Bounded isolated");
    expect(resourceProbe(limits)).toContain("/proc/self/cgroup"); expect(resourceProbe(limits)).toContain('/sys/fs/cgroup${group%/}'); expect(resourceProbe(limits)).toContain("cpu.max"); expect(resourceProbe(limits)).toContain("memory.max");
  });
});
