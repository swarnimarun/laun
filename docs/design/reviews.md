# Independent design reviews

2026-11-14. Three independent agents inspected the baseline and upstream
primary sources. Root integrated their recommendations and reviewed all four
sections. These are design/code reviews, not live VPS or penetration tests.

| Section | Author | Independent reviewers | Result and corrections |
|---|---|---|---|
| 01 Control plane | Root | Security, runtime, product/operations | Proceed incrementally. Separate run from attempt; evaluate upstream Pi Durable before building a scheduler; include sandbox volumes in backup; packaged readiness must be authenticated; yard registry alone does not permit dispatch. |
| 02 Permissions | Security | Product/operations, runtime, root | Adopt deterministic authority and adviser separation. Align isolated/manual/auto names; unconfigured actions always deny. Keep third-party executable extensions out of control process. Child grants must recheck ancestors. |
| 03 Runtime | Runtime | Product/operations, security, root | Adapter-first; experimental upstream durability must pass crash/storage probes. Keep admission idempotency separate from external-effect safety. Distinct runtime-entry and client-event cursors, no migration while two writers are active. |
| 04 Product/operations | Product/operations | Runtime, security, root | Distinguish mower/thread/run/attempt, CLI targets from enrolled hosts, recorded approvals from applied effects. Keep Telegram topic/user identities and delivery durable before delegation multiplies work. |

Review identified and fixed a concrete first-kernel defect: comparing action
bindings through Object.keys could omit inherited context fields. The module
now compares a fixed complete field set, with a regression test. Profile
attenuation is deny-first across duplicates; it is not a substitute for
transactional grant consumption, ancestor authorization or host isolation.

Remaining validation gates are explicit in each section. Multi-user resource
ACLs, a credential broker, actual runtime/tool mediation, outbound workers,
server-owned checkpoint archives and live sandbox probes are required before
the full product can claim those guarantees.

The four numbered design documents preserve that initial audit. Their old
gap lists are not a current implementation checklist; use
[core status](../core-status.md) and [the implementation ledger](implementation.md).

## V2 implementation reviews

The runtime, broker/operations and UI/connector agents independently reviewed
each other's implementation boundaries, with root integration and actual
acceptance tests. Reviews found concrete defects rather than treating source
presence as delivery evidence:

| Boundary | Independent review | Corrections verified |
| --- | --- | --- |
| Permissions and MCP | Broker, runtime, UI and root | Generation/ancestor fences, abort checks after every asynchronous stage, logical credential binding and atomic catalog persistence. |
| Harness and durable state | Runtime, broker and root | Controller-acknowledged Pi commits, no foreign-task replay, lost-ACK recovery, hard guest identities/resources and whole-sandbox command stop. Packaged qualification caught missing local-controller journal callbacks; local execution now uses the same ledger and has cache-loss/pre-inference failure tests. |
| Worker/fleet maintenance | UI, runtime, broker and root | No start after close, current credential/capacity dispatch, separately approved cleanup leases, final unlink cancellation checks and bounded ACK-only journal compaction. |
| Browser and CLI | UI, runtime and root | Primary setup without inference, managed adviser authority, explicit interruption/retention/fleet confirmations, secret-free browser persistence and portable public assets. |
| Telegram | UI, broker and root | Actual grammY admission redelivery, immutable edits/media notices, private/forum topic separation, pre-send route checks, Unicode chunk order and usable uncertain-send reconciliation. |
| Installation and recovery | Broker, UI, runtime and root | Private no-clobber paths/configuration, pinned source/capabilities, inert restore, actual image/source comparison and synthetic Docker context exclusions. |

Actual live checks use temporary owned fixtures. Source review, scripted model
tests, real provider calls, real browser tests and live kernel/container probes
remain separately identified in the current acceptance checklist. No external
VPS install or live Telegram delivery is inferred from local fake transports.

Final implementation review also caught failure-order problems in gateway
startup and deletion. Initialization now runs inside cleanup protection, and
persistent index deletion precedes event disposal. Both have disk-failure
regression tests. Over-budget boot recovery no longer accesses an uninitialized
API object, timeout denials settle evicted pending approvals, and corrupt
history fails replay. Root reviewed the deployment profile/parser and the
real upstream Pi Durable experiment; full source-suite validation passed
503 tests with one opt-in live skip. No live VPS qualification is implied.
