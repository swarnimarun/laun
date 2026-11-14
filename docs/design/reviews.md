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
