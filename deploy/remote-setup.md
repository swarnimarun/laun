# Remote setup: laun on a VPS

`laun setup ssh` provisions a Debian/Ubuntu host over SSH and prints the
agent key you use to drive it. Everything below is what that command does, so
you can also run the steps by hand.

## Prerequisites

- A VPS running Debian or Ubuntu.
- SSH access with a private key, as `root` or as a user with passwordless
  `sudo`. The script runs `apt-get`, installs Docker, and starts containers.
- Ports `8080` (gateway, API + browser UI) and `8081` (executor) reachable from
  where you will connect from — or a reverse proxy / SSH tunnel in front of
  them.
- ~2 GB RAM. `docker compose --build` on a 512 MB box will usually fail; add
  swap or build the images elsewhere.
- Either network access to the git remote for the repo, or a checkout already
  copied to the host.

## One command

```bash
laun setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9
```

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
