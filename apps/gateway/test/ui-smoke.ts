import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBrowserFixture } from "./fixture.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const fixture = process.env.LAUN_UI_URL
  ? undefined
  : await startBrowserFixture(repoRoot);
const base = process.env.LAUN_UI_URL || fixture!.url;
const key: string =
  process.env.LAUN_UI_KEY ||
  fixture?.key ||
  (await Bun.file(join(repoRoot, ".laun-local/access.json")).json()).key;
if (!key)
  throw new Error(
    "Set LAUN_UI_KEY or create .laun-local/access.json with the local startup helper",
  );
let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath && existsSync("/nix/store")) {
  const candidates = await Array.fromAsync(
    new Bun.Glob("*chromium*/bin/chromium").scan({
      cwd: "/nix/store",
      absolute: true,
    }),
  );
  executablePath = candidates.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )[0];
}
const browser = await chromium
  .launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  })
  .catch(async (error) => {
    await fixture?.close();
    throw error;
  });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const failures: string[] = [];
page.on("pageerror", (error) =>
  failures.push(error.message.replaceAll(key, "[KEY]")),
);
const stamp = Date.now().toString(36);
const mowerName = `Clover ${stamp}`;
const threadTitle = `Browser garden ${stamp}`;
const profileName = `Careful gardener ${stamp}`;
const screenshotDir = process.env.LAUN_UI_SHOTS || "/tmp/laun-ui-shots";
await mkdir(screenshotDir, { recursive: true });
const checks: string[] = [];
const waitHidden = async (selector: string) =>
  page.locator(selector).waitFor({ state: "hidden", timeout: 20_000 });
const closeDialog = async () => {
  if (await page.locator("#modal").isVisible())
    await page.locator("#modal-close").click();
};
const getState = async () => {
  const response = await context.request.get(`${base}/api/v2/state`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert(response.ok(), "authenticated state is readable");
  return response.json();
};
const chooseTab = async (name: string) => {
  if (!(await page.locator("#inspector").isVisible()))
    await page.locator("#inspector-toggle").click();
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
};
const createMower = async (name: string, role = "mower", workerId?: string) => {
  await page.locator("#new-mower-button").click();
  await page.locator("#field-name").fill(name);
  await page
    .locator("#field-model")
    .fill(process.env.LAUN_UI_MODEL || "faux/faux-1");
  await page.locator("#field-role").selectOption(role);
  if (workerId) await page.locator("#field-worker").selectOption(workerId);
  await page.locator("#modal-submit").click();
  await waitHidden("#modal");
  return (await getState()).mowers.find(
    (m: { name: string }) => m.name === name,
  );
};
const createThread = async (title: string, mowerId: string, goal = "") => {
  await page.locator("#new-thread-button").click();
  await page.locator("#field-title").fill(title);
  await page.locator("#field-mower").selectOption(mowerId);
  if (goal) await page.locator("#field-goal").fill(goal);
  await page.locator("#modal-submit").click();
  await waitHidden("#modal");
  await page
    .locator("#thread-title")
    .filter({ hasText: title })
    .waitFor({ state: "visible" });
  return (await getState()).threads.find(
    (t: { title: string }) => t.title === title,
  );
};
const openThread = async (threadId: string) => {
  await page.evaluate((id) => {
    location.hash = `#/threads/${id}`;
  }, threadId);
  await page.waitForFunction((id) => location.hash.endsWith(id), threadId);
  await page.locator("#composer").waitFor({ state: "visible" });
};
const messageVisible = async (text: string) =>
  page
    .locator("#messages .message.user .message-content")
    .filter({ hasText: text })
    .waitFor({ state: "visible", timeout: 20_000 });

try {
  await page.goto(`${base}/app`, { waitUntil: "networkidle" });
  await page.screenshot({
    path: `${screenshotDir}/welcome.png`,
    fullPage: true,
  });
  await page.locator("#auth-key").fill(key);
  await page
    .locator("#login-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await page
    .locator("#workspace")
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({
    path: `${screenshotDir}/workspace-empty.png`,
    fullPage: true,
  });
  checks.push("authenticated login");

  const mower = await createMower(mowerName, "director");
  assert(mower?.id, "named director was created");
  checks.push("named director creation");
  const thread = await createThread(
    threadTitle,
    mower.id,
    "Hello from the browser smoke test. Reply with a short greeting.",
  );
  await page
    .locator(".message.user")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  if (process.env.LAUN_UI_EXPECT_ANSWER !== "false")
    await page
      .locator(".message.assistant .message-content")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
  await page
    .locator("#message-input")
    .fill("This follow-up should remain in this durable thread.");
  await page.locator("#send-button").click();
  await messageVisible("This follow-up should remain in this durable thread.");
  await page.screenshot({
    path: `${screenshotDir}/conversation-desktop.png`,
    fullPage: true,
  });
  checks.push("thread creation, answer and follow-up");
  if (fixture) {
    await page.locator("#thread-menu-button").click();
    await page
      .getByRole("button", { name: "Download last saved checkpoint" })
      .click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#modal-submit").click();
    const download = await downloadPromise;
    await waitHidden("#modal");
    const savedPath = await download.path();
    assert(savedPath, "checkpoint downloaded to browser storage");
    const archive = JSON.parse(await readFile(savedPath!, "utf8"));
    assert.equal(archive.threadId, thread.id);
    assert(
      archive.files.some((file: { path: string }) =>
        file.path.startsWith("session/"),
      ),
    );
    assert(
      !JSON.stringify(archive).includes(key),
      "controller credential absent from checkpoint export",
    );
    checks.push(
      "owner checkpoint download includes durable state without controller key",
    );
  }

  await chooseTab("Permissions");
  await page
    .locator("#inspector-content .inspector-section")
    .filter({ has: page.getByRole("heading", { name: "Permission profiles" }) })
    .locator("button.icon-button")
    .click();
  await page.locator("#field-profile-name").fill(profileName);
  await page.locator("#field-profile-mode").selectOption("auto");
  for (const [operation, effect] of [
    ["workspace.read", "allow"],
    ["workspace.write", "ask"],
    ["process.execute", "ask"],
  ]) {
    await page.getByRole("button", { name: "Add exact rule" }).click();
    const row = page.locator(".inline-rule").last();
    await row.locator("select").first().selectOption(operation!);
    await row.locator("input").fill("workspace:own");
    await row.locator("select").last().selectOption(effect!);
  }
  await page.locator("#modal-submit").click();
  await waitHidden("#modal");
  const profileCard = page
    .locator("#inspector-content .item-card")
    .filter({ has: page.getByText(profileName, { exact: true }) });
  await profileCard.getByRole("button", { name: "Assign to mower" }).click();
  await page.locator("#field-mower").selectOption(mower.id);
  await page.locator("#modal-submit").click();
  await waitHidden("#modal");
  checks.push("exact-rule profile creation and explicit shared assignment");

  if (fixture) {
    const approvedThread = await createThread(
      `Reviewed write ${stamp}`,
      mower.id,
      "UI_APPROVE_WRITE",
    );
    await chooseTab("Permissions");
    const approvedCard = page.locator("#inspector-content .item-card").filter({
      has: page.locator(".approval-detail").filter({ hasText: "approved.txt" }),
    });
    await approvedCard.waitFor({ state: "visible", timeout: 20_000 });
    assert(
      (await approvedCard.locator(".approval-detail").textContent())?.includes(
        "approved.txt",
      ),
      "exact file action is visible before approval",
    );
    await page.screenshot({
      path: `${screenshotDir}/approval-context.png`,
      fullPage: true,
    });
    await approvedCard
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await page
      .locator("#messages .message.assistant .message-content")
      .filter({ hasText: "The reviewed write completed." })
      .waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(
      await readFile(
        join(
          fixture.directory,
          "threads",
          approvedThread.id,
          "work",
          "approved.txt",
        ),
        "utf8",
      ),
      "approved by browser",
    );
    checks.push(
      "inspect exact action, allow once and verify real mediated file effect",
    );

    const deniedThread = await createThread(
      `Denied write ${stamp}`,
      mower.id,
      "UI_DENY_WRITE",
    );
    await chooseTab("Permissions");
    const deniedCard = page.locator("#inspector-content .item-card").filter({
      has: page.locator(".approval-detail").filter({ hasText: "denied.txt" }),
    });
    await deniedCard.waitFor({ state: "visible", timeout: 20_000 });
    const beforeAdvice = await getState();
    await deniedCard
      .getByRole("button", { name: "Discuss with Gatekeeper" })
      .click();
    const feedback =
      "Ask me before future writes; explain the reusable scope before I decide.";
    await page.locator("#field-advice-feedback").fill(feedback);
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    await page
      .locator("#thread-title")
      .filter({ hasText: "Permission advice" })
      .waitFor({ state: "visible" });
    const reviewAdvice = page
      .getByRole("button", { name: "Review guardrail proposal" })
      .last();
    await reviewAdvice.waitFor({ state: "visible", timeout: 20_000 });
    const adviceText = await page.locator("#messages").innerText();
    assert(adviceText.includes("Ask before future writes in this workspace"));
    assert(
      !adviceText.includes('"baseProfileId"'),
      "machine proposal identifiers stay in collapsed advanced details",
    );
    const afterAdvice = await getState();
    const adviser = afterAdvice.mowers.find(
      (item: { role: string }) => item.role === "adviser",
    );
    const adviserProfile = afterAdvice.profiles.find(
      (item: { id: string; version: number }) =>
        item.id === adviser.profileId &&
        item.version === adviser.profileVersion,
    );
    assert.equal(adviserProfile.mode, "isolated");
    assert.equal(
      adviserProfile.rules.length,
      0,
      "Gatekeeper has no operational authority",
    );
    assert.equal(
      afterAdvice.profiles.length,
      beforeAdvice.profiles.length,
      "model discussion does not create a profile revision",
    );
    assert.equal(
      afterAdvice.approvals.find(
        (item: { action: { threadId: string } }) =>
          item.action.threadId === deniedThread.id,
      ).status,
      "pending",
    );
    await reviewAdvice.click();
    await page
      .getByText("REVIEW PERMISSION PROPOSAL", { exact: true })
      .waitFor({ state: "visible" });
    await page.locator("#modal-close").click();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Review guardrail proposal" })
      .last()
      .waitFor({ state: "visible", timeout: 20_000 });
    await messageVisible(feedback);
    await page
      .getByRole("button", { name: "Return to original request ↗" })
      .last()
      .click();
    await page
      .locator("#thread-title")
      .filter({ hasText: `Denied write ${stamp}` })
      .waitFor({ state: "visible" });
    await chooseTab("Permissions");
    checks.push(
      "actual Gatekeeper model conversation, human result, durable reopen, typed review and no automatic grant",
    );
    await deniedCard.getByRole("button", { name: "Set guardrails" }).click();
    await page
      .locator("#field-feedback")
      .fill("Ask me before writing in this thread workspace.");
    await page.locator("#modal-submit").click();
    await page
      .getByText("REVIEW PERMISSION PROPOSAL", { exact: true })
      .waitFor({ state: "visible" });
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const deniedBefore = (await getState()).approvals.find(
      (a: { action: { threadId: string }; status: string }) =>
        a.action.threadId === deniedThread.id,
    );
    assert.equal(
      deniedBefore.status,
      "pending",
      "reviewed profile proposal did not approve pending action",
    );
    assert(
      !existsSync(
        join(
          fixture.directory,
          "threads",
          deniedThread.id,
          "work",
          "denied.txt",
        ),
      ),
      "proposal did not perform side effect",
    );
    await deniedCard
      .getByRole("button", { name: "Give direction", exact: true })
      .click();
    await page
      .locator("#field-denial-feedback")
      .fill(
        "Find a permitted read-only approach within the current guardrails.",
      );
    await page.locator("#field-denial-continuation").selectOption("replan");
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    await page
      .locator("#messages .message.assistant .message-content")
      .filter({ hasText: "The write was denied." })
      .waitFor({ state: "visible", timeout: 20_000 });
    assert(
      !existsSync(
        join(
          fixture.directory,
          "threads",
          deniedThread.id,
          "work",
          "denied.txt",
        ),
      ),
      "denied tool did not write file",
    );
    checks.push(
      "quick guardrail draft, reviewed revision, feedback asks guarded replan, no self-grant, deny blocks file effect",
    );
  }

  if (fixture) {
    await chooseTab("Connectors");
    await page
      .locator("#inspector-content .inspector-section")
      .first()
      .locator(".icon-button")
      .click();
    const connectionName = `Browser tools ${stamp}`;
    await page.locator("#field-connection-name").fill(connectionName);
    await page.locator("#field-connection-url").fill(fixture.mcpURL);
    await page.locator("#field-connection-local").check();
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const connectionCard = page
      .locator("#inspector-content .item-card")
      .filter({ has: page.getByText(connectionName, { exact: true }) });
    await connectionCard
      .getByRole("button", { name: "Discover tools" })
      .click();
    await connectionCard
      .getByText("1 tool", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    await connectionCard.getByText("Inspect tool identities").click();
    await connectionCard
      .locator(".resource-rule")
      .filter({ hasText: "browser_echo" })
      .waitFor({ state: "visible" });
    await connectionCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page.locator("#field-connection-enabled").uncheck();
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    await connectionCard
      .getByText("disabled", { exact: true })
      .waitFor({ state: "visible" });
    checks.push(
      "MCP connection, real broker catalog discovery, pinned tool identity, disable",
    );
  }

  await chooseTab("Yards");
  await page
    .locator("#inspector-content .inspector-section")
    .first()
    .locator(".icon-button")
    .click();
  const yardName = `Holding yard ${stamp}`;
  await page.locator("#field-worker-name").fill(yardName);
  await page.locator("#field-worker-capacity").fill("1");
  await page.locator("#modal-submit").click();
  await page
    .getByText("SAVE THIS KEY NOW", { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  const workerKey = await page
    .locator("#modal-fields .readonly-value")
    .textContent();
  assert(
    workerKey && workerKey !== key,
    "one-time worker credential displayed",
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert(
    !storage.includes(workerKey),
    "worker key not persisted in browser storage",
  );
  await closeDialog();
  const holdingWorker = (await getState()).workers.find(
    (w: { name: string }) => w.name === yardName,
  );
  checks.push(
    "distinct one-time worker credential with no browser persistence",
  );

  if (fixture) {
    const paused = await createMower(
      `Paused mower ${stamp}`,
      "mower",
      holdingWorker.id,
    );
    const pausedThread = await createThread(
      `Interrupted browser work ${stamp}`,
      paused.id,
      "Wait for explicit reconciliation.",
    );
    const workerRequest = async (method: string, data: unknown) => {
      const response = await context.request.post(
        `${base}/api/v2/worker/${method}`,
        { headers: { authorization: `Bearer ${workerKey}` }, data },
      );
      assert(response.ok(), `worker ${method} accepted`);
      return response.json();
    };
    const first = (await workerRequest("poll", { activeRunIds: [] })).job;
    assert.equal(first.thread.id, pausedThread.id);
    await workerRequest("interrupted", {
      runId: first.run.id,
      generation: first.run.generation,
      summary: "Test worker stopped before any external effect.",
    });
    await page
      .locator("#recovery-strip")
      .waitFor({ state: "visible", timeout: 20_000 });
    await page
      .locator("#message-input")
      .fill("This later message must remain queued during reconciliation.");
    await page.locator("#send-button").click();
    await messageVisible(
      "This later message must remain queued during reconciliation.",
    );
    assert.equal(
      (await workerRequest("poll", { activeRunIds: [] })).job,
      null,
      "later queued work cannot bypass interrupted attempt",
    );
    await page
      .locator("#recovery-strip")
      .getByRole("button", { name: "Review interrupted work" })
      .click();
    await page.locator("#modal-submit").click();
    assert(
      await page.locator("#modal").isVisible(),
      "confirmation required before resume",
    );
    assert.equal(
      (await getState()).runs.find(
        (run: { id: string }) => run.id === first.run.id,
      ).status,
      "interrupted",
    );
    await page.locator("#field-resume-confirmed").check();
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const resumed = (await workerRequest("poll", { activeRunIds: [] })).job;
    assert.equal(resumed.run.id, first.run.id);
    assert.equal(resumed.run.generation, first.run.generation + 1);
    await workerRequest("finish", {
      runId: resumed.run.id,
      generation: resumed.run.generation,
      status: "done",
      summary: "Explicitly reconciled request completed.",
    });
    const later = (await workerRequest("poll", { activeRunIds: [] })).job;
    assert.equal(
      later.run.prompt,
      "This later message must remain queued during reconciliation.",
    );
    await workerRequest("finish", {
      runId: later.run.id,
      generation: later.run.generation,
      status: "done",
      summary: "Later queued request completed.",
    });
    checks.push(
      "interrupted run holds later queue, requires explicit reconciliation, resumes fenced generation",
    );
    const lifecycleThread = await createThread(
      `Reviewed lifecycle ${stamp}`,
      paused.id,
    );
    const beforeLifecycle = await getState();
    const revision = beforeLifecycle.profiles
      .filter((profile: { name: string }) => profile.name === profileName)
      .sort(
        (a: { version: number }, b: { version: number }) =>
          b.version - a.version,
      )[0];
    await page.locator("#thread-menu-button").click();
    await page
      .getByRole("button", { name: "Rebase thread guardrails" })
      .click();
    await page
      .locator("#field-thread-profile")
      .selectOption(`${revision.id}:${revision.version}`);
    await page.locator("#modal-submit").click();
    assert(
      await page.locator("#modal").isVisible(),
      "profile rebase requires explicit confirmation",
    );
    await page.locator("#field-thread-profile-confirm").check();
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const rebased = (await getState()).threads.find(
      (item: { id: string }) => item.id === lifecycleThread.id,
    );
    assert.equal(rebased.profileId, revision.id);
    assert.equal(rebased.profileVersion, revision.version);
    assert(rebased.stoppedAt);
    await page.locator("#thread-menu-button").click();
    await page.getByRole("button", { name: "Move execution yard" }).click();
    await page.locator("#field-thread-move-yard").waitFor({ state: "visible" });
    await page.locator("#field-thread-move-yard").selectOption("local");
    await page.locator("#field-thread-move-confirm").check();
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const moved = (await getState()).threads.find(
      (item: { id: string }) => item.id === lifecycleThread.id,
    );
    assert.equal(moved.workerId, "local");
    assert(moved.placementId && moved.stoppedAt);
    assert(
      !(await getState()).runs.some(
        (run: { threadId: string }) => run.threadId === lifecycleThread.id,
      ),
      "lifecycle changes never replay or submit a prompt",
    );
    checks.push(
      "explicit pinned-profile rebase and idle yard move stay stopped without replay",
    );
  }

  if (fixture) {
    const helper = await createMower(
      `Moss ${stamp}`,
      "mower",
      holdingWorker.id,
    );
    const receiver = await createMower(`Fern ${stamp}`);
    await openThread(thread.id);
    await chooseTab("Tasks");
    await page
      .locator("#inspector-content .inspector-section")
      .first()
      .locator(".icon-button")
      .click();
    const goal = `Finish the delegated browser check ${stamp}`;
    await page.locator("#field-task-name").fill(`Browser delegation ${stamp}`);
    await page.locator("#field-task-mower").selectOption(helper.id);
    await page.locator("#field-task-goal").fill(goal);
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    const task = (await getState()).tasks.find(
      (t: { mowerId: string; parentThreadId: string }) =>
        t.mowerId === helper.id && t.parentThreadId === thread.id,
    );
    assert(task, "delegated task saved");
    const taskCard = page
      .locator("#inspector-content .item-card")
      .filter({ has: page.getByText(task.title, { exact: true }) });
    await taskCard.getByRole("button", { name: "Open thread" }).click();
    await page.locator("#thread-context").waitFor({ state: "visible" });
    await page
      .locator("#message-input")
      .fill("Direct user input to the delegated child.");
    await page.locator("#send-button").click();
    await messageVisible("Direct user input to the delegated child.");
    await page.locator("#thread-context").getByRole("button").click();
    await chooseTab("Tasks");
    await taskCard
      .getByRole("button", { name: "Hand off", exact: true })
      .click();
    await page.locator("#field-handoff-mower").selectOption(receiver.id);
    await page.locator("#modal-submit").click();
    await waitHidden("#modal");
    await page.waitForFunction(
      async ({ url, key, taskId, mowerId }) => {
        const response = await fetch(`${url}/api/v2/state`, {
          headers: { authorization: `Bearer ${key}` },
        });
        const data = await response.json();
        return data.tasks.some(
          (t: { id: string; mowerId: string; status: string }) =>
            t.id === taskId && t.mowerId === mowerId && t.status === "done",
        );
      },
      { url: base, key, taskId: task.id, mowerId: receiver.id },
      { timeout: 20_000 },
    );
    checks.push(
      "delegate task, directly message child, hand off to another mower, receive result",
    );
  }

  await chooseTab("Yards");
  const workerCard = page
    .locator("#inspector-content .item-card")
    .filter({ hasText: yardName });
  await workerCard.getByRole("button", { name: "Revoke worker" }).click();
  await page.locator("#modal-submit").click();
  await waitHidden("#modal");
  await workerCard
    .getByText("revoked", { exact: true })
    .waitFor({ state: "visible" });
  checks.push("worker revocation");
  await openThread(thread.id);
  if(fixture){
    const historyId=fixture.seedLongHistory();
    await page.goto(`${base}/app#/threads/${historyId}`,{waitUntil:"networkidle"});
    await messageVisible("History fixture marker 1999");
    assert.equal(await page.getByText("History fixture marker 0000",{exact:true}).count(),0);
    for(let i=0;i<3;i++){await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();await page.getByRole("button",{name:"Loading history…",exact:true}).waitFor({state:"hidden"});}
    await messageVisible("History fixture marker 0000");
    assert((await page.locator("#messages .message").count())<=1000,"browser keeps a bounded history window");
    await page.getByRole("button",{name:"Return to latest messages",exact:true}).click();await messageVisible("History fixture marker 1999");
    assert.equal(await page.getByText("History fixture marker 0000",{exact:true}).count(),0);
    checks.push("bounded newest/older durable history with an explicit return to live messages");
    await page.goto(`${base}/app#/threads/${thread.id}`,{waitUntil:"networkidle"});
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() =>
    document
      .getElementById("workspace")
      ?.classList.contains("inspector-hidden"),
  );
  await page.screenshot({
    path: `${screenshotDir}/conversation-mobile.png`,
    fullPage: true,
  });
  assert(await page.locator("#composer").isVisible());
  await page.locator("#sidebar-toggle").click();
  await page.locator("#thread-search").fill(threadTitle);
  await page.locator("#thread-list .thread-item").first().click();
  const threadUrl = page.url();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator("#workspace")
    .waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(page.url(), threadUrl);
  await messageVisible("This follow-up should remain in this durable thread.");
  checks.push("mobile navigation and durable deep-link reopen");
  assert.equal(failures.length, 0, `browser errors: ${failures.join("; ")}`);
  checks.push("zero browser page errors");
  console.log(
    JSON.stringify({
      ok: true,
      fixture: !!fixture,
      checks,
      screenshots: screenshotDir,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await fixture?.close();
}
