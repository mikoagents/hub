import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";
import { artifactDigest, type TriggerArtifact } from "../src/triggers/code/contract.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const WORKSPACES = "/srv/workspaces/acme/projects";

const owner = {
  name: "Table Owner",
  email: "table-owner@example.com",
  password: "table-owner-password",
};

interface SeededTrigger {
  name: string;
  source: string;
  event: string;
  summary: string;
  connection?: string;
}
const TRIGGERS: readonly SeededTrigger[] = [
  {
    name: "issue-comment-triage",
    source: "github",
    event: "issue_comment.created",
    summary: "GitHub issue comment created",
    connection: "acme-inc",
  },
  {
    name: "pull-request-review-followup",
    source: "github",
    event: "pull_request_review.*",
    summary: "GitHub pull request review events",
    connection: "acme-inc",
  },
  {
    name: "discord-support-mention",
    source: "discord",
    event: "mention",
    summary: "Discord mention",
    connection: "community-discord",
  },
  {
    name: "slack-help",
    source: "slack",
    event: "mention",
    summary: "Slack mention",
    connection: "company-slack",
  },
  { name: "manual-incident-review", source: "manual", event: "run", summary: "Manual run" },
  {
    name: "scheduled-health-check",
    source: "schedule",
    event: "tick",
    summary: "Schedule",
  },
];

test("the Trigger list fits readable events and last-run results without horizontal overflow", async ({
  hub,
  page,
}) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  await hub.seedGitHubConnection("Acme", "acme-inc");
  await hub.seedDiscordConnection("Acme", "community-discord");
  const triggers = new OrganizationTriggers(page);
  const table = page.getByRole("table", { name: "Triggers" });

  await test.step("seed triggers of every kind", async () => {
    await triggers.open();
    for (const trigger of TRIGGERS)
      await hub.deployCodeTrigger("owner", triggerArtifact(trigger, daemon));
    await triggers.open();
  });

  // The first column used to keep every spare pixel, so the rest were cut to their headers:
  // "Git…", "8 minutes …", a path missing its tail.
  await test.step("at 1100px names and event kinds are whole", async () => {
    await showAt(page, 1100, table);
    for (const trigger of TRIGGERS) {
      const cells = rowCells(table, trigger.name);
      await expectWhole(cells.nth(0), trigger.name);
      await expectWhole(cells.nth(1), trigger.summary);
    }
  });

  await test.step("at 1280px models, events, targets, last triggers and status are visible", async () => {
    await showAt(page, 1280, table);
    await expect(table.getByRole("columnheader")).toHaveText([
      "Trigger",
      "Event",
      "Target",
      "Last triggered",
      "Status",
    ]);
    for (const trigger of TRIGGERS) {
      const cells = rowCells(table, trigger.name);
      await expectWhole(cells.nth(0), trigger.name);
      await expect(cells.nth(0)).toContainText("codex/gpt-6.1-sol");
      await expectWhole(cells.nth(1), trigger.summary);
      if (trigger.connection) await expect(cells.nth(1)).toContainText(trigger.connection);
      await expect(cells.nth(2)).toContainText(daemon);
      await expect(
        cells.nth(2).getByTitle(`${WORKSPACES}/platform/infrastructure-runbooks`),
      ).toBeVisible();
      await expect(cells.nth(3)).toHaveText("Never");
      await expect(cells.nth(4)).toHaveText("Enabled");
      await expectWhole(cells.nth(3));
      await expectWhole(cells.nth(4));
    }
    await expect(rowCells(table, "scheduled-health-check").nth(1)).toContainText(
      "Every day at 00:00 (UTC)",
    );
  });

  await test.step("on a phone the name, model and status fit without scrolling", async () => {
    await showAt(page, 390, table);
    await expect(table.getByRole("columnheader")).toHaveText(["Trigger", "Status"]);
    for (const trigger of TRIGGERS) {
      const cells = rowCells(table, trigger.name);
      await expect(cells.nth(0)).toContainText("codex/gpt-6.1-sol");
      await expect(cells.nth(1)).toHaveText("Enabled");
    }
  });
});

test("a connected-only daemon's grant command gives way before the daemons table scrolls", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedConnectedOnlyDaemon("owner", "build-runner-eu-west-primary");
  await page.setViewportSize({ width: 1100, height: 900 });
  await projectApp(page).navigation.openOrganizationSection("Daemons");

  const table = page.getByRole("table", { name: "Daemons" });
  await expect(table.getByTitle("miko hub permissions grant hub.execute")).toBeAttached();
  await expect(
    table.getByRole("button", { name: "Actions for build-runner-eu-west-primary" }),
  ).toBeInViewport({ ratio: 1 });
  expect(await scrollsSideways(table)).toBe(false);
});

async function showAt(page: Page, width: number, table: Locator) {
  await page.setViewportSize({ width, height: 900 });
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(TRIGGERS.length + 1);
  expect(await scrollsSideways(table)).toBe(false);
}

function rowCells(table: Locator, name: string): Locator {
  return table.getByRole("row").filter({ hasText: name }).getByRole("cell");
}

/** The cell, and every truncating line in it or only the one reading `text`, shows all its text. */
async function expectWhole(cell: Locator, text?: string) {
  await expect(cell).toBeVisible();
  const lines = cell.locator(".truncate").filter(text === undefined ? {} : { hasText: text });
  if (text !== undefined) await expect(lines).not.toHaveCount(0);
  const cut = await lines.evaluateAll((elements) =>
    elements
      .filter((element) => element.scrollWidth > element.clientWidth)
      .map((element) => element.textContent),
  );
  expect(cut).toEqual([]);
  expect(await cell.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function scrollsSideways(table: Locator): Promise<boolean> {
  return table.evaluate((element) => {
    const container = element.parentElement;
    return container !== null && container.scrollWidth > container.clientWidth;
  });
}

function triggerArtifact(trigger: SeededTrigger, daemon: string): TriggerArtifact {
  const code =
    'export default {run(ctx){return ctx.agent.run("review",{target:"review",agent:{provider:"codex",model:"gpt-6.1-sol"},prompt:"Review",maxRuntime:"5m",idleTimeout:"1m"})}};';
  const body = {
    format: "trigger-code-v1" as const,
    manifest: {
      name: trigger.name,
      description: `Operator-owned project with configuration under ${WORKSPACES}/platform/infrastructure-runbooks`,
      runner: "local",
      on: [
        {
          source: trigger.source,
          event: trigger.event,
          ...(trigger.connection === undefined ? {} : { connection: trigger.connection }),
          ...(trigger.source === "schedule"
            ? { recurrence: { start: "2098-01-01T00:00:00", timezone: "UTC", rule: "FREQ=DAILY" } }
            : {}),
        },
      ],
      grants: {
        targets: {
          review: {
            daemon,
            cwd: `${WORKSPACES}/platform/infrastructure-runbooks`,
            providers: ["codex"],
          },
        },
      },
      limits: { maxRuntime: "1h" },
    },
    code,
    sources: [{ path: "trigger.ts", content: code }],
  };
  return { ...body, digest: artifactDigest(body) };
}
