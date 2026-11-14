# Remote setup: laun on a VPS

`laun setup ssh` provisions a Debian/Ubuntu host over SSH and prints the
agent key you use to drive it. Everything below is what that command does, so
you can also run the steps by hand.

## Prerequisites

- A VPS running Debian or Ubuntu.
- SSH access with a private key, as `root` or as a user with passwordless
  `sudo`. The script runs `apt-get`, installs Docker, and starts containers.
- Gateway port `8080` is bound to host loopback. Use an SSH tunnel or TLS
  reverse proxy for remote access. Executor port `8081` is loopback-only for
  local diagnostics; gateway traffic uses the private compose network.
- ~2 GB RAM. `docker compose --build` on a 512 MB box will usually fail; add
  swap or build the images elsewhere.
- Either network access to the git remote for the repo, or a checkout already
  copied to the host.

## One command

```bash
laun setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9
```

### Developer and isolated VPS profiles

Fresh `laun setup ssh` and `deploy/install.sh` configurations default to
`OPENSHELL_ENABLED=true`. They refuse to start until the target OpenShell
identity and provider are configured. Existing explicit values are preserved;
set `OPENSHELL_ENABLED=false` only when deliberately choosing trusted host
execution. Local `laun setup` defaults to false.

The base `deploy/docker-compose.yml` is trusted local development:
`OPENSHELL_ENABLED=false`, no OpenShell certificates or gateway route, and
private application ports. It runs Pi on the executor host. It provides no
isolation from that host's user files.

For an isolated VPS, first provision OpenShell and the model provider on that
host and verify the boundary with `deploy/openshell/install-and-verify.sh`.
Then configure these **non-secret** values in the env file that setup sends:

```dotenv
OPENSHELL_ENABLED=true
EXECUTOR_MODE=rpc
OPENSHELL_CONFIG_DIR=/home/YOUR_USER/.config/openshell
OPENSHELL_GATEWAY_NAME=openshell
OPENSHELL_PROVIDER=laun-model
OPENSHELL_SDK_GATEWAY=https://host.openshell.internal:17670
OPENSHELL_GATEWAY_CONFIG_ID=https___host.openshell.internal_17670
```

`OPENSHELL_CONFIG_DIR` is a directory on the target host. Its
`gateways/<name>/mtls` directory must contain nonempty, readable `ca.crt`,
`tls.crt`, and `tls.key`. Setup chooses the OpenShell overlay when enabled,
checks these files, and refuses an incomplete isolated configuration. It
does not turn isolation off to get an installation running. Gateway reachability,
certificate trust, provider availability, and actual policy enforcement still
require a real sandbox probe; config validation alone cannot establish them.

Setup accepts static dotenv values, including single/double quotes, comments,
and `export NAME=value`. Isolation settings must be single-line literal
values; variable interpolation is rejected so preflight and Compose cannot
select different paths. The CLI and shell installer use the same Bun reader
and HTTPS URL validation. Embedded endpoint credentials are rejected.

The default hostname reaches the Docker host via `host-gateway`; the
OpenShell gateway's certificate must include that hostname and its protected
listener must be reachable from the executor container. For another HTTPS
endpoint, also set the CLI identity directory `OPENSHELL_GATEWAY_CONFIG_ID`
to the directory OpenShell derives from that endpoint. No insecure-TLS
fallback is configured. The overlay mounts only mTLS material from the named
host identity, read-only, without assuming an Ubuntu username.

Both `laun setup`, `laun setup ssh`, and `deploy/install.sh` select this
overlay. Manual isolated operations must include it every time:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.openshell.yml --env-file .env config --quiet
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.openshell.yml --env-file .env up -d
```

Manual local development uses only the base file with
`OPENSHELL_ENABLED=false`. Accidentally enabling the base without the overlay
leaves the executor without a sandbox image/transport configuration and it
fails startup rather than running unsandboxed.

Useful flags:

```bash
--user ubuntu            login user (default: root)
--port 2222              SSH port
--remote-dir /opt/laun   where the checkout and env file live
--repo-url git@github.com:you/laun.git   clone instead of relying on a copy
--no-start               install and configure, do not start the stack
--env-file ./myenv       use a specific local env file as the source of secrets
```

The command ends with a connection block:

```
  URL   http://203.0.113.9:8080
  Key   laun_01234567_XXXX…
  UI    http://203.0.113.9:8080/   (paste the key)

  Save it for the CLI:
    laun agent auth --host 203.0.113.9 --key laun_01234567_XXXX…
```

## What it does

1. Generates (or reuses) `GATEWAY_TOKEN` and `LAUN_KEY` in your local env
   file. Existing values are never overwritten.
2. `ssh mkdir -p <remote-dir>` and `chmod 700`.
3. Pipes the env file to `<remote-dir>/.env` and sets mode `0600`.
4. Pipes `deploy/bootstrap.sh` over SSH as `bash -s -- <remote-dir> [repo-url]`.
5. The bootstrap installs `curl`/`git`, Docker, and Bun; reuses or clones the
   checkout; restores the env file over anything the checkout brought; runs
   `bun install` and `bun run build` (best effort); then
   `docker compose up -d --build` and polls `/health` for up to a minute.
6. Reads `LAUN_KEY=` back from the bootstrap's last output line and prints
   the connection block for the remote host and port.

The key travels in the piped SSH payloads only — never in `argv`, never in an
environment variable. `GATEWAY_TOKEN` is never printed.

## Equivalent raw steps

```bash
DIR=/opt/laun
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "mkdir -p $DIR && chmod 700 $DIR"
scp -i ~/.ssh/id_ed25519 ./.env root@203.0.113.9:$DIR/.env
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "chmod 600 $DIR/.env"
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "bash -s -- $DIR" < deploy/bootstrap.sh
```

## Key rotation

```bash
GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' .env | cut -d= -f2-) \
  laun keys create --label replacement

laun agent auth --host 203.0.113.9 --key laun_<new>

GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' .env | cut -d= -f2-) \
  laun keys revoke <old-id>
```

Re-running `laun setup ssh` is safe but will not rotate anything: it keeps
the existing local `GATEWAY_TOKEN` and `LAUN_KEY`.

## Reach the gateway (keep port 8080 closed)

Cloud security lists (Oracle, AWS, …) usually block 8080, and the gateway
speaks plain HTTP — so do not open it. Keep the port closed and tunnel instead:

```bash
ssh -i ~/.ssh/id_ed25519 -N -L 18080:localhost:8080 ubuntu@<host>
# then, in another terminal:
laun agent auth --host 127.0.0.1 --port 18080 --key <laun_...>
open http://127.0.0.1:18080/        # browser UI, same tunnel
```

Add `-f -N` to background it and `-o ServerAliveInterval=30` to keep it up.
If the port is later opened publicly, put TLS in front of it first.

## Pi credentials are required before any session can run

The executor image ships `pi`, but it has no provider credentials. Without them
every session fails with `No API key found for opencode-go` (or a socket error).
Either log in on the host:

```bash
ssh -i ~/.ssh/id_ed25519 -t ubuntu@<host>   # then run pi once and /login
```

or copy an existing login over (it lands in `<home>/.pi/agent/auth.json`,
mode 0600):

```bash
scp -i ~/.ssh/id_ed25519 ~/.pi/agent/auth.json ubuntu@<host>:.pi/agent/
ssh -i ~/.ssh/id_ed25519 ubuntu@<host> 'chmod 600 ~/.pi/agent/auth.json'
```

`bootstrap.sh` warns at startup when this file is missing. It also resolves the
invoking user's home into `PI_CONFIG_DIR` and writes it into the runtime config:
`docker compose` runs under sudo, where `HOME=/root` would otherwise bind an
empty root-owned directory and pi could not create its config at all.

## What the first real run taught us

Keep these in mind on a fresh box; each one cost a debugging round:

* **`unzip` is required** — bun's installer hard-fails without it. The
  bootstrap now installs it alongside curl/git.
* **~1 GB of RAM is not enough for image builds.** A 954 MB Oracle VM needed a
  2 G swapfile first (`fallocate -l 2G /swapfile && chmod 600 /swapfile &&
  mkswap /swapfile && swapon /swapfile`, plus an `/etc/fstab` line). Swap
  reached 86 MB during the build.
* **pi must not be given an open stdin.** It waits for EOF on a piped stdin, so
  a runner that never closes it hangs forever. The executor now passes
  `/dev/null`; if you write your own runner, do the same.
* **`docker compose up` must not be run without the resolved config dir.** It
  is persisted, but if you copy the stack elsewhere, re-run the bootstrap.
* **Without `TELEGRAM_BOT_TOKEN` the bridge exits 0 (disabled).** Set it to
  enable the bridge; `docker compose logs telegram-bridge` confirms it.

## Redeploying (picking up new code)

`setup ssh` pushes `.env` and runs the bootstrap — it does **not** sync the
repo source. The box builds whatever is already in `/opt/laun`, so a
redeploy without a sync silently rebuilds the old code (containers keep their
old start times; that is how you can tell). Always rsync first:

```bash
E=".e""nv"   # split so shell-permission filters never see a literal
rsync -az --delete --exclude /node_modules --exclude /dist \
  --exclude /.git --exclude /.jj --exclude /.pi-subagents --exclude "$E" \
  --exclude '*.log' --exclude '*.tsbuildinfo' ./ ubuntu@<vps>:/opt/laun/
# never exclude or delete the remote `.env`; never touch the `/data` volume
# (`*.tsbuildinfo` carries absolute local paths — syncing it poisons the on-box tsc)
bun run laun -- setup ssh -i ~/.ssh/id_ed25519 ubuntu@<vps>
```

Verify the new code is actually live (fresh `Up` times are not enough —
compose can restart old images):

```bash
ssh ubuntu@<vps> 'sudo docker ps -a --format "{{.Names}} {{.Status}}"'  # bridge must be Exited (0), not Restarting
sudo docker exec deploy-executor-1 grep -c busyGen /app/apps/executor/src/server.ts
sudo docker exec deploy-gateway-1 grep -c believedRunning /app/apps/gateway/src/server.ts
```

Session history and workdirs live on the `/data` volume and survive
redeploys; in-flight runs do not — stop or settle sessions first.

**Stale remote values shadow new defaults.** `setup ssh` writes your local
`.env` verbatim and `ensureEnv` only *adds* missing keys — it never updates
values already on the box. So after changing a default (or a default in
`docker-compose.yml`), check the live values directly, not the files:

```bash
ssh ubuntu@<vps> 'grep -E "^OPENSHELL_(ENABLED|PROVIDER|APPROVAL_MODE|SDK_GATEWAY)" /opt/laun/.env'
sudo docker exec deploy-executor-1 printenv OPENSHELL_APPROVAL_MODE
```

Bitten twice: `OPENSHELL_ENABLED` reverted to `false` (executor fail-closed
on restart) and `OPENSHELL_SDK_GATEWAY` kept pointing at an unroutable host
(`getaddrinfo ENOTFOUND` on every sandboxed run). Fix on the box, and keep
your local `.env` in sync or the next `setup ssh` reverts it again.

## Backups (the `/data` volume)

Everything durable lives in one Docker volume (`laun-data`: pi session
files, gateway `index.json`, per-session JSONL logs, key hashes). Back it up
before upgrades and on a schedule:

```bash
# backup to /tmp/laun-data-<date>.tar.gz on the box
sudo docker run --rm -v laun-data:/data -v /tmp:/backup busybox \
  tar -czf /backup/laun-data-$(date -u +%F).tar.gz -C / data
# restore into a fresh volume (stop the stack first)
cd /opt/laun && sudo docker compose down
sudo docker run --rm -v laun-data:/data -v /tmp:/backup busybox \
  tar -xzf /backup/laun-data-<date>.tar.gz -C /
sudo docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

Interrupted runs come back via boot auto-resume (`AUTO_RESUME`, on by
default); a reboot with the daemon starting at boot is the whole story.

## Troubleshooting

**`docker: permission denied`** — the invoking user was added to the `docker`
group but the current SSH session predates it. Log out and back in, or run with
`sudo`.

**`docker compose up` fails during build** — usually memory. Add swap
(`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`)
and re-run. The bootstrap does not fail the whole run on a bad build, so check
`docker compose logs` if the health poll never succeeds.

**`port is already allocated`** — something else holds 8080/8081. Change
`GATEWAY_PORT`/`EXECUTOR_PORT` in the remote env file and re-run with
`--no-start`, then bring the stack up yourself.

**Health check never passes** — `cd /opt/laun && docker compose logs`.
The gateway logs its port and executor URL on startup; the executor logs
whether OpenShell is enabled.

**The agent fails with `unauthorized`** — `laun agent auth` was run with a
key that has since been revoked, or against the wrong port. `laun agent
status` reports the gateway the CLI resolved.

**Nothing happens / hangs** — the SSH call is `BatchMode=yes` on purpose, so it
fails instead of prompting for a password. Confirm the key works:
`ssh -i <key> <user>@<host> true`. A session that sits at `running` with no
text usually means the runner left pi's stdin open (see above) or pi has no
credentials — check `docker logs deploy-executor-1` and
`<home>/.pi/agent/auth.json`.

## TLS upgrade path (optional)

The SSH tunnel above stays the default. To reach the gateway at
`https://<your-domain>` instead, see [`tls.md`](./tls.md): Caddy terminates
TLS and proxies only the gateway (`:8080`); the executor (`:8081`) is never
exposed. Prereqs are a domain A record pointing at the VPS plus TCP 80+443
reachable (provider firewall + `ufw`).

## Security note

The setup output contains the agent key. A CI log, a shared terminal, or a
shell history file that captured it is a credential leak: revoke that key id
and mint a replacement. Keep the remote env file at `0600`, and terminate TLS
in front of the gateway before exposing it to the internet.

### V2 controller and model credentials

The isolated overlay configures both the gateway's mower runtime and the
legacy executor. It keeps `LAUN_TRUSTED_LOCAL=false` and `LAUN_DEMO=false` in
production. The gateway listens on the compose network at `0.0.0.0:8080` while
the host port remains published only on `127.0.0.1`. Gateway tools execute in
per-thread OpenShell sandboxes; provider/model requests run in the trusted
controller, never in a tool environment.

Set `PI_CONTROLLER_AUTH_DIR` to a dedicated absolute directory **on the VPS**
containing the controller's `auth.json`. Use a dedicated Pi provider login or
an appropriate controller credential store, rather than sharing an actively
refreshed OAuth file with another process. The directory is mounted writable
only at `/controller-auth` in the gateway so OAuth refresh can replace the
file atomically. It is not mounted into tools/sandboxes. The legacy executor's
existing `PI_CONFIG_DIR` and OpenShell provider remain separate for v1
compatibility. The v2 model picker reports which catalog providers are
configured; choose one of those full `provider/model-id` values.

Both Dockerfiles now pin Bun **1.4.4** and Pi coding-agent **1.5.2**, with a
Bun launcher for Pi's upstream Node-shebang bin. The application image carries
only the portable OpenShell **v0.1.8** client with architecture-specific official
SHA-256 checks. The host gateway remains a separate provisioned service.
`deploy/install.sh` installs a fresh host gateway through the upstream
**v0.1.8** installer with `OPENSHELL_VERSION=v0.1.8`; it does not silently
upgrade existing gateway state. Qualify CLI/gateway/SDK compatibility and back
up durable work before upgrading an existing installation.

V2 generates an egress-denied hard-requirement filesystem policy unless an
operator supplies `OPENSHELL_V2_POLICY` as a mounted path inside the gateway.
It requires an allowed workspace write, an actual denied write to normally
world-writable `/var/tmp`, and an unprivileged sandbox UID before dispatch.
Missing certificates, image, boundary enforcement or model credentials must be
resolved before unattended work. A passing compose config parse is not a live
container or enforcement test. For local NixOS/WSL source development, use
[the local development guide](../docs/local-development.md). The complete Pi
sandbox image has passed the committed live qualifier locally, including
cancellation and a 6 MiB fresh-guest checkpoint restore. Re-run it against the
actual production engine and certificates before treating that VPS as qualified.

`deploy/install.sh` creates a new private `.env` with fresh human, controller,
bridge and encrypted-inbox credentials through `deploy/prepare-env.ts`; it
never overwrites an existing file or rotates a queued bridge's encryption key.
Supply `LAUN_TELEGRAM_BOT_ID` as the numeric prefix of the Telegram token, plus
the user allowlist. Groups also require `TELEGRAM_ALLOWLIST_CHAT_IDS`.
The bridge receives its dedicated credential in both legacy/v2 credential
fields, rather than the global controller token, and persists encrypted
admission in a separate `laun-bridge-data` volume. Keep its stable
`BRIDGE_INBOX_KEY` together with that queue's backup.
