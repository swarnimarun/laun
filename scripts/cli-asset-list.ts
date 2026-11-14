/** Only public deployment templates; never include an installation's .env, identities or data. */
export const CLI_ASSET_PATHS = [
  "deploy/.env.example",
  "deploy/bootstrap.sh",
  "deploy/controller-contract.js",
  "deploy/install-bun.sh",
  "deploy/compose-profile.sh",
  "deploy/docker-compose.yml",
  "deploy/docker-compose.openshell.yml",
  "deploy/Caddyfile",
  "deploy/openshell/install-cli.sh",
  "deploy/openshell/install-and-verify.sh",
  "deploy/openshell/policy.yaml",
  "deploy/openshell/provider-model.yaml",
  "apps/laun/src/compose-profile.ts",
] as const;
