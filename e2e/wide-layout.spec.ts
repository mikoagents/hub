import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { manualTriggerArtifact } from "./helpers/triggers.js";

const WIDTHS = [390, 1100, 1280, 1440, 1920, 2560];
const TRIGGER = "platform-infrastructure-health-check";

test("uses wide screens for overview columns and records while keeping narrow layouts contained", async ({
  hub,
  page,
}, testInfo) => {
  await hub.signUpAs("owner", {
    name: "Layout Owner",
    email: "layout-owner@example.com",
    password: "layout-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "platform-build-runner");
  await hub.deployCodeTrigger("owner", manualTriggerArtifact(TRIGGER, "platform-build-runner"));
  await hub.seedTriggerRun(TRIGGER, { minutesAgo: 1, status: "succeeded" });
  await page.reload();

  const recent = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Recent runs", exact: true }),
  });
  const daemons = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Daemons", exact: true }),
  });
  await expect(recent.getByRole("listitem")).toContainText(TRIGGER);
  await expect(daemons.getByRole("listitem")).toContainText("platform-build-runner");

  for (const width of WIDTHS) {
    await test.step(`overview at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      const runsBox = await box(recent);
      const daemonsBox = await box(daemons);
      if (width >= 1440) {
        expect(Math.abs(runsBox.y - daemonsBox.y)).toBeLessThan(1);
        expect(daemonsBox.x).toBeGreaterThanOrEqual(runsBox.x + runsBox.width);
      } else {
        expect(daemonsBox.y).toBeGreaterThanOrEqual(runsBox.y + runsBox.height);
      }
      await expectContained(page);
      if (width === 1920 || width === 390) {
        await page.screenshot({
          path: testInfo.outputPath(`overview-${width}.png`),
          fullPage: true,
        });
      }
    });
  }

  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  const table = page.getByRole("table", { name: "Triggers", exact: true });
  await expect(table.getByRole("row").filter({ hasText: TRIGGER })).toBeVisible();
  for (const width of WIDTHS) {
    await test.step(`records at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      const mainBox = await box(page.getByRole("main"));
      const tableBox = await box(table);
      const inset = width >= 768 ? 32 : 16;
      const expectedWidth = Math.min(mainBox.width - inset * 2, 1600);
      // The table's border accounts for the two pixels outside its own bounds.
      expect(Math.abs(tableBox.width + 2 - expectedWidth)).toBeLessThan(2);
      expect(
        Math.abs(tableBox.x + tableBox.width / 2 - (mainBox.x + mainBox.width / 2)),
      ).toBeLessThan(1);
      expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expectContained(page);
      if (width === 1920) {
        await page.screenshot({ path: testInfo.outputPath("triggers-1920.png"), fullPage: true });
      }
    });
  }
});

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("Expected a visible layout surface");
  return bounds;
}

async function expectContained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
