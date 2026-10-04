# Models with laun: Muse via opencode-go (through pi)

Laun doesn't talk to models directly — `pi` does (`pi-ai`). The default is:

```
MODEL=opencode-go/muse-spark-1.3-contributor
```

Verify it resolves (provider/model pattern):

```bash
pi --list-models "opencode-go/muse-spark"
# provider     model                       context  max-out
# opencode-go  muse-spark-1.2-contributor  1.0M     131.1K
# opencode-go  muse-spark-1.3-contributor  1.0M     131.1K
```

Other Muse-family rows under `opencode-go` work the same way — just set `MODEL`
to `opencode-go/<id>`.

## Auth: host-local, never in the repo

pi reads provider credentials from `~/.pi/agent/auth.json` on the machine that
runs the executor (your local box, or the VPS). Log in exactly like you do
locally, then confirm the command above lists rows on that host.

The executor container mounts the host's `~/.pi` read-only
(`docker-compose.yml`), so:

* No keys in `.env`, images, or session files.
* With OpenShell on, the agent sandbox additionally never sees them — OpenShell
  injects credentials only for approved endpoints.
* If your provider needs token refresh writes (opencode-go's key type does not —
  it's a static key), drop the `:ro` flag on that mount.

## Check it end-to-end (no Telegram needed)

```bash
bun run build   # required once so workspace packages resolve
export GATEWAY_TOKEN=test-token
bun run dev:executor &   # :8081
bun run dev:gateway &    # :8080
curl -H "Authorization: Bearer test-token" -X POST localhost:8080/sessions \
  -d '{"goal":"reply with the word PONG and nothing else"}'
# poll:
curl -H "Authorization: Bearer test-token" 'localhost:8080/sessions/<id>/log?since=0'
```

If that returns agent text, the whole chain (gateway → executor → pi → Muse)
works. Then put real tokens in `.env` and bring up compose.
