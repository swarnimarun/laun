# Local packaged qualification — 2026-11-14

The final source was built and exercised locally with Bun 1.4.4, Pi Durable
1.5.2 and OpenShell 0.1.8. The images were kept in an isolated, agent-owned
rootless Podman store; no image was published.

| Image | Local tag | Image ID |
| --- | --- | --- |
| Controller | `localhost/laun-controller:current-qualified` | `d8bee16c5154b6c2ff8a9e2beee3145a91b14631754529cb82312f7994a7b2f3` |
| Sandbox | `localhost/laun-pi-agent:current-qualified` | `d9ed3f26cd68cf7cafdad6a9c8346100fc57c54dab7e32bd0bb11e83e72570dc` |

The controller's 41 selected source hashes matched the checkout, including the
human credential fence, MCP uncertainty handling, central ledger, worker journal
compaction, Telegram bridge and generated CLI assets. The image did not contain
the checked private checkout state directories. The real builder sentinel test
passed all 64 synthetic private-file placements while retaining `auth.ts` source
and required vendored distribution files. See [artifact boundaries](artifact-boundaries.md)
for the audit's scope.

The exact deployment `controller-contract.js` payload passed in the image with
network disabled, a read-only root, all capabilities dropped, no-new-privileges,
128 processes, 512 MiB memory, one CPU and a 96 MiB temporary filesystem. It
received no production data or credentials. The image's actual gateway separately
served the UI and authenticated v2 API, rejected unauthenticated state access,
reported the isolated runtime and durable journal, and contacted the host gateway
over certificate-verified mutual TLS.

A fresh fixture then exercised the packaged production control HTTP, scheduler
and runtime code against the real host OpenShell gateway. A scripted provider
drove real Pi file reads, writes and command execution. The workload ran as UID
1000 with verified `cpu.max = 200000 100000` and `memory.max = 1073741824`.
The filesystem and direct-network denial probes passed, and the controller's
test credential was absent from the guest. Six model calls produced six central
admission records; the first run's server ledger reached sequence 50.

After controller restart and removal of the fixture's local thread cache, the
same accepted input returned its original run without another model call. Fresh
input recovered the workspace/history from server checkpoint and ledger data.
Controller-copy removal left the host copy intact until separate human approval.
That approved cleanup verified removal of exactly one owned dummy sandbox and
one managed directory; the old input retry returned HTTP 410.

The committed `scripts/qualify-packaged-control.ts` also passed against this same
controller image: actual Pi runs across restart, stable owner and input receipt,
other-owner isolation, two central model admissions, and no full or partial test
credentials in thread artifacts. Its explicit demo mode qualifies persistence
and authentication; the OpenShell proof above provides the isolation evidence.

These are local host-network results with a temporary mTLS gateway and scripted
model responses. They do not qualify an external VPS, public DNS/TLS ingress,
live Telegram delivery or a real paid model provider. Temporary services and
test resources were stopped after qualification; the local image tags and
private proof reports were retained. Operator provisioning remains described in
[remote setup](../deploy/remote-setup.md).
