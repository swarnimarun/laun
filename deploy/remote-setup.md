# Remote setup: cloudbear on a VPS

`cloudbear setup ssh` provisions a Debian/Ubuntu host over SSH and prints the
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
cloudbear setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9
```

Useful flags:

```bash
--user ubuntu            login user (default: root)
--port 2222              SSH port
--remote-dir /opt/cloudbear   where the checkout and env file live
--repo-url git@github.com:you/cloudbear.git   clone instead of relying on a copy
--no-start               install and configure, do not start the stack
--env-file ./myenv       use a specific local env file as the source of secrets
```

The command ends with a connection block:

```
  URL   http://203.0.113.9:8080
  Key   cb_5ca79d23_1awj…
  UI    http://203.0.113.9:8080/   (paste the key)

  Save it for the CLI:
    cloudbear agent auth --host 203.0.113.9 --key cb_5ca79d23_1awj…
```

## What it does

1. Generates (or reuses) `GATEWAY_TOKEN` and `CLOUDBEAR_KEY` in your local env
   file. Existing values are never overwritten.
2. `ssh mkdir -p <remote-dir>` and `chmod 700`.
3. Pipes the env file to `<remote-dir>/.env` and sets mode `0600`.
4. Pipes `deploy/bootstrap.sh` over SSH as `bash -s -- <remote-dir> [repo-url]`.
5. The bootstrap installs `curl`/`git`, Docker, and Bun; reuses or clones the
   checkout; restores the env file over anything the checkout brought; runs
   `bun install` and `bun run build` (best effort); then
   `docker compose up -d --build` and polls `/health` for up to a minute.
6. Reads `CLOUDBEAR_KEY=` back from the bootstrap's last output line and prints
   the connection block for the remote host and port.

The key travels in the piped SSH payloads only — never in `argv`, never in an
environment variable. `GATEWAY_TOKEN` is never printed.

## Equivalent raw steps

```bash
DIR=/opt/cloudbear
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "mkdir -p $DIR && chmod 700 $DIR"
scp -i ~/.ssh/id_ed25519 ./.env root@203.0.113.9:$DIR/.env
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "chmod 600 $DIR/.env"
ssh -i ~/.ssh/id_ed25519 root@203.0.113.9 "bash -s -- $DIR" < deploy/bootstrap.sh
```

## Key rotation

```bash
GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' .env | cut -d= -f2-) \
  cloudbear keys create --label replacement

cloudbear agent auth --host 203.0.113.9 --key cb_<new>

GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' .env | cut -d= -f2-) \
  cloudbear keys revoke <old-id>
```

Re-running `cloudbear setup ssh` is safe but will not rotate anything: it keeps
the existing local `GATEWAY_TOKEN` and `CLOUDBEAR_KEY`.

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

**Health check never passes** — `cd /opt/cloudbear && docker compose logs`.
The gateway logs its port and executor URL on startup; the executor logs
whether OpenShell is enabled.

**The agent fails with `unauthorized`** — `cloudbear agent auth` was run with a
key that has since been revoked, or against the wrong port. `cloudbear agent
status` reports the gateway the CLI resolved.

**Nothing happens / hangs** — the SSH call is `BatchMode=yes` on purpose, so it
fails instead of prompting for a password. Confirm the key works:
`ssh -i <key> <user>@<host> true`.

## Security note

The setup output contains the agent key. A CI log, a shared terminal, or a
shell history file that captured it is a credential leak: revoke that key id
and mint a replacement. Keep the remote env file at `0600`, and terminate TLS
in front of the gateway before exposing it to the internet.
