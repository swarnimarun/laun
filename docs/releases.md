# Releases

The tagged artifact pipeline exists. V2 release qualification is tracked in
[core status](core-status.md); a published image or liveness check alone does
not establish production readiness.

For the current prerelease, see [v0.2.0-rc.1](https://github.com/swarnimarun/laun/releases/tag/v0.2.0-rc.1)
and the [CLI install instructions](../README.md#install-the-cli). Both GHCR
images use the version tag `0.2.0-rc.1`.

Pushing a `vX.Y.Z` tag, or explicitly rerunning an existing tag through
`workflow_dispatch`, starts the release pipeline. It publishes, in one run:

| Artifact | Coordinates |
| --- | --- |
| Service image (gateway + executor + telegram-bridge in one) | `ghcr.io/swarnimarun/laun:X.Y.Z` |
| Sandbox image (OpenShell `pi-agent`) | `ghcr.io/swarnimarun/laun-pi-agent:X.Y.Z` |
| CLI binaries | GitHub Release assets: linux/darwin `amd64`+`arm64`, windows `amd64`, plus `checksums.txt` |
| Changelog | GitHub Release notes, auto-generated from commits since the previous tag |

Publication occurs through this workflow; local qualification artifacts remain
unpublished. `deploy/docker-compose.yml` consumes the same image names. Record
the actual image digest to preserve exact bytes across deployments.

## Version source of truth

The root `package.json` version must equal the tag (`v0.1.0` → `0.1.0`); the
workflow's `verify` job fails the release on mismatch. `apps/laun/src/index.ts`
keeps a dev fallback, but the release build injects the real version with
`bun build --define process.env.LAUN_VERSION=...`, so a released binary always
reports the tag it was built from.

## Why one service image

The gateway, Telegram bridge and optional legacy executor use the same pinned
Bun runtime, application packages and lockfile. A comprehensive service image
keeps that build shared; Compose selects each service's entrypoint. The v2
gateway embeds its runtime and the legacy executor is disabled by default.

Image contents and runtime authority are separate. The controller owns its data
and model credentials; the bridge has a separate encrypted queue volume. Neither
mount enters the isolated tool guest. The controller is trusted code, so its
compromise is outside the protection provided by agent tool permissions.
See [how it works](how-it-works.md) for the actual trust boundaries.

Two images stay separate:

* `laun-pi-agent` uses the pinned Bun 1.4.4 base, an unprivileged
  `bun` user, and a writable `/workspace`.
  It is what OpenShell launches *inside*
  sandboxes; merging it into the service image would give sandboxes the whole
  control plane.
* Per-service slim images can come back later by adding a build arg and one
  more matrix entry; the workflow is already shaped for it.

## Pipeline

```
push tag vX.Y.Z
      │
      ▼
   verify ──┬─► images (laun, laun-pi-agent) ──► merge (multi-arch index) ──► smoke
            └─► cli (5 cross-compiled targets) ─────────────────────────────┤
                                                                           ▼
                                                                       release
```

Jobs in `.github/workflows/release.yml`:

| Job | Runs on | What it does |
| --- | --- | --- |
| `verify` | ubuntu-24.04 | Validates the tag/version, pins Bun1.4.4, installs frozen dependencies without lifecycle scripts, runs build/full source/browser checks, proves synthetic Docker context exclusions, then builds and qualifies the unpublished service candidate |
| `images` | `ubuntu-24.04` + `ubuntu-24.04-arm` | Matrix: each image × each arch. Native builds (no QEMU), pushes `X.Y.Z-amd64` / `X.Y.Z-arm64` with GHA layer cache |
| `merge` | ubuntu-24.04 | `docker buildx imagetools create` joins both per-arch manifests into `X.Y.Z`, the floating `X.Y` tag, and `latest` (stable releases only) |
| `smoke` | ubuntu-24.04 | Pulls the merged amd64 image and repeats the authenticated packaged v2 durability/restart qualifier; no legacy executor or production provider credentials are required |
| `cli` | ubuntu-24.04 | `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`; smoke-checks the linux/amd64 binary with `--version`; packages tar.gz/zip and uploads |
| `release` | ubuntu-24.04 | Downloads binaries, writes `checksums.txt`, creates (or re-runs) the GitHub Release with `--generate-notes` |

Source and browser checks finish before image publication. Both source and
release CI run the Chromium workflows and layout regressions with the
workspace-pinned Playwright installer. Branch and pull request CI also builds
the controller and runs the packaged durability and restart qualifier without
publishing artifacts. The synthetic context proof uses actual Docker matching
with synthetic private sentinels, including credential and state filenames,
while retaining code such as `auth.ts` and required vendor files.

`scripts/qualify-packaged-control.ts` uses unique labelled disposable containers
and a private data volume. It binds the gateway inside the container explicitly
and publishes only a loopback port. With the explicit faux provider and trusted
local fixture mode, it verifies bad-key rejection, independent owner isolation,
actual Pi Durable execution, central inference receipts and Pi ledger commits,
same-volume process restart, stable input deduplication, and both old/new
conversation markers in the restored archive. Synthetic controller credentials
must not appear in events or thread archives. Cleanup removes only resources
with the qualifier's exact label. This proof makes no production model,
OpenShell confinement, external VPS or live Telegram claim. Those deployment
boundaries require their separate qualification.

Run the same unpublished packaged proof locally with an explicit image:

```sh
LAUN_SMOKE_IMAGE=localhost/laun-controller:qualified bun scripts/qualify-packaged-control.ts
```

`LAUN_SMOKE_ENGINE_ARGV` accepts a JSON engine argv for an already-provisioned
Podman test engine. `LAUN_SMOKE_HOST_NETWORK=true` is available only for local
engines that cannot publish a port; that fixture binds its unique port to
127.0.0.1. The GitHub Docker job uses container networking and a loopback port
mapping instead.

Image tag policy:

* `X.Y.Z` — versioned selection; record and pin the resolved image digest for exact bytes
* `X.Y` — floating minor, for `0.1.x` style updates
* `latest` — stable releases only; prerelease tags (`v0.2.0-rc.1`) skip it
* `X.Y.Z-{amd64,arm64}` — per-arch intermediates pushed by `images` and
  referenced by `merge`; not for humans (they remain in the registry)

## Deploying a release

Use the [controller/yard install guide](../deploy/remote-setup.md), with a
private environment file containing real host paths, reviewed image references
and protected credentials. Select a concrete `LAUN_TAG` or a complete
`LAUN_SERVICE_IMAGE` reference, preferably `repository@sha256:digest`. The sandbox
uses its own complete `OPENSHELL_SANDBOX_IMAGE` reference on the compute engine.

The installers select the required isolation overlay and validate configuration.
For pulled service images, they run the disposable no-network, read-only v2
contract before starting the application with production data. A bare Compose
pull/up command omits those installer checks. Source setup instead transfers or
checks an explicit source manifest/revision, installs frozen dependencies,
typechecks and qualifies the actual v2 API before startup.

`LAUN_IMAGE` selects a repository with `LAUN_TAG`; `LAUN_SERVICE_IMAGE` selects a
complete service image reference. Version tags can be overwritten by an
explicit workflow rerun, so a version string alone is not a byte-level rollback
record. The sandbox is created by OpenShell, not a Compose sandbox profile.

Private GHCR packages require an operator login. Supply the registry token
through Docker's `--password-stdin` flow or an existing credential helper.
Credentials belong outside agent workspaces and repository source.

For upgrades and rollback, follow [the cold upgrade runbook](operations-upgrade.md).
Preserve an offline backup and the exact prior artifact references. Older
gateways may ignore revoked-key tombstones or lose owner mappings; do not point
an arbitrary old binary at live v2 state. Runtime history also needs its
matching checkpoint/runtime compatibility set.

## Cutting 0.1.0

1. Confirm CI is green on the release commit and `package.json` says `0.1.0`.
2. Tag and push (human action — agents never push):

   ```bash
   git tag -a v0.1.0 -m "laun 0.1.0"
   git push origin v0.1.0
   ```

3. Watch the `release` workflow under Actions. It fails before creating the
   Release if any image, smoke test, or binary fails.
4. First release only: open the two GHCR packages and set visibility to public
   (unless the box logs in to pull).
5. Deploy with `LAUN_TAG=0.1.0` per the section above.

Re-running a release (after a flake or a fixed workflow) is
`workflow_dispatch` with the existing tag as input: per-arch tags are
overwritten, the release assets are re-uploaded with `--clobber`, and the notes
are regenerated.

## Follow-ups

* Provenance/SBOM attestations (`provenance: true`, `sbom: true`) and image
  signing; deliberately off for the first release so `imagetools` merging stays
  simple.
* `git-cliff` or a committed `CHANGELOG.md` if auto-generated notes prove too
  noisy.
* Slim per-service images once the comprehensive image's size hurts a real
  deployment.
* `laun` distribution beyond GitHub Releases (Homebrew tap, apt, `install.sh`
  `--release <tag>` path).
