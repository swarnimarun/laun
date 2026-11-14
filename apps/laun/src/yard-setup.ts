import { isIP } from "node:net";
import { posix } from "node:path";
import { UsageError } from "./args.js";
import {
  shQuote,
  sshArgv,
  bunRunner,
  type CommandRunner,
  type SshTargetSpec,
} from "./ssh.js";
import { yardSourceDecoder, type YardSourceArchive } from "./yard-source.js";
import type { WorkerCapabilities } from "@laun/protocol";
import {
  prepareRemoteDirectory,
  publishRemoteConfig,
  validateInstallDirectory,
} from "./remote-path.js";

export function supportsYardCapabilities(
  value: unknown,
  inference: "controller" | "local",
): value is WorkerCapabilities {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<WorkerCapabilities>;
  return (
    c.protocolVersion === 1 &&
    c.checkpointVersion === "pi-durable@1.5.2" &&
    Array.isArray(c.inferenceModes) &&
    c.inferenceModes.includes(inference) &&
    Array.isArray(c.durabilityAdapters) &&
    c.durabilityAdapters.some(
      (adapter) =>
        adapter?.adapter === "pi-durable@1.5.2" && adapter.version === 1,
    )
  );
}

const CONFIG_KEYS = new Set([
  "PI_AUTH_FILE",
  "OPENSHELL_BIN",
  "OPENSHELL_SANDBOX_IMAGE",
  "OPENSHELL_V2_POLICY",
  "OPENSHELL_GATEWAY_ENDPOINT",
  "OPENSHELL_GATEWAY_CONFIG_ID",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "OPENSHELL_CPU_LIMIT",
  "OPENSHELL_MEMORY_MIB",
  "LAUN_MIN_FREE_DISK_MIB",
]);
export interface YardSetupOptions extends SshTargetSpec {
  controllerUrl: string;
  workerId: string;
  workerKey: string;
  remoteDir: string;
  repoUrl?: string;
  revision?: string;
  sourceArchive?: YardSourceArchive;
  inference?: "controller" | "local";
  serviceUser?: string;
  capacity?: number;
  config: Record<string, string>;
  bunPath?: string;
  runner?: CommandRunner;
  noStart?: boolean;
}
export interface YardInstallPlan {
  service: string;
  directory: string;
  environment: string;
  bootstrap: string;
}

/** All remote values remain data. Only the explicitly enrolled worker key is transferred. */
export function planYardSetup(options: YardSetupOptions): YardInstallPlan {
  validateInstallDirectory(options.remoteDir);
  if (
    !/^[A-Za-z0-9_.:%\[\]-]+$/.test(options.host) ||
    options.host.startsWith("-") ||
    (options.user !== undefined &&
      !/^[a-z_][a-z0-9_-]*\$?$/i.test(options.user))
  )
    throw new UsageError("invalid SSH host or user");
  const endpoint = new URL(options.controllerUrl);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."));
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback))
  )
    throw new UsageError(
      "controller URL must be a credential-free HTTPS origin (explicit loopback HTTP tunnel allowed)",
    );
  if (
    !/^[0-9a-f-]{36}$/.test(options.workerId) ||
    !new RegExp(`^yard_${options.workerId}_[A-Za-z0-9_-]{20,128}$`).test(
      options.workerKey,
    )
  )
    throw new UsageError(
      "yard setup requires the newly enrolled scoped worker credential",
    );
  if (options.sourceArchive && (options.repoUrl || options.revision))
    throw new UsageError(
      "choose the local source archive or an explicit published repository revision",
    );
  if (
    !options.sourceArchive &&
    (!options.repoUrl ||
      !options.revision ||
      !/^[0-9a-f]{40}$/.test(options.revision))
  )
    throw new UsageError(
      "published source needs repo-url plus an exact 40-character commit revision",
    );
  if (
    options.sourceArchive &&
    !/^[0-9a-f]{64}$/.test(options.sourceArchive.manifest)
  )
    throw new UsageError("invalid source archive manifest");
  if (
    !options.remoteDir.startsWith("/") ||
    options.remoteDir === "/" ||
    /[\r\n\0]/.test(options.remoteDir)
  )
    throw new UsageError(
      "remote-dir must be an absolute private installation directory",
    );
  const repository = options.repoUrl ? new URL(options.repoUrl) : undefined;
  if (
    repository &&
    (repository.protocol !== "https:" ||
      repository.username ||
      repository.password ||
      repository.hash ||
      repository.search)
  )
    throw new UsageError("repo-url must be credential-free HTTPS");
  for (const [name, value] of Object.entries(options.config)) {
    if (
      !CONFIG_KEYS.has(name) ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value)
    )
      throw new UsageError(`unsupported yard configuration field: ${name}`);
    if (
      (name.endsWith("_FILE") ||
        name.endsWith("_POLICY") ||
        name.startsWith("XDG_") ||
        name === "OPENSHELL_BIN") &&
      !value.startsWith("/")
    )
      throw new UsageError(
        `${name} must refer to an absolute operator-provisioned remote path`,
      );
  }
  const inference = options.inference ?? "controller";
  if (
    options.capacity !== undefined &&
    (!Number.isSafeInteger(options.capacity) ||
      options.capacity < 1 ||
      options.capacity > 16)
  )
    throw new UsageError("capacity must be between 1 and 16");
  if (!["controller", "local"].includes(inference))
    throw new UsageError("inference must be controller or local");
  if (options.sourceArchive) {
    const declaration = options.sourceArchive.files.find(
      (file) => file.path === "apps/worker/src/capabilities.json",
    );
    if (
      !declaration ||
      !supportsYardCapabilities(
        JSON.parse(Buffer.from(declaration.content, "base64").toString("utf8")),
        inference,
      )
    )
      throw new UsageError(
        "source worker must advertise controller-compatible inference and central durable adapter pi-durable@1.5.2 version 1",
      );
  }
  if (inference === "controller" && options.config.PI_AUTH_FILE)
    throw new UsageError(
      "controller inference must not provision provider credential files",
    );
  if (
    (inference === "local" && !options.config.PI_AUTH_FILE) ||
    !options.config.OPENSHELL_SANDBOX_IMAGE ||
    !options.config.OPENSHELL_BIN ||
    !options.config.XDG_CONFIG_HOME
  )
    throw new UsageError(
      "yard setup requires OpenShell binary/image/config references; local inference also requires a remote PI_AUTH_FILE",
    );
  if (options.config.OPENSHELL_GATEWAY_ENDPOINT) {
    const gateway = new URL(options.config.OPENSHELL_GATEWAY_ENDPOINT);
    if (
      gateway.protocol !== "https:" ||
      gateway.username ||
      gateway.password ||
      gateway.search ||
      gateway.hash
    )
      throw new UsageError(
        "OpenShell gateway endpoint must be credential-free HTTPS",
      );
  }
  const gatewayId =
    options.config.OPENSHELL_GATEWAY_CONFIG_ID ??
    (options.config.OPENSHELL_GATEWAY_ENDPOINT
      ? new URL(options.config.OPENSHELL_GATEWAY_ENDPOINT).origin.replace(
          /[:/]/g,
          "_",
        )
      : undefined);
  if (
    gatewayId &&
    (!/^[A-Za-z0-9_.-]+$/.test(gatewayId) ||
      gatewayId === "." ||
      gatewayId === "..")
  )
    throw new UsageError(
      "provide a safe OpenShell gateway config identity for certificate preflight",
    );
  const bunPath = options.bunPath ?? "/usr/local/bin/bun";
  if (!bunPath.startsWith("/") || /[\r\n\0]/.test(bunPath))
    throw new UsageError("bun-path must be absolute");
  const directory = options.remoteDir.replace(/\/+$/, "");
  const statePath = posix.resolve(directory, "state");
  const trustedPaths = [
    "PI_AUTH_FILE",
    "OPENSHELL_BIN",
    "OPENSHELL_V2_POLICY",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
  ];
  for (const name of trustedPaths) {
    if (options.config[name]) {
      const path = posix.resolve(options.config[name]);
      if (path === statePath || path.startsWith(`${statePath}/`))
        throw new UsageError(
          `${name} must stay outside worker state, thread and workspace directories`,
        );
    }
  }
  if (options.config.OPENSHELL_CPU_LIMIT !== undefined) {
    const cpu = Number(options.config.OPENSHELL_CPU_LIMIT);
    if (
      !Number.isFinite(cpu) ||
      cpu < 0.1 ||
      cpu > 64 ||
      !Number.isInteger(cpu * 1000)
    )
      throw new UsageError(
        "OPENSHELL_CPU_LIMIT must be 0.1-64 with millicpu precision",
      );
  }
  if (options.config.OPENSHELL_MEMORY_MIB !== undefined) {
    const memory = Number(options.config.OPENSHELL_MEMORY_MIB);
    if (!Number.isSafeInteger(memory) || memory < 64 || memory > 65536)
      throw new UsageError("OPENSHELL_MEMORY_MIB must be 64-65536");
  }
  if (options.config.LAUN_MIN_FREE_DISK_MIB !== undefined) {
    const reserve = Number(options.config.LAUN_MIN_FREE_DISK_MIB);
    if (!Number.isInteger(reserve) || reserve < 0 || reserve > 1024 * 1024)
      throw new UsageError(
        "LAUN_MIN_FREE_DISK_MIB must be an integer from 0 to 1048576",
      );
  }
  const service = `laun-yard-${options.workerId.slice(0, 8)}`;
  const serviceUser = options.serviceUser ?? service;
  if (serviceUser === "root" || !/^[a-z_][a-z0-9_-]*\$?$/i.test(serviceUser))
    throw new UsageError("service-user must be a dedicated non-root account");
  const configuration = {
    ...options.config,
    LAUN_INFERENCE_MODE: inference,
    LAUN_CONTROLLER_URL: endpoint.origin,
    LAUN_WORKER_KEY: options.workerKey,
    LAUN_WORKER_DIR: `${directory}/state`,
    OPENSHELL_ENABLED: "true",
    OPENSHELL_GATEWAY_INSECURE: "false",
    LAUN_WORKER_CAPACITY: String(options.capacity ?? 1),
  };
  // systemd EnvironmentFile understands quoted values and does not perform shell expansion.
  const environment =
    Object.entries(configuration)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n") + "\n";
  const unitValue = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  const release = `${directory}/releases/${options.sourceArchive?.manifest ?? options.revision}`;
  const unit = [
    "[Unit]",
    "Description=Laun outbound execution yard",
    "After=network-online.target",
    "Wants=network-online.target",
    "[Service]",
    "Type=simple",
    `User=${serviceUser}`,
    `WorkingDirectory=${unitValue(release)}`,
    `EnvironmentFile=${unitValue(`${directory}/worker.env`)}`,
    `Environment=${unitValue(`HOME=${directory}/home`)}`,
    `ExecStart=${unitValue(bunPath)} ${unitValue(`${release}/apps/worker/src/index.ts`)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=75",
    "KillMode=control-group",
    "UMask=0077",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  const bootstrap = [
    "set -euo pipefail",
    "umask 077",
    `directory=${shQuote(directory)}`,
    `release=${shQuote(release)}`,
    `service=${shQuote(service)}`,
    `service_user=${shQuote(serviceUser)}`,
    `bun_bin=${shQuote(bunPath)}`,
    'test "$(id -u)" = 0 || { echo "yard installation needs root or passwordless sudo" >&2; exit 1; }',
    `${repository ? "command -v git >/dev/null && " : ""}command -v systemctl >/dev/null && command -v useradd >/dev/null && command -v runuser >/dev/null || { echo "install the systemd/user-management host prerequisites (and Git for repository setup) first" >&2; exit 1; }`,
    'test -x "$bun_bin" && test "$("$bun_bin" --version)" = 1.4.4 || { echo "a pinned Bun 1.4.4 installation is required" >&2; exit 1; }',
    ...(options.serviceUser
      ? [
          `id "$service_user" >/dev/null 2>&1 || { echo "the explicit service-user must already be provisioned" >&2; exit 1; }`,
        ]
      : [
          'id "$service_user" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$service_user"',
        ]),
    'test "$(id -u "$service_user")" != 0 || { echo "worker service must not run as root" >&2; exit 1; }',
    'service_group=$(id -gn "$service_user")',
    'install -d -o root -g "$service_group" -m 0750 "$directory" "$directory/releases"',
    'install -d -o "$service_user" -g "$service_group" -m 0700 "$directory/state" "$directory/home"',
    ...(repository
      ? [
          `test ! -e "$release" || { echo "release directory already exists; inspect the previous setup before retry" >&2; exit 1; }`,
          `git -c core.hooksPath=/dev/null clone --no-checkout --filter=blob:none -- ${shQuote(repository.href)} "$release"`,
          `git -C "$release" -c core.hooksPath=/dev/null fetch --depth 1 origin ${shQuote(options.revision!)}`,
          `git -C "$release" -c core.hooksPath=/dev/null checkout --detach ${shQuote(options.revision!)}`,
          `test "$(git -C "$release" rev-parse HEAD)" = ${shQuote(options.revision!)}`,
        ]
      : [
          `test -f "$release/bun.lock" && test -f "$release/apps/worker/src/index.ts"`,
        ]),
    `"$bun_bin" -e ${shQuote(`const c=await Bun.file(${JSON.stringify(`${release}/apps/worker/src/capabilities.json`)}).json();if(c.protocolVersion!==1||c.checkpointVersion!=='pi-durable@1.5.2'||!Array.isArray(c.inferenceModes)||!c.inferenceModes.includes(${JSON.stringify(inference)})||!Array.isArray(c.durabilityAdapters)||!c.durabilityAdapters.some(d=>d?.adapter==='pi-durable@1.5.2'&&d.version===1))throw Error('worker source lacks required inference and central durable adapter capabilities');`)}`,
    '(cd "$release" && "$bun_bin" install --frozen-lockfile --ignore-scripts)',
    'chown -R root:"$service_group" "$release"; chmod -R u=rwX,g=rX,o= "$release"',
    'runuser -u "$service_user" -- test -x "$bun_bin" || { echo "the pinned Bun path must be executable by service-user" >&2; exit 1; }',
    `capability_output=$(cd "$release" && timeout 15 runuser -u "$service_user" -- env -i PATH=/usr/bin:/bin HOME=${shQuote(`${directory}/home`)} "$bun_bin" "$release/apps/worker/src/index.ts" --capabilities) || { echo "worker capabilities probe failed before configuration or launch" >&2; exit 1; }`,
    `printf '%s' "$capability_output" | "$bun_bin" -e ${shQuote(`const c=JSON.parse(await Bun.stdin.text());if(c.protocolVersion!==1||c.checkpointVersion!=='pi-durable@1.5.2'||!Array.isArray(c.inferenceModes)||!c.inferenceModes.includes(${JSON.stringify(inference)})||!Array.isArray(c.durabilityAdapters)||!c.durabilityAdapters.some(d=>d?.adapter==='pi-durable@1.5.2'&&d.version===1))throw Error('worker executable capability mismatch');`)}`,
    ...(inference === "local"
      ? [
          `runuser -u "$service_user" -- test -r ${shQuote(options.config.PI_AUTH_FILE!)} || { echo "operator PI_AUTH_FILE must be readable by service-user" >&2; exit 1; }`,
          `auth_real=$(readlink -f -- ${shQuote(options.config.PI_AUTH_FILE!)}); state_real=$(readlink -f -- "$directory/state"); case "$auth_real" in "$state_real"|"$state_real"/*) echo "provider credentials must not live in worker state or agent workspaces" >&2; exit 1;; esac`,
        ]
      : []),
    `runuser -u "$service_user" -- test -x ${shQuote(options.config.OPENSHELL_BIN)}`,
    ...trustedPaths
      .filter((name) => options.config[name])
      .map(
        (name) =>
          `reference_real=$(readlink -f -- ${shQuote(options.config[name]!)}); state_real=$(readlink -f -- "$directory/state"); case "$reference_real" in "$state_real"|"$state_real"/*) echo "${name} must not resolve into worker state or agent workspaces" >&2; exit 1;; esac`,
      ),
    ...(options.config.OPENSHELL_V2_POLICY
      ? [
          `runuser -u "$service_user" -- test -f ${shQuote(options.config.OPENSHELL_V2_POLICY)} && runuser -u "$service_user" -- test -r ${shQuote(options.config.OPENSHELL_V2_POLICY)} || { echo "operator OpenShell policy must be readable by service-user" >&2; exit 1; }`,
        ]
      : []),
    `runuser -u "$service_user" -- test -d ${shQuote(options.config.XDG_CONFIG_HOME)} && runuser -u "$service_user" -- test -r ${shQuote(options.config.XDG_CONFIG_HOME)} && runuser -u "$service_user" -- test -x ${shQuote(options.config.XDG_CONFIG_HOME)} || { echo "operator OpenShell config directory must be readable and traversable by service-user" >&2; exit 1; }`,
    ...(gatewayId
      ? ["ca.crt", "tls.crt", "tls.key"].map(
          (name) =>
            `runuser -u "$service_user" -- test -f ${shQuote(`${options.config.XDG_CONFIG_HOME}/openshell/gateways/${gatewayId}/mtls/${name}`)} && runuser -u "$service_user" -- test -r ${shQuote(`${options.config.XDG_CONFIG_HOME}/openshell/gateways/${gatewayId}/mtls/${name}`)} || { echo "operator OpenShell mTLS ${name} must be readable by service-user; verify OPENSHELL_GATEWAY_CONFIG_ID" >&2; exit 1; }`,
        )
      : []),
    `cat > ${shQuote(`/etc/systemd/system/${service}.service`)} <<'LAUN_SYSTEMD_UNIT'`,
    unit,
    "LAUN_SYSTEMD_UNIT",
    "systemctl daemon-reload",
    ...(options.noStart
      ? []
      : [
          'systemctl enable --now "$service.service"',
          'systemctl is-active --quiet "$service.service"',
        ]),
    'printf "LAUN_YARD_INSTALLED=%s\\n" "$service"',
  ].join("\n");
  return { service, directory, environment, bootstrap };
}

/** SSH host provisioning is invoked only by an explicit setup command. Tests inject a runner. */
export async function runRemoteYardSetup(
  options: YardSetupOptions,
): Promise<{ service: string; directory: string }> {
  const plan = planYardSetup(options),
    run = options.runner ?? bunRunner;
  const root = (command: string) =>
    `if [ "$(id -u)" = 0 ]; then bash -c ${shQuote(command)}; else sudo -n bash -c ${shQuote(command)}; fi`;
  const steps: [string, string?][] = [
    [
      root(
        `${prepareRemoteDirectory(plan.directory, "yard")}\n${publishRemoteConfig(plan.directory, "worker.env")}\n[ ! -L ${shQuote(`${plan.directory}/releases`)} ] || { echo 'release directory must not be a symlink' >&2; exit 1; }; mkdir -p -m 0700 -- ${shQuote(`${plan.directory}/releases`)}`,
      ),
      plan.environment,
    ],
    ...(options.sourceArchive
      ? [
          [
            root(
              `${shQuote(options.bunPath ?? "/usr/local/bin/bun")} -e ${shQuote(yardSourceDecoder(`${plan.directory}/releases/${options.sourceArchive.manifest}`))}`,
            ),
            JSON.stringify(options.sourceArchive),
          ] as [string, string],
        ]
      : []),
    [
      'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi',
      plan.bootstrap,
    ],
  ];
  for (const [command, stdin] of steps) {
    const result = await run(sshArgv(options, command), {
      stdin,
      stdio: "pipe",
      echo: false,
    });
    if (result.code !== 0) {
      const safe = result.stderr
        .replaceAll(options.workerKey, "[redacted worker key]")
        .slice(-1000);
      throw new Error(
        `yard SSH installation failed (${result.code}); the private remote files remain for inspection${safe ? `: ${safe}` : ""}`,
      );
    }
  }
  return { service: plan.service, directory: plan.directory };
}
