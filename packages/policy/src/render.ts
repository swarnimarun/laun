// Render a policy template to stdout.
// Usage: WORKDIR=/data/sessions/<id>/work MODEL_HOST=YOUR_MODEL_HOST bun packages/policy/src/render.ts restrictive
import { loadTemplate, renderTemplate } from "./index.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: render.ts <template> (vars via env: WORKDIR, MODEL_HOST)");
  process.exit(1);
}
const tpl = loadTemplate(name);
const rendered = renderTemplate(tpl, {
  WORKDIR: process.env["WORKDIR"] ?? "",
  MODEL_HOST: process.env["MODEL_HOST"] ?? "",
});
console.log(JSON.stringify(rendered, null, 2));
