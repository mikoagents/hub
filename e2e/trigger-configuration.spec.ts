import { expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { buildTrigger } from "../src/triggers/code/build.js";

test("shows deployed configuration without source prompts and keeps revision browsing independent", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", {
    name: "Code Configuration Owner",
    email: "configuration-owner@example.com",
    password: "configuration-owner-password",
  });
  await hub.createOrganization("owner", "Code Configuration");
  const daemon = await hub.connectProviderDaemon("owner", "Code Configuration");
  await hub.seedGitHubConnection("Code Configuration", "acme-inc", "acme-inc/app");
  const directory = await mkdtemp(join(tmpdir(), "hub-visual-configuration-"));
  const source = [
    'import {defineTrigger} from "@getpaseo/hub/triggers";',
    'import {agent} from "./policy.js";',
    "export default defineTrigger({",
    'name:"visual-configuration",runner:"browser",',
    'on:[{source:"github",event:"pull_request.opened",connection:"acme-inc",resource:"acme-inc/app"}],',
    "grants:{targets:{review:{daemon:" +
      JSON.stringify(daemon) +
      ',cwd:"/workspace/review",providers:["codex"]}},',
    'github:{reviews:{connection:"acme-inc",repositories:["acme-inc/app"],permissions:{contents:"read",pull_requests:"write"}}}},',
    'limits:{maxRuntime:"1h",maxAgentRuns:2},',
    "async run(ctx){",
    'const first=await ctx.agent.run("review",{target:"review",agent,prompt:"Review this PR.",github:"reviews",maxRuntime:"50m",idleTimeout:"10m"});',
    'if(ctx.event.payload.recheck)await ctx.agent.run("recheck",{target:"review",agent:{provider:"codex",model:ctx.event.payload.model},prompt:ctx.event.payload.prompt,maxRuntime:"10m",idleTimeout:"5m"});',
    "return first;",
    "}});",
  ].join("\n");
  try {
    await writeFile(join(directory, "trigger.ts"), source);
    await writeFile(
      join(directory, "policy.ts"),
      'export const agent={provider:"codex",model:"model-v1",mode:"auto-review",thinkingOptionId:"max"};',
    );
    await hub.deployCodeTrigger("owner", await buildTrigger(join(directory, "trigger.ts")));
    const triggers = new OrganizationTriggers(page);
    await triggers.open();
    const listRow = page
      .getByRole("table", { name: "Triggers" })
      .getByRole("row")
      .filter({ hasText: "visual-configuration" });
    await expect(listRow).toContainText("codex/model-v1 · Computed at runtime");
    await expect(listRow).toContainText("GitHub pull request opened");
    await expect(listRow).toContainText("acme-inc");
    await expect(listRow).toContainText(daemon);
    await expect(listRow).toContainText("/workspace/review");
    await expect(listRow.getByRole("img", { name: "github provider" })).toBeVisible();
    await page.getByRole("link", { name: "visual-configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: /^View .* source$/ })).toHaveCount(0);
    await expect(page.locator('[data-provider="configuration-event"]')).toContainText("acme-inc");
    await expect(page.locator('[data-provider="configuration-target"]')).toContainText(
      "/workspace/review",
    );
    await expect(page.locator('[data-provider="configuration-agent"]')).toContainText("model-v1");
    await expect(page.locator('[data-provider="configuration-agent"]')).toContainText(
      "Thinking: max",
    );
    await expect(page.locator('[data-provider="configuration-github"]')).toContainText(
      "pull_requests: write",
    );
    for (const title of ["The event", "Where it runs", "What runs there", "GitHub access"]) {
      const row = page.getByRole("button", { name: new RegExp("^" + title) });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await row.click();
    }
    await expect(page.locator('[data-summary="Trigger event configuration"]')).toContainText(
      "Pull request opened",
    );
    await expect(page.locator('[data-summary="review execution target"]')).toContainText(
      "/workspace/review",
    );
    const config = page.locator('[data-summary="review agent configuration"]');
    const agent = config.locator("..");
    await expect(config).toContainText("model-v1");
    await expect(config).toContainText("auto-review");
    await expect(config).toContainText("max");
    await expect(page.locator('[data-summary="recheck agent configuration"]')).toContainText(
      "Computed at runtime",
    );
    const permissions = page.locator('[data-summary="reviews permissions"]');
    await expect(permissions).toContainText("contents");
    await expect(permissions).toContainText("read");
    await expect(permissions).toContainText("pull_requests");
    await expect(permissions).toContainText("write");
    await expect(page.getByRole("textbox", { name: "policy.ts value", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /^View .* source$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "policy.ts", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "policy.ts value", exact: true })).toBeVisible();

    await writeFile(
      join(directory, "policy.ts"),
      'export const agent={provider:"codex",model:"model-v2",mode:"auto-review",thinkingOptionId:"max"};',
    );
    await hub.deployCodeTrigger("owner", await buildTrigger(join(directory, "trigger.ts")));
    await page.reload();
    await page.getByRole("button", { name: /^What runs there/ }).click();
    await expect(config).toContainText("model-v2");
    await page.getByRole("combobox", { name: "Code revision" }).click();
    await page.getByRole("option", { name: /Revision 1/ }).click();
    await page.getByRole("button", { name: "policy.ts", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "policy.ts value", exact: true })).toContainText(
      "model-v1",
    );
    await expect(config).toContainText("model-v2");
    await page.getByRole("combobox", { name: "Code revision" }).click();
    await page.getByRole("option", { name: /Revision 2/ }).click();
    await expect(page.getByRole("combobox", { name: "Code revision" })).toContainText("Revision 2");
    await page.getByRole("button", { name: "policy.ts", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "policy.ts value", exact: true })).toContainText(
      "model-v2",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const agentRow = page.getByRole("button", { name: /^What runs there/ });
    await expect(agentRow).toHaveAttribute("aria-expanded", "false");
    await expect(agentRow).toContainText("model-v2");
    await expect(agentRow).toContainText("Thinking: max");
    await expect(page.getByRole("button", { name: /^View .* source$/ })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "policy.ts value", exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    for (const title of ["The event", "Where it runs", "What runs there", "GitHub access"]) {
      await page.getByRole("button", { name: new RegExp("^" + title) }).click();
    }
    await expect(config).toContainText("model-v2");
    await expect(permissions).toContainText("pull_requests");
    await agent.getByRole("button", { name: /^Prompt/ }).click();
    await expect(page.getByRole("textbox", { name: "review prompt", exact: true })).toContainText(
      "Review this PR.",
    );
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
