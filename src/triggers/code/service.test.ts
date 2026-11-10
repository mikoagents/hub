import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createFetchServer } from "../../http/node-server.js";
import { createPublicApi } from "../../public-api/index.js";
import {
  artifactDigest,
  validateArtifact,
  matchesPattern,
  type TriggerArtifact,
} from "./contract.js";
import { TriggerCodeService, type TriggerCodeAgentHost } from "./service.js";
import { createTriggerCodeApi } from "./api.js";
import { executeTriggerJob, type TriggerRunnerOptions } from "./runner.js";
import { buildTrigger } from "./build.js";
import type { TriggerJob } from "./service.js";
import type { OperationRequest, TriggerEvent } from "./sdk.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("code-authored Triggers", () => {
  it("builds a multi-file TypeScript project and verifies every artifact byte", async () => {
    const root = await mkdtemp(join(process.cwd(), "node_modules", ".trigger-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "helper.ts"),
      "export const multiply = (value: number) => value * 3;\n",
    );
    await writeFile(
      join(root, "workflow.ts"),
      `import { defineTrigger } from "@getpaseo/hub/triggers";
      import { multiply } from "./helper";
      import { z } from "zod";
      export default defineTrigger({ name: "typed", runner: "local", grants: {}, on: [{source:"manual",event:"run"}], limits: {maxRuntime:"1h"}, async run(ctx) { return multiply(z.number().parse(ctx.event.payload)); } });`,
    );
    const built = await buildTrigger(join(root, "workflow.ts"));
    assert.equal(built.entrypoint, "workflow.ts");
    assert.deepEqual(
      built.sources.map((file) => file.path),
      ["helper.ts", "workflow.ts"],
    );
    assert.equal(validateArtifact(built).manifest.name, "typed");
    assert.throws(
      () => validateArtifact({ ...built, code: `${built.code}\n// altered` }),
      /digest/u,
    );
    const { digest: _digest, ...body } = built;
    const missingEntry = { ...body, entrypoint: "missing.ts" };
    assert.throws(
      () => validateArtifact({ ...missingEntry, digest: artifactDigest(missingEntry) }),
      /entrypoint must reference a source file/u,
    );
    const fixture = await setup();
    await fixture.service.deploy("org", built);
    const run = await fixture.start("typed", 7);
    await fixture.execute();
    assert.equal((await fixture.detail(run.id)).output, 21);
  }, 30_000);

  it("suspends a real worker, recreates Hub coordination, and never repeats a completed external step", async () => {
    let effects = 0;
    const fixture = await setup((path) =>
      path === "/effect" ? Response.json({ value: ++effects }) : undefined,
    );
    const code = `export default {async run(ctx) {
      const result = await ctx.step("fetch", null, async () => (await fetch(${JSON.stringify(`${fixture.url}/effect`)})).json());
      await ctx.sleep("pause", 1000);
      return {value:result.value, database:process.env.DATABASE_URL ?? null, miko:process.env.MIKO_HOME ?? null};
    }};`;
    await fixture.service.deploy("org", artifact(code));
    const run = await fixture.start("example");
    const prior = {
      DATABASE_URL: process.env["DATABASE_URL"],
      MIKO_HOME: process.env["MIKO_HOME"],
    };
    process.env["DATABASE_URL"] = "postgres://production-must-never-be-inherited";
    process.env["MIKO_HOME"] = "/production-miko-must-never-be-inherited";
    try {
      await fixture.execute();
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal((await fixture.detail(run.id)).status, "waiting");
    fixture.restart();
    fixture.advance(1001);
    await fixture.execute();
    assert.equal(effects, 1);
    assert.deepEqual((await fixture.detail(run.id)).output, {
      value: 1,
      database: null,
      miko: null,
    });
  }, 30_000);

  it("recovers after graceful runner shutdown without failing the parent or repeating its completed write", async () => {
    let writes = 0;
    const fixture = await setup((path) =>
      path === "/write" ? Response.json(++writes) : undefined,
    );
    await fixture.service.deploy(
      "org",
      artifact(`export default {async run(ctx){
      const write = await ctx.step("write", null, async () => (await fetch(${JSON.stringify(`${fixture.url}/write`)})).json());
      await new Promise(resolve => setTimeout(resolve, 500));
      return write;
    }};`),
    );
    const run = await fixture.start("example");
    const controller = new AbortController();
    const execution = fixture.execute({ signal: controller.signal });
    await expect
      .poll(() => fixture.operation(run.id, "write"))
      .toMatchObject({ status: "completed" });
    controller.abort();
    await execution;
    assert.equal((await fixture.detail(run.id)).status, "running");
    fixture.restart();
    fixture.advance(30_001);
    await fixture.execute();
    assert.equal((await fixture.detail(run.id)).status, "succeeded");
    assert.equal(writes, 1);
  }, 30_000);

  it("passes only granted secrets and redacts escaped strings throughout structured worker logs", async () => {
    const fixture = await setup();
    const code = artifact(`export default {async run(ctx){
      const secret=ctx.secret("AUTH_TOKEN");
      console.info("Token",secret);
      await ctx.log("Structured token",{nested:[secret], [secret]:secret});
      try {ctx.secret("constructor");} catch {return {inherited:false};}
      return {inherited:true};
    }};`);
    code.manifest.grants = { secrets: ["AUTH_TOKEN"] };
    const { digest: _digest, ...body } = code;
    code.digest = artifactDigest(body);
    await fixture.service.deploy("org", code);
    const run = await fixture.start("example");
    const secret = 'private-"escaped"-token';
    await fixture.execute({ secrets: { AUTH_TOKEN: secret, UNGRANTED: "must-not-pass" } });
    const logs = await fixture.database.triggerCode.transaction("org", (tx) => tx.logs(run.id));
    assert.equal(logs.length, 2);
    assert.equal(JSON.stringify(logs).includes("escaped"), false);
    assert.match(JSON.stringify(logs), /redacted/u);
    assert.deepEqual((await fixture.detail(run.id)).output, { inherited: false });
  });

  it("persists event timeouts so code can handle them after a restart", async () => {
    const fixture = await setup();
    await fixture.service.deploy(
      "org",
      artifact(
        `export default {async run(ctx){
      try { await ctx.waitForEvent("missing", {source:"ci",event:"done",timeout:"1s"}); }
      catch (error) { return {handled:error.message}; }
      return {handled:false};
    }};`,
        [
          { source: "manual", event: "run" },
          { source: "ci", event: "done" },
        ],
      ),
    );
    const run = await fixture.start("example");
    await fixture.execute();
    assert.equal((await fixture.detail(run.id)).status, "waiting");
    fixture.restart();
    fixture.advance(1001);
    await fixture.execute();
    assert.equal((await fixture.detail(run.id)).status, "succeeded");
    assert.deepEqual((await fixture.detail(run.id)).output, {
      handled: "Timed out waiting for Trigger event",
    });
  });

  it("leases each queued run once under concurrent runner polling and joins parallel steps", async () => {
    const fixture = await setup();
    await fixture.service.deploy(
      "org",
      artifact(`export default {async run(ctx){
      return Promise.all([1,2,3].map(n=>ctx.step("parallel:"+n,{n},async input=>input.n*2)));
    }};`),
    );
    const runs = await Promise.all(Array.from({ length: 3 }, () => fixture.start("example")));
    await Promise.all(runs.map(() => fixture.execute()));
    const done = await Promise.all(runs.map((run) => fixture.detail(run.id)));
    assert.deepEqual(
      done.map((run) => run.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    for (const run of done) assert.deepEqual(run.output, [2, 4, 6]);
  });

  it("keeps every run pinned to its code revision while preserving Trigger identity", async () => {
    const fixture = await setup();
    const first = await fixture.service.deploy(
      "org",
      artifact("export default {run(){return 'first'}}"),
    );
    const old = await fixture.start("example");
    const next = await fixture.service.deploy(
      "org",
      artifact("export default {run(){return 'second'}}"),
    );
    assert.equal(next.triggerId, first.triggerId);
    assert.equal(next.version, 2);
    const fresh = await fixture.start("example");
    await fixture.execute();
    await fixture.execute();
    assert.equal((await fixture.detail(old.id)).output, "first");
    assert.equal((await fixture.detail(fresh.id)).output, "second");
  }, 30_000);

  it("handles CI events arriving before registration, arbitrary predicates and duplicate deliveries", async () => {
    const fixture = await setup();
    const built = artifact(
      `export default {async run(ctx){ const event = await ctx.waitForEvent("ci", {source:"ci",event:"workflow.*",timeout:"1m",where:e=>e.payload.passed===true}); return event.payload; }};`,
      [
        { source: "manual", event: "run" },
        { source: "ci", event: "workflow.*" },
      ],
    );
    const deployed = await fixture.service.deploy("org", built);
    const run = await fixture.start("example");
    await fixture.service.receive("org", deployed.triggerId, {
      id: "ci-1",
      source: "ci",
      type: "workflow.completed",
      payload: { passed: false },
      receivedAt: new Date().toISOString(),
    });
    const event = {
      id: "ci-2",
      source: "ci",
      type: "workflow.completed",
      payload: { passed: true },
      receivedAt: new Date().toISOString(),
    };
    await fixture.service.receive("org", deployed.triggerId, event);
    assert.equal((await fixture.service.receive("org", deployed.triggerId, event)).created, false);
    for (
      let attempt = 0;
      attempt < 10 && (await fixture.detail(run.id)).status !== "succeeded";
      attempt++
    )
      await fixture.execute();
    assert.equal((await fixture.detail(run.id)).status, "succeeded");
    assert.deepEqual((await fixture.detail(run.id)).output, { passed: true });
    assert.equal(matchesPattern("issue_comment.created", "issue_comment.*"), true);
  }, 30_000);

  it("keeps old custom subscriptions without accepting a newer revision's expanded resource scope", async () => {
    const fixture = await setup();
    const code =
      "export default {async run(ctx){if(ctx.event.source!=='manual')return null; return (await ctx.waitForEvent('ci',{source:'ci',event:'workflow.completed',timeout:'1m'})).resource;}};";
    const first = artifact(code, [
      { source: "manual", event: "run" },
      { source: "ci", event: "workflow.completed", resource: "alpha" },
    ]);
    const deployed = await fixture.service.deploy("org", first);
    const old = await fixture.start("example");
    await fixture.execute();
    const second = artifact(code, [
      { source: "manual", event: "run" },
      { source: "ci", event: "workflow.completed", resource: "beta" },
    ]);
    await fixture.service.deploy("org", second);
    await fixture.service.publishEvent("org", deployed.triggerId, {
      id: "beta",
      source: "ci",
      type: "workflow.completed",
      resource: "beta",
      receivedAt: new Date().toISOString(),
      payload: null,
    });
    await fixture.execute();
    assert.equal((await fixture.detail(old.id)).status, "waiting");
    const delivered = await fixture.service.publishEvent("org", deployed.triggerId, {
      id: "alpha",
      source: "ci",
      type: "workflow.completed",
      resource: "alpha",
      receivedAt: new Date().toISOString(),
      payload: null,
    });
    assert.equal(delivered.created, false);
    await fixture.execute();
    assert.equal((await fixture.detail(old.id)).output, "alpha");
  });

  it("rejects stale workers, marks uncertain side effects and detects nondeterministic replay", async () => {
    const fixture = await setup();
    await fixture.service.deploy("org", artifact("export default {run(){return null}}"));
    const run = await fixture.start("example");
    const first = await fixture.lease();
    const request: OperationRequest = { id: "write", kind: "step", input: { value: 1 } };
    assert.equal(
      (await fixture.service.operation("org", run.id, first.leaseToken, request)).status,
      "execute",
    );
    fixture.advance(30_001);
    const second = await fixture.lease();
    await assert.rejects(
      fixture.service.completeOperation("org", run.id, first.leaseToken, "write", {
        output: "too late",
      }),
      /stale/u,
    );
    const result = await fixture.service.operation("org", run.id, second.leaseToken, request);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /unknown external outcome/u);
    await assert.rejects(
      fixture.service.operation("org", run.id, second.leaseToken, {
        ...request,
        input: { value: 2 },
      }),
      /Nondeterministic/u,
    );
  });

  it("serializes durable locks, scopes claims across runs, and rejects out-of-grant agent execution", async () => {
    const fixture = await setup();
    await fixture.service.deploy("org", artifact("export default {run(){return null}}"));
    await fixture.start("example");
    await fixture.start("example");
    const a = await fixture.lease(),
      b = await fixture.lease();
    const op = (job: TriggerJob, id: string, kind: string, input: unknown) =>
      fixture.service.operation("org", job.run.id, job.leaseToken, { id, kind, input });
    assert.deepEqual(await op(a, "claim", "claim", { key: "head:1" }), {
      status: "completed",
      output: true,
    });
    assert.deepEqual(await op(b, "claim", "claim", { key: "head:1" }), {
      status: "completed",
      output: false,
    });
    assert.equal((await op(a, "lock", "lock", { key: "pr:1" })).status, "completed");
    assert.equal((await op(b, "lock", "lock", { key: "pr:1" })).status, "waiting");
    await fixture.service.report("org", b.run.id, b.leaseToken, {
      status: "suspended",
      waitingFor: ["lock"],
    });
    await op(a, "unlock", "unlock", { key: "pr:1" });
    await fixture.service.report("org", a.run.id, a.leaseToken, {
      status: "succeeded",
      output: null,
    });
    const resumed = await fixture.lease();
    assert.equal(resumed.run.id, b.run.id);
    assert.equal((await op(resumed, "lock", "lock", { key: "pr:1" })).status, "completed");
    await assert.rejects(
      op(resumed, "agent", "agent", {
        target: "constructor",
        agent: { provider: "codex" },
        prompt: "hello",
        maxRuntime: "1m",
        idleTimeout: "1m",
      }),
      /not granted/u,
    );
    await assert.rejects(
      fixture.service.operation("another-org", b.run.id, resumed.leaseToken, {
        id: "read",
        kind: "state.get",
        input: { key: "secret" },
      }),
      /not found/u,
    );
  });

  it("propagates parent cancellation and deadlines and cannot forge native provider events through the API", async () => {
    const fixture = await setup();
    await fixture.service.deploy("org", artifact("export default {run(){return null}}"));
    const run = await fixture.start("example");
    await fixture.service.cancel("org", run.id);
    assert.equal((await fixture.detail(run.id)).status, "cancelled");
    const waiting = await fixture.start("example");
    fixture.advance(3_600_001);
    await fixture.service.tick();
    assert.equal((await fixture.detail(waiting.id)).status, "timed_out");
    const response = await fetch(`${fixture.url}/api/v1/triggers/example/events`, {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({
        id: "fake",
        source: "github",
        type: "pull_request.opened",
        payload: {},
      }),
    });
    assert.equal(response.status, 403);
  });
});

function artifact(
  code: string,
  on: TriggerArtifact["manifest"]["on"] = [{ source: "manual", event: "run" }],
): TriggerArtifact {
  const body = {
    format: "trigger-code-v1" as const,
    manifest: { name: "example", runner: "local", on, grants: {}, limits: { maxRuntime: "1h" } },
    code,
    sources: [{ path: "trigger.js", content: code }],
  };
  return { ...body, digest: artifactDigest(body) };
}

async function setup(extra?: (path: string) => Response | undefined) {
  const database = createMemoryDatabase({ organizationIds: ["org", "another-org"] });
  let now = Date.now();
  const host: TriggerCodeAgentHost = {
    ensure: async () => {},
    cancel: async () => {},
    github: async () => {
      throw new Error("No GitHub grant");
    },
  };
  let service = new TriggerCodeService(database, host, () => new Date(now));
  const composition = {
    status: "enabled" as const,
    authenticator: {
      async authorize(request: Request) {
        return request.headers.get("authorization") === "Bearer operator"
          ? {
              status: "authorized" as const,
              access: {
                kind: "apiKey" as const,
                credentialId: "operator",
                organizationId: "org",
                scopes: [],
              },
            }
          : { status: "unauthorized" as const };
      },
    },
  };
  const server = createFetchServer(
    (request) =>
      extra?.(new URL(request.url).pathname) ??
      createTriggerCodeApi(
        service,
        composition,
        createPublicApi({ status: "unavailable" }, null),
      ).handle(request),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "hub-code-runner-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.once("close", resolve);
        server.closeAllConnections();
        server.close();
      }),
  );
  const enrolled = await service.enroll("org", "local");
  const runner = await service.runner(enrolled.token);
  const lease = async () => {
    const job = await service.lease(runner);
    assert.ok(job);
    return job;
  };
  return {
    database,
    url,
    get service() {
      return service;
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    restart() {
      service = new TriggerCodeService(database, host, () => new Date(now));
    },
    async start(name: string, input: TriggerEvent["payload"] = null) {
      const trigger = await service.trigger("org", name);
      const result = await service.receive("org", trigger.id, {
        id: randomUUID(),
        source: "manual",
        type: "run",
        payload: input,
        receivedAt: new Date(now).toISOString(),
      });
      assert.ok(result.run);
      return result.run;
    },
    operation: (runId: string, id: string) =>
      database.triggerCode.transaction("org", (tx) => tx.getOperation(runId, id)),
    async detail(id: string) {
      const run = await database.triggerCode.transaction("org", (tx) => tx.getRun(id));
      assert.ok(run);
      return run;
    },
    lease,
    async execute(options: Partial<TriggerRunnerOptions> = {}) {
      const job = await lease();
      await executeTriggerJob(job, { url, token: enrolled.token, directory, ...options });
    },
  };
}
