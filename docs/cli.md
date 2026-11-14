# Durable control CLI

Run from the checkout with `bun run laun <command>`, or use a packaged `laun`
binary built with `bun run cli:build`. Portable packaging is locally qualified;
no release was published during that qualification. The v2 commands use the same
configured controller, owner identity and records as `/app`. `laun agent ...`
and the old top-level `run`, `ls`, `stop`, `approve` aliases still use the v1
session API. Use `laun thread ...` and `laun approval ...` for durable v2 work.

## Connect and identify

All v2 commands accept `--target <saved-name>` and `--json`. Reuse a saved
target, or provide `LAUN_HOST`, `LAUN_PORT`, `LAUN_SCHEME` and `LAUN_KEY` through
a protected shell/environment. Keys are never included in list, status or
diagnostic output. Obtain a human key from the app startup helper or your
installation administrator; a yard key cannot control human-owned resources.
`laun agent auth --host <host> --key <key>` verifies `/api/v2/me`, reads the
owner's mower/thread summary, then saves the target privately. It only falls
back to old sessions when that identity endpoint returns 404. Wrong keys,
outages and a disabled compatibility endpoint never trigger a downgrade.
The JSON response contains identity and summary metadata, never the key.

```sh
bun run laun whoami --json
bun run laun mower ls --json
bun run laun thread ls --target home --json
bun run laun doctor --target home
```

`whoami` returns the stable principal used to own mowers, threads and profiles.
An administrator can rotate a human credential while retaining that identity:

```sh
# GATEWAY_TOKEN must be supplied privately; output contains the new one-time key.
bun run laun keys create --label replacement --principal <existing-principal-id>
```

Omitting `--principal` creates a new owner. Revoking an old key does not delete
its owner's work or grant it to another owner. Legacy keys keep their existing
identity. `target ls` shows saved hosts without their secrets.

Durable v2 requests recheck the human credential after a delayed JSON body and
before admitting its mutation. Onboarding and operator tool discovery also
recheck after their asynchronous preparation. A revoked or changed credential
cannot approve work through a request still waiting at those boundaries.
Inputs, approvals and tasks already durably admitted remain owner decisions;
key revocation does not undo them or cancel that owner's running work. Use an
explicit thread stop or profile revocation when that is the intended action.

Doctor authenticates, checks the current execution mode, recently online yard
capacity and the configured model catalog. A controller without a local runtime
can dispatch to an online remote yard; that does not verify remote provider
credentials. No inference or external tool is invoked by this check. Public
health alone never establishes authenticated v2 readiness.
Doctor also reports central journal support and closed disk-reserve admission.
It returns a failure while storage rejects new work, even if the server responds.

Legacy session endpoints are disabled by default. Set `LAUN_LEGACY_API=true`
on the controller only for explicit single-operator compatibility. Existing
`agent` commands remain available for such an installation; v2 owner isolation
must not be inferred for its legacy sessions. Doctor labels an older server
without `/api/v2/me` as legacy qualification rather than v2 readiness.

## Crew, conversations and recovery

The app's primary Groundskeeper wizard and these commands share the same durable
owner setup. Setup performs no inference and does not submit a run:

```sh
bun run laun onboard status --json
bun run laun onboard new --file ./primary-setup.json --request-id primary-setup --json
bun run laun onboard select <directorMowerId> <topLevelThreadId> --from-revision 1
```

`primary-setup.json` explicitly contains `name`, `title`, configured `model`,
online `workerId`, `mode` (`manual`, `auto`, `isolated`), `workspaceWrite`
(`ask`, `allow`), `processExecute` (`ask`, `deny`), and `delegation` (`ask`,
`deny`). The server creates six exact minimal rules: read, write, process,
spawn, handoff and child-thread messaging. Missing external capabilities deny.
Selecting an existing primary changes its pointer with a reviewed revision;
it does not rewrite that director's profiles, threads or work. Auto mode may
queue Gatekeeper model advice when a permission request occurs; setup itself
does not call that model, and advice cannot grant authority.

```sh
bun run laun mower new Groundskeeper --role director --model provider/model-id --json
bun run laun mower set <mowerId> --instructions "Review releases and delegate bounded checks."
bun run laun thread new <mowerId> "Release review" --json
bun run laun thread say <threadId> "Review the release changes" --json
bun run laun thread watch <threadId> --timeout 5m --json
bun run laun thread log <threadId> --after 120 --json
bun run laun thread stop <threadId>
```

New input defaults to a UUID request ID. Supply `--request-id <stable-id>` to
retry an input deliberately: the same payload returns the original receipt;
a changed payload conflicts. `say` returns admission, not a promise that work
already finished. `watch` polls durable events and thread-scoped run status;
`--run <runId>` watches one specific attempt. An old global history limit
cannot hide an unresolved run from this check.
Mower purpose and working instructions are captured when each run is accepted.
Editing them changes future inputs, while previously accepted work retains its
snapshot. Instructions do not change permissions. The managed Gatekeeper only
allows name/model edits; its empty authority profile and placement are managed
by the controller.

JSON logs use newline-delimited `{type:"event",event}` records followed by a
`{type:"cursor",nextCursor}` record. Watch ends with a typed status record.
Events drain through all available pages, with cursor deduplication. Default
watch timeout is five minutes; `--poll-ms` controls polling. Exit codes are:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Selected work finished successfully, or a non-watch command succeeded |
| 1    | Failed/cancelled work, missing resource or controller/transport error |
| 2    | Invalid usage or watch timeout; timed-out work may still be running   |
| 3    | Interrupted work requires operator reconciliation                     |

A lost lease or connection does not prove an old command stopped. First stop
the old host/guest and reconcile any external side effects, then explicitly
choose one recovery action using the run ID printed by `watch`:

```sh
bun run laun thread resume <runId> --confirmed-stopped
# Or discard the reconciled attempt without replay and cancel its queued work:
bun run laun thread abandon <runId> --confirmed-stopped
```

Resume re-admits the durable request; it does not report successful completion.
Without the confirmation flag neither command sends a mutation. Never use the
flag merely to silence an interrupted warning while the old worker may run.

```sh
bun run laun yard enroll workshop --capacity 2 --labels linux,build --json
bun run laun mower set <mowerId> --yard <yardId>
bun run laun yard ls
bun run laun yard revoke <yardId>
```

Enrollment is the only yard command printing its one-time worker key. Save it
privately, then configure the outbound worker as described in
[local development](local-development.md). A new mower placement preference
does not migrate an existing thread's execution host. `--clear-yard` removes
the default preference; explicit host migration remains separate work.

Yard maintenance preserves stable placement identity:

```sh
bun run laun yard drain <yardId>
bun run laun yard ls --json
bun run laun yard rotate <yardId> --from-version 1 --confirmed-stopped --json
# Replace the private worker configuration, restart it, then inspect its heartbeat.
bun run laun yard resume <yardId>
```

Drain stops new execution and host-cleanup claims. Active attempts may finish,
and queued work stays assigned to the same yard. It does not stop a process
already running. Resume requires a recent authenticated heartbeat and valid
capacity, inference, checkpoint and central durability metadata.

Before rotating, stop the old worker process and reconcile external effects.
Rotation compares the exact credential revision you reviewed, replaces the key
hash atomically, and retains the yard ID and queued placement affinity. The old
key becomes invalid immediately; active attempts become interrupted with their
approvals/leases fenced. Host-cleanup approval and leases are also invalidated,
requiring fresh owner review. Rotation leaves the yard offline and drained and
clears previously advertised capabilities. The replacement worker must reconnect
and advertise current metadata before an explicit resume can release new work.

Only the explicit `yard enroll` and `yard rotate` commands print worker keys.
Save rotation output privately once. The raw replacement is not persisted in a
receipt, thread or audit event; if a response or key is lost, inspect the current
revision and deliberately rotate again. Update `LAUN_WORKER_KEY` in the service's
protected environment through an operator-controlled edit/replacement, preserving
private ownership and permissions, then restart the service. The SSH installer
will refuse a differing `worker.env` and does not silently perform this update.
Revoked yard identities cannot be resumed or rotated; enroll a new yard instead.
The app exposes the same drain/resume/rotation controls on remote yard cards and
keeps its one-time key display in session memory only.

Existing threads can be changed after all family work is stopped and reconciled:

```sh
bun run laun thread profile <threadId> <profileId> --version 2 \
  --from-profile <currentProfileId> --from-version 1 --confirmed-stopped
bun run laun thread move <threadId> <yardId> --from-yard <currentYardId|none> \
  --checkpoint-sha256 <reviewed-raw-checkpoint-hash> --confirmed-stopped
```

Both operations compare the reviewed current binding, preserve ownership and
parent ceilings, and leave the thread stopped. Move validates online worker
compatibility and the controller checkpoint's exact bytes. Add
`--confirmed-omissions` only after reviewing listed missing workspace artifacts.
No migration or profile rebase implicitly replays old input.

## Profiles and exact action decisions

Structured payloads come from a JSON object file with `--file <path>` or stdin
with `--file=-`. No shell-evaluated JSON strings are needed. Input is bounded
to 256 KiB. For example, save this as a private profile configuration:

```json
{
  "name": "Workspace only",
  "mode": "manual",
  "rules": [
    {
      "operation": "workspace.read",
      "resource": "workspace:own",
      "effect": "allow"
    },
    {
      "operation": "workspace.write",
      "resource": "workspace:own",
      "effect": "ask"
    }
  ]
}
```

```sh
bun run laun profile new --file ./profile.json --json
bun run laun profile revise <profileId> --base 1 --file ./revised-profile.json --json
bun run laun mower set <mowerId> --profile <profileId> --version 2
bun run laun profile revoke <profileId> --version 1
bun run laun approval ls
bun run laun approval allow <approvalId>
bun run laun approval deny <approvalId>
bun run laun approval deny <approvalId> --feedback "Use a permitted read-only approach."
bun run laun approval deny <approvalId> --feedback "Pause this work." --stop
bun run laun approval discuss <approvalId> "Ask before future writes" --json
bun run laun advice get <adviserRunId> --json
```

Read the exact action preview before allowing it. Missing previews prevent
CLI approval. Allow is bound to one action; profile rules are reusable across
all future matching argument values. Profile revision requires the exact base
version you reviewed and rejects a stale update. Assignment changes new-thread
defaults; existing threads retain their pinned revision.
Denial feedback can let the model replan within unchanged guardrails. `--stop`
cancels the thread family instead; feedback never grants a capability.

Gatekeeper discussion uses the configured model in a durable advice-only
thread. Advice status and a server-validated proposal can be inspected as JSON;
they never approve an action, save a revision or change an assignment. Review
the proposed scope in `/app`, or deliberately create a reviewed profile JSON
revision. `advice ask` is an alias for the `approval discuss` operation.

## Delegation and MCP

```sh
bun run laun task delegate <parentThreadId> "Review this module" --mower <mowerId> --json
bun run laun task ls --parent <parentThreadId> --json
bun run laun task handoff <taskId> <nextMowerId> --json
bun run laun thread say <childThreadId> "Focus on error paths"
bun run laun connector add --file ./connection.json --json
bun run laun connector discover <connectionId> --json
bun run laun connector disable <connectionId>
```

Delegation and handoff retain ownership and parent permission ceilings. A live
or interrupted task must settle or be reconciled before handoff. Thread IDs
from task responses allow direct child interaction.

A connection object contains `name`, credential-free HTTP `url`, and
`protocolVersion` (`2026-07-28` or explicit legacy `2025-11-25`). Optional
`secretRef` names a controller-managed `MCP_...` environment secret; only the
installation administrator can bind it. Never paste a token into the JSON URL
or payload. Local destinations require both `allowLocal:true` in configuration
and the controller's explicit opt-in. Discovery pins tool/schema identity; it
does not grant a mower permission to invoke those tools.

## Checkpoint export

```sh
bun run laun thread checkpoint <threadId> --out ./thread-checkpoint.json --json
```

Export uses the owner-protected API and creates a new mode-0600 file, refusing
an existing path or symlink. It never writes private archive contents to
stdout. The last completed checkpoint may omit active changes and explicitly
lists dependency/generated/quota omissions. Treat it as a private user
artifact. It is not a consistent backup of the entire controller, credentials,
database and installation. Use the offline backup workflow below for the
controller database and consult its explicit exclusions for other copies.

## Install a yard over SSH

`yard setup ssh` enrolls an owner-scoped execution yard, transfers source and
its worker key, installs a systemd service and waits for that yard's
authenticated heartbeat. The controller URL is explicit because a CLI's local
SSH tunnel address may not be reachable from the remote host.

```sh
bun run laun yard setup ssh ubuntu@yard.example -i /private/ssh_identity \
  --name workshop --controller-url https://control.example \
  --config ./remote-yard.json --service-user laun-worker --json
```

Example `remote-yard.json`, containing references on the remote host:

```json
{
  "OPENSHELL_BIN": "/usr/local/bin/openshell",
  "OPENSHELL_SANDBOX_IMAGE": "registry.example/laun-pi@sha256:reviewed-digest",
  "OPENSHELL_GATEWAY_ENDPOINT": "https://openshell.internal:17670",
  "XDG_CONFIG_HOME": "/etc/laun/worker-openshell"
}
```

The Linux host needs systemd/user-management tools, pinned Bun **1.4.4**
(`--bun-path` overrides `/usr/local/bin/bun`), root or passwordless sudo, and
operator-provisioned OpenShell binary, image and gateway mTLS identity.
`--service-user` selects an existing dedicated non-root account with access to
that configuration. Without it, setup creates `laun-yard-<yard-id-prefix>`;
configuration access must be provisioned accordingly. The installer refuses
root as the worker account. It never copies controller/provider credentials or
weakens OpenShell gateway TLS. Missing prerequisites fail with a diagnostic;
this worker deployment command does not itself provision the OpenShell gateway.

All new yard installs require the central durable journal. Default
`--inference controller` additionally requires the controller's fenced inference
relay and never silently switches to local inference. The source and executable
must advertise the versioned `pi-durable@1.5.2` durability adapter before launch;
an old worker that only advertises inference is refused. Explicit
`--inference local` additionally requires `PI_AUTH_FILE` in the JSON, pointing
to an operator-provisioned remote supervisor credential file readable by the
service account, outside worker/session/workspace data. That file is never
transferred by the CLI. Model calls and credentials remain outside the agent
sandbox in either mode.

By default, setup bundles the current checkout, including unpublished JJ
changes. `--source-dir` selects another checkout. It transfers only allowlisted
root package/lock/TypeScript files and `apps`, `packages`, `vendor`, `deploy`
source. Dependencies, generated state, dotfiles, environment files other than
the example, credential/config/state directories, known credential data names,
uncurated JSON/YAML and private key files are excluded or rejected. Required
source modules such as `credentials.ts` remain included. Configured controller
authentication paths inside the checkout are excluded, including resolved
symlink destinations. This is a source allowlist, not a guarantee that arbitrary
source code or documentation cannot contain a hardcoded secret: review the
checkout before transfer. A bounded
SHA-256 manifest is checked completely before extracting to a fresh release
directory. Bun installs from the frozen lockfile without package lifecycle
scripts. Alternatively, supply an explicit published HTTPS `--repo-url` and
40-hex `--revision`; this path additionally needs Git on the remote host.

The scoped worker key travels through SSH stdin into a mode-0600 environment
file. It never appears in command arguments, logs or result JSON. Source and
unit files stay root-owned; state belongs to the worker account. `--remote-dir`
must be a canonical dedicated application leaf, never `/`, a protected OS/home
base, credential directory or symlink ancestor. Nonempty unrecognized paths
are refused. Recognized marker directories permit only an identical private
configuration; a different key, guardrail or setting requires an explicit
reviewed update and is never silently written. The default is
`/opt/laun/yards/<yardId>`.

On install/heartbeat failure, the command attempts to revoke only the newly
enrolled yard and preserves private remote files for inspection. An explicit
revocation warning identifies the yard if cleanup could not reach the
controller. `--timeout 2m` bounds heartbeat qualification. `--no-start` installs
without starting and reports readiness as unqualified. A successful heartbeat
proves authenticated worker transport; installation does not claim inference,
OpenShell execution, external tools or a full production VPS qualification.

## Portable CLI and controller templates

Build a release CLI with pinned Bun 1.4.4:

```sh
bun run cli:build --outfile /tmp/laun-release/laun --version 0.2.0
# Cross-compilation is explicit, for example --target bun-linux-arm64.
```

The binary embeds only verified public deployment templates and a build version.
Its adjacent `.manifest.json` records binary/template/source hashes, exact
toolchain versions and the required worker durability adapter. CI attaches the
manifest alongside each packaged CLI. Provider files, `.env`, human/worker keys
and working data are not build inputs. An unpublished local binary has no
fetchable source commit; `yard setup ssh` requires `--source-dir` or an explicit
published repository and 40-hex revision in that case.

Outside a checkout, `laun setup` extracts verified public templates into a
private cache beside the selected environment file. Existing symlink,
foreign-owned, writable or altered cache contents are refused. Concrete release
tags and a stable Compose project identity preserve volume selection across
asset-cache versions. Compiled setup pulls released images with `--no-build`;
an explicit `LAUN_SERVICE_IMAGE` override also uses that path from source.
SSH controller setup verifies public assets and preserves identical `.env`
reruns, rejecting differing credentials or guardrails. It cannot adopt an
arbitrary existing directory or silently upgrade its contents.

From a source checkout, `setup ssh` transfers the current JJ source, including
unpublished changes, rather than requiring a floating clone. The controller
archive additionally includes the exact root `.dockerignore`, sandbox
Dockerfile and a fixed list of public build/qualification scripts. A trusted,
hash-checked receiver verifies the entire bounded manifest before publishing
source files without clobbering existing paths. Private pending/complete
source markers support identical retries; changed or unrecognized source
requires the explicit upgrade workflow. Configurations and credentials stay
outside that archive. An explicit HTTPS `--repo-url` plus exact `--revision`
selects a published source installation instead.

SSH source setup installs locked dependencies, typechecks and initializes the
actual owner/durable-journal/inference API in a disposable directory without
making model calls before starting the stack. Its live readiness check is
authenticated. `--no-start` leaves execution unqualified; neither check
replaces an actual model and OpenShell probe on the target host.

Pulled release images and explicit `LAUN_SERVICE_IMAGE` overrides must pass the
trusted owner/durable/inference contract in a disposable read-only, no-network
container before Compose can start them. That probe mounts no production volume
or credentials; an old image fails before it can read restored controller data.
The qualification payload comes from the current CLI, including for explicit
repository installs, so an old checkout cannot weaken the required contract.

The Bun helper reuses exact 1.4.4 or extracts it from a digest-pinned Bun image
into private application tools using an existing container engine. It never
replaces a global Bun executable. OpenShell uses the repository's pinned
SHA-verified installer, and Pi version is checked exactly. Provision Docker
and the OpenShell gateway/identity through the documented operator workflow.
Portable templates and local fresh-source qualification are tested; real SSH
host installation, published multi-platform release artifacts and production
VPS rollback remain separate qualification gates.

An optional `LAUN_DATA_DIR` binds a concrete cold-restored data directory instead
of the named volume. Setup requires an existing canonical private real directory
with no symlink ancestors; it never creates a possibly mistaken restore path.
`LAUN_MIN_FREE_DISK_MIB` controls the admission reserve (512 MiB by default).

## Offline controller backup and restore

Stop the controller, Telegram bridge and every worker before either command.
The confirmation flag is an operator assertion, not an automatic shutdown or
proof that another host stopped.

```sh
bun run laun backup create --data-dir /private/controller-data \
  --out /private/backups/control-2026-11-14 --confirmed-offline --json
bun run laun backup restore /private/backups/control-2026-11-14 \
  --to /private/restored-controller --confirmed-offline --json
```

These commands run locally without a saved network target. Backup validates a
consistent SQLite copy and public credential metadata; output directories must
be new, with private permissions and checksummed manifests. Treat the archive
as sensitive because it contains user conversations, profiles and central
checkpoints. Installation environment/provider credential files, independent
bridge inbox files, live guest volumes and uncheckpointed worker changes are
outside this scope.

Restore preserves owner identities and durable data while making old authority
inert: runs require reconciliation, grants expire, yards/human credentials need
replacement, and uncertain deliveries need inspection. JSON lists preserved
principals and safety counts. Re-provision secret references and installation
credentials privately, mint replacement keys for the existing principal IDs,
re-enroll workers and reconcile effects before resuming. See the full
[backup recovery procedure](operations-backup.md) for scope and verification.

## Remove a controller copy

Removal is separate from archiving and host cleanup. Stop/reconcile all work,
archive a settled leaf thread, then inspect the current server preview:

```sh
bun run laun thread archive <threadId>
bun run laun thread purge-preview <threadId> --json
bun run laun thread purge <threadId> --digest <reviewed-preview-digest> \
  --confirmed-stopped --controller-copy-only --request-id remove-reviewed-copy --json
bun run laun purge ls --json
bun run laun purge status <purgeId> --json
bun run laun purge continue <purgeId> --max-rows 64 --json
bun run laun purge host-copies <purgeId> --json
```

The preview lists blockers, exact record counts, payload size, family usage
retained for accounting, and known host copies. Confirmation is bound to its
digest; changed records require a fresh review. The initial removal fence makes
the thread unavailable and prevents old inputs or late callbacks resurrecting
it. Each continuation is bounded to 1–256 rows per phase and is resumable after
disconnect/restart. Keep continuing until status is `done`; accepting a removal
job does not mean every record has already been removed.

Older Telegram delivery history may lack source-thread metadata. When the
preview lists `legacyTelegramRouteDetails`, inspect every recorded bot/chat/topic
and count. Only then pass `--legacy-telegram-route-cleanup` to consent separately
to deleting **all listed untyped delivery history, including unrelated settled
entries and switched/unlinked routes**. Typed output for surviving sources is
preserved. Already-sent Telegram messages remain outside controller removal.

The app exposes the same review under workspace settings → **Review controller
copies**. It requires independent stopped-execution and controller-copy scope
confirmations, and a separate broad Telegram consent when applicable. The job
list provides bounded continuation and inspection of known pending host copies.
The host-copy inspection view does not automatically delete a worker directory
or sandbox.

Review and authorize each known host separately after the controller removal
job finishes:

```sh
bun run laun host-copy review <planId> --json
bun run laun host-copy approve <planId> --digest <reviewed-plan-digest> \
  --confirmed-stopped --delete-host-copies --json
bun run laun host-copy review <planId> --json
# To withdraw further authority, review again and use that current digest:
bun run laun host-copy revoke <planId> --digest <current-reviewed-plan-digest> --json
```

Keep the idle yard service online, and independently verify this thread's work
is stopped on the intended host. Online/offline/draining status does not prove
physical shutdown. Only that owner can approve or withdraw cleanup; an admin
credential for another owner cannot substitute. Approval expires after ten
minutes and does not mean deletion completed. Inspect `status`, `verified` and
`outstanding`; a blocked or unknown outcome needs fresh host inspection and
review, with no automatic effect retry. Withdrawal cannot undo removal already
begun. Changed plan digests require another review rather than an automatic
approval retry. The app exposes the same steps from each **Review host copy**
button, with independent stopped-work and deletion-scope confirmations.

Parent conversations can retain quoted results. Exports, backups, bridge inboxes,
external messages, unknown hosts and known pending host caches are separate
copies. SQLite can reuse logically released pages without shrinking its file;
logical removal is not secure erasure or an all-copies deletion guarantee.
