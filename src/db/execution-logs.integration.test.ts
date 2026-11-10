import { randomUUID } from "node:crypto";
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
    const sessionId = randomUUID();
    await first.runtime.query(
      "insert into agent_sessions (id, organization_id, project_id, data) values ($1, 'logs', $2, '{}'::jsonb)",
      [sessionId, project.id],
    );
    const transcript = {
      epoch: "one",
      reset: false,
      hasOlder: false,
      hasNewer: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      agent: {
        nativeAgentId: "native",
        provider: "codex",
        providerSessionId: "provider",
        status: "idle" as const,
        cwd: "/repo",
        model: null,
      },
      rows: [
        {
          seq: 1,
          timestamp: "2026-11-09T12:00:00Z",
          item: { type: "assistant_message", text: "retained" },
        },
      ],
    };
    await database.sessionTimelines.save(sessionId, transcript);
    await database.sessionTimelines.save(sessionId, {
      ...transcript,
      rows: [
        ...transcript.rows,
        {
          seq: 2,
          timestamp: "2026-11-09T12:00:01Z",
          item: { type: "assistant_message", text: "second" },
        },
      ],
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
    assert.deepEqual(
      (await persisted.sessionTimelines.rows(sessionId)).map((row) => row.item["text"]),
      ["retained", "second"],
    );
    await persisted.sessionTimelines.save(sessionId, {
      ...transcript,
      epoch: "two",
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
    });
    assert.equal((await persisted.sessionTimelines.rows(sessionId)).length, 1);
    assert.equal((await persisted.sessionTimelines.state(sessionId))?.epoch, "two");
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
