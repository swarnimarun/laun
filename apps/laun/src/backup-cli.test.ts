import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "@laun/control";
import { main, type Io } from "./index.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
test("offline backup CLI preserves owner data and restores inertly without a network target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "laun-cli-backup-"));
  directories.push(directory);
  const data = join(directory, "source"),
    backup = join(directory, "backup"),
    target = join(directory, "restored");
  await mkdir(data);
  const p = { id: `user_${"a".repeat(32)}`, admin: false },
    store = new ControlStore(join(data, "control.sqlite"));
  const mower = store.createMower(p, { name: "Retained" }),
    thread = store.createThread(p, {
      mowerId: mower.id,
      title: "Saved thread",
    });
  store.submit(p, thread.id, {
    text: "Do not blindly replay",
    requestId: "saved-input",
  });
  store.close();
  const output: string[] = [],
    errors: string[] = [];
  const io: Io = {
    out: (value) => output.push(value),
    err: (value) => errors.push(value),
    write: (value) => output.push(value),
  };
  expect(
    await main(
      ["backup", "create", "--data-dir", data, "--out", backup],
      { HOME: directory },
      io,
    ),
  ).toBe(2);
  expect(errors.join(" ")).toContain("Stop the controller");
  expect(
    await main(
      [
        "backup",
        "create",
        "--data-dir",
        data,
        "--out",
        backup,
        "--confirmed-offline",
        "--json",
      ],
      { HOME: directory },
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.at(-1)!).scope).toBe("laun-v2-control");
  expect((await stat(join(backup, "control.sqlite"))).mode & 0o777).toBe(0o600);
  expect(
    await main(
      [
        "backup",
        "restore",
        backup,
        "--to",
        target,
        "--confirmed-offline",
        "--json",
      ],
      { HOME: directory },
      io,
    ),
  ).toBe(0);
  const restored = JSON.parse(output.at(-1)!);
  expect(restored.principals).toContainEqual({ principalId: p.id, keyIds: [] });
  expect(restored.safety.interruptedRuns).toBe(1);
  const reopened = new ControlStore(join(target, "control.sqlite"));
  try {
    expect(reopened.runs(p)[0]!.status).toBe("interrupted");
    expect(reopened.get("mower", mower.id, p)).toBeDefined();
  } finally {
    reopened.close();
  }
  expect(
    await main(
      ["backup", "restore", backup, "--to", target, "--confirmed-offline"],
      { HOME: directory },
      io,
    ),
  ).toBe(1);
  expect(await readFile(join(backup, "manifest.json"), "utf8")).not.toContain(
    "GATEWAY_TOKEN",
  );
});
