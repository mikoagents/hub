import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { compileHubConfig } from "../config/compiler.js";
import { createGitHubTriggerProvider } from "../triggers/github/provider.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { hashTemplate, UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { DurableWorkflowEngine } from "./engine.js";
import { durableExecutionId } from "../daemons/lifecycle.js";

it("user queues CI follow-ups through the workflow engine without duplicate or overlapping repairs", async () => {
  // Given a real migrated embedded database and an opted-in GitHub CI trigger.
  // The execution transport below is the external Paseo boundary; this test proves Hub's
  // persisted dispatch contract and does not claim a real coding agent was launched.
  const root = await mkdtemp(join(tmpdir(), "hub-ci-dispatch-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(root);
  await runtime.migrate();
  const database = createDatabase(runtime, locks);
  const entitlements = composeEntitlements(database, runtime);
  await runtime.query(
    "insert into organization (id, name, slug) values ('ci-org', 'CI', 'ci-org')",
  );
  const project = await database.createProject({
    organizationId: "ci-org",
    name: "Repairs",
    slug: "repairs",
    createdByUserId: null,
  });
  await database.stampOrganizationEntitlements({
    organizationId: "ci-org",
    granted: UNLIMITED_TEMPLATE,
    planId: null,
    planVersion: hashTemplate(UNLIMITED_TEMPLATE),
    source: "provisioning",
    actor: null,
    reason: null,
  });
  const compiled = compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "repair",
        on: "github.workflow_run_completed",
        max_runtime: "1h",
        coordination: { serialize: "conversation", deduplicate: "event" },
        filters: { repo: "owner/repo", from_users: ["maintainer"] },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "30m",
            idle_timeout: "5m",
            agent: { provider: "codex" },
            prompt: [{ text: "Repair ${{ paseo.context }}" }],
          },
        ],
      },
    ],
  });
  const config = {
    ...compiled,
    environments: compiled.environments.map((environment) =>
      Object.assign({}, environment, {
        daemonId: randomUUID(),
      }),
    ),
  };
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: config,
    contentHash: "ci-dispatch",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  const provider = createGitHubTriggerProvider({
    configurationStoreForProject: () => new ProjectConfigurationStore(database, project.id),
    reactions: { createReaction: async () => null, deleteReaction: async () => undefined },
  });
  const engine = new DurableWorkflowEngine({
    database,
    providers: [provider],
    entitlements: entitlements.service,
    async dispatchLaunchMachineIntent(intent) {
      const result = await database.transitionAgentExecution(durableExecutionId(intent), "running");
      return { execution: result.execution };
    },
  });
  const deliver = async (attempt: number, pr = 1053) => {
    const id = randomUUID();
    const receivedAt = new Date();
    const payload = {
      id,
      type: "workflow_run",
      repo: "owner/repo",
      repositoryId: 7,
      installationId: 42,
      createdAt: receivedAt.toISOString(),
      payload: {
        action: "completed",
        sender: { login: "maintainer" },
        workflow_run: {
          id: 123,
          run_attempt: attempt,
          event: "pull_request",
          status: "completed",
          conclusion: "failure",
          head_sha: "head",
          pull_requests: [{ number: pr }],
        },
      },
    };
    const receipt = await database.persistManualEvent({
      organizationId: "ci-org",
      projectId: project.id,
      deliveryId: id,
      source: "github.workflow_run",
      payload,
      receivedAt,
    });
    if (receipt.status !== "accepted") throw new Error("receipt rejected");
    await engine.enqueue(receipt.event);
    return receipt.event.providerEventReceiptId;
  };
  try {
    // When GitHub sends a duplicate attempt and then new completed attempts for two PRs.
    const first = await deliver(1);
    await deliver(1);
    const queued = await deliver(2);
    const independent = await deliver(3, 1054);
    await engine.processAvailable();
    // Then only one repair is active per PR; a different PR can run independently.
    const runs = await runtime.query<{ count: string }>(
      "select count(*)::text as count from trigger_runs",
    );
    assert.equal(runs.rows[0]?.count, "3");
    const firstRun = (await database.findTriggerRunsByProviderEventReceiptId(first))[0]!;
    const queuedRun = (await database.findTriggerRunsByProviderEventReceiptId(queued))[0]!;
    const independentRun = (
      await database.findTriggerRunsByProviderEventReceiptId(independent)
    )[0]!;
    assert.equal(
      (await database.listWorkflowStepRunsForTriggerRun(firstRun.id))[0]?.status,
      "running",
    );
    assert.equal(
      (await database.listWorkflowStepRunsForTriggerRun(queuedRun.id))[0]?.status,
      "pending",
    );
    assert.equal(
      (await database.listWorkflowStepRunsForTriggerRun(independentRun.id))[0]?.status,
      "running",
    );
  } finally {
    await engine.stop();
    await entitlements.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
