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
  await application.query(`with inserted as (
    insert into agent_sessions (id, organization_id, project_id, data)
    select gen_random_uuid(), organization_id, project_id,
      jsonb_build_object('organizationId', organization_id, 'projectId', project_id, 'daemonId', 'offline-daemon', 'agentId', 'public-agent', 'runtimeBinding', jsonb_build_object('provider', 'codex', 'nativeAgentId', 'native-agent'))
    from agent_executions returning id, data
  ), cache as (
    insert into agent_session_timelines (session_id, data)
    select id, '{"epoch":"fixture","startSeq":1,"endSeq":3,"hasOlder":false,"hasNewer":false,"updatedAt":"2026-11-09T10:00:00Z","agent":{"nativeAgentId":"native-agent","provider":"codex","providerSessionId":"provider-thread","status":"idle","cwd":"/workspace","model":"fixture-model"}}'::jsonb from inserted
  ) update agent_executions set agent_session_id = inserted.id from inserted`);
  await application.query(
    "update agent_sessions set data = jsonb_set(data, '{id}', to_jsonb(id::text))",
  );
  await application.query(`insert into agent_session_timeline_rows (session_id, seq, data)
    select id, 1, '{"seq":1,"timestamp":"2026-11-09T10:00:00Z","item":{"type":"user_message","text":"Inspect this change"}}'::jsonb from agent_sessions
    union all select id, 2, '{"seq":2,"timestamp":"2026-11-09T10:00:01Z","item":{"type":"assistant_message","text":"I found the permission failure"}}'::jsonb from agent_sessions
    union all select id, 3, '{"seq":3,"timestamp":"2026-11-09T10:00:02Z","item":{"type":"tool_call","callId":"shell-call","name":"Shell","status":"failed","detail":{"type":"shell","command":"cat source.ts","output":"Operation not permitted"}}}'::jsonb from agent_sessions`);
  await application.query(`insert into workflow_step_runs (trigger_run_id, step_id, ordinal, status)
    select id, 'skipped', 1, 'skipped' from trigger_runs where configured_trigger_name = 'logged-run'`);
  await application.query(
    `update agent_session_timelines set data = jsonb_set(data, '{endSeq}', '4'::jsonb)`,
  );
  await application.query(`insert into agent_session_timeline_rows (session_id, seq, data)
    select id, 4, jsonb_build_object('seq', 4, 'timestamp', '2026-11-09T10:00:03Z',
      'item', jsonb_build_object('type', 'assistant_message', 'text', repeat('Detailed explanation of the execution. ', 180))) from agent_sessions`);
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
  for (const width of [390, 768, 1280, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    const inset = width >= 640 ? 32 : 16;
    // Visibility arrives before the opening animation reaches the dialog's final bounds.
    await expect
      .poll(async () => {
        const bounds = await dialog.boundingBox();
        return bounds === null
          ? Infinity
          : Math.abs(bounds.width - Math.min(width - inset * 2, 1152));
      })
      .toBeLessThan(1);
    const bounds = await dialog.boundingBox();
    if (bounds === null) throw new Error("Expected an open detail dialog");
    expect(bounds.x).toBeGreaterThanOrEqual(inset);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - inset);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialogHeight = await dialog.evaluate((element) => element.clientHeight);
  await expect(dialog.getByRole("radio", { name: "Conversation", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dialog.getByRole("textbox", { name: "Run prompt" })).toBeHidden();
  await expect(dialog.getByText("miko agent inspect native-agent", { exact: true })).toBeHidden();
  await dialog.getByRole("combobox", { name: "Execution step" }).click();
  await page.getByRole("option", { name: /2\. skipped/u }).click();
  await expect(dialog.getByText("No agent session", { exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Execution step" }).click();
  await page.getByRole("option", { name: /1\. work/u }).click();
  await expect(dialog.getByText("Inspect this change", { exact: true })).toBeVisible();
  await expect(dialog.getByText("I found the permission failure", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Saved session history", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Shell" }).click();
  await expect(dialog.getByRole("textbox", { name: "Tool input", exact: true })).toHaveText(
    "cat source.ts",
  );
  await expect(dialog.getByRole("textbox", { name: "Tool output", exact: true })).toHaveText(
    "Operation not permitted",
  );
  const expand = dialog.getByRole("button", { name: "Show full message", exact: true });
  await expect(expand).toBeVisible();
  const message = dialog
    .getByRole("paragraph")
    .filter({ hasText: "Detailed explanation of the execution." });
  const previewHeight = await message.evaluate((element) => element.clientHeight);
  await expand.click();
  await expect(dialog.getByRole("button", { name: "Show less", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await message.evaluate((element) => element.clientHeight)).toBeGreaterThan(previewHeight);
  await dialog.getByRole("button", { name: "Show less", exact: true }).click();
  await dialog.getByRole("radio", { name: "Run details", exact: true }).click();
  expect(await dialog.evaluate((element) => element.clientHeight)).toBe(dialogHeight);
  await expect(dialog.getByRole("textbox", { name: "Run prompt" })).toBeHidden();
  await dialog.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Run prompt" })).toContainText(
    "Handle the event.",
  );
  await dialog.getByRole("button", { name: /1\. work/u }).click();
  await expect(dialog.getByRole("textbox", { name: "work output" })).toContainText(
    "All checks passed",
  );
  await dialog.getByRole("button", { name: "Event and context" }).click();
  await expect(dialog.getByRole("textbox", { name: "Event payload" })).toBeVisible();
  await dialog.getByRole("radio", { name: "Diagnostics", exact: true }).click();
  await expect(dialog.getByText("miko agent inspect native-agent", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Raw session data", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Session message data" })).toContainText(
    "cat source.ts",
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
  const body = dialog.getByRole("region", { name: "Activity details content" });
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    dialog.getByRole("heading", { name: "Activity details", exact: true }),
  ).toBeInViewport();
  await expect(dialog.getByRole("radio", { name: "Conversation", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await dialog.getByRole("radio", { name: "Diagnostics", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("radio", { name: "Run details", exact: true })).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("radio", { name: "Conversation", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("cell", { name: "On demand", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth),
    )
    .toBe(true);
  await expect(dialog.getByText("Inspect this change", { exact: true })).toBeVisible();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("radio", { name: "Diagnostics", exact: true })).toBeInViewport();
  await page.screenshot({ path: "e2e/screenshots/activity/details-mobile.png" });
  await page.keyboard.press("Escape");

  await application.query("delete from agent_execution_logs");
  await trigger.click();
  await dialog.getByRole("radio", { name: "Diagnostics", exact: true }).click();
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
