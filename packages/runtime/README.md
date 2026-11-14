# Laun Pi Durable adapter

This package implements the runtime-neutral `AgentRuntime` contract from
`@laun/protocol`, using the exact-pinned upstream Pi Durable 1.5.2 API. The
control service supplies one server-owned `sessionDir` and `workspaceRoot` per
thread; a run's stable `runId` becomes the upstream submission request ID.
Gateway/connector code does not import Pi types.

`listModels()` returns cached runtime-neutral metadata with full
`provider/model-id` IDs and provider configuration status, never credential
values. The current built-in catalog works with a separately configured
Vercel AI Gateway credential; custom provider catalogs remain an injectable
adapter seam. A real local smoke on 2026-11-14 using
`vercel-ai-gateway/openai/gpt-4.1-nano` returned `LAUN_REAL_RUNTIME_OK`
through the complete Durable adapter (619 reported tokens). Its tools were
all denied and its run was bounded to two turns/60 seconds.

Only Laun's reviewed tool registry is installed. Repository extensions,
project MCP configuration, package hooks and arbitrary executable plugins are
not loaded into the controller. Native model access runs in the trusted
controller, using provider environment variables or a separately configured
credential file. Credential refresh is serialized and atomically persisted;
that file must remain outside thread state/workspaces. Do not open the same
credential file concurrently with another credential-writing application.

The mediated file and command tools call the server's authorization callback
before effects. Workspace-relative file operations reject traversal and
escaping symlinks, bound file/output sizes and carry cancellation signals.
Broker tools delegate authorization and stable idempotency to the central
service; their request IDs include the run and upstream call ID. Writes,
commands and mutating broker calls use upstream's unsafe replay policy. A
crash produces an interrupted tool result rather than automatically repeating
an uncertain external action. Read-only tools may be replayed.

Execution modes are explicit:

- `trustedLocal: true` enables local developer tools. File tools are scoped;
  an approved shell command retains the host user's OS authority. Its minimal
  environment excludes model/control credentials. This is not OS isolation.
- `openshellEnabled: true` requires an OpenShell execution backend and image.
  Each thread gets a persistent sandbox, manual policy escalation, an empty
  command environment and a hard-enforced workspace filesystem boundary.
  Default generated policy denies all network egress. Before model dispatch,
  a positive workspace-write probe and negative world-writable `/var/tmp`
  probe must pass, and root execution is rejected. Any failure remains an
  error; host execution is never a fallback. Closing stops and preserves the
  sandbox. Explicit artifact export/retention owns deletion.
- Neither mode selected refuses execution. `faux/faux-1` exists only with an
  explicit demo option or injected test models; real model failures never
  become demonstration answers.

Pi state uses the upstream fsync JSONL backend. A guarded single writer opens
it for each run, with a private per-thread request fingerprint index preventing
changed payload reuse. Control SQLite state, thread ACLs, run ownership and
permission grants are handled by the control service rather than the Pi
transcript. `close()` cancels active work; process/command cancellation and
permission waits share an abort signal.

Run `bun test packages/runtime/src` and `bun x tsc -b packages/runtime` from the
repository root. Tests exercise the real upstream harness with its explicit
scripted provider, including a SIGKILL while an unsafe write waits for
permission, reopen deduplication, denial without effects, cancellation, broker
request IDs, file boundaries, minimal command environments and the OpenShell
transport's fail-closed behavior. Fake OpenShell transport tests do not claim
that a local kernel or live OpenShell gateway has been qualified; the real
boundary probe must pass on the actual execution host.
