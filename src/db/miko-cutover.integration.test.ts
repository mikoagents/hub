import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("cutover refuses active work, then retires old daemon authority and continuation keys after draining", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
     create table agent_executions (daemon_id text,status text);
     create table daemons (id text,status text,presence text,disconnected_at timestamptz);
     create table agent_sessions (continuation_key text,data jsonb);
     insert into agent_executions values (null,'spawning');
     insert into daemons values ('old-daemon','active','connected',null);
     insert into agent_sessions values ('conversation','{"continuationKey":"conversation","agentId":"native-agent"}');
   `);
    const migration = await readFile(
      new URL("../../drizzle/0051_miko_execution_cutover.sql", import.meta.url),
      "utf8",
    );
    await expect(
      database.transaction(async (transaction) => transaction.exec(migration)),
    ).rejects.toThrow("draining or cancelling");
    expect((await database.query("select status from daemons")).rows).toEqual([
      { status: "active" },
    ]);
    await database.exec("update agent_executions set status='failed'");
    await database.transaction(async (transaction) => transaction.exec(migration));
    expect((await database.query("select id,status,presence from daemons")).rows).toEqual([
      { id: "old-daemon", status: "revoked", presence: "offline" },
    ]);
    expect((await database.query("select continuation_key,data from agent_sessions")).rows).toEqual(
      [{ continuation_key: null, data: { continuationKey: null, agentId: "native-agent" } }],
    );
  } finally {
    await database.close();
  }
});

test("removing backends refuses active work and releases local and remote continuations without changing history", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      create table agent_executions (status text);
      create table agent_sessions (continuation_key text, data jsonb);
      insert into agent_executions values ('running');
    `);
    for (const backend of ["local", "workstation"]) {
      await database.query("insert into agent_sessions values ($1, $2)", [
        backend,
        {
          continuationKey: backend,
          agentId: `agent-${backend}`,
          creationOptions: { backend, provider: "codex", cwd: "/repo" },
          runtimeBinding: { backend, provider: "codex", nativeAgentId: `native-${backend}` },
        },
      ]);
    }
    const migration = await readFile(
      new URL("../../drizzle/0053_remove_execution_backends.sql", import.meta.url),
      "utf8",
    );
    await expect(
      database.transaction(async (transaction) => transaction.exec(migration)),
    ).rejects.toThrow("draining or cancelling");
    expect(
      (
        await database.query(
          "select continuation_key from agent_sessions order by continuation_key",
        )
      ).rows,
    ).toEqual([{ continuation_key: "local" }, { continuation_key: "workstation" }]);
    await database.exec("update agent_executions set status='succeeded'");
    await database.transaction(async (transaction) => transaction.exec(migration));
    expect(
      (
        await database.query(
          "select continuation_key, data from agent_sessions order by data->>'agentId'",
        )
      ).rows,
    ).toEqual(
      ["local", "workstation"].map((id) => ({
        continuation_key: null,
        data: {
          continuationKey: null,
          agentId: `agent-${id}`,
          creationOptions: { provider: "codex", cwd: "/repo" },
          runtimeBinding: { provider: "codex", nativeAgentId: `native-${id}` },
        },
      })),
    );
  } finally {
    await database.close();
  }
});
