# Container build-context boundary

The controller image copies the root package manifest/lock, application and package source, the vendored SDK and specific OpenShell deployment files. It does not copy the whole checkout. `.dockerignore` independently limits the builder context to the source roots and excludes known nested credentials, private configuration, agent state, dependency/compiler outputs, databases, session/event files and archives.

In particular, `.laun-local`, `.aws`, `.ssh`, `.pi`, `.config`, `.agents`, `.codex`, `auth.json`, `credentials.json`, `access.json`, `keys.json`, worker environment files and SQLite/WAL files are excluded. Source code named `auth.ts` remains included. The vendored OpenShell SDK's `dist` is required shipped source and remains included; private-state exclusions still apply inside it.

Run the real builder sentinel check with Bun and an available Docker engine:

```sh
bun scripts/check-container-context.ts
```

The helper builds a disposable synthetic context using the checkout's exact ignore rules. It checks 64 private file/directory placements plus required source paths. No live access file, provider credential or controller database is copied into the test. Output contains booleans and a count; failed builder diagnostics are retained in a private temporary log. Only the uniquely named proof image is removed. `LAUN_CONTEXT_ENGINE_ARGV` and `LAUN_CONTEXT_BUILD_ARGV` accept explicit JSON argument arrays for an operator's isolated Docker-compatible test engine.

Docker documents that `.dockerignore` filters the context before it is sent to the builder. This matters even for a file that no final `COPY` instruction uses: builder exposure and final-image presence are distinct questions. See [Docker build contexts](https://docs.docker.com/build/concepts/context/#dockerignore-files).

These are curated filename and directory boundaries, not a claim that arbitrary source contents are secret-free. A secret pasted into an otherwise included TypeScript file, package manifest or vendored asset remains source content and requires removal and credential rotation. Keep runtime state and provider/TLS identities outside source roots, pass runtime credentials through protected configuration, and review the source before distributing images or compiled artifacts.

The local qualification audit checked the known older agent-built controller image and its 17 ancestry layers for the generated local access/key/database paths and operator configuration directories; none of those checked paths was present. No controller archive was found in the known agent artifact directories, and no image was published. The broader builder-context omission was still corrected. Generated local development credentials were rotated separately. This audit does not cover unknown images, arbitrary temporary directories or third-party image contents.

The final current-source images, deployment contract probe and live local
OpenShell results are recorded in [packaged qualification](packaged-qualification.md).
