# Laun: durable mower harness

Design and source audit dated **2026-11-14**, based on v1 commit `cff77fd8`.
This is the current architectural plan; [the older roadmap](../roadmap.md)
contains contradictory historical deployment snapshots and is not a current
capability or security certification.

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
Rust port. Pi Durable 1.5.2 is a strong experimental candidate; qualification
comes before adopting its scheduler. OpenShell 0.1.8 is the researched current
release, while the existing vendored SDK remains 0.1.2 until a tested upgrade.

This plan is intentionally staged. A library decision engine does not enforce
Pi tools; named targets do not constitute a fleet; extension dialogs do not
constitute trusted policy approvals. The ledger records actual implemented
behavior and remaining work separately.
