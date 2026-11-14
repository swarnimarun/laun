# Implementation and validation ledger

Updated 2026-11-14. This ledger describes the first reviewed delivery tranche,
not completion of the fleet/MCP product. The eight-slice plan remains in
[01-control-plane.md](01-control-plane.md).

## Implemented in the existing Bun services

| Change | Behavior now | Qualification |
|---|---|---|
| Shared request validation | Reject malformed goals, models, repos and runtime identifiers; do not propagate caller-injected authority fields | Protocol owns the contract; does not yet authorize arbitrary repository acquisition |
| Shared stream validation | Reject cross-session/malformed events, invalid UTF-8, oversized records and EOF without terminal outcome; release stream readers | Recovery errors followed by running are not final outcomes; worker/run generation fencing is still needed |
| Session index integrity | Fail on corrupt/unreadable/duplicate records; exclusive private temp snapshot, file sync, atomic rename, memory swap after persistence; defensive copies | Single writer, no directory fsync/power-loss guarantee; legacy missing runtime explicitly becomes Pi |
| Run/delete failure ordering | Index failures release process-local run slots; failed index deletion preserves event log and session | No transactional inbox, reconciliation scheduler or external-effect deduplication yet |
| Lifetime session state | Token totals and pending approvals replay across full history; display eviction cannot lower spend; timeout denials clear pending state | History scan still reads whole file; durable accounting needs transactional metadata before scale |
| Absolute log cursor | Cursors advance beyond display-ring eviction and survive intact-history reopen; response includes oldest available cursor | Old clients get existing events/next plus additive oldest; subscriptions still need explicit gap UI and versioned event envelopes |
| Corrupt history | Invalid/cross-session or unterminated history refuses replay, preserving the source for recovery | Restore a verified backup; no automatic repair or silent tail truncation. Corruption may affect one lazy-loaded thread rather than prevent all service startup |
| Key revocation | Persistent revoked-ID tombstones prevent bootstrap reimport from restoring access; malformed store refuses reset; failed writes preserve live auth state | Rotate to a fresh key ID; old binaries ignore tombstones, so rollback needs credential migration/rotation; single-writer/rename durability only |
| Child credential containment | Host Pi children lose reserved controller env variables and preload hooks; Git loses model/control secrets and inherited Git helpers/config | Trusted local mode still has same-user filesystem access; provider/Pi environment preserved. Sandbox CLI supervisor retains its required auth; this is not full sandbox enforcement |
| Deployment profiles | Loopback app ports, gateway limit/recovery env propagation, local base without broken SDK config, isolated OpenShell overlay with explicit verified-TLS identity paths and preflight | Config/source smoke only; Docker unavailable here. Gateway, kernel enforcement, provider readiness and real container boot require disposable VPS qualification |
| Permission foundation | Protocol-owned immutable profile/action/grant types; exact-resource deny-first evaluator, isolated/manual/auto semantics, context/digest/version/expiry binding and profile attenuation | Library only. No production tool interception, grant ledger, ACLs, shared-profile registry, adviser runtime or enforcement UI claim |

The kernel receives trusted server-built identities and trusted grant records.
A caller must canonicalize resources/arguments, check ancestor authority and
current revocations, and atomically consume a grant with dispatch. Calling the
pure function twice does not consume a grant. A grant cannot override an
explicit deny, missing rule, isolated-mode ask or revoked profile. Exact string
matching deliberately does not pretend to secure arbitrary shell commands.

## Upstream compatibility experiment

[The isolated Pi Durable spike](../../experiments/pi-durable/README.md) pins
Pi Durable/AI/Chord **1.5.2** outside production workspaces. Four tests exercise
upstream Harness.open, faux-model submission, request-ID deduplication after
close/reopen and a persisted sleeping task checkpoint using JSONL and SQLite
under Bun **1.4.4**. It does not change the executor runtime or production Pi
version. No real model credentials or API calls are needed.

Orderly reopen is demonstrated. SIGKILL, power loss, mid-tool interruption,
permission interception, plugin containment, OpenShell environment integration,
child ownership and production migration remain unverified. SQLite retains
upstream NORMAL synchronization defaults. A Pi fork remains unjustified until
an actual adapter limitation is demonstrated.

## Required next work

1. Transactional control metadata with principal/resource ACLs, immutable
   profile bindings and durable submissions/approval/outbox records.
2. Real mediated tool and MCP broker, scoped credential delivery, ancestor
   authorization and replay-safe action grants, then permission adviser UX.
3. Named mower/thread/yard registry integrated with an authenticated worker
   lease, attempt generation, capacity and startup reconciliation path.
4. Pin and qualify real Pi/OpenShell versions, archive server-owned sandbox
   checkpoints, prove restart/restore and enforce every execution path.
5. Bounded director delegation/handoff, direct child interaction, durable
   Telegram topic/user routing and connector delivery; fleet UI follows those
   actual capabilities.
6. Packaged installer assets, clean-host provisioning, backup/restore/upgrade,
   authenticated doctor readiness and live positive/negative sandbox probes.

The old v1 shared-key API remains single-operator. This tranche does not make
multi-user public exposure, OpenShell network auto-approval, arbitrary plugins,
or automatic multi-host failover supported. Existing startup continuation and
one-slot in-memory follow-up queue still need replacement with the reviewed
reconciliation/inbox design. Session event appends and index changes are not a
single transaction; append failures can still leave UI observations ahead of
disk. Do not equate the cursor fix with transactional durable admission.

## Validation

Root TypeScript build and focused regression checks pass. The initial full
suite needed process/loopback permissions unavailable in the restricted
sandbox. Its only functional failures were five recovery fixture log variables
intentionally removed by controller-env filtering; those fixture names were
corrected, and all five targeted tests passed without weakening the filter.

Final validation: `bun run build` passed. `bun run test` passed **503 tests**,
with **1 intentional live Goose skip**, **0 failures**, and 1,835 assertions
across 34 source test files (70.59 seconds). The isolated experiment passed
**4 tests / 16 assertions**, and `bun run typecheck` passes with its own
exact-pinned TypeScript and Bun typings. Shell syntax and config/profile
smoke checks passed; the latter do not execute Docker Compose.
No Docker daemon, real Pi model execution or live OpenShell/VPS enforcement was
exercised. The opt-in live Goose test remains intentionally skipped.
