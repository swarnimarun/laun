# Documentation

Start with the current v2 guides. [Core status](core-status.md) records what is
implemented, how it was tested and which deployment checks remain specific to
your environment.

## Choose a reading route

| I want to… | Read |
| --- | --- |
| Try Laun locally | [Quickstart](../README.md), then [local development](local-development.md) for NixOS/WSL, credentials and state paths |
| Understand mowers, threads, yards and permissions | [How it works](how-it-works.md), then [permission boundaries](permissions-boundaries.md) |
| See the interface and reproduce the demonstration | [Screenshot tour and demos](demos.md) |
| Control the same work from a terminal | [Durable control CLI](cli.md) |
| Install a controller or connect a remote yard | [Remote setup](../deploy/remote-setup.md), then [TLS](../deploy/tls.md) if exposing HTTPS |

The explicit demo uses scripted model responses with the real application and
durable runtime. Use the demo guide's fixture to reproduce its screenshots;
ordinary `dev:app --demo` is a simpler demonstration. Configured model work,
live Telegram delivery and a selected VPS each have their own setup and checks.

## Operate and recover

| Operation | Runbook |
| --- | --- |
| Preserve and restore controller data | [Backup and recovery](operations-backup.md) |
| Change versions or roll back safely | [Upgrades and compatibility](operations-upgrade.md) |
| Rebase a thread's profile or move its yard | [Thread lifecycle](operations-lifecycle.md) |
| Preserve old Pi history without activating it | [Passive legacy import](operations-legacy-import.md) |
| Remove a controller copy and review separate host cleanup | [Retention](operations-retention.md) |
| Understand portable artifacts and publication gates | [Releases](releases.md) |

For Telegram account linking, allowlists and topic routing, follow
[remote setup](../deploy/remote-setup.md) and the
[bridge guide](../apps/telegram-bridge/V2.md).

## Check the evidence

- [Core status](core-status.md): current acceptance results and explicit limits.
- [Packaged qualification](packaged-qualification.md): dated local image,
  mutual-TLS OpenShell, resource, recovery and cleanup results.
- [Runtime record](../packages/runtime/README.md): Pi adapter and live runtime
  qualification details.
- [Browser tests](../apps/gateway/test/README.md): repeatable UI checks and
  explicitly scripted providers.
- [Artifact boundaries](artifact-boundaries.md): build-context exclusions and
  the scope of the synthetic sentinel/image audit.

## Design and history

The [implementation ledger](design/implementation.md) connects the current code
to the [reviewed architecture](design/README.md) and
[independent reviews](design/reviews.md). The numbered design documents preserve
the original baseline findings and accepted plan; use the current guides and
status for operating instructions.

[The old roadmap](roadmap.md) and [legacy development notes](../DEVELOPMENT.md)
describe the v1 starting point. Legacy session commands use a separately enabled
compatibility API; they do not share all v2 ownership and permission guarantees.
