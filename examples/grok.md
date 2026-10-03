# Grok with cloudbear (via pi)

Cloudbear doesn't talk to models directly — `pi` does (`pi-ai`). Pick one auth path, then verify:

```bash
pi --list-models grok
```

## Option A — xAI API key (direct)

```bash
export XAI_API_KEY=...   # or add to .env on the VPS
```

Point `MODEL` at an xAI model id from the list output, e.g. `MODEL=x-ai/grok-4.6`.

## Option B — OpenRouter (one key, many models)

```bash
export OPENROUTER_API_KEY=...
```

Use `MODEL=openrouter/x-ai/grok-4.6` (or another `x-ai/*` row from the list).

## Option C — Subscription via pi login

On the VPS (or wherever the executor runs):

```bash
pi
# then /login — connect your existing Claude/ChatGPT/Gemini subscription via ACP
```

No key in `.env` needed; the executor inherits the executor host's pi auth.
Least moving parts for a personal single-VPS setup, but auth lives on that host.

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

If that returns agent text, the whole chain (gateway → executor → pi → model) works.
Then put real tokens in `.env` and bring up compose.
