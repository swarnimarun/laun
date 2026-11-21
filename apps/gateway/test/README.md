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
The primary setup wizard chooses explicit model/yard/guardrails and is checked
to create no model run. Managed Gatekeeper editing omits authority fields. A
second interruption scenario runs actual Pi Durable, injects a failed execution
shutdown attestation, then verifies explicit abandonment cancels the prior queue
and permits a different fresh input. Disposable retention checks archive that
thread, review exact controller-copy scope, require both confirmations, continue
bounded removal, and confirm known host copies remain separately pending.
Fleet maintenance drains a disposable yard without losing queued placement,
rotates its key with explicit stopped-execution confirmation, checks the old
credential is rejected and active attempts require reconciliation, then requires
the replacement worker's authenticated metadata before dispatch resumes. The
replacement key is checked to remain absent from browser storage and test logs.
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

## Documentation demonstrations

`bun run test:design` checks layout geometry and reachable controls in Chromium
using the disposable demo fixture. It covers login, setup, populated
conversations, the inspector and pending permission review at short phone,
landscape, tablet and desktop sizes. It also checks both sides of the workspace
breakpoints. Use screenshots for visual review.

For a readable scripted story instead of regression-test markers:

```sh
bun apps/gateway/test/demo-fixture.ts
CHROMIUM_PATH=/path/to/chromium bun apps/gateway/test/capture-demos.ts
```

The first command serves a disposable interactive workspace and prints its
private access-file path. The second starts its own fixture, uses the actual
browser UI, and writes eight screenshots to `docs/images/` (override with
`LAUN_DEMO_SHOTS`). Both use the real controller and Pi Durable adapter with
scripted model replies, and remove temporary state when they finish. They do
not connect to an existing installation or any provider, Telegram bot, or VPS.
See the [walkthrough and exact prompts](../../../docs/demos.md).
