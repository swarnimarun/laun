# Browser workflow checks

The browser smoke runs the actual static app against a disposable, file-backed
control server and the real pinned Pi Durable adapter. A scripted upstream
`faux` provider replaces model network calls only inside this test fixture.
The fixture creates no provider credentials and removes its directory on exit.

From the repository root after `bun install`:

```sh
CHROMIUM_PATH=/path/to/chromium bun apps/gateway/test/ui-smoke.ts
```

On NixOS/WSL, an installed `/nix/store/*chromium*/bin/chromium` is detected
automatically. Otherwise enter a Nix shell that provides Chromium and pass
its executable path. The test uses the exact-pinned Playwright development
dependency; no global Node or npm is needed.

The fixture checks login, mower creation, durable conversation/follow-up,
profile creation and assignment, action preview/allow-once with an actual
file effect, a real Gatekeeper model conversation in a tool-free durable thread,
validated proposal review without self-grant, denial without a file effect,
worker enrollment/revocation, task delegation/direct child input/handoff,
an MCP connection with real loopback catalog discovery and pinned tool identity,
checkpoint download, explicit interrupted-run reconciliation and its queue fence,
mobile navigation, and deep-link reopen. All application mutations use the
browser UI; read-only API/file observations establish the resulting state.
The Gatekeeper check verifies a human explanation, collapsed raw identifiers,
feedback and review after reload, and no automatic profile or approval change.
The interruption scenario also simulates the actual authenticated worker
protocol to establish a stopped assignment; it verifies that unconfirmed UI
submission cannot resume it and that a confirmed resume advances generation.
Screenshots default to `/tmp/laun-ui-shots` (`LAUN_UI_SHOTS` overrides it).
Keys and worker credentials are never printed or included in screenshots.

To exercise an already-running explicit local demo installation instead:

```sh
LAUN_UI_URL=http://127.0.0.1:18880 \
CHROMIUM_PATH=/path/to/chromium \
bun apps/gateway/test/ui-smoke.ts
```

`LAUN_UI_KEY` supplies a key through the environment; otherwise the live mode
reads `.laun-local/access.json` relative to the repository root. The live mode
creates named test records and preserves them for inspection. It skips the
scripted approval/delegation fixture scenarios because it must not fabricate
responses for ordinary configured models. `LAUN_UI_MODEL` selects the mower
model (default `faux/faux-1`, which requires an explicit local demo provider).
Set `LAUN_UI_EXPECT_ANSWER=false` only when testing durable queue admission
without a connected worker; it does not prove execution.

This suite does not qualify real OpenShell kernel containment, external MCP
services, Telegram delivery, or production provider authentication. Those
need their own integration checks.
