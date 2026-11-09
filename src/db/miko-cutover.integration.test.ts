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
