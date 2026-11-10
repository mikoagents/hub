import { expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { artifactDigest } from "../src/triggers/code/contract.js";
import { executeTriggerJob } from "../src/triggers/code/runner.js";
import type { TriggerJob } from "../src/triggers/code/service.js";

const owner = {
  name: "Trigger Owner",
  email: "trigger-owner@example.com",
  password: "trigger-owner-test-password",
};

test("creates code projects without requiring a daemon for non-agent workflows", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Code projects");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await expect(page.getByText("No triggers", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "New trigger" }).click();
  await expect(page.getByRole("heading", { name: "New trigger", exact: true })).toBeVisible();
  await expect(page.getByText("paseo-hub trigger init my-trigger", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save trigger" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Trigger YAML" })).toHaveCount(0);
  await page.getByRole("button", { name: "See the starter script" }).click();
  await expect(page.getByRole("textbox", { name: "trigger.ts value" })).toContainText(
    'name: "my-trigger"',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Copy commands", exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("deploys code, runs a real worker, shows Activity results and retains identity on redeploy", async ({
  hub,
  page,
  request,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Code workflows");
  const deployed = await hub.deployCodeTrigger("owner", artifact("first"));
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await page.getByRole("link", { name: "code-workflow", exact: true }).click();
  await expect(page.getByRole("img", { name: "Workflow for code-workflow" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Source code", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Source code" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Code revision" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "trigger.ts value" })).toHaveCount(0);
  const triggerFile = page.getByRole("button", { name: "trigger.ts Entrypoint", exact: true });
  const policyFile = page.getByRole("button", { name: "policy.ts", exact: true });
  await expect(triggerFile).toHaveAttribute("aria-expanded", "false");
  await expect(policyFile).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("combobox", { name: "Source file" })).toHaveCount(0);
  await triggerFile.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("return result;", { exact: false })).toBeVisible();
  await policyFile.click();
  await expect(page.getByRole("textbox", { name: "policy.ts value" })).toContainText(
    'version = "first"',
  );
  await expect(page.getByRole("textbox", { name: "trigger.ts value" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await triggerFile.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("textbox", { name: "trigger.ts value" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "policy.ts value" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Run queued", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Run history" }).getByRole("row").filter({ hasText: "Queued" }),
  ).toHaveCount(1);

  const operator = await hub.codeTriggerCredential("owner");
  const url = hub.primaryApplication().origin;
  const enrollment = await request.post(`${url}/api/v1/triggers/runners`, {
    headers: { authorization: `Bearer ${operator}` },
    data: { name: "browser" },
  });
  expect(enrollment.status()).toBe(201);
  const runner = (await enrollment.json()) as { token: string };
  const lease = await request.post(`${url}/api/v1/triggers/runner/lease`, {
    headers: { authorization: `Bearer ${runner.token}` },
    data: {},
  });
  const { job } = (await lease.json()) as { job: TriggerJob };
  expect(job.run.triggerId).toBe(deployed.triggerId);
  const directory = await mkdtemp(join(tmpdir(), "hub-browser-runner-"));
  try {
    await executeTriggerJob(job, { url, token: runner.token, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const history = page.getByRole("table", { name: "Run history" });
  await expect(history.getByRole("row").filter({ hasText: "Succeeded" })).toHaveCount(1);
  await history.getByRole("button", { name: /^Open run from / }).click();
  await expect(page.getByRole("radio", { name: "Run details", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Trigger result", exact: true })).toContainText(
    '"version": "first"',
  );
  await expect(page.getByRole("textbox", { name: "process result", exact: true })).toBeHidden();
  await page.getByRole("button", { name: /^process\b/ }).click();
  await expect(page.getByRole("textbox", { name: "process result", exact: true })).toContainText(
    '"version": "first"',
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("link", { name: "Activity", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "code-workflow" });
  await expect(row).toContainText("Succeeded");
  await row.getByRole("button", { name: "code-workflow", exact: true }).click();
  await page.getByRole("radio", { name: "Run details", exact: true }).click();
  await expect(page.getByText('"version": "first"', { exact: false }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByText("Processed code workflow", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const updated = await hub.deployCodeTrigger("owner", artifact("second"));
  expect(updated.triggerId).toBe(deployed.triggerId);
  expect(updated.version).toBe(2);
  await triggers.open();
  await page.getByRole("link", { name: "code-workflow", exact: true }).click();
  await policyFile.click();
  await expect(page.getByText('"second"', { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Code revision" }).click();
  await page.getByRole("option", { name: /Revision 1/ }).click();
  await expect(policyFile).toHaveAttribute("aria-expanded", "false");
  await policyFile.click();
  await expect(page.getByText('"first"', { exact: false })).toBeVisible();
  await expect(
    page.getByText("This is an older revision. Run now uses the current revision, 2."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "Code revision" }).click();
  await page.getByRole("option", { name: /Revision 2/ }).click();
  await policyFile.click();
  await expect(page.getByText('"second"', { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toBeDisabled();
});

test("shows authored branches and loops in an expandable diagram in both palettes and on a phone", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Workflow diagrams");
  await hub.deployCodeTrigger(
    "owner",
    diagramArtifact(
      "review-flow",
      `flowchart LR
    event([Incoming event]) --> review[Review]
    review --> ready{Ready?}
    ready -->|No| repair[Repair]
    repair --> review
    ready -->|Yes| done[Publish result]`,
    ),
  );
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await page.getByRole("link", { name: "review-flow", exact: true }).click();
  const graph = page.getByRole("img", { name: "Workflow for review-flow" });
  await expect(graph).toContainText("Repair");
  await expect(graph.locator("svg.pele-flowchart")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand diagram", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Workflow diagram" });
  await expect(dialog.getByRole("img", { name: "Workflow for review-flow" })).toContainText(
    "Publish result",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const color = await graph
    .locator(".pele-node rect")
    .first()
    .evaluate((node) => getComputedStyle(node).fill);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      graph
        .locator(".pele-node rect")
        .first()
        .evaluate((node) => getComputedStyle(node).fill),
    )
    .not.toBe(color);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  await expect
    .poll(() =>
      graph
        .locator(".pele-node rect")
        .first()
        .evaluate((node) => node.getBoundingClientRect().height),
    )
    .toBeGreaterThan(24);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.getByRole("button", { name: "Expand diagram", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Workflow for review-flow" })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("renders Pele mindmaps with readable mobile labels and an expanded view", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Mindmap diagrams");
  await hub.deployCodeTrigger(
    "owner",
    diagramArtifact(
      "review-map",
      `mindmap
  root((Review workflow))
    When
      Pull request opened
      CI completed
    Review
      Check the latest head
      Repair findings
    Result
      Publish formal review`,
    ),
  );
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await page.getByRole("link", { name: "review-map", exact: true }).click();
  const graph = page.getByRole("img", { name: "Workflow for review-map" });
  await expect(graph.locator("svg.pele-mindmap")).toHaveCount(1);
  await expect(graph).toContainText("Publish formal review");
  const color = await graph
    .locator(".pele-root circle")
    .evaluate((node) => getComputedStyle(node).fill);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => graph.locator(".pele-root circle").evaluate((node) => getComputedStyle(node).fill))
    .not.toBe(color);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  await expect(graph.locator(".pele-root .pele-label")).toHaveCSS("font-size", "13px");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await graph.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => graph.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Expand diagram", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Workflow diagram" });
  await expect(dialog.locator("svg.pele-mindmap")).toHaveCount(1);
  await expect(dialog).toContainText("Repair findings");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("keeps malformed diagrams and embedded HTML from taking over the Trigger page", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Diagram failures");
  await hub.deployCodeTrigger(
    "owner",
    diagramArtifact(
      "safe-diagram",
      `flowchart LR
    A["<img src=x onerror=alert(1)>"] --> B[Done]
    click A "javascript:alert(1)"
    click B "https://example.com"
    B --> C@{ img: "https://example.com/diagram.png", label: "External image" }`,
    ),
  );
  await hub.deployCodeTrigger(
    "owner",
    diagramArtifact("broken-diagram", "flowchart LR\n A[unfinished"),
  );
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await page.getByRole("link", { name: "safe-diagram", exact: true }).click();
  const graph = page.getByRole("img", { name: "Workflow for safe-diagram" });
  await expect(graph.locator("svg")).toHaveCount(1);
  await expect(
    graph.locator("script, img, image, foreignObject, a[href], a[*|href], [onerror], [onload]"),
  ).toHaveCount(0);
  await triggers.open();
  await page.getByRole("link", { name: "broken-diagram", exact: true }).click();
  await expect(page.getByText("Diagram unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "trigger.ts Entrypoint", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "trigger.ts value" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
});

function diagramArtifact(name: string, diagram: string) {
  const { digest: _digest, ...body } = artifact("diagram");
  const updated = { ...body, manifest: { ...body.manifest, name, diagram } };
  return { ...updated, digest: artifactDigest(updated) };
}

function artifact(version: string) {
  const code = `export default {async run(ctx) { const result = await ctx.step("process", null, async () => ({version:${JSON.stringify(version)}})); await ctx.log("Processed code workflow", result); return result; }};`;
  const body = {
    format: "trigger-code-v1" as const,
    manifest: {
      name: "code-workflow",
      runner: "browser",
      description: "A code-defined workflow",
      on: [{ source: "manual", event: "run" }],
      grants: {},
      limits: { maxRuntime: "10m" },
    },
    code,
    entrypoint: "trigger.ts",
    sources: [
      { path: "policy.ts", content: `export const version = ${JSON.stringify(version)};` },
      { path: "trigger.ts", content: code },
    ],
  };
  return { ...body, digest: artifactDigest(body) };
}
