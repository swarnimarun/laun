# Controller and yard installation over SSH

Laun has two separate installation paths: a **controller** owns conversations, model credentials and permissions; a **yard** executes tasks assigned by that controller. They can share one VPS or run on different hosts. The local workstation may also be the controller. Use the same versioned protocol and exact-pinned runtime in every topology.

The supported SSH provisioner targets Debian/Ubuntu with root or passwordless sudo. It does not change a NixOS host's system configuration; use the [NixOS/WSL local runbook](../docs/local-development.md) there. No external VPS was modified during the current local qualification.

## Provision the execution boundary first

Fresh VPS configuration defaults to OpenShell enabled. Provision the host's Docker/compatible engine and an OpenShell **0.1.8** gateway using the upstream installation procedure. The pinned portable client is installed by Laun's SHA-verified helper, but the client does not provision a gateway server. The actual CLI has no gateway-start command.

Register an existing local mTLS gateway with the intended auth mode:

    openshell gateway add https://GATEWAY_HOST:17670 --name openshell --local
    openshell gateway info

The gateway and its operator certificates must already be configured. The HTTPS server certificate must cover the hostname that the controller container will use. The default Compose endpoint is host.openshell.internal:17670, mapped to the Docker host; an unrelated loopback-only certificate does not cover that name. Keep the gateway listener protected by authenticated TLS and host firewall/network placement.

On the VPS, the configured directory must contain readable, nonempty:

    OPENSHELL_CONFIG_DIR/gateways/OPENSHELL_GATEWAY_NAME/mtls/ca.crt
    OPENSHELL_CONFIG_DIR/gateways/OPENSHELL_GATEWAY_NAME/mtls/tls.crt
    OPENSHELL_CONFIG_DIR/gateways/OPENSHELL_GATEWAY_NAME/mtls/tls.key

The CLI's identity directory inside the controller is derived from the endpoint URL. Change OPENSHELL_GATEWAY_CONFIG_ID together with an alternate endpoint; for the default it is https___host.openshell.internal_17670. The overlay mounts only that mTLS material read-only. No insecure-TLS fallback is selected.

V2 model inference runs in the trusted controller, outside the tool sandbox. Create a dedicated private controller-auth directory containing the pinned Pi provider auth.json, using a separate operator login/writer. Do not mount an entire operator home into v2. No provider credential file is transferred to a remote yard by default.

The legacy install-and-verify.sh provider/egress helper remains available for explicitly enabled v1 deployments. It is **not** the v2 runtime qualification: v2 requires the actual non-root, hard Landlock, no-direct-egress and cgroup probes, durable harness recovery and verified sandbox stop.

## Install the controller

Prepare a private local dotenv file from deploy/.env.example. It contains installation credentials and non-secret host paths, so keep it outside agent workspaces and shell history. Set these values to paths/references on the VPS:

    OPENSHELL_ENABLED=true
    PI_CONTROLLER_AUTH_DIR=/srv/laun/controller-auth
    OPENSHELL_CONFIG_DIR=/etc/laun/openshell
    OPENSHELL_GATEWAY_NAME=openshell
    OPENSHELL_SDK_GATEWAY=https://host.openshell.internal:17670
    OPENSHELL_GATEWAY_CONFIG_ID=https___host.openshell.internal_17670
    LAUN_TAG=0.2.0-rc.1
    OPENSHELL_SANDBOX_IMAGE=ghcr.io/swarnimarun/laun-pi-agent@sha256:d509ecd85ac171e774e99ad50c0305f39f4920d50a243fb9daacf80327798
    LAUN_SERVICE_IMAGE=ghcr.io/swarnimarun/laun@sha256:6500bdf8bd770a7f411554d3bd4d33546655e31137f78cc46e5a4a15be4e6e74
    LAUN_LEGACY_API=false
    LAUN_DEMO=false
    MODEL=provider/model-id

The image digests above pin both images from [v0.2.0-rc.1](https://github.com/swarnimarun/laun/releases/tag/v0.2.0-rc.1). Update both references together when changing releases. Source setup can build the checkout when no service image override is set. See [CLI packaging](../docs/cli.md#portable-cli-and-controller-templates).

With the [installed release CLI](../README.md#install-the-cli):

    laun setup ssh -i /private/ssh_identity root@vps.example --remote-dir /opt/laun/controller --env-file /private/laun-controller.env

For a controller built from your checkout, run the same command with `bun run laun` in place of `laun`. Supply `--no-start` to prepare the installation and leave the stack stopped. An explicit published repository/revision selects a different source installation.

Source setup carries the current JJ checkout, including unpublished changes, in a curated checksummed archive. It includes the exact Docker ignore boundary and a fixed list of public build scripts. A trusted receiver verifies the complete manifest before publishing without clobbering existing files; changed or unrecognized source needs an explicit upgrade. Identical interrupted transfers can resume through private source markers.

Setup creates or reuses generated installation/human credentials, transfers them separately through SSH stdin, validates a dedicated canonical destination and private no-clobber configuration, checks required host paths and selects the isolated Compose overlay. It installs pinned Bun in an application tool directory rather than replacing a global runtime. Locked install, typecheck and a disposable no-model v2 contract check precede service startup. Existing differing credentials or guardrails require explicit operator reconciliation; re-running setup does not silently overwrite them.

The default application port stays on VPS loopback. Use an SSH tunnel:

    ssh -i /private/ssh_identity -N -L 18080:127.0.0.1:8080 root@vps.example

Open http://127.0.0.1:18080/app and enter the generated human key. Save the target using the CLI's authenticated login, then inspect whoami and doctor. Public health proves the HTTP listener only; model configuration and execution-boundary checks must also pass.

The first-run wizard asks for the primary Groundskeeper, model, compatible yard and exact starter permissions. It does not run a model or grant external access. Send the first task explicitly. Confirm one permitted workspace effect, a denied outside effect, cancellation and durable reopen on the actual host before unattended work.

## Add another VPS yard

A remote yard needs pinned Bun 1.4.4, systemd/user-management tools, an operator-provisioned OpenShell client/gateway/image and mTLS configuration accessible to a dedicated non-root account. The worker's control key grants one enrolled yard, not controller administration.

Create a private JSON file of remote non-secret paths:

    {
      "OPENSHELL_BIN": "/usr/local/bin/openshell",
      "OPENSHELL_SANDBOX_IMAGE": "registry.example/laun-pi-agent@sha256:REVIEWED_DIGEST",
      "OPENSHELL_GATEWAY_ENDPOINT": "https://openshell.internal:17670",
      "XDG_CONFIG_HOME": "/etc/laun/worker-openshell"
    }

Then use the current authenticated controller target:

    bun run laun yard setup ssh ubuntu@yard.example -i /private/ssh_identity --name workshop --controller-url https://control.example --config /private/remote-yard.json --service-user laun-worker --json

The controller URL must be reachable from the yard; a workstation's loopback SSH tunnel usually is not. Remote control requires HTTPS. The default controller inference mode keeps provider credentials off the yard and has no silent local fallback.

Setup checks source and executable capability contracts before service launch, transfers the scoped key only through protected stdin/configuration, and waits for that yard's authenticated heartbeat. Current source can be transferred with unpublished JJ changes; an unpublished portable binary needs --source-dir or an explicit published HTTPS repository and exact revision. Install failure attempts to revoke only the newly enrolled yard and preserves private files for inspection.

An authenticated heartbeat establishes transport/capabilities. It does not by itself prove model, sandbox, tool or kernel enforcement. Assign a mower and explicitly qualify an isolated task. Existing threads stay on their bound yard until a reviewed checkpoint move; an unreachable host with unknown effects is not transparently replayed elsewhere.

## Telegram

Configure the bot token, numeric bot/user/group allowlists, a separate bridge credential and stable inbox-encryption key in protected installation configuration. Model and worker credentials do not belong in Telegram messages. Keep long polling; no webhook/Kubernetes service is required.

Use the app to mint a one-time account link code, then send it privately to the configured bot. Text messages follow the selected durable user/chat/topic thread; /new, /mowers, /thread, /delegate and /status use the same owner registry as the browser. Private and forum topics have independent routes. Editing a prior message does not change accepted work; attachments receive a text-only notice.

Revoke a link from the owner app/CLI before changing account routing. The bridge rechecks current route/lease authority after throttling and immediately before each send. A message already submitted to Telegram cannot be retracted by later revocation. Uncertain deliveries require explicit reconciliation/retry.

## Maintenance and recovery

Use yard drain before maintenance. Stable-ID key rotation requires confirmed stopped execution and a reviewed credential version; fresh authenticated metadata is needed before resume. Do not copy a key to an unrelated host and assume its filesystem copies are tracked.

Follow the [backup](../docs/operations-backup.md), [cold upgrade/rollback](../docs/operations-upgrade.md), [thread lifecycle](../docs/operations-lifecycle.md), [legacy import](../docs/operations-legacy-import.md) and [retention](../docs/operations-retention.md) runbooks. Restored authority is inert until explicitly renewed. Controller-history removal and each host-copy deletion have separate owner confirmations.

Supported local evidence and outstanding external-host qualification are recorded in [core status](../docs/core-status.md). Upstream release sources: [Pi](https://github.com/earendil-works/pi/releases) and [OpenShell](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.8).
