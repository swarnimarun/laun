import { createHash } from "node:crypto";

export interface OpenShellResourceOptions { cpuLimit?: number; memoryMiB?: number }
export interface OpenShellResourceLimits { cpuMilli: number; memoryBytes: number; cpuArgument: string; memoryArgument: string; sha256: string }
const error = () => new Error("Bounded isolated execution requires enforced cgroup-v2 CPU and memory limits. Configure delegated resource controllers or a supported OpenShell driver; explicit trusted-local mode is a separate host trust choice.");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function resolveResourceLimits(options: OpenShellResourceOptions = {}): OpenShellResourceLimits {
  const cpu = options.cpuLimit ?? 2, memory = options.memoryMiB ?? 1024;
  const rawMilli = cpu * 1000, cpuMilli = Math.round(rawMilli);
  if (!Number.isFinite(cpu) || cpu < 0.1 || cpu > 64 || Math.abs(rawMilli - cpuMilli) > Number.EPSILON * Math.max(1, Math.abs(rawMilli)) * 4) throw new Error("OpenShell cpuLimit must be 0.1-64 CPUs with millicpu precision");
  if (!Number.isSafeInteger(memory) || memory < 64 || memory > 65536) throw new Error("OpenShell memoryMiB must be an integer from 64 to 65536");
  const memoryBytes = memory * 1024 * 1024;
  return { cpuMilli, memoryBytes, cpuArgument: String(cpuMilli / 1000), memoryArgument: memory % 1024 === 0 ? `${memory / 1024}Gi` : `${memory}Mi`, sha256: createHash("sha256").update(JSON.stringify({ cpuMilli, memoryBytes })).digest("hex") };
}

/** OpenShell0.1.8 omits these domains; verified guest cgroups remain mandatory. */
export function validateResourceCapabilities(raw: string): void {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw error(); }
  if (!object(value) || value.status !== "healthy" || !Array.isArray(value.compute_drivers) || value.compute_drivers.length !== 1) throw error();
  const driver = value.compute_drivers[0]; if (!object(driver) || !object(driver.capabilities)) throw error();
  const resources = driver.capabilities.resource_capabilities;
  if (resources === undefined) return;
  if (!object(resources)) throw error();
  for (const key of ["cpu", "memory"]) {
    const domain = resources[key]; if (domain === undefined) continue;
    if (!object(domain) || domain.limit_supported !== true) throw error();
  }
}

export function validateRetainedResources(value: Record<string, unknown>, limits: OpenShellResourceLimits): void {
  const spec = object(value.spec) ? value.spec : undefined;
  const workload = spec && object(spec.workload) ? spec.workload : undefined;
  const template = spec && object(spec.template) ? spec.template : object(value.template) ? value.template : undefined;
  const resource = value.resources !== undefined ? value.resources : workload?.resources !== undefined ? workload.resources : template?.resources;
  if (resource === undefined) return;
  const fields = object(resource) && object(resource.limits) ? resource.limits : resource;
  if (!object(fields) || typeof fields.cpu !== "string" || typeof fields.memory !== "string") throw new Error("retained OpenShell guest resource specification differs from the reviewed limits");
  const cpuMatch = fields.cpu.match(/^([0-9]+(?:\.[0-9]{1,3})?)(m?)$/), memoryMatch = fields.memory.match(/^([0-9]+)(Ki|Mi|Gi|K|M|G)?$/);
  const rawMilli = cpuMatch ? Number(cpuMatch[1]) * (cpuMatch[2] ? 1 : 1000) : NaN, cpuMilli = Math.round(rawMilli);
  const units: Record<string, number> = { "": 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1000, M: 1000 ** 2, G: 1000 ** 3 };
  const memoryBytes = memoryMatch ? Number(memoryMatch[1]) * units[memoryMatch[2] ?? ""]! : NaN;
  if (!Number.isSafeInteger(cpuMilli) || Math.abs(rawMilli - cpuMilli) > Number.EPSILON * Math.max(1, Math.abs(rawMilli)) * 4 || cpuMilli <= 0 || cpuMilli > limits.cpuMilli || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || memoryBytes > limits.memoryBytes) throw new Error("retained OpenShell guest resource specification exceeds the reviewed limits");
}

/** Runs under Landlock inside the guest, before model or tool dispatch. */
export function resourceProbe(limits: OpenShellResourceLimits): string {
  return `
resource_error() { echo 'Bounded isolated execution requires enforced cgroup-v2 CPU and memory limits; configure delegated controllers or a supported OpenShell driver' >&2; exit 1; }
group=''
while IFS=: read -r hierarchy controllers path; do
  if test "$hierarchy" = 0 && test -z "$controllers"; then group="$path"; fi
done < /proc/self/cgroup
case "$group" in /*) ;; *) resource_error;; esac
case "$group" in *..*|*\\\\*|*[!a-zA-Z0-9_./:@-]*) resource_error;; esac
base="/sys/fs/cgroup\${group%/}"
read -r quota period extra < "$base/cpu.max" || resource_error
read -r memory memory_extra < "$base/memory.max" || resource_error
[[ "$quota" =~ ^[1-9][0-9]{0,8}$ && "$period" =~ ^[1-9][0-9]{0,6}$ && "$memory" =~ ^[1-9][0-9]{0,11}$ && -z "$extra" && -z "$memory_extra" ]] || resource_error
(( period <= 1000000 && quota * 1000 <= ${limits.cpuMilli} * period && memory <= ${limits.memoryBytes} )) || resource_error
printf 'LAUN_RESOURCE_OK %s %s %s\\n' "$quota" "$period" "$memory"
`;
}
export function verifyResourceProbe(stdout: string, limits: OpenShellResourceLimits): void {
  const match = stdout.match(/^LAUN_RESOURCE_OK ([1-9][0-9]{0,8}) ([1-9][0-9]{0,6}) ([1-9][0-9]{0,11})\nLAUN_BOUNDARY_OK$/);
  if (!match) throw error(); const quota = Number(match[1]), period = Number(match[2]), memory = Number(match[3]);
  if (period > 1_000_000 || quota * 1000 > limits.cpuMilli * period || memory > limits.memoryBytes) throw error();
}
