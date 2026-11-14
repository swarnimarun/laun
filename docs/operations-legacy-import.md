# Import legacy Pi history without resuming it

The offline importer accepts one explicitly selected Pi coding-agent session JSONL in format version **3**. It can also preserve a supplied v1 gateway `index.json` and event JSONL when their selected session ID matches the Pi header. It never scans directories, follows old repository/session paths, opens the original with a writable Pi SessionManager, or guesses which file belongs to which user.

The result is a new named mower and stopped thread under an empty isolated profile. Original session IDs, tree entry IDs, branches, timestamps, source paths and SHA-256 digests remain provenance. New v2 IDs avoid collisions between old installations. Imported status, permissions, providers, extensions, system messages, task graphs and approval requests do not become current authority. Import admits **zero runs** and makes no model, tool or connector calls.

## Prepare and preview

Stop the old gateway, executor, bridge, tracked sandbox processes and restarting supervisors. Retain a verified backup and the original files. If the old Pi session lives inside a sandbox, use the old installation's tools to copy the actual session file after stopping its writer. A gateway event stream is not a Pi session file. Do not rename an old file into the v2 Durable storage directory.

Choose the destination's stable human `principalId` explicitly. V1's shared service token and global session index are not evidence of human ownership. Obtain the intended owner from the current installation identity or retained key/backup metadata; mint a replacement key for that same owner when required.

From the repository, inspect the selected source with Bun:

```sh
bun --eval 'import { previewLegacyImport } from "./packages/control/src/legacy.ts";
const preview = await previewLegacyImport({
  sessionFile: "/srv/laun-v1-export/selected-session.jsonl",
  confirmOffline: true
});
console.log(JSON.stringify(preview, null, 2));'
```

The preview lists all branch leaves, entry counts, unsupported types/fields, shortened previews and exact file digests. Treat displayed legacy text as untrusted history. Repository/artifact files are not copied; old paths are provenance only. Model context is not imported, and no branch is silently selected for a model.

The reader rejects unsupported versions, malformed UTF-8/JSON, duplicate JSON keys or entry IDs, missing/cyclic parent references, unresolved required entry references, incomplete JSONL records, symlinks and special files. It checks file identity/size/timestamps while reading; `confirmOffline` remains the operator's acknowledgement that the original writer is stopped, not a process detector.

Supported input limits are 16 MiB for the Pi transcript, 4 MiB for an optional gateway index, and 8 MiB for optional gateway events. There are at most 10,000 Pi entries and 10,000 gateway events, JSON nesting is bounded, and displayed previews share a 1 MiB budget with a 2,000-byte limit per entry. Exact bytes remain in private archival storage even when display previews are shortened. Inputs beyond the supported limits fail without altering their source; retain them with the old reader until a larger-format migration is qualified.

## Create the inert import

Keep the destination controller and workers stopped too. Choose a current model ID explicitly; the importer does not adopt the old provider/model configuration. Pass the reviewed `sourceDigest` so a changed transcript cannot silently replace the preview:

```sh
bun --eval 'import { ControlStore } from "./packages/control/src/store.ts";
import { importLegacyHistory } from "./packages/control/src/legacy.ts";
import { writePassiveLegacyHistory } from "./packages/runtime/src/legacy.ts";
const store = new ControlStore("/srv/laun/data/control.sqlite");
try {
  const report = await importLegacyHistory({
    store,
    runtimeDataDir: "/srv/laun/data/control",
    ownerId: "user_0123456789abcdef0123456789abcdef",
    name: "Legacy project history",
    model: "provider/model-id",
    sessionFile: "/srv/laun-v1-export/selected-session.jsonl",
    expectedSourceDigest: "replace-with-the-reviewed-64-character-sha256",
    confirmOffline: true,
    writePassiveHistory
  });
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }'
```

For explicit v1 companions, also supply `legacySessionId`, `indexFile` and/or `eventsFile`. The selected ID must match the Pi header, exist in the supplied index as a Pi session, and match every supplied event. A whole index may contain unrelated legacy goals, so its raw contents are never placed in the selected owner's display log.

The runtime writer uses real Pi Durable passive `kind`/`data` entries, containing only provenance and tree metadata. It does not copy old prompt text, tool structures or configuration into session files. Redacted display previews live in the controller's system-event log. The controller also stores a checksummed passive checkpoint and a private raw archive in `legacy_imports`, so a control backup remains sufficient for these imported records after the original source file disappears.

An owner/source-digest pair is idempotent. Retrying the same options returns the existing mapping without creating another mower or writing another session. Different options or companion files for that same transcript fail with a conflict. Interrupted staging can leave an unreferenced private directory after a hard process crash, but no startup scan can submit it; an unsuccessful writer is cleaned up without changing existing threads or the source.

## Inspect, continue and retain

The owner can list import reports and read the new thread's historical display events. Raw archive export requires the installation administrator: source files can contain credentials, private tool data, or other sessions' metadata from an optional gateway index. Protect the SQLite database and backups accordingly. The importer does not load `.env`, provider credential files or old executable extensions.

The new thread stays stopped until a direct current user message. Its empty isolated profile still denies every tool action; review a current profile revision and apply it explicitly before granting tools. A later message uses current Laun instructions, the explicitly chosen current model and current permissions. Original system messages and tool calls never become a resumable task. If old text is needed as model context, a human must review and quote the relevant material through an ordinary new message; automated branch/context projection is not implemented, and requested activation options are rejected.

The source remains untouched and the old reader remains the reference for unsupported formats, richer compaction semantics, attachments and uncopied workspaces. This importer is a history migration path, not a claim that external effects are known complete or that arbitrary old Pi formats can resume in the new harness.

Tests exercise the real Durable writer, inspect zero live tasks/submissions/model messages after reopen, start a later fresh model request without old context, reject malformed/ambiguous sources, preserve all branches/raw hashes, and restore the imported archive/checkpoint through the control backup reader.
