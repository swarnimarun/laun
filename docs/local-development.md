# Running the mower app locally on NixOS / WSL

Use the Linux checkout under `/home`, rather than `/mnt/c`, for SQLite, file
watching, executable scripts and Linux file permissions. Windows may open
`http://localhost:8080` through WSL's localhost forwarding. The server binds
Linux loopback by default; it does not expose a public service.

## Development shell

From the repository root:

```sh
nix-shell
bun install --frozen-lockfile
bun run build
bun run test
```

The shell uses your selected Nixpkgs channel and provides Bun, Git, JJ, jq,
ripgrep, fd and Bash. It keeps Bun's cache under writable `/tmp`. This is not a
new NixOS system configuration and does not change global services. To include
Chromium for browser tests, use:

```sh
nix-shell --arg withBrowser true
```

That shell exports `CHROMIUM_BIN` and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Browser launchers should pass this path
explicitly instead of downloading a foreign Linux browser binary. Nix's
Chromium includes its required shared libraries. WSL may also need the normal
WSLg display setup for a visible browser; headless browser tests do not.

## Start the app from source

The startup helper creates private local credentials and state, so a first UI
demo does not need Docker, a global Pi CLI or a provider login:

```sh
bun run dev:app --demo
```

Open the printed `/app` URL, normally `http://127.0.0.1:8080/app`, and enter the
printed human key. Complete the Groundskeeper wizard, then send a message.
Select another port with `GATEWAY_PORT=18881` if 8080 is occupied.

The helper keeps its generated credentials in `.laun-local/access.json` and its
control database in `.laun-local/control.sqlite`. Read the `key` field for browser
login; the `service` field is an installation credential. Neither belongs in
screenshots or agent workspaces. The process prints a key at startup, so treat
its terminal output as private. Ctrl-C stops this helper and its gateway.

Demo mode uses `faux/faux-1` and returns scripted echo responses. It exercises
real durable storage and queueing. The richer approval, Gatekeeper and
delegation scenarios in [demos](demos.md) use a separate disposable scripted
fixture; arbitrary prompts in echo mode do not activate those scenarios.

For real configured models with host execution:

```sh
MODEL=provider/model-id bun run dev:app --trusted-local
```

The controller reads `~/.pi/agent/auth.json` by default; `PI_AUTH_FILE` selects a
separate protected credential file. Use a dedicated file when the controller
can refresh OAuth tokens, with no concurrent credential writer. Provider
credentials stay outside thread/sandbox directories. Ordinary failures never
fall back to a demo response.

The helper makes `--demo` and `--trusted-local` explicit host modes even if a
repository `.env` enables OpenShell. Approved shell commands then retain the
host user's OS authority. The permission profile's isolated/manual/auto choice
is separate from this operating-system execution mode.

For an operator-managed gateway that uses `.env` instead of the helper's local
credentials, prepare configuration with `bun run laun setup --no-start` and run
`bun apps/gateway/src/index.ts` with the intended execution settings explicitly.
This path defaults to `DATA_DIR=./data`; the helper uses `.laun-local`. Do not mix
the two sets of keys or data directories accidentally. V2 embeds its runtime;
a separate executor is only needed for the explicitly enabled v1 API.

## Local OpenShell isolation

OpenShell needs a real Linux container engine and its own provisioned gateway.
A Windows Docker executable on WSL's PATH is not proof that its engine is
reachable. Check the actual daemon from Linux:

```sh
docker version
docker info
openshell --version
openshell gateway info
```

If Docker Desktop reports WSL integration disabled, enable it for this distro
in Docker Desktop or use a separately configured Linux engine. Nix's Docker
client alone does not start a daemon. Do not treat an installer dry run, a
container health check or a YAML parse as an enforcement proof.

The checked-in portable CLI installer is pinned to OpenShell **v0.1.8** and
verifies the official per-architecture release asset digest. It installs only
the client, not the gateway or a system service:

```sh
sh deploy/openshell/install-cli.sh "$HOME/.local/bin"
```

For a fully provisioned host, set `OPENSHELL_ENABLED=true`,
`OPENSHELL_SANDBOX_IMAGE`, and the gateway CLI's TLS identity/configuration.
The v2 adapter refuses to execute without that configuration. Before dispatch
it proves a permitted workspace write and a denied write to normally writable
`/var/tmp`, rejects root execution, and never falls back to host tools. The
sandbox starts with hard-requirement filesystem enforcement, no egress and no
provider keys. Model calls stay in the trusted controller; MCP calls pass
through the central broker.

The [runtime qualification record](../packages/runtime/README.md) documents a
real local OpenShell 0.1.8 / rootless Podman 5.8.9 run on WSL2. Its complete Pi
image passed filesystem denial, actual tools, remote command cancellation and
a 6 MiB binary server-checkpoint restore into a fresh guest. To repeat against
your provisioned gateway and image:

```sh
OPENSHELL_ENABLED=true OPENSHELL_SANDBOX_IMAGE=<built-pi-image> \
  bun packages/runtime/test/openshell-live.ts
```

This explicit fixture uses the upstream scripted provider, creates labelled
test guests and deletes only those verified guests. It retains local test
archives at printed paths. It does not make paid model requests or qualify
production TLS routing on a different host.

For Docker deployment, use the production overlay described in
[remote setup](../deploy/remote-setup.md). It supplies both the gateway's v2
sandbox client and the legacy executor's existing transport. The gateway must
bind `0.0.0.0` inside its container so other compose services can reach it;
compose still publishes only `127.0.0.1` on the host. A dedicated
`PI_CONTROLLER_AUTH_DIR` mount supplies model credentials only to the gateway.
No controller credential or operator home mount enters a v2 sandbox.

## State and recovery

The controller database (`DATA_DIR/control.sqlite`) owns transactional control
records, acknowledged Pi commits and captured workspace checkpoints. The local
yard keeps rebuildable session/work mirrors under `DATA_DIR/control/threads`;
remote yards keep their own private journals and thread caches. See
[the data map](how-it-works.md#where-data-lives) for the distinction.

Workers stop further progress on control transport loss; an interrupted attempt
requires explicit reconciliation before resuming. Do not move a live thread to
another worker without a verified checkpoint transfer. Use the
[offline backup runbook](operations-backup.md): a live copy of the SQLite file
alone is not a consistent backup, and control backup does not capture every
live guest file or external credential. An event stream or UI connection can
reconnect without restarting a run.

For isolated runs, the backend exports a bounded, checksummed guest workspace
to the host mirror before server capture. A new guest imports the restored
mirror; existing guests retain their newer files. Generated dependencies and
VCS/cache directories are omitted and recorded. Failed boundary shutdowns
return `interrupted` and block automatic follow-up work pending reconciliation.

Telegram's encrypted admission queue uses `BRIDGE_DATA_DIR` and a stable
`BRIDGE_INBOX_KEY`. Compose keeps it in a separate `laun-bridge-data` volume,
outside gateway and agent data. Back up the queue with its matching key. New
setup generates a dedicated bridge credential; account linking uses the
authenticated web app and a private `/link` message before Telegram work begins.

Run `jj status` before/after changes and commit small scopes with
`jj commit -m "scope: change"`. The app is Bun-only: do not introduce direct
Node or npm commands for its runtime, install, typecheck or tests.
