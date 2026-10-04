# Vendored dependencies

## openshell-sdk@0.1.2 (`@nvidia/openshell-sdk`)

- **What:** TypeScript SDK for the OpenShell gateway (sandbox create/exec,
  `execInteractive` streaming transport). Used only by `apps/executor` when
  OpenShell sandboxing is enabled.
- **Source:** GitHub Packages (`npm.pkg.github.com`, `@nvidia` scope),
  published from [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell).
  **License: Apache-2.0** (declared in its `package.json`; no LICENSE file
  ships in the package — see the upstream repo for the full text).
- **Why vendored instead of installed:** build environments (local lanes,
  Docker image builds, the VPS) have no GitHub Packages credential, and the
  registry answers 401 without one — which broke every image build. A
  `file:` dependency keeps builds deterministic and offline-capable.
- **How to update:** replace this directory with the new version's contents
  (keep the directory name version-less), run `bun install`, confirm
  `bun run build` + the executor suite, and record the SDK↔gateway compat
  verdict (SDK and gateway must be the same release).
- Its runtime deps (`@bufbuild/protobuf`, `@connectrpc/*`) stay on the
  public npm registry — no auth needed for those.
