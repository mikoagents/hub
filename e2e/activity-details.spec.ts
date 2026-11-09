import { expect } from "@playwright/test";
import { test } from "./app.js";

test("inspects run details and every log page in a keyboard-accessible dialog", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", {
    name: "Activity Owner",
    email: "activity-owner@example.com",
    password: "activity-owner-password",
  });
  await hub.createOrganization("owner", "Activity organization");
  await hub.seedLegacyTrigger(
    "owner",
    "logged-run",
    "name: logged-run\non: manual.run\nsteps: []\n",
  );
  const application = hub.primaryApplication();
  await application.query(`with project as (
      insert into projects (organization_id, name, slug)
      select organization_id, 'Logged runtime', 'logged-runtime' from organization_triggers where name = 'logged-run'
      returning id, organization_id
    ), revision as (
      insert into project_configuration_revisions
        (project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash, validated_at)
      select id, organization_id, 1, 'manual', '{}'::jsonb, '{"environments":[],"triggers":[]}'::jsonb, 'activity-log-fixture', now()
      from project returning project_id
    )
    update organization_triggers set runtime_project_id = revision.project_id from revision where name = 'logged-run'`);
  await hub.seedTriggerRun("logged-run", { minutesAgo: 1, status: "succeeded" });
  await application.query(`
    with run as (select * from trigger_runs where configured_trigger_name = 'logged-run'),
    step as (
      insert into workflow_step_runs (trigger_run_id, step_id, ordinal, status, output, started_at, completed_at)
      select id, 'work', 0, 'succeeded', '{"result":"All checks passed"}'::jsonb, created_at, now() from run
      returning id, trigger_run_id
    ), execution as (
      insert into agent_executions (organization_id, project_id, configuration_revision_id, status, workflow_step_run_id)
      select run.organization_id, run.project_id, run.configuration_revision_id, 'succeeded', step.id from run, step
      returning id, workflow_step_run_id
    )
    select id from execution
  `);
  await application.query(
    `update workflow_step_runs s set agent_execution_id = e.id from agent_executions e where e.workflow_step_run_id = s.id`,
  );
  await application.query(`insert into agent_execution_logs (execution_id, recorded_at, event)
    select e.id, now(), jsonb_build_object('type', 'timeline', 'text', 'Log entry ' || n)
    from agent_executions e cross join generate_series(0, 100) n order by n`);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  const row = page
    .getByRole("table", { name: "Trigger activity" })
    .getByRole("row")
    .filter({ hasText: "logged-run" });
  const trigger = row.getByRole("button", { name: "logged-run", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Activity details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Run prompt" })).toContainText(
    "Handle the event.",
  );
  await expect(dialog.getByRole("textbox", { name: "work output" })).toContainText(
    "All checks passed",
  );
  const log = dialog.getByRole("textbox", { name: /^Execution log/u });
  await expect(log).toContainText('"Log entry 0"');
  await expect(log).toContainText('"Log entry 99"');
  await expect(log).not.toContainText('"Log entry 100"');
  await dialog.getByRole("button", { name: "Later entries" }).click();
  await expect(log).toContainText('"Log entry 100"');
  await expect(dialog.getByRole("button", { name: "Later entries" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Earlier entries" }).click();
  await expect(log).toContainText('"Log entry 0"');
  await dialog.getByRole("button", { name: "Event and context" }).click();
  await expect(dialog.getByRole("textbox", { name: "Event payload" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("cell", { name: "manual", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth),
    )
    .toBe(true);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await page.screenshot({ path: "e2e/screenshots/activity/details-mobile.png" });
  await page.keyboard.press("Escape");

  await application.query("delete from agent_execution_logs");
  await trigger.click();
  await expect(dialog.getByText("No recorded log", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  const failure = "Review tool access denied; no Review published";
  await application.query(
    "update trigger_runs set status = 'failed', failure_reason = $1 where configured_trigger_name = 'logged-run'",
    [failure],
  );
  await application.query("update workflow_step_runs set status = 'failed', failure_reason = $1", [
    failure,
  ]);
  await page.reload();
  await expect(row.getByText("Failed", { exact: true })).toBeVisible();
  await expect(row.getByText(failure, { exact: true })).toBeVisible();
  await trigger.click();
  await expect(dialog.getByText(failure, { exact: true }).first()).toBeVisible();
});
