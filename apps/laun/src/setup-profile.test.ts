import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureEnv,
  readEnvValue,
  setupComposeFiles,
  upsertEnv,
} from "./setup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const compose = resolve(import.meta.dir, "../../../deploy/docker-compose.yml");
const script = resolve(import.meta.dir, "../../../deploy/compose-profile.sh");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "laun-profile-"));
  dirs.push(dir);
  const mtls = join(dir, "gateways", "openshell", "mtls");
  mkdirSync(mtls, { recursive: true });
  for (const name of ["ca.crt", "tls.crt", "tls.key"])
    writeFileSync(join(mtls, name), "fixture, not a credential");
  return dir;
}

describe("installation profile selection", () => {
  test("explicit data bindings require existing private real directories before compose selection", () => {
    const dir = fixture(),
      data = join(dir, "restore");
    mkdirSync(data, { mode: 0o700 });
    expect(
      setupComposeFiles(
        `LAUN_DATA_DIR=${data}\nOPENSHELL_ENABLED=false`,
        compose,
        {},
      ),
    ).toEqual(["-f", compose]);
    for (const value of [
      "/",
      "/etc/laun",
      "relative",
      "${HOME}/restore",
      join(dir, "missing"),
    ])
      expect(() =>
        setupComposeFiles(
          `LAUN_DATA_DIR=${value}\nOPENSHELL_ENABLED=false`,
          compose,
          {},
        ),
      ).toThrow("LAUN_DATA_DIR");
    const link = join(dir, "linked");
    symlinkSync(data, link);
    expect(() =>
      setupComposeFiles(`LAUN_DATA_DIR=${link}`, compose, {}),
    ).toThrow("symlinks");
    chmodSync(data, 0o755);
    expect(() =>
      setupComposeFiles(`LAUN_DATA_DIR=${data}`, compose, {}),
    ).toThrow("private");
  });
  test("fresh VPS env defaults to isolation, local stays off, explicit trusted config survives", () => {
    const dir = fixture();
    const template = resolve(import.meta.dir, "../../../deploy/.env.example");
    const remote = ensureEnv(join(dir, "remote.env"), template, {
      openshellEnabled: true,
    });
    const local = ensureEnv(join(dir, "local.env"), template);
    expect(readEnvValue(remote.content, "OPENSHELL_ENABLED")).toBe("true");
    expect(readEnvValue(local.content, "OPENSHELL_ENABLED")).toBe("false");
    expect(() => setupComposeFiles("", compose, {}, true)).toThrow(
      "OPENSHELL_CONFIG_DIR",
    );
    expect(setupComposeFiles("", compose, {})).toEqual(["-f", compose]);
    const file = join(dir, "existing.env");
    writeFileSync(
      file,
      'export OPENSHELL_ENABLED="false" # trusted mode\nGATEWAY_TOKEN=keep-me\n',
    );
    const existing = ensureEnv(file, template, { openshellEnabled: true });
    expect(readEnvValue(existing.content, "OPENSHELL_ENABLED")).toBe("false");
    expect(existing.token).toBe("keep-me");
    expect(
      upsertEnv('export OPENSHELL_ENABLED="false"', {
        OPENSHELL_ENABLED: "true",
      }),
    ).toBe('export OPENSHELL_ENABLED="false"');
  });

  test("local mode does not require OpenShell files or forward a stale SDK endpoint", () => {
    expect(
      setupComposeFiles(
        "OPENSHELL_ENABLED=false\nOPENSHELL_SDK_GATEWAY=https://stale.invalid",
        compose,
        {},
      ),
    ).toEqual(["-f", compose]);
  });

  test("requested isolation requires its host identity and never falls back", () => {
    expect(() =>
      setupComposeFiles("OPENSHELL_ENABLED=true", compose, {}),
    ).toThrow("OPENSHELL_CONFIG_DIR");
    expect(() =>
      setupComposeFiles("OPENSHELL_ENABLED=tru", compose, {}),
    ).toThrow("true or false");
    const dir = fixture();
    const content = `OPENSHELL_ENABLED=true\nOPENSHELL_CONFIG_DIR=${dir}\nOPENSHELL_PROVIDER=laun-model`;
    expect(setupComposeFiles(content, compose, {})).toEqual([
      "-f",
      compose,
      "-f",
      resolve(import.meta.dir, "../../../deploy/docker-compose.openshell.yml"),
    ]);
    rmSync(join(dir, "gateways", "openshell", "mtls", "tls.key"));
    expect(() => setupComposeFiles(content, compose, {})).toThrow("tls.key");
  });
  test("legacy executor requires an explicit strict boolean profile selection", () => {
    expect(
      setupComposeFiles(
        "OPENSHELL_ENABLED=false\nLAUN_LEGACY_API=true",
        compose,
        {},
      ),
    ).toEqual(["--profile", "legacy", "-f", compose]);
    expect(() =>
      setupComposeFiles(
        "OPENSHELL_ENABLED=false\nLAUN_LEGACY_API=tru",
        compose,
        {},
      ),
    ).toThrow("LAUN_LEGACY_API must be true or false");
  });

  test("shell installer and CLI select the same modes, with strict failures", () => {
    const dir = fixture();
    const envFile = join(dir, "install.env");
    const select = (content: string, defaultMode = "false") => {
      writeFileSync(envFile, content);
      return Bun.spawnSync(
        [
          "bash",
          "-c",
          'set -euo pipefail; source "$1"; laun_compose_profile "$2" "$3" "$4"; printf "%s\\n" "${LAUN_COMPOSE_FILES[@]}"',
          "profile-test",
          script,
          envFile,
          compose,
          defaultMode,
        ],
        { env: { PATH: process.env.PATH ?? "/bin:/usr/bin" } },
      );
    };
    const local = select("OPENSHELL_ENABLED=false");
    expect(local.exitCode).toBe(0);
    expect(local.stdout.toString().trim().split("\n")).toEqual(
      setupComposeFiles("OPENSHELL_ENABLED=false", compose, {}),
    );
    const isolated = `OPENSHELL_ENABLED=true\nOPENSHELL_CONFIG_DIR=${dir}\nOPENSHELL_PROVIDER=laun-model`;
    const result = select(isolated);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual(
      setupComposeFiles(isolated, compose, {}),
    );
    expect(select("OPENSHELL_ENABLED=true").exitCode).not.toBe(0);
    expect(select("", "true").exitCode).not.toBe(0);
    expect(select("OPENSHELL_ENABLED=false", "true").exitCode).toBe(0);
    const quoted = `export OPENSHELL_ENABLED="true" # isolated\nOPENSHELL_CONFIG_DIR='${dir}'\nOPENSHELL_PROVIDER="laun-model"`;
    expect(select(quoted).exitCode).toBe(0);
    expect(setupComposeFiles(quoted, compose, {})).toHaveLength(4);
    const embeddedCredentials = `${isolated}\nOPENSHELL_SDK_GATEWAY="https://user:secret@host.invalid:17670"`;
    expect(select(embeddedCredentials).exitCode).not.toBe(0);
    expect(() => setupComposeFiles(embeddedCredentials, compose, {})).toThrow(
      "without credentials",
    );
    const interpolation = `${isolated}\nOPENSHELL_CONFIG_DIR=\u0024{HOME}/.config/openshell`;
    expect(select(interpolation).exitCode).not.toBe(0);
    expect(() => setupComposeFiles(interpolation, compose, {})).toThrow(
      "without interpolation",
    );
  });
});
