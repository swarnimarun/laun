# OpenShell policy notes

`packages/policy/templates/` ships two starting points:

* `restrictive` — workdir-only fs, model-host-only network, no credential passthrough. **Default. Start here.**
* `standard-dev` — adds github/npm/pypi egress. Per-repo, only after review.

## Render a template for a session

```bash
WORKDIR=/data/sessions/<id>/work MODEL_HOST=openrouter.ai \
  bun packages/policy/src/render.ts restrictive
```

## Apply on the VPS (OpenShell version-dependent — confirm with `openshell --help`)

1. `openshell sandbox create --name agent`
2. Translate the rendered JSON into your OpenShell policy file(s) for that sandbox.
3. Run `openshell policy advisor` / `prover` (names per your version) and review the diff:
   new hosts reached with credentials and new API methods must wait for your approval.
4. Set in `.env`:
   ```
   OPENSHELL_ENABLED=true
   OPENSHELL_PREFIX=<your openshell exec prefix, e.g. openshell exec --sandbox agent>
   ```
   The executor prepends this prefix to every `pi` invocation. If the var is
   empty while enabled, the executor refuses to start (fail closed).

## Rules of thumb

* Keys (XAI/OpenRouter/GitHub) live on the host/gateway env, never in the sandbox.
* One sandbox per sensitivity level; don't reuse the dev sandbox for personal data.
* Telegram approvals in cloudbear v1 are acknowledge-style (logged + broadcast).
  Hard blocking happens here, at the policy layer: deny-by-default + prover review.
