import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationHome } from "./helpers/home.js";
import { manualTriggerArtifact } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/home";
const owner = {
  name: "Home Owner",
  email: "home-owner@example.com",
  password: "home-owner-password",
};

test.describe.configure({ timeout: 180_000 });

/**
 * The hosted journey the funnel loses people on, step by step: each step is done by the real
 * thing — a provider connection, a daemon over the wire, a saved trigger, a dispatched run — and
 * Home only ever repeats what those records say.
 */
test("walks a hosted organization from sign-in to its first run", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const home = new OrganizationHome(page);

  await test.step("a fresh organization lands on Home with every step to do", async () => {
    await home.expectOpen();
    await home.expectProgress("0 of 4 done");
    await home.expectStep("Connect an app", "To do");
    await home.expectStep("Connect a daemon", "To do");
    await expect(home.command("Connect a daemon")).toHaveText(
      `miko hub login ${hub.primaryApplication().origin}`,
    );
    await home.expectStep("Create a trigger", "To do");
    await home.expectStep("Run it", "To do");
    await home.expectNoNudge();
    await home.expectRuns(0, "0 succeeded · 0 failed");
    await home.capture(`${SHOTS}/01-fresh.png`);
  });

  await test.step("connecting GitHub completes the first step", async () => {
    await home.followStepAction("Connect an app", "Connect an app");
    await hub.connectGitHub("owner");
    await home.open();
    await home.expectStep("Connect an app", "Done");
    await home.expectStep("Connect an app", "acme-inc");
  });

  await test.step("a daemon enrolled without execute permission is connected but cannot run agents", async () => {
    await hub.seedConnectedOnlyDaemon("owner", "laptop");
    await home.reload();
    await home.expectStep("Connect a daemon", "Cannot run agents");
    await expect(home.command("Connect a daemon")).toHaveText(
      "miko hub permissions grant hub.execute",
    );
    await home.capture(`${SHOTS}/02-cannot-run.png`);
  });

  let daemon = "";
  await test.step("a daemon that can run agents completes the second step", async () => {
    daemon = await hub.connectProviderDaemon("owner", "Acme");
    await home.reload();
    await home.expectStep("Connect a daemon", "Done");
    await home.expectProgress("2 of 4 done");
  });

  await test.step("events arriving with no trigger listening are a nudge to create one", async () => {
    await hub.deliverUnroutedGitHubEvent("home-unrouted-1");
    await hub.deliverUnroutedGitHubEvent("home-unrouted-2");
    await home.reload();
    await expect(home.nudge()).toContainText("2 events in the last 7 days");
    await expect(home.nudge()).toContainText("2 from GitHub");
    await home.capture(`${SHOTS}/03-unrouted-nudge.png`);
    await home.followNudge();
  });

  await test.step("deploying code to the connected daemon completes the third step", async () => {
    await expect(page.getByText("miko trigger init my-trigger", { exact: false })).toBeVisible();
    await hub.deployCodeTrigger("owner", manualTriggerArtifact("deploy", daemon));
    await home.open();
    await home.expectStep("Create a trigger", "Done");
    await home.expectStep("Run it", "To do");
    await home.expectStep("Run it", "miko trigger run deploy");
    await home.expectProgress("3 of 4 done");
  });

  await test.step("the first run completes the list, which collapses and stays toggleable", async () => {
    await hub.runCodeTrigger("owner", "deploy", "home-first-run");
    await home.reload();
    await home.expectProgress("4 of 4 done");
    await home.expectCollapsed();
    await home.expectRuns(1, "0 succeeded · 0 failed");
    await home.expectRecentRun("deploy", "Waiting");
    await home.capture(`${SHOTS}/04-complete.png`);
    await home.toggle();
    await home.expectExpanded();
    await home.expectStep("Run it", "Done");
    await home.reload();
    await home.expectCollapsed();
  });
});

/** A self-hosted operator who deferred app setup is sent back to it from the first step. */
test("sends a self-hosted operator with no provider app to app setup", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: owner,
    providerScenario: "not-configured",
  });
  try {
    await session.surface.leave("Do this later");
    const home = new OrganizationHome(session.page);
    await home.expectOpen();
    await home.expectStep("Connect an app", "Needs setup");
    await home.capture(`${SHOTS}/05-self-hosted-setup.png`);
    await home.followStepAction("Connect an app", "Set up apps");
    await expect(session.page).toHaveURL(/\/apps$/u);
    await session.surface.expectManagement();
  } finally {
    await session.close();
  }
});
