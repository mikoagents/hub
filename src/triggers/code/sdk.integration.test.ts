import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { createFetchServer } from "../../http/node-server.js";
import { setupCodeStorage } from "./test-fixture.js";
import { buildTrigger } from "./build.js";

afterEach(() => vi.restoreAllMocks());

it("uses the packaged author API across JSONB recovery, a transient read failure, native completion, and an ambiguous comment write", async () => {
  const fixture = await setupCodeStorage("embedded", undefined, true);
  let reads = 0,
    posts = 0;
  const comments = [
    {
      id: 80,
      body: "Earlier discussion",
      user: { login: "human" },
      issue_url: "https://api.github.com/repos/example/project/issues/1",
      html_url: "https://github.com/example/project/issues/1#issuecomment-80",
    },
    {
      id: 81,
      body: "More discussion",
      user: { login: "human" },
      issue_url: "https://api.github.com/repos/example/project/issues/1",
      html_url: "https://github.com/example/project/issues/1#issuecomment-81",
    },
  ];
  const remote = createFetchServer(async (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer local-github-test-credential");
    const path = new URL(request.url).pathname;
    if (path.endsWith("/issues/1")) {
      if (reads++ === 0)
        return new Response("temporary", {
          status: 503,
          headers: { "x-github-request-id": "read-1" },
        });
      return Response.json({
        number: 1,
        title: "Request",
        user: { login: "human", id: 2 },
        labels: [{ name: "test", color: "red" }],
      });
    }
    if (path.endsWith("/comments") && request.method === "POST") {
      posts++;
      const body: unknown = await request.json();
      assert.ok(
        body && typeof body === "object" && "body" in body && typeof body.body === "string",
      );
      const comment = {
        id: 10,
        body: body.body,
        user: { login: "replace-with-your-app[bot]" },
        issue_url: "https://api.github.com/repos/example/project/issues/1",
        html_url: "https://github.com/example/project/issues/1#issuecomment-10",
      };
      comments.push(comment);
      return Response.json(comment);
    }
    if (path.endsWith("/issues/comments/10"))
      return Response.json(comments.find((comment) => comment.id === 10));
    if (path.endsWith("/comments")) {
      const url = new URL(request.url);
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      const rows = comments.slice((page - 1) * perPage, page * perPage);
      const headers =
        page * perPage < comments.length
          ? {
              link: `<https://api.github.com/repositories/9001/issues/1/comments?per_page=${perPage}&page=${page + 1}>; rel="next"`,
            }
          : {};
      return Response.json(rows, { headers });
    }
    return new Response("unexpected", { status: 404 });
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com") return originalFetch(input, init);
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
      init,
    );
    if (init?.method === "POST") {
      await response.text();
      throw new TypeError("write succeeded but connection closed before its receipt");
    }
    return response;
  });
  try {
    const project = join(fixture.root, "project");
    await mkdir(project);
    const entry = join(project, "trigger.ts");
    await writeFile(
      entry,
      `import {defineTrigger,GitHubRequestError} from "@getpaseo/hub/triggers";
export default defineTrigger({
 name:"sdk-client",runner:"test",on:[{source:"manual",event:"run"}],limits:{maxRuntime:"10m"},
 grants:{github:{repo:{connection:"github",repositories:["example/project"],permissions:{issues:"write"}}},targets:{worker:{daemon:"devbox",cwd:"/workspace/test",providers:["codex"]}}},
 async run(ctx){
  const repo=ctx.github.repo("repo","example/project");
  try { await repo.issues.get("not-found",999); throw new Error("missing expected error"); }
  catch(error){ if(!(error instanceof GitHubRequestError) || error.status!==404) throw error; }
  const publication={number:1,marker:"<!-- sdk-test:request:1 -->",author:"replace-with-your-app[bot]",perPage:1};
  const existing=await repo.comments.find("existing",publication);
  if(existing)return existing;
  const issue=await repo.issues.get("issue",1,{retry:{maxAttempts:2,initialDelayMs:0}});
  const result=await ctx.agent.run("reply",{target:"worker",agent:{provider:"codex"},prompt:JSON.stringify(issue),maxRuntime:"5m",idleTimeout:"1m",output:{schema:{type:"object",required:["reply"],properties:{reply:{type:"string"}},additionalProperties:false}}});
  return repo.comments.publishOnce("publish",{...publication,body:result.output.reply});
 }});`,
    );
    const artifact = await buildTrigger(entry);
    assert.deepEqual(
      artifact.sources.map((file) => file.path),
      ["trigger.ts"],
    );
    const deployment = await fixture.service().deploy("code-org", artifact);
    const event = {
      id: "first",
      source: "manual",
      type: "run",
      receivedAt: new Date().toISOString(),
      payload: null,
    };
    const first = await fixture.service().receive("code-org", deployment.triggerId, event);
    assert.ok(first.run);
    await fixture.execute();
    await expect.poll(() => fixture.daemon.prompts.length).toBe(1);
    const before = await fixture
      .database()
      .triggerCode.transaction("code-org", (tx) => tx.getOperation(first.run!.id, "issue"));
    assert.equal(before?.failure?.status, 503);
    assert.equal(before?.failure?.requestId, "read-1");
    assert.equal(
      (await fixture.finish(0, { output: { reply: "Verified reply" } })).isError,
      undefined,
    );
    await fixture.restart();
    await fixture.execute();
    const finished = await fixture.read(first.run.id);
    assert.equal(finished.status, "succeeded", finished.error ?? "");
    assert.ok(
      finished.output && typeof finished.output === "object" && "deduplicated" in finished.output,
    );
    assert.equal(finished.output.deduplicated, true);
    assert.equal(posts, 1);
    assert.equal(reads, 2);
    assert.equal(fixture.daemon.launches.length, 1);
    const operations = await fixture
      .database()
      .triggerCode.transaction("code-org", (tx) => tx.operations(first.run!.id));
    assert.equal(operations.find((op) => op.id === "publish:publish")?.failure?.outcome, "unknown");
    assert.equal(
      operations.find((op) => op.id === "publish:recover:readback")?.status,
      "completed",
    );
    const second = await fixture
      .service()
      .receive("code-org", deployment.triggerId, { ...event, id: "same-logical-request" });
    assert.ok(second.run);
    await fixture.execute();
    assert.equal((await fixture.read(second.run.id)).status, "succeeded");
    assert.equal(posts, 1);
    assert.equal(fixture.daemon.launches.length, 1);
    assert.equal(
      (await fixture.service().receive("code-org", deployment.triggerId, event)).created,
      false,
    );
  } finally {
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await fixture.close();
  }
}, 90_000);
