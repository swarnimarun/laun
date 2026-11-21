/** Browser layout regression checks. Visual hierarchy still needs screenshot review. */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { chromium, type Locator } from "playwright";
import { DEMO_PROMPTS } from "../../../packages/runtime/test/demo-fixture.js";
import { startDemoFixture } from "./demo-fixture.js";

let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath && existsSync("/nix/store")) {
  const candidates = await Array.fromAsync(
    new Bun.Glob("*chromium*/bin/chromium").scan({ cwd: "/nix/store", absolute: true }),
  );
  executablePath = candidates.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )[0];
}
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const fixture = await startDemoFixture().catch(async (error) => {
  await browser.close();
  throw error;
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.replaceAll(fixture.key, "[KEY]")));
  const compact = [
    { width: 320, height: 568 },
    { width: 390, height: 667 },
  ];
  const desktop = { width: 1440, height: 900 };
  const landscape = { width: 667, height: 375 };
  const noHorizontalOverflow = async () => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `document fits ${JSON.stringify(page.viewportSize())}`);
  };
  const bounds = async (locator: Locator) => {
    const rect = await locator.boundingBox();
    assert(rect && rect.width > 0 && rect.height > 0, `${locator} has rendered bounds`);
    return rect;
  };
  const inViewport = async (locator: Locator) => {
    const { x, y, width, height } = await bounds(locator);
    const viewport = page.viewportSize()!;
    assert(x >= -0.5 && y >= -0.5 && x + width <= viewport.width + 0.5
      && y + height <= viewport.height + 0.5,
    `${locator} fits ${JSON.stringify(viewport)} at ${JSON.stringify({ x, y, width, height })}`);
  };
  const hit = async (locator: Locator, minimum: number) => {
    await inViewport(locator);
    const { width, height } = await bounds(locator);
    assert(width >= minimum && height >= minimum, `${locator} has a ${minimum}px hit area`);
    assert(await locator.evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }), `${locator} is reachable at its center`);
  };
  const resize = async (viewport: { width: number; height: number }) => {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    if (await page.locator("#workspace").isVisible()) {
      const layout = viewport.width >= 1200 ? "wide" : viewport.width >= 800 ? "medium" : "compact";
      await page.locator(`#workspace[data-layout="${layout}"]`).waitFor();
    }
  };
  const choose = async (name: string) => {
    if (!await page.locator("#inspector").isVisible()) await page.locator("#inspector-toggle").click();
    await page.getByRole("tab", { name, exact: false }).click();
  };

  await page.goto(`${fixture.url}/app`);
  await page.evaluate(() => document.fonts.ready);
  assert(await page.evaluate(() => document.fonts.check("16px Newsreader")
    && document.fonts.check('14px "DM Sans"')), "workspace fonts loaded");
  for (const viewport of [...compact, { width: 768, height: 768 }, desktop]) {
    await resize(viewport);
    await noHorizontalOverflow();
    await hit(page.locator("#connect-button"), 40);
    await inViewport(page.locator("#login-origin"));
  }
  await resize(landscape);
  await page.locator("#login-origin").scrollIntoViewIfNeeded();
  await inViewport(page.locator("#login-origin"));
  await resize(desktop);
  await page.locator("#auth-key").fill(fixture.key);
  await page.locator("#connect-button").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  assert(await page.locator(".empty-art img").evaluate((img: HTMLImageElement) =>
    img.complete && img.naturalWidth > 0), "empty-state art loaded");

  await page.locator("#workspace-info").click();
  await page.getByRole("button", { name: "Set up primary Groundskeeper", exact: true }).click();
  await page.locator("#field-setup-name").fill("Groundskeeper");
  await page.locator("#field-setup-title").fill("Release garden");
  await page.locator("#field-setup-model").selectOption("faux/faux-1");
  await page.locator("#field-setup-yard").selectOption("local");
  await page.locator("#modal-submit").click();
  await page.locator("#field-setup-write").waitFor({ state: "visible" });
  const dialogFields = page.locator("#modal-fields");
  const submit = page.locator("#modal-submit");
  const cancel = page.locator("#modal-cancel");
  const saveDialog = async () => {
    await submit.click();
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#modal")?.open
      || document.querySelector("#modal-error")?.textContent?.trim());
    assert(!await page.locator("#modal").isVisible(),
      (await page.locator("#modal-error").textContent())?.replaceAll(fixture.key, "[KEY]"));
  };
  for (const viewport of [...compact, landscape, { width: 1024, height: 768 }, desktop]) {
    await resize(viewport);
    await noHorizontalOverflow();
    await hit(submit, 40);
    await hit(cancel, 40);
    await inViewport(page.locator("#modal-title"));
    const select = page.locator("#field-setup-mode");
    for (const mode of ["auto", "isolated", "manual"]) {
      await select.selectOption(mode);
      const clipped = await dialogFields.locator("select").evaluateAll((nodes) => {
        const canvas = document.createElement("canvas").getContext("2d")!;
        return nodes.flatMap((node) => {
          if (!(node instanceof HTMLSelectElement)) return [];
          const style = getComputedStyle(node);
          canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const text = node.selectedOptions[0].text;
          const available = node.clientWidth - parseFloat(style.paddingLeft)
            - parseFloat(style.paddingRight) - (style.appearance === "none" ? 0 : 20);
          return canvas.measureText(text).width > available ? [text] : [];
        });
      });
      assert.deepEqual(clipped, [], `selected guardrails fit at ${viewport.width}px`);
    }
    await dialogFields.evaluate((fields) => { fields.scrollTop = fields.scrollHeight; });
    await hit(submit, 40);
    await hit(cancel, 40);
    await inViewport(page.locator("#modal-title"));
  }
  await submit.click();
  await saveDialog();
  const title = page.locator("#thread-title");
  await title.filter({ hasText: "Release garden" }).waitFor({ state: "visible" });

  const input = page.locator("#message-input");
  const send = async (message: string) => {
    await input.fill(message);
    await page.locator("#send-button").click();
  };
  const answers = page.locator("#messages .message.assistant .message-content");
  await send(DEMO_PROMPTS.plan);
  await answers.filter({ hasText: "A small plan with clear owners" }).waitFor();
  await page.locator("#new-mower-button").click();
  await page.locator("#field-name").fill("Clover");
  await page.locator("#field-model").fill("faux/faux-1");
  await page.locator("#field-profile").selectOption({ label: "Groundskeeper guardrails · v1 · manual" });
  await saveDialog();
  await choose("Tasks");
  await page.getByRole("button", { name: "Delegate a task", exact: false }).click();
  await page.locator("#field-task-name").fill("Review the release plan");
  await page.locator("#field-task-mower").selectOption({ label: "Clover" });
  await page.locator("#field-task-goal").fill(DEMO_PROMPTS.review);
  await saveDialog();
  await page.locator("#thread-list .thread-item").filter({ hasText: "Review the release plan" }).click();
  await title.filter({ hasText: "Review the release plan" }).waitFor();
  await answers.filter({ hasText: "Release review" }).waitFor();
  await send(DEMO_PROMPTS.followup);
  await answers.filter({ hasText: "Before a real VPS rollout" }).waitFor();

  const messages = page.locator("#messages");
  const jump = page.locator("#jump-latest");
  const composer = page.locator("#composer");
  const tablist = page.getByRole("tablist");
  for (const viewport of [...compact, landscape]) {
    await resize(viewport);
    await noHorizontalOverflow();
    const reading = await bounds(messages);
    assert(reading.height >= viewport.height * 0.46,
      `compact conversation has ${reading.height}px at ${viewport.width}×${viewport.height}`);
    assert(await title.evaluate((node) => node.scrollWidth <= node.clientWidth
      && node.scrollHeight <= node.clientHeight + 1), "delegated thread title fits");
    await hit(page.locator("#send-button"), 40);
    await hit(page.locator("#inspector-toggle"), 40);
    await messages.evaluate((node) => { node.scrollTop = 0; });
    await jump.waitFor({ state: "visible" });
    for (const draft of ["", "First line\nSecond line\nThird line\nFourth line"]) {
      await input.fill(draft);
      const [reading, latest, compose] = await Promise.all(
        [bounds(messages), bounds(jump), bounds(composer)],
      );
      assert(reading.y + reading.height <= latest.y + 1, "latest control stays outside messages");
      assert(latest.y + latest.height <= compose.y + 1, "latest control stays above composer");
      await hit(jump, 40);
    }
    await input.clear();
    await jump.click();
    await jump.waitFor({ state: "hidden" });
  }
  for (const width of [1440, 1201, 1200, 1199, 1024, 991, 990, 801, 800, 799, 681, 680]) {
    await resize({ width, height: 768 });
    await noHorizontalOverflow();
    assert((await bounds(messages)).width >= Math.min(568, width - 32),
      `conversation keeps its reading width at ${width}px`);
  }
  await resize(desktop);
  for (const selector of ["#new-mower-button", "#refresh-button", "#delivery-mode"]) {
    await hit(page.locator(selector), 40);
  }

  await page.locator("#new-thread-button").click();
  await page.locator("#field-title").fill("Release brief");
  await page.locator("#field-mower").selectOption({ label: "Groundskeeper · Director" });
  await page.locator("#field-goal").fill(DEMO_PROMPTS.write);
  await saveDialog();
  await title.filter({ hasText: "Release brief" }).waitFor();
  await choose("Permissions");
  const target = page.locator(".approval-target").filter({ hasText: "RELEASE_NOTES.md" });
  await target.waitFor({ state: "visible" });
  for (const viewport of [desktop, { width: 1024, height: 768 }, ...compact]) {
    await resize(viewport);
    await choose("Permissions");
    const card = page.locator(".item-card").filter({ has: target });
    const permissions = page.locator("#inspector-content");
    await permissions.evaluate((node) => { node.scrollTop = 0; });
    await noHorizontalOverflow();
    await inViewport(target);
    const tabs = tablist.getByRole("tab");
    const rows = await tabs.evaluateAll((nodes) =>
      new Set(nodes.map((node) => node.getBoundingClientRect().top)).size);
    assert.equal(rows, 1, "inspector destinations remain on one row");
    for (const name of ["Allow once", "Deny", "Discuss with Gatekeeper"]) {
      await hit(card.getByRole("button", { name, exact: true }), 40);
    }
    const preview = card.locator(".approval-preview");
    assert.match(await preview.innerText(), /Laun release brief\s+[-•] Durable conversations/);
    const raw = card.locator(".approval-detail");
    assert(!await raw.isVisible(), "raw action starts collapsed");
    await card.locator("details summary").click();
    assert.match(await raw.textContent() ?? "", /RELEASE_NOTES.md/);
    await card.locator("details summary").click();
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#inspector-toggle").evaluate((node) => node === document.activeElement),
    true, "closing the detail drawer restores focus");
  assert.equal(await page.locator("#main-content").evaluate((node) => node instanceof HTMLElement && node.inert),
    false, "closing the detail drawer restores the conversation");
  const review = page.locator("#approval-strip").getByRole("button", { name: "Review request", exact: false });
  await review.click();
  await page.keyboard.press("Escape");
  assert(await review.evaluate((node) => node === document.activeElement),
    "closing the drawer restores the conversation's review button");

  assert.deepEqual(errors, [], "browser exceptions");
  console.log("Layout regressions passed for login, setup, populated threads and permission review in Chromium.");
} finally {
  try {
    await browser.close();
  } finally {
    await fixture.close();
  }
}
