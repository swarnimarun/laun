# Releases

Status: implemented; first release target `v0.1.0`.

Pushing a `vX.Y.Z` tag is the only release trigger. It publishes, in one run:

| Artifact | Coordinates |
| --- | --- |
| Service image (gateway + executor + telegram-bridge in one) | `ghcr.io/swarnimarun/laun:X.Y.Z` |
| Sandbox image (OpenShell `pi-agent`) | `ghcr.io/swarnimarun/laun-pi-agent:X.Y.Z` |
| CLI binaries | GitHub Release assets: linux/darwin `amd64`+`arm64`, windows `amd64`, plus `checksums.txt` |
| Changelog | GitHub Release notes, auto-generated from commits since the previous tag |

No release artifact is produced anywhere else. `deploy/docker-compose.yml` consumes the same
image names, so a released box and a source checkout run the same bytes.

## Version source of truth

The root `package.json` version must equal the tag (`v0.1.0` → `0.1.0`); the
workflow's `verify` job fails the release on mismatch. `apps/laun/src/index.ts`
keeps a dev fallback, but the release build injects the real version with
`bun build --define process.env.LAUN_VERSION=...`, so a released binary always
reports the tag it was built from.

## Why one service image

The three services already share everything that is expensive to build: the
same Bun runtime, the same `apps/` + `packages/` source tree, the same lockfile.
They only differed in the executor's extra tooling (Node, pi, ripgrep, fd,
OpenShell) and in the default `CMD`. Building three near-identical images was
duplicated work and three package surfaces to keep in sync.

The comprehensive image bakes in the executor tooling unconditionally and each
compose service selects its entrypoint with `command:`. Costs: every service
carries the agent tooling (~2 GB uncompressed) and a gateway compromise has the
same content as an executor compromise. For a single-VPS deployment where all
three run on the same host and share a data volume, neither is a boundary that
exists today.

Two images stay separate:

* `laun-pi-agent` is a different base (`node:24-bookworm-slim`), a different
  user (`node`), and a different layout (writable `/workspace`,
  `PI_CODING_AGENT_DIR=/tmp/pi-agent`). It is what OpenShell launches *inside*
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
| `verify` | ubuntu-latest | Derives `X.Y.Z` from the tag, validates shape, checks `package.json`, computes image prefix / prerelease / floating minor |
| `images` | `ubuntu-latest` + `ubuntu-24.04-arm` | Matrix: each image × each arch. Native builds (no QEMU), pushes `X.Y.Z-amd64` / `X.Y.Z-arm64` with GHA layer cache |
| `merge` | ubuntu-latest | `docker buildx imagetools create` joins both per-arch manifests into `X.Y.Z`, the floating `X.Y` tag, and `latest` (stable releases only) |
| `smoke` | ubuntu-latest | Pulls the merged amd64 image, runs `pi --version`, boots the gateway and the executor, waits for both `/health` endpoints |
| `cli` | ubuntu-latest | `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`; smoke-checks the linux/amd64 binary with `--version`; packages tar.gz/zip and uploads |
| `release` | ubuntu-latest | Downloads binaries, writes `checksums.txt`, creates (or re-runs) the GitHub Release with `--generate-notes` |

Image tag policy:

* `X.Y.Z` — immutable, what deployments should pin
* `X.Y` — floating minor, for `0.1.x` style updates
* `latest` — stable releases only; prerelease tags (`v0.2.0-rc.1`) skip it
* `X.Y.Z-{amd64,arm64}` — per-arch intermediates pushed by `images` and
  referenced by `merge`; not for humans (they remain in the registry)

## Deploying a release

`deploy/docker-compose.yml` supports both source builds and released images.
The released path is:

```bash
cp deploy/.env.example .env          # fill GATEWAY_TOKEN etc.
echo "LAUN_TAG=0.1.0" >> .env        # pin the release
docker compose -f deploy/docker-compose.yml --env-file .env pull
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

Source builds are unchanged (`up -d --build`); compose tags the local build
with the same `LAUN_TAG` name, so both paths use identical service config.

* `LAUN_IMAGE` overrides the whole image reference (forks, mirrors), default
  `ghcr.io/swarnimarun/laun`.
* GHCR packages start **private** for personal accounts. Either make both
  packages public once (Package settings → visibility) or log the box in:
  `docker login ghcr.io -u <user> -p <PAT with read:packages>`.
* The sandbox image is only needed when `OPENSHELL_ENABLED=true`; fetch it with
  `docker compose --profile sandbox pull`.
* **Rollback:** set `LAUN_TAG` to the previous version, `pull`, `up -d`. The
  `laun-data` volume is never touched by an image change; session files survive
  patch releases.

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
* Build the image on PRs (no push) so a Dockerfile regression fails before
  tag day, not during a release.
* `git-cliff` or a committed `CHANGELOG.md` if auto-generated notes prove too
  noisy.
* Slim per-service images once the comprehensive image's size hurts a real
  deployment.
* `laun` distribution beyond GitHub Releases (Homebrew tap, apt, `install.sh`
  `--release <tag>` path).
