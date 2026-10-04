// Render a policy template to stdout.
// Usage: WORKDIR=/workspace MODEL_HOST=openrouter.ai bun packages/policy/src/render.ts restrictive [--target openshell|abstract]
//
// --target openshell (default): emit real, appliable OpenShell YAML and
//   validate it before printing. Failing closed: exit non-zero with the
//   reason when the rendered policy is invalid or vars are missing.
// --target abstract: emit the legacy JSON dialect (for tooling that still
//   consumes it). Not appliable to OpenShell.
import { loadTemplate, renderOpenShellPolicy, renderTemplate } from "./index.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: render.ts <template> [--target openshell|abstract] (vars via env: WORKDIR, MODEL_HOST)");
  process.exit(1);
}

let target = "openshell";
for (const arg of process.argv.slice(3)) {
  if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
  else if (arg === "--target") {
    const i = process.argv.indexOf(arg);
    target = process.argv[i + 1] ?? "";
  } else if (arg === "openshell" || arg === "abstract") target = arg;
  else {
    console.error(`unknown argument: ${arg} (expected --target openshell|abstract)`);
    process.exit(1);
  }
}

const vars = {
  WORKDIR: process.env["WORKDIR"] ?? "",
  MODEL_HOST: process.env["MODEL_HOST"] ?? "",
};

try {
  if (target === "openshell") {
    process.stdout.write(renderOpenShellPolicy(name, vars) + "\n");
  } else if (target === "abstract") {
    const tpl = loadTemplate(name);
    const rendered = renderTemplate(tpl, vars);
    console.log(JSON.stringify(rendered, null, 2));
  } else {
    console.error(`unknown target: ${target} (expected openshell|abstract)`);
    process.exit(1);
  }
} catch (err) {
  console.error(`render failed: ${(err as Error).message}`);
  process.exit(1);
}
