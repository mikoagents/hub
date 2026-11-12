import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { artifactDigest, type TriggerArtifact } from "../src/triggers/code/contract.js";

test("deploys a code schedule, receives a real clock tick, and inspects edited calendar rules and prior revisions", async ({
  hub,
  page,
  request,
}) => {
  await hub.signUpAs("owner", {
    name: "Schedule Owner",
    email: "schedule-owner@example.com",
    password: "schedule-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const start = new Date(Date.now() + 5000).toISOString().slice(0, 19);
  const first = await hub.deployCodeTrigger("owner", scheduled("FREQ=MINUTELY;COUNT=1", start));
  const token = await hub.codeTriggerCredential("owner");
  const origin = hub.primaryApplication().origin;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${origin}/api/v1/triggers/periodic-scan/runs`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = (await response.json()) as { runs: { event: { source: string } }[] };
        return body.runs.some((run) => run.event.source === "schedule");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "periodic-scan" });
  await expect(row).toContainText("schedule");
  await expect(row).toContainText("Queued");

  const triggers = new OrganizationTriggers(page);
  for (const { rule, summary } of [
    {
      rule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8,18;BYMINUTE=15,30",
      summary: "Every Mon, Fri at 08:15 and 08:30 and 18:15 and 18:30 (UTC)",
    },
    { rule: "FREQ=MINUTELY;INTERVAL=90", summary: "FREQ=MINUTELY;INTERVAL=90 (UTC)" },
    {
      rule: "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17",
      summary: "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17 (UTC)",
    },
  ]) {
    const deployed = await hub.deployCodeTrigger("owner", scheduled(rule, "2098-01-01T09:00:00"));
    expect(deployed.triggerId).toBe(first.triggerId);
    await triggers.open();
    await expect(
      page
        .getByRole("table", { name: "Triggers" })
        .getByRole("row")
        .filter({ hasText: "periodic-scan" }),
    ).toContainText(summary);
    await page.getByRole("link", { name: "periodic-scan", exact: true }).click();
    await expect(page.getByRole("list", { name: "Events", exact: true })).toContainText(summary);
    await page.reload();
    await page.getByRole("button", { name: "trigger.ts", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "trigger.ts value", exact: true }),
    ).toContainText(rule);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.getByRole("combobox", { name: "Code revision" }).click();
  await page.getByRole("option", { name: /Revision 1/ }).click();
  await page.getByRole("button", { name: "trigger.ts", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "trigger.ts value", exact: true })).toContainText(
    "FREQ=MINUTELY;COUNT=1",
  );
});
function scheduled(rule: string, start: string): TriggerArtifact {
  const manifest = {
    name: "periodic-scan",
    runner: "browser",
    on: [
      { source: "schedule", event: "tick", recurrence: { start, timezone: "UTC", rule } },
      { source: "manual", event: "run" },
    ],
    grants: {},
    limits: { maxRuntime: "1h" },
  };
  const code = "export default {run(ctx){return ctx.event.payload}};";
  const body = {
    format: "trigger-code-v1" as const,
    manifest,
    code,
    sources: [{ path: "trigger.ts", content: `// ${rule}\n${code}` }],
  };
  return { ...body, digest: artifactDigest(body) };
}
