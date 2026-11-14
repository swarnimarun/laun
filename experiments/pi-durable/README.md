# Pi Durable compatibility spike

This isolated experiment evaluates `@earendil-works/pi-durable` **1.5.2** with
**Bun 1.4.4**. It is outside the root workspace globs and production test script.
The gateway and executor do not import it. Pi Durable marks its APIs experimental;
passing this probe does not make it laun's supported execution backend.

From this directory:

```sh
BUN_INSTALL_CACHE_DIR=/tmp/laun-pi-durable-cache bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
```

The Pi family and TypeScript/Bun tooling dependencies are exact pins. The local lockfile
records transitive versions. No install scripts are needed for these probes;
provider credentials and real model calls are never used. `fauxProvider` is the
upstream scripted model, explicitly selected regardless of environment keys.

Verified on 2026-11-14: **4 tests / 16 assertions pass**. Both upstream disk
backends (`openNodeJsonlStorage` with `fsync: true` and
`openNodeSqliteStorage`) work for the exercised operations under this Bun version:

- Open a harness, submit an input, persist its faux-model answer, close and reopen.
- Reuse the same request ID after reopen and retrieve the original completed
  submission and answer without another generation.
- Persist a sleeping custom task, close and reopen, advance a fake clock and
  resume its stored next-phase checkpoint exactly once in this scenario.

The Node SQLite adapter uses `node:sqlite`, which this Bun version supports for
these operations. That observation replaces an assumption; it does not establish
full adapter conformance on other Bun versions or platforms. SQLite retains the
upstream WAL / `synchronous=NORMAL` defaults, so newest commits may be lost on
host power failure. JSONL holds history in memory and is not a recommendation
for unbounded production transcripts.

This probe uses orderly harness close, not SIGKILL or power loss. It does not
verify mid-tool crash recovery, unsafe external effects, all storage conformance,
OpenShell execution environments, permission interception, plugin containment,
child ownership, multi-process writer exclusion, fleet failover, upgrades, or
old laun session migration. Those remain gates in
[the runtime design](../../docs/design/03-runtime.md). Production dependency
changes require that evaluation and an explicit migration strategy.

Primary sources: [release v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2),
[Durable API](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md),
[checkpoint example](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/test/examples/12-recovery.ts),
[faux model example](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/test/examples/21-subagent-foreground.ts).
