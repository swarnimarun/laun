import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatAgentKey } from "../packages/protocol/src/index.js";

// Standalone bootstrap: pull-only installs have no workspace node_modules yet.
// Exclusive creation also prevents accidentally rotating an existing inbox key.
let content = readFileSync(new URL("./.env.example", import.meta.url), "utf8");
for (const [name, value] of Object.entries({
  GATEWAY_TOKEN: randomBytes(32).toString("base64url"),
  LAUN_KEY: formatAgentKey(randomBytes(4).toString("hex"), randomBytes(32).toString("base64url")),
  LAUN_TELEGRAM_BRIDGE_TOKEN: randomBytes(32).toString("base64url"),
  BRIDGE_INBOX_KEY: randomBytes(32).toString("base64url"),
  OPENSHELL_ENABLED: "true",
})) content = content.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);
writeFileSync(".env", content, { flag: "wx", mode: 0o600 });
