# Agent keys

An **agent key** is the credential you use to talk to a cloudbear gateway as a
person: from the CLI, from the browser UI, or from any script. It is separate
from `GATEWAY_TOKEN`, which is the internal secret the bridge and executor use
to talk to the gateway.

Two credentials, two audiences:

| Credential | Used by | Can it create sessions? | Can it mint keys? |
| --- | --- | --- | --- |
| `GATEWAY_TOKEN` | bridge, executor, operators | yes | yes |
| agent key `cb_<id>_<secret>` | you, your laptop, the browser | yes | no |

An agent key can never mint or revoke other keys, so a leaked key is a
contained incident: you rotate it, not the whole deployment.

## Anatomy (synthetic example — never a real key)

```
cb_01234567_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
│  │        │
│  │        └── secret: 32 random bytes, base64url
│  └─────────── id: 4 random bytes, 8 hex characters
└────────────── prefix
```

- The id identifies the key record; the secret is the secret.
- The gateway looks the record up by id and compares `sha256(secret)` against
  the stored hash with a constant-time comparison.
- `cb_` and the strict shape mean a `GATEWAY_TOKEN` can never be mistaken for
  an agent key.

## Where it lives

| Location | Contents | Protection |
| --- | --- | --- |
| `.env` on the operator's machine | the plaintext key `cloudbear setup` generated | file mode `0600`, never committed |
| gateway `data/keys.json` | `{id, label, createdAt, sha256(secret)}` | file mode `0600`, no plaintext |
| `~/.cloudbear/auth.json` | the key `cloudbear agent auth` saved | directory `0700`, file `0600` |
| the browser | `localStorage["cloudbear.key"]` | same-origin only |

The plaintext key is printed exactly once, by `cloudbear setup` or
`cloudbear keys create`. If you lose it, mint a new one — it cannot be
recovered from the gateway.

## Using it

```bash
# local or remote setup prints the key once
cloudbear setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9

# save it for later CLI use
cloudbear agent auth --host 203.0.113.9 --key cb_01234567_XXXX…

# or skip the file entirely
CLOUDBEAR_HOST=203.0.113.9 CLOUDBEAR_KEY=cb_01234567_XXXX… cloudbear agent ls

# browser: open http://203.0.113.9:8080/ and paste the key
```

## Rotation and revocation

```bash
# mint a second key (needs the service token from the env file)
GATEWAY_TOKEN=… cloudbear keys create --label laptop
GATEWAY_TOKEN=… cloudbear keys ls
GATEWAY_TOKEN=… cloudbear keys revoke 01234567
```

Rotation is two steps on purpose: create the replacement, confirm it works
with `cloudbear agent auth`, then revoke the old id. Revocation takes effect on
the next request; there is no session or token cache.

## Rules

- Treat an agent key exactly like a password. It grants full control of every
  session on that deployment.
- Never commit it, never paste it into a chat, never put it in a URL.
- `cloudbear setup ssh` prints the key in its output; that output is a secret.
  Avoid `tee`-ing it into a shared log.
- The gateway speaks plain HTTP. Do not expose port 8080 to the internet: put
  it behind TLS (a reverse proxy or tunnel) or reach it over a private network
  or SSH tunnel first.
