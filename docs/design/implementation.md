# Implementation and validation ledger

Updated 2026-11-14. The reviewed [eight-slice plan](01-control-plane.md) is implemented on the harness-v2 JJ stack. [Core status](../core-status.md) records the completed local acceptance checks and the remaining environment limits. Start with [how Laun works](../how-it-works.md) for the current architecture and [demos](../demos.md) for a walkthrough.

## Architecture that is now implemented

The Bun gateway serves the browser at /app and owner-scoped control API at /api/v2. The control service owns identities, immutable permissions, admission, task routing, leases, approvals, event cursors, checkpoints, inference-call receipts and the replicated Pi ledger. A runtime-neutral AgentRuntime contract in packages/protocol keeps Pi types inside packages/runtime. The exact-pinned Pi Durable 1.5.2 adapter supplies the real harness rather than a local rewrite of its scheduler.

A yard may run beside the controller or connect outbound from another host. Central inference is the default for remote yards: model/provider credentials stay on the controller, and a worker cannot choose arbitrary inference endpoints or headers. Local runtime inference follows the same admission/accounting fence. No provider failure falls back to the explicitly labeled demo.

The controller must acknowledge Pi storage commits before the harness releases them. A seed snapshot followed by ordered fingerprinted commit batches reconstructs the fixed server head before a lost/replaced yard schedules work. This protects current conversation state in addition to end-of-run checkpoint archives. Workspace files still need a captured checkpoint; arbitrary external effects still require explicit reconciliation.

The browser, CLI and Telegram clients use the same durable identities and authorization. Telegram links a bot/user to a stable owner, then keeps each user/chat/topic route independent. Legacy globally authenticated sessions are a separately enabled compatibility surface; the v2 gateway does not start their resume/sweeper behavior by default.

## Completed delivery slices

| Slice | Concrete result | Main evidence |
| --- | --- | --- |
| Trust baseline | Strict input/event validation, corrupt-store refusal, private durable writes, stable owner keys, legacy default-off, no automatic credential injection into tool state. | Gateway/key/config/legacy regressions and authenticated actual-process restart. |
| Permission kernel | Missing-rule deny, immutable exact rules, ancestor attenuation, revocation, generation/argument-bound one-shot approval and explicit feedback/replan/stop. | Policy, broker, control, runtime, worker and browser effects/denial checks. |
| Registry and setup | Named mowers/threads, persistent purpose/model snapshots, primary Groundskeeper wizard and CLI, stable owner identity, strict legacy history import. | Transaction/reopen/old-schema/onboarding/import/CLI/browser tests. |
| Harness and tools | Real Pi Durable, trusted tool registry, no repository executable plugins, bounded turns/time, local/OpenShell execution, durable cancellation and no unsafe replay. | Real harness, parked tool, SIGKILL, lost-ACK, foreign-submission and server-ledger tests. |
| Workers and recovery | Authenticated outbound scheduling, capacity/lease/generation fences, central inference, checkpoints, explicit moves, drain and stable-ID credential rotation. | Actual HTTP worker, full gateway replacement, active SIGTERM/restart, browser and CLI fleet tests. |
| MCP and Automode | Reviewed HTTP connections, catalog/schema/credential binding, CAS catalog writes, DNS pinning, current-authority checks at every await; real durable advice-only Gatekeeper. | MCP race/transport tests and browser conversation, validated proposal, feedback and no-self-grant checks. |
| Delegation and Telegram | Constrained children, full goals, direct child input, atomic handoff, once-only result admission; linked topics, encrypted inbox and durable ordered outbox. | Controller/Pi/browser tests and actual grammY fake-HTTP polling/admission failure checks. |
| Install and operations | Compiled CLI with embedded verified templates/manifests, guarded SSH source setup, pinned images/toolchain, offline inert restore, retention and separately approved host cleanup. | Empty-directory binary/source/fake-SSH tests, backup/replacement tests and final packaged controller/OpenShell mTLS, recovery and cleanup qualification. |

## Critical findings resolved during independent implementation reviews

- A delayed worker request body could revive an old credential snapshot after revocation. Authentication is repeated after reading the body, and dispatch reloads the current worker in the transaction.
- Delayed mower/connection mutations could overwrite newer archive, disable or credential bindings. Current records are reloaded after the await, and catalog persistence is compare-and-set.
- Mid-run Pi state originally lived only on the yard until its final checkpoint. The central acknowledged ledger now gates provider/tool progress and rebuilds lost local storage.
- A new input could unpark an old unfinished Pi task. Foreign submissions/tasks are canceled and centrally acknowledged while scheduling remains paused.
- Killing only the OpenShell CLI could leave background processes alive. Command stop now targets the entire sandbox and an unverified stop interrupts later work.
- Runtime labels could exceed the actual CLI limit. Full 256-bit policy/resource identities use bounded base36 labels and are checked with retained guest/placement identity.
- Worker cleanup needed an authenticated lease before effects, final cancellation checks before unlink and no admission after close. Regressions cover those boundaries.
- Controller-only retention could not imply host filesystem authority. Host deletion has a separate digest-bound owner approval, its own lease/generation and verified/blocked result.
- Telegram Bot.stop can acknowledge the last attempted update even when inbox persistence failed. Admission failure now exits polling without that acknowledgment; the actual grammY regression observes redelivery after restart.
- Telegram output needed fresh route authority after throttling and ordering through 429/uncertain sends. Pre-send verification and content ordering now enforce those boundaries; command replies remain usable for reconciliation.
- Development state was not excluded from Docker builder input. A curated context and actual synthetic sentinel proof close that gap. Checked earlier image layers contained none of the inspected private state; generated local app keys were rotated.
- Busy yards accumulated terminal journals toward the recovery bound. Reviewed compaction only removes positively acknowledged terminal records; unknown outcomes remain preserved. Regression and final packaged qualification cover this maintenance path.
- Revocation during asynchronous human-key admission could otherwise retain a stale owner snapshot. Admission rechecks current authority before committing a decision or new work.
- MCP dispatch can succeed remotely before its response is lost or rejected. The controller records an unknown outcome and interrupts execution instead of letting the model retry; durable-write failures also fence further progress.

## Supported boundaries

OpenShell supplies OS confinement only when explicitly enabled and its real probes pass. The supported guest policy has a hard Landlock filesystem ceiling and no direct network egress; authorized external tools go through the controller MCP broker. Actual cgroup probes enforce configured CPU and memory limits. Trusted local shell commands retain the host user's authority.

Profiles support exact operation/resource selectors, not arbitrary shell-argument semantics. A director is not an administrator. Gatekeeper can explain intent and propose a revision but cannot grant authority. A shared profile edit does not silently change already-pinned threads; rebase is reviewed and leaves work stopped.

Supported plugins are versioned discovered HTTP MCP tools. Arbitrary executable extensions, project MCP configuration, unreviewed OAuth callback servers, extra runtime engines and a Rust port are not silently enabled.

Checkpoints and control backups have explicit scopes and limits. Dependencies/generated workspace files may be omitted with manifest records. Control backup does not include external credential files, a bridge queue with its key, every live guest volume or already-sent messages. Legacy import preserves history as passive data without resuming old tools or importing authority.

## Evidence and environment limits

See [core status](../core-status.md) for current counts and final integration gates. Browser proofs use a real disposable controller and Pi Durable with explicitly scripted providers. Separate real-provider proofs and live OpenShell evidence are in the [runtime README](../../packages/runtime/README.md).

Live local OpenShell 0.1.8/rootless Podman on NixOS/WSL observed non-root execution, permitted workspace writes, denied outside writes, 2 CPUs/1 GiB, real Pi tools/reopen, cancellation and fresh guest checkpoint recovery. The final packaged controller-to-host mTLS topology also passed real tool execution, server-ledger recovery after cache loss, restart and separately approved host cleanup. The [packaged qualification record](../packaged-qualification.md) identifies the tested artifacts and scope.

A disposable external VPS and real Telegram bot configuration have not been supplied. No external VPS was modified and no real Telegram messages were sent. Fake transport success is not described as a live connector/deployment proof. The [local development guide](../local-development.md) explains how to start a disposable demo.
