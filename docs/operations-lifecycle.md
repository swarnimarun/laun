# Reviewed profile changes and worker moves

Thread assignments are explicit. Creating a profile revision does not change existing threads, and changing a mower's default worker does not move threads with an explicit placement. A human reviews the current assignment and supplies it as an expected value so a stale page or CLI invocation cannot overwrite a newer decision.

These operations require confirmation that prior execution has stopped. They reject queued, running, waiting and interrupted attempts rather than treating a permission decision or expired lease as proof of shutdown. Cancel queued work and reconcile interrupted outcomes through the normal recovery flow first. Neither operation queues or replays a prompt.

## Apply a profile revision

`POST /api/v2/threads/:id/profile` accepts:

```json
{
  "profileId": "reviewed-profile-id",
  "profileVersion": 2,
  "expectedProfileId": "currently-assigned-profile-id",
  "expectedProfileVersion": 1,
  "confirmedStopped": true
}
```

The thread's entire delegation family, including siblings, must be idle during the change. The new revision must belong to the thread owner and be active. The controller rechecks every ancestor ceiling and the affected descendants' permission attenuation. A narrower parent cannot leave an active descendant with broader authority; rebase that descendant first. Archived or revoked branches remain inactive.

The controller updates this thread's immutable revision reference and stops its descendant subtree, expires stale approvals, and records an event. It does not rewrite the profile, alter the mower's defaults, or change unrelated siblings. A direct user message resumes the relevant thread under its newly assigned profile. Reusable rules cover all future argument values matching their operation and resource; applying a revision is separate from allowing one pending action.

Gatekeeper retains its dedicated isolated empty profile and cannot use this operation to acquire tool permissions.

## Move a thread to a different worker

`POST /api/v2/threads/:id/move` accepts:

```json
{
  "workerId": "target-worker-id",
  "expectedWorkerId": "currently-assigned-worker-id",
  "confirmedStopped": true,
  "checkpointSha256": "reviewed-server-checkpoint-sha256",
  "confirmedOmissions": true
}
```

Use `expectedWorkerId: null` only when the thread has no effective worker assignment. The controller resolves legacy threads through their recorded execution host, then their mower's default. New threads snapshot an explicitly selected mower worker when they are created.

The target must belong to the owner, or be the controller's local worker, and must be online with a recent authenticated heartbeat. Every thread with any execution attempt requires a server checkpoint, the exact checksum reviewed by the user, and an exact advertised checkpoint runtime version match. An absent capability is not a compatibility promise. The checkpoint endpoint is `GET /api/v2/threads/:id/checkpoint`.

Check the archive's `omittedPaths` before confirming. Generated dependencies, VCS metadata and caches can be omitted from bounded checkpoints; `confirmedOmissions: true` acknowledges those gaps. Files outside the captured thread session/workspace are not transferred, and external effects cannot be rolled back.

A move creates a fresh placement ID and leaves the thread stopped. The destination restores the server checkpoint into a fresh root, preserving any older local data, and uses a fresh sandbox placement when isolation is enabled. This matters for A → B → A moves: A's older session files or retained sandbox must not override the newer checkpoint. Subsequent runs in the same placement retain their newer local state. Direct user input creates the next run; old work stays settled.

Gatekeeper placement remains fixed. The controller's administrator can inspect the recorded events and checkpoints, but cannot use an administrative request to attach another owner's worker or profile to a thread.
