# Server-owned thread checkpoints

`@laun/storage` captures quiescent Pi Durable 1.5.2 session files and bounded
workspace artifacts. Controllers commit local captures before recording a
terminal result. Outbound yards upload a validated archive before completing
a run; a yard with missing local thread data restores from the controller's
checksum-bound archive before starting the next submission. Missing or corrupt
state fails visibly; an existing local history is never overwritten silently.

Archives contain all session files, excluding the advisory writer lock.
Workspace source and outputs are included within a 32 MiB decoded / 2,048-file
limit. Reproducible dependency/build/VCS directories (`node_modules`, `.git`,
`.cache`, `.venv`, `venv`, `dist`, `target`) and workspace files exceeding the
remaining quota are listed in `omittedPaths`. Regenerate those dependencies
when restoring. This is a thread checkpoint, not a complete VPS/repository
backup. Conversation data exceeding the durable limit fails capture rather
than silently discarding context. Symlinks, devices, traversal, duplicate paths,
wrong thread/runtime identities and invalid hashes are rejected.

Provider/connector/yard credentials remain outside the captured thread roots.
Archives may contain sensitive user-provided text and workspace artifacts;
owner ACLs apply to downloads. Capture assumes the runtime writer is closed.
Trusted-local mode cannot defend against a hostile process with the same host
UID mutating directories; production tools must use OpenShell containment.

The controller and yard remain pinned to the current host by default. This
archive enables recovery after yard data loss; relocating an uncertain live
run still requires fencing and explicit side-effect reconciliation. It does
not make external tools replay-safe or prove power-loss durability of every
filesystem/runtime component.
