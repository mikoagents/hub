import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";

it("persists execution logs across reopen and pages without mixing executions or losing entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-execution-logs-"));
  const directory = join(root, "database");
  const first = await embeddedDatabaseRuntime(directory);
  const database = createDatabase(first.runtime, first.locks);
  let reopened: Awaited<ReturnType<typeof embeddedDatabaseRuntime>> | undefined;
  try {
    await first.runtime.migrate();
    await first.runtime.query(
      "insert into organization (id, name, slug) values ('logs', 'Logs', 'logs')",
    );
    const project = await database.createProject({
      organizationId: "logs",
      name: "Logs",
      slug: "logs",
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "logs",
    });
    const input = {
      organizationId: "logs",
      projectId: project.id,
      machineId: null,
      configurationRevisionId: revision.id,
      triggerContext: {},
      outputContext: {},
    };
    const execution = await database.insertAgentExecution(input);
    const other = await database.insertAgentExecution(input);
    const recordedAt = new Date("2026-11-09T12:00:00.000Z");
    for (let index = 0; index < 105; index++) {
      await database.appendAgentExecutionLog({
        executionId: execution.id,
        recordedAt,
        event: { text: `message ${String(index)}` },
      });
      if (index === 50)
        await database.appendAgentExecutionLog({
          executionId: other.id,
          recordedAt,
          event: { text: "other execution" },
        });
    }
    await database.close();
    reopened = await embeddedDatabaseRuntime(directory);
    const persisted = createDatabase(reopened.runtime, reopened.locks);
    const page = await persisted.listAgentExecutionLogs(execution.id, "0", 100);
    assert.equal(page.length, 100);
    assert.deepEqual(page[0]?.event, { text: "message 0" });
    assert.equal(page[0]?.recordedAt.toISOString(), recordedAt.toISOString());
    const tail = await persisted.listAgentExecutionLogs(execution.id, page[99]!.id, 100);
    assert.deepEqual(
      tail.map(({ event }) => event),
      Array.from({ length: 5 }, (_, index) => ({ text: `message ${String(index + 100)}` })),
    );
    await reopened.runtime.query("delete from agent_executions where id = $1", [execution.id]);
    assert.deepEqual(await persisted.listAgentExecutionLogs(execution.id, "0", 100), []);
    assert.equal((await persisted.listAgentExecutionLogs(other.id, "0", 100)).length, 1);
  } finally {
    await (reopened?.runtime ?? first.runtime).close();
    await rm(root, { recursive: true, force: true });
  }
});
