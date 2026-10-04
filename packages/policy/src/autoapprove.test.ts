// Scoped auto-approval: network egress proposals may auto-approve while
// filesystem/process proposals stay held for review (roadmap P0 #3a).
//
// The scoping lives SCRIPT-SIDE (deploy/openshell/install-and-verify.sh:
// --approval-mode at sandbox create + `rule get` audit), never as policy
// YAML -- OpenShell rejects unknown keys and validatePolicy enforces the same
// allowlist, so no YAML knob exists for this. These tests pin that split:
// YAML must not grow an approval knob (validator rejects it, templates carry
// none), and the script's --dry-run must expose the flag + audit surface
// without ever printing key material. No network, no real openshell needed:
// --dry-run exits before any openshell call. Secrets: TEST-ONLY sentinels.
import { describe, expect, test } from "bun:test";
import {
  listOpenShellTemplates,
  renderOpenShellPolicy,
  validatePolicy,
} from "./openshell.js";

const VARS = { WORKDIR: "/workspace", MODEL_HOST: "model.example.com" };
const SCRIPT = new URL(
  "../../../deploy/openshell/install-and-verify.sh",
  import.meta.url,
).pathname;

function dryRun(extraEnv: Record<string, string>): { code: number | null; out: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, "--dry-run"], {
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout == null ? "" : proc.stdout.toString();
  const stderr = proc.stderr == null ? "" : proc.stderr.toString();
  return { code: proc.exitCode, out: `${stdout}\n${stderr}` };
}

describe("auto-approval scoping stays out of policy YAML", () => {
  test("validator rejects invented auto-approval top-level keys", () => {
    const base = renderOpenShellPolicy("restrictive", VARS);
    for (const key of ["autoApproval", "auto_approval"]) {
      const doctored = base.replace("version: 1", `version: 1\n${key}: { network: allow }`);
      expect(validatePolicy(doctored)).toContainEqual(
        expect.stringContaining("unknown top-level"),
      );
    }
  });

  test("rendered templates carry no approval knobs", () => {
    for (const name of listOpenShellTemplates()) {
      expect(renderOpenShellPolicy(name, VARS)).not.toMatch(/approv/i);
    }
  });
});

describe("bring-up dry-run (no openshell, no network)", () => {
  test("dry-run keeps the summary contract, provider skipped without a key", () => {
    const { code, out } = dryRun({ MODEL_API_KEY: "", MODEL_HOST: "model.example.com" });
    expect(code).toBe(0);
    for (const key of [
      "OS_SANDBOX=",
      "OS_PROVIDER=none",
      "OS_POLICY=",
      "OS_GATEWAY=",
      "OS_PROBE=",
      "OS_APPROVAL_MODE=",
      "OS_GRANTED=",
    ]) {
      expect(out).toContain(key);
    }
    // The script-side scoping surface is visible in the plan...
    expect(out).toContain("--approval-mode");
    expect(out).toContain("rule get");
    // ...and the unset key keeps today's skip path.
    expect(out).toContain("MODEL_API_KEY is unset (provider step will skip)");
  });

  test("provider attach path never prints key material (TEST-ONLY sentinel)", () => {
    const sentinel = "TEST-ONLY-SENTINEL-abc123";
    const { code, out } = dryRun({
      MODEL_API_KEY: sentinel,
      MODEL_HOST: "model.example.com",
    });
    expect(code).toBe(0);
    expect(out).toContain("OS_PROVIDER=laun-model");
    expect(out).toContain("MODEL_API_KEY is set (value hidden)");
    expect(out).not.toContain(sentinel);
  });

  test("MODEL_PROVIDER override renames the instance", () => {
    const { code, out } = dryRun({
      MODEL_API_KEY: "TEST-ONLY-SENTINEL-abc123",
      MODEL_PROVIDER: "TEST-ONLY-provider-x",
      MODEL_HOST: "model.example.com",
    });
    expect(code).toBe(0);
    expect(out).toContain("OS_PROVIDER=TEST-ONLY-provider-x");
  });

  test("OS_APPROVAL_MODE=none surfaces in the plan", () => {
    const { code, out } = dryRun({
      MODEL_API_KEY: "",
      MODEL_HOST: "model.example.com",
      OS_APPROVAL_MODE: "none",
    });
    expect(code).toBe(0);
    expect(out).toContain("OS_APPROVAL_MODE=none");
  });
});
