import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../../db/runtime/index.js";
import { createDatabase } from "../../db/pg.js";
import { createHubApplication, type HubApplication } from "../../app.js";
import { createFetchServer } from "../../http/node-server.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { ScheduleTestDaemon } from "../schedule/test-daemon.js";
import { createExecutionAuthority } from "../../execution-authority/index.js";
import { executeTriggerJob } from "./runner.js";

export async function setupCodeStorage(
  kind: "embedded" | "postgres",
  postgresUri?: string,
  github = false,
) {
  const root = await mkdtemp(join(tmpdir(), "hub-code-storage-"));
  const connection = kind === "postgres" ? new URL(postgresUri!) : undefined;
  if (connection) connection.pathname = `/trigger_${randomUUID().replaceAll("-", "")}`;
  const open = () =>
    connection === undefined
      ? embeddedDatabaseRuntime(join(root, "database"))
      : postgresDatabaseRuntime(connection.href);
  let bundle: DatabaseRuntimeBundle = await open();
  await bundle.runtime.migrate();
  let database = createDatabase(bundle.runtime, bundle.locks);
  await bundle.runtime.query(
    "insert into organization (id,name,slug) values ('code-org','Code tests','code-tests')",
  );
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: "test-enrollment",
    organizationId: "code-org",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  const daemonId = randomUUID();
  await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    suggestedSlug: "devbox",
    tokenVerifier: "test-enrollment",
    serverId: randomUUID(),
    daemonPublicKey: "test-public",
    credentialVerifier: "test-credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  if (github) {
    await bundle.runtime.query(`insert into github_connections
      (id,organization_id,installation_id,slug,account_id,account_login,account_type,status)
      values ('00000000-0000-4000-8000-0000000000c2','code-org',42,'github','example','example','Organization','active')`);
    await bundle.runtime.query(`insert into github_repositories
      (organization_id,connection_id,repository_id,full_name,default_branch)
      values ('code-org','00000000-0000-4000-8000-0000000000c2',9001,'example/project','main')`);
  }
  let app: HubApplication;
  const daemon = new ScheduleTestDaemon();
  let connected = true;
  const server = createFetchServer((request) => {
    const path = new URL(request.url).pathname;
    const session = /^\/agent-sessions\/([^/]+)\/mcp$/u.exec(path)?.[1];
    return session === undefined
      ? app.publicApi.handle(request)
      : app.operations.handleSessionCapabilities(request, session);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const authority = {
    mint: async () => ({
      token: "local-github-test-credential",
      expiresAt: Date.now() + 60_000,
      botUserId: 1,
      botLogin: "replace-with-your-app[bot]",
    }),
    revoke: async () => {},
  };
  const make = () =>
    createHubApplication({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      publicBaseUrl: url,
      completionTokenSecret: "isolated-trigger-test-secret-more-than-32-characters",
      publicApi: { status: "unavailable" },
      ...(github
        ? {
            githubAuthority: authority,
            executionAuthority: createExecutionAuthority({
              database,
              githubAuthority: authority,
              connectionsForProject: () => async () => {
                throw new Error("Unexpected connection");
              },
              isExecutionActive: async (id) => {
                const execution = await database.findAgentExecutionById(id);
                return execution?.status === "running" || execution?.status === "spawning";
              },
            }),
          }
        : {}),
      daemonConnectionForId: (id) => (id === daemonId && connected ? daemon : undefined),
    });
  app = make();
  await app.hub.start();
  const credential = await app.hub.triggerCode!.enroll("code-org", "test");
  return {
    daemon,
    setConnected(value: boolean) {
      connected = value;
    },
    url,
    root,
    database: () => database,
    bundle: () => bundle,
    service: () => app.hub.triggerCode!,
    async execute() {
      const service = app.hub.triggerCode!;
      const runner = await service.runner(credential.token);
      let job = await service.lease(runner);
      for (let attempt = 0; job === null && attempt < 10; attempt++) {
        await app.hub.processWorkflowOutbox();
        await service.tick();
        job = await service.lease(runner);
      }
      assert.ok(job);
      await executeTriggerJob(job, { url, token: credential.token, directory: root });
    },
    async read(id: string) {
      const run = await database.triggerCode.transaction("code-org", (tx) => tx.getRun(id));
      assert.ok(run);
      return run;
    },
    async finish(index: number, args: Record<string, unknown>) {
      const mcp = daemon.launches[index]?.mcpServers?.["hub"];
      assert.ok(mcp && mcp.type === "http");
      const client = new Client({ name: "trigger-code-test", version: "1.0.0" });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
          requestInit: mcp.headers === undefined ? {} : { headers: mcp.headers },
        });
        // The official SDK getter is string | undefined while Transport uses exact-optional string.
        // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
        await client.connect(transport);
        const sessionId = new URL(mcp.url).pathname.split("/")[2]!;
        const executions = await database.listAgentSessionExecutions(sessionId);
        const execution =
          executions.find((item) => item.status === "running" || item.status === "spawning") ??
          executions[0];
        assert.ok(execution);
        return await client.callTool({
          name: "finish_execution",
          arguments: { executionId: execution.id, ...args },
        });
      } finally {
        await client.close();
      }
    },
    async restart() {
      await app.hub.stop();
      await bundle.runtime.close();
      bundle = await open();
      database = createDatabase(bundle.runtime, bundle.locks);
      app = make();
      await app.hub.start();
    },
    async close() {
      await app.hub.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await bundle.runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
