import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";
import { compileHubBundle } from "../config/bundle.js";
import { migrateLegacyProjectTriggers } from "./migration.js";
import { artifactDigest } from "./code/contract.js";
import { TriggerCodeService } from "./code/service.js";

describe("trigger dashboard read model", () => {
  it("keeps a Trigger's own history visible when another fills the organization feed", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "member-1",
          role: "owner",
        },
      ],
    });
    const service = new TriggerCodeService(database, {
      ensure: async () => {},
      cancel: async () => {},
      github: async () => null,
    });
    const project = (name: string) => {
      const body = {
        format: "trigger-code-v1" as const,
        manifest: {
          name,
          runner: "local",
          on: [{ source: "manual", event: "run" }],
          grants: {},
          limits: { maxRuntime: "10m" },
          diagram: "flowchart LR\n A[Event] --> B[Result]",
        },
        code: "export default {async run(){ return null }};",
        sources: [{ path: "trigger.ts", content: "export default {async run(){ return null }};" }],
        entrypoint: "trigger.ts",
      };
      return { ...body, digest: artifactDigest(body) };
    };
    const quiet = await service.deploy("org-1", project("quiet"));
    const busy = await service.deploy("org-1", project("busy"));
    const startedAt = new Date().toISOString();
    const first = await service.receive("org-1", quiet.triggerId, {
      id: "quiet-first",
      source: "manual",
      type: "run",
      payload: null,
      receivedAt: startedAt,
    });
    for (let index = 0; index < 105; index++)
      await service.receive("org-1", busy.triggerId, {
        id: `busy-${index}`,
        source: "manual",
        type: "run",
        payload: null,
        receivedAt: startedAt,
      });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const request = new Request("https://hub.test/o/acme/triggers");
    const history = await dashboard.triggerHistory(request, "acme", quiet.triggerId);
    assert.deepEqual(
      history.map((run) => run.id),
      [first.run?.id],
    );
    const snapshot = await dashboard.snapshot(request, "acme");
    assert.equal(
      snapshot.triggers.find((trigger) => trigger.id === quiet.triggerId)?.lastTriggered?.status,
      "queued",
    );
    assert.equal((await dashboard.triggerHistory(request, "acme", busy.triggerId)).length, 100);
    assert.equal(
      (await dashboard.codeDetail(request, "acme", quiet.triggerId)).artifact?.entrypoint,
      "trigger.ts",
    );
    assert.match(
      (await dashboard.codeDetail(request, "acme", quiet.triggerId)).artifact?.manifest.diagram ??
        "",
      /A\[Event\]/u,
    );
    await assert.rejects(
      dashboard.triggerHistory(request, "acme", "another-trigger"),
      /run_unavailable/u,
    );
    await assert.rejects(
      dashboard.triggerHistory(request, "other-org", quiet.triggerId),
      /tenant route not found/u,
    );
  });

  it("describes the provider and latest run on the organization trigger list", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
      ],
    });
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml,
      userId: "user-1",
    });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const request = new Request("https://hub.test/o/acme/triggers");

    const before = await dashboard.snapshot(request, "acme");
    assert.equal(before.triggers[0]?.provider, "manual");
    assert.equal(before.triggers[0]?.event, "manual.run");
    assert.equal(before.triggers[0]?.lastTriggered, null);

    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    const receivedAt = new Date("2026-08-30T09:30:00.000Z");
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: "dashboard-manual-run",
      source: "manual.run",
      payload: {},
      receivedAt,
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    const created = await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: { request: "Full invocation context" },
      outputContext: {},
      deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
      stepIds: ["run"],
    });

    const after = await dashboard.snapshot(request, "acme");
    assert.deepEqual(after.triggers[0]?.lastTriggered, {
      status: "running",
      receivedAt: receivedAt.toISOString(),
    });

    const scope = { organizationSlug: "acme", triggerId: trigger.id, runId: created.run.id };
    const detail = await dashboard.activityRunSnapshot(request, scope);
    assert.equal(detail.activity.prompt, "run it");
    assert.deepEqual(detail.activity.triggerContext, { request: "Full invocation context" });
    assert.equal("triggerContext" in after.activity[0]!, false);
    const step = (await database.listWorkflowStepRunsForTriggerRun(created.run.id))[0]!;
    const execution = await database.insertAgentExecution({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      machineId: null,
      configurationRevisionId: revision.id,
      triggerContext: {},
      outputContext: {},
      workflowStepRunId: step.id,
    });
    await database.linkWorkflowStepRunExecution(step.id, execution.id);
    for (let index = 0; index < 105; index++)
      await database.appendAgentExecutionLog({
        executionId: execution.id,
        recordedAt: receivedAt,
        event: { text: String(index) },
      });
    const first = await dashboard.activityRunLogs(request, {
      ...scope,
      executionId: execution.id,
      after: "0",
    });
    assert.equal(first.entries.length, 100);
    assert.ok(first.nextCursor);
    const last = await dashboard.activityRunLogs(request, {
      ...scope,
      executionId: execution.id,
      after: first.nextCursor,
    });
    assert.equal(last.entries.length, 5);
    assert.equal(last.nextCursor, null);
    assert.deepEqual(last.entries[4]?.event, { text: "104" });
    assert.equal(
      (await dashboard.activityRunSnapshot(request, scope)).activity.steps[0]?.executionId,
      execution.id,
    );

    await assert.rejects(
      dashboard.activityRunTimeline(request, { ...scope, executionId: "unrelated-execution" }),
      /run_unavailable/u,
    );
    assert.equal(
      (await dashboard.activityRunTimeline(request, { ...scope, executionId: execution.id }))
        .sessionId,
      null,
    );
    const other = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml.replace("manual-task", "other-task"), userId: "user-1" });
    await assert.rejects(
      dashboard.activityRunSnapshot(request, { ...scope, triggerId: other.id }),
      /run_unavailable/u,
    );
    await assert.rejects(
      dashboard.activityRunSnapshot(request, { ...scope, organizationSlug: "other-org" }),
      /tenant route not found/u,
    );
    await assert.rejects(
      dashboard.activityRunLogs(request, {
        ...scope,
        executionId: "unrelated-execution",
        after: "0",
      }),
      /run_unavailable/u,
    );

    const failureReason =
      "Review tool access denied (Operation not permitted); no Review published";
    await database.failWorkflowRun(created.run.id, "failed", failureReason, "run");
    const failed = (await dashboard.snapshot(request, "acme")).activity[0];
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.failureReason, failureReason);
    assert.equal(
      (await dashboard.activityRunSnapshot(request, scope)).activity.failureReason,
      failureReason,
    );
  });

  it("opens historical runs only through the matching migrated trigger", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "member-1",
          role: "member",
        },
      ],
    });
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Legacy",
      slug: "legacy",
      createdByUserId: null,
    });
    const bundle = compileHubBundle([
      {
        path: ".miko/hub.yml",
        content:
          "environments:\n  runner: { kind: daemon, daemon: devbox, cwd: /workspace }\nagents:\n  coder: { provider: codex }\n",
      },
      ...["first", "second"].map((name) => ({
        path: `.miko/workflows/${name}.yml`,
        content: `name: ${name}\non: manual.run\nmax_runtime: 2h\nsteps:\n  - id: work\n    environment: runner\n    max_runtime: 1h\n    idle_timeout: 10m\n    agent: coder\n    prompt: [{ text: Work }]\n`,
      })),
    ]);
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {
        kind: "manual",
        bundle: { authoredHash: bundle.authoredHash, files: bundle.files },
      },
      normalizedConfiguration: bundle.configuration,
      contentHash: bundle.authoredHash,
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id);
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "historical",
      source: "manual.run",
      payload: { historical: true },
      receivedAt: new Date(),
    });
    if (receipt.status !== "accepted") throw new Error("receipt rejected");
    const created = await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "first",
      prompt: "Historical prompt",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(Date.now() + 60_000),
      stepIds: [],
    });
    await migrateLegacyProjectTriggers(database);
    const triggers = await database.listOrganizationTriggers("org-1");
    const first = triggers.find(({ name }) => name === "first")!;
    const second = triggers.find(({ name }) => name === "second")!;
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const request = new Request("https://hub.test/o/acme/activity");
    const scope = { organizationSlug: "acme", triggerId: first.id, runId: created.run.id };
    assert.equal(
      (await dashboard.activityRunSnapshot(request, scope)).activity.prompt,
      "Historical prompt",
    );
    await assert.rejects(
      dashboard.activityRunSnapshot(request, { ...scope, triggerId: second.id }),
      /run_unavailable/u,
    );
    assert.deepEqual(
      (await dashboard.triggerHistory(request, "acme", first.id)).map((run) => run.id),
      [created.run.id],
    );
    assert.deepEqual(await dashboard.triggerHistory(request, "acme", second.id), []);
  });
});

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
