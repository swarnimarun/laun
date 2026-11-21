# Laun: durable mower harness

Frontend: [rework plan](frontend-rework.md) and [layout audit with screenshot evidence and repair record](frontend-layout-audit.md).

Design and source audit dated **2026-11-14**, based on v1 commit `cff77fd8`.
This is the independently reviewed original architecture and delivery plan.
Read [how Laun works](../how-it-works.md) for the implemented system and the
[implementation ledger](implementation.md) for resolved findings. The
[older roadmap](../roadmap.md) contains contradictory historical deployment
snapshots and is not a current capability or security certification.

Read in order:

1. [Control plane, terminology and eight delivery slices](01-control-plane.md)
2. [Permissions, Automode, OpenShell, auth and MCP](02-permissions.md)
3. [Pi APIs, durable threads, orchestration and worker recovery](03-runtime.md)
4. [Clients, Telegram, multi-host product and VPS operations](04-product-operations.md)
5. [Independent reviews and corrections](reviews.md)
6. [Implementation and validation ledger](implementation.md)

The recommended vocabulary is **mowers** for agent identities,
**groundskeeper** for the director, **yards** for execution hosts and
**gatekeeper** for the permission adviser. Display names never confer authority.

The reviewed direction preserves the functioning Bun/TypeScript base and
adds server-owned control metadata. It does not start with a Pi rewrite or
Rust port. The implementation uses exact-pinned Pi Durable 1.5.2 after real
harness, crash and central storage-acknowledgment tests. OpenShell 0.1.8 is the
qualified CLI/gateway release for the supported v2 path. The older vendored
SDK remains limited to the legacy compatibility surface. Both primary upstream
release pages were rechecked on 2026-11-14; actual host qualification remains
specific to the engine, kernel, certificates and artifact set.

This plan is intentionally staged. A library decision engine does not enforce
Pi tools; named targets do not constitute a fleet; extension dialogs do not
constitute trusted policy approvals. The ledger records actual implemented
behavior and remaining work separately.
