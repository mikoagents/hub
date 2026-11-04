import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { embeddedDatabaseRuntime, postgresDatabaseRuntime } from "./runtime/index.js";
import { createDatabase } from "./pg.js";

// This uses the real embedded PostgreSQL engine and migrations. The public repository boundary
// covers transaction races and restart persistence without launching an external coding agent.
describe("user queues repair work durably", () => {
  it.each(["embedded", "postgres"] as const)(
    "user gets one run and an exclusive repair queue across restarts on %s",
    async (storage) => {
      // Given persisted organization, project, and configuration records.
      const root = await mkdtemp(join(tmpdir(), "hub-coordination-"));
      const postgres =
        storage === "postgres"
          ? await new PostgreSqlContainer("postgres:17-alpine").start()
          : undefined;
      const open = () =>
        postgres === undefined
          ? embeddedDatabaseRuntime(root)
          : postgresDatabaseRuntime(postgres.getConnectionUri());
      let bundle = await open();
      await bundle.runtime.migrate();
      let database = createDatabase(bundle.runtime, bundle.locks);
      try {
        await bundle.runtime.query(
          `insert into organization (id, name, slug, created_at) values ('coord-org', 'Coordination', 'coord-org', now())`,
        );
        const project = await database.createProject({
          organizationId: "coord-org",
          name: "Repairs",
          slug: "repairs",
          createdByUserId: null,
        });
        const revision = await database.insertProjectConfigurationRevision({
          projectId: project.id,
          sourceKind: "manual",
          sourceEvidence: {},
          normalizedConfiguration: {},
          contentHash: "coordination",
        });
        await database.activateProjectConfigurationRevision(project.id, revision.id);
        const enqueue = async (key: string) => {
          const receipt = await database.persistManualEvent({
            organizationId: "coord-org",
            projectId: project.id,
            deliveryId: randomUUID(),
            source: "manual.run",
            payload: {},
            receivedAt: new Date(),
          });
          if (receipt.status !== "accepted") throw new Error("event rejected");
          return database.createAcceptedTriggerRun({
            organizationId: "coord-org",
            projectId: project.id,
            configurationRevisionId: revision.id,
            providerEventReceiptId: receipt.event.providerEventReceiptId,
            configuredTriggerName: "repair",
            prompt: "Repair",
            inputs: {},
            triggerContext: {},
            outputContext: {},
            deadlineAt: new Date(Date.now() + 60_000),
            stepIds: ["run"],
            concurrencyKey: "PR:1053",
            idempotencyKey: key,
          });
        };
        // When two different deliveries describe the same completed attempt, including after restart.
        const concurrent = await Promise.all([
          enqueue("coverage:41770361160:2"),
          enqueue("coverage:41770361160:2"),
        ]);
        const first = concurrent.find((result) => result.created)!;
        const replay = concurrent.find((result) => !result.created)!;
        await database.close();
        bundle = await open();
        database = createDatabase(bundle.runtime, bundle.locks);
        const restarted = await enqueue("coverage:41770361160:2");
        const nextAttempt = await enqueue("coverage:41770361160:3");
        // Then the original run survives exactly once, and a genuinely new attempt is accepted.
        assert.equal(first.created, true);
        assert.equal(replay.created, false);
        assert.equal(replay.run.id, first.run.id);
        assert.equal(restarted.created, false);
        assert.equal(restarted.run.id, first.run.id);
        assert.equal(nextAttempt.created, true);
        assert.notEqual(nextAttempt.run.id, first.run.id);
        // Given two distinct completed events for the same PR.
        const start = async (runId: string) => {
          const now = new Date();
          return database.createWorkflowStepExecution({
            triggerRunId: runId,
            stepId: "run",
            ordinal: 0,
            executionId: randomUUID(),
            execution: {
              organizationId: "coord-org",
              projectId: project.id,
              machineId: null,
              configurationRevisionId: revision.id,
              triggerContext: {},
              outputContext: {},
              startedAt: now,
              deadlineAt: new Date(now.getTime() + 60_000),
              idleDeadlineAt: new Date(now.getTime() + 60_000),
            },
          });
        };
        // When the first repair is active, including across a Hub restart.
        const [active, queued] = await Promise.all([
          start(first.run.id),
          start(nextAttempt.run.id),
        ]);
        assert.equal(active.created, true);
        assert.equal(queued.deferred, true);
        assert.equal(queued.execution, undefined);
        await database.close();
        bundle = await open();
        database = createDatabase(bundle.runtime, bundle.locks);
        const stillQueued = await start(nextAttempt.run.id);
        assert.equal(stillQueued.deferred, true);
        if (active.execution === undefined) throw new Error("repair execution missing");
        await database.completeWorkflowAgentExecution({
          executionId: active.execution.id,
          executionStatus: "succeeded",
          stepStatus: "succeeded",
          result: { repaired: true },
          hubAction: "archive",
        });
        await database.succeedTriggerRun(first.run.id);
        assert.equal((await start(nextAttempt.run.id)).deferred, true);
        await database.completeHubAction(active.execution.id, "archive");
        // Then exactly the queued repair starts once its predecessor has finished.
        const continued = await start(nextAttempt.run.id);
        assert.equal(continued.created, true);
        assert.equal(continued.execution?.status, "spawning");
      } finally {
        await database.close();
        await postgres?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
