import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createTriggerContext,
  stableJson,
  githubIssueComment,
  GitHubRequestError,
  type OperationReply,
  type OperationRequest,
  type TriggerEvent,
  type TriggerTransport,
} from "./sdk.js";
import { createGitHubClient } from "./sdk-github.js";
import { requestGitHub } from "./github-transport.js";
import { errorFailure, parseTriggerFailure } from "./sdk-errors.js";

const event: TriggerEvent = {
  id: "delivery",
  source: "github",
  type: "issue_comment.created",
  connection: "github",
  resource: "example/project",
  receivedAt: "2026-11-11T00:00:00Z",
  payload: {
    action: "created",
    repository: { full_name: "example/project" },
    issue: { number: 3 },
    comment: { id: 7, body: "request", user: { login: "human", type: "User" } },
  },
};
function runtime(transport: TriggerTransport) {
  return createTriggerContext({
    runId: "run",
    event,
    startedAt: event.receivedAt,
    deadlineAt: "2099-01-01T00:00:00Z",
    secrets: {},
    transport,
  }).context;
}

describe("author-facing Trigger SDK", () => {
  it("renders stable JSON and gives ordinary JSON.stringify the same data on initial execution and storage replay", async () => {
    const journal = new Map<string, OperationReply>();
    const transport: TriggerTransport = {
      operation: async ({ id }) => journal.get(id) ?? { status: "execute" },
      complete: async (id, result) => {
        if (!("output" in result)) throw new Error(result.error);
        // JSONB changes object key order independently of the author's insertion order.
        journal.set(id, { status: "completed", output: JSON.parse(stableJson(result.output)) });
      },
      log: async () => {},
    };
    let reads = 0;
    const original = await runtime(transport).step("read", null, () => {
      reads++;
      return { z: [{ b: 2, a: 1 }], A: 4, a: 3 };
    });
    const replay = await runtime(transport).step("read", null, () => {
      throw new Error("must not execute twice");
    });
    assert.equal(reads, 1);
    assert.equal(JSON.stringify(original), JSON.stringify(replay));
    assert.equal(stableJson({ b: 2, a: 1 }, 2), '{\n  "a": 1,\n  "b": 2\n}');
    for (const invalid of [undefined, new Date(), Infinity, { nested: undefined }])
      assert.throws(() => stableJson(invalid), /JSON/u);
  });

  it("preserves structured GitHub failures after durable replay without invoking the remote operation again", async () => {
    const failure = {
      code: "GITHUB_HTTP",
      outcome: "rejected" as const,
      retryable: true,
      status: 429,
      retryAfterMs: 2000,
      requestId: "request-7",
    };
    const transport: TriggerTransport = {
      operation: async () => ({
        status: "failed",
        error: "rate limited",
        failure: parseTriggerFailure(JSON.parse(JSON.stringify(failure))),
      }),
      complete: async () => {},
      log: async () => {},
    };
    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(
        runtime(transport).github.request("read", "github", {
          method: "GET",
          path: "/repos/example/project",
        }),
        (error) => {
          assert.ok(error instanceof GitHubRequestError);
          assert.equal(error.status, 429);
          assert.equal(error.requestId, "request-7");
          assert.equal(error.operationId, "read");
          assert.equal(error.retryAfterMs, 2000);
          return true;
        },
      );
    }
  });

  it("parses issue and PR event targets without deciding mention or author policy", () => {
    assert.deepEqual(githubIssueComment(event), {
      repository: "example/project",
      number: 3,
      commentId: 7,
      body: "request",
      author: "human",
      authorType: "User",
      action: "created",
      kind: "issue",
    });
    const pull = structuredClone(event);
    assert.ok(pull.payload && typeof pull.payload === "object" && !Array.isArray(pull.payload));
    pull.payload["issue"] = { number: 3, pull_request: {} };
    assert.equal(githubIssueComment(pull)?.kind, "pull_request");
    assert.equal(githubIssueComment({ ...event, source: "manual" }), null);
    assert.throws(() => githubIssueComment({ ...event, resource: "other/repo" }), /Invalid/u);
  });
});

function githubFixture(
  options: { lostResponse?: boolean; wrongAuthor?: boolean; readbackFailure?: boolean } = {},
) {
  const comments: {
    id: number;
    body: string;
    user: { login: string };
    issue_url: string;
    html_url: string;
  }[] = [];
  const requests: { path: string; method: string }[] = [];
  const delays: number[] = [];
  let posts = 0,
    failures = 0;
  const locks = new Map<string, Promise<unknown>>();
  const client = createGitHubClient({
    async request(id, _grant, input) {
      requests.push({ path: input.path, method: input.method });
      const result = await requestGitHub(
        { ...input },
        "credential",
        "2099-01-01T00:00:00Z",
        async (url, init) => {
          const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
          if (path.endsWith("/comments") && init?.method === "POST") {
            posts++;
            assert.ok(typeof init.body === "string");
            const body: unknown = JSON.parse(init.body);
            assert.ok(
              body && typeof body === "object" && "body" in body && typeof body.body === "string",
            );
            const comment = {
              id: posts,
              body: body.body,
              user: { login: "app[bot]" },
              issue_url: "https://api.github.com/repos/example/project/issues/3",
              html_url: `https://github.com/example/project/pull/3#issuecomment-${posts}`,
            };
            comments.push(comment);
            if (options.lostResponse) throw new TypeError("response lost after write");
            return Response.json(comment);
          }
          if (path.includes("/issues/comments/")) {
            if (options.readbackFailure && failures++ === 0)
              throw new TypeError("offline readback");
            const comment = comments.find((item) => item.id === Number(path.split("/").at(-1)));
            return Response.json(
              options.wrongAuthor ? { ...comment, user: { login: "other" } } : comment,
            );
          }
          return Response.json(comments);
        },
      );
      return result;
    },
    sleep: async (_id, delay) => {
      delays.push(delay);
    },
    async withLock(_id, key, action) {
      const previous = locks.get(key) ?? Promise.resolve();
      const task = previous.then(action);
      locks.set(
        key,
        task.catch(() => {}),
      );
      return task;
    },
  });
  return { client, comments, requests, delays, posts: () => posts };
}
const publication = {
  number: 3,
  body: "Reply",
  marker: "<!-- test:source-comment:7 -->",
  author: "app[bot]",
};

describe("GitHub author helpers", () => {
  it("serializes concurrent publication, recovers a lost POST response, and verifies the actual comment", async () => {
    const f = githubFixture({ lostResponse: true });
    const repo = f.client.repo("github", "example/project");
    const [one, two] = await Promise.all([
      repo.comments.publishOnce("reply", publication),
      repo.comments.publishOnce("duplicate", publication),
    ]);
    assert.equal(f.posts(), 1);
    assert.equal(one.id, two.id);
    assert.equal(one.deduplicated, true);
    assert.equal(two.deduplicated, true);
    assert.equal(one.body, "Reply\n\n<!-- test:source-comment:7 -->");
    assert.ok(f.requests.some((row) => row.path.endsWith("/issues/comments/1")));
  });

  it("recovers a completed write after a readback outage without sending another POST", async () => {
    const f = githubFixture({ readbackFailure: true });
    const repo = f.client.repo("github", "example/project");
    await assert.rejects(repo.comments.publishOnce("first", publication), GitHubRequestError);
    const receipt = await repo.comments.publishOnce("recovery", publication);
    assert.equal(receipt.deduplicated, true);
    assert.equal(f.posts(), 1);
  });

  it("rejects a false receipt or a conflicting reuse of a publication marker", async () => {
    const wrong = githubFixture({ wrongAuthor: true });
    await assert.rejects(
      wrong.client.repo("github", "example/project").comments.publishOnce("reply", publication),
      /readback/u,
    );
    const f = githubFixture();
    const repo = f.client.repo("github", "example/project");
    await repo.comments.publishOnce("reply", publication);
    await assert.rejects(
      repo.comments.publishOnce("conflict", { ...publication, body: "Different" }),
      /readback/u,
    );
    assert.equal(f.posts(), 1);
  });

  it("follows bounded pagination for arrays and named lists, and rejects endpoint changes or partial evidence", async () => {
    const calls: string[] = [];
    const client = createGitHubClient({
      request: async (_id, _grant, request) => {
        calls.push(request.path);
        const page = Number(
          new URL(request.path, "https://api.github.com").searchParams.get("page"),
        );
        return {
          status: 200,
          headers:
            page === 1
              ? {
                  link: '<https://api.github.com/repos/example/project/actions/runs?per_page=1&page=2>; rel="next"',
                }
              : {},
          data: { total_count: 2, workflow_runs: [{ id: page }] },
        };
      },
      sleep: async () => {},
      withLock: async (_id, _key, action) => action(),
    });
    await assert.rejects(
      client.paginate("foreign", "github", {
        path: "https://evil.test/repos/example/project/issues",
      }),
      /repository API path/u,
    );
    assert.equal(calls.length, 0);
    const runs = await client
      .repo("github", "example/project")
      .actions.runs("ci", { headSha: "head" }, { perPage: 1 });
    assert.deepEqual(
      runs.map((run) => run.id),
      [1, 2],
    );
    assert.equal(calls.length, 2);
    await assert.rejects(
      client
        .repo("github", "example/project")
        .actions.runs("short", { headSha: "head" }, { maxPages: 1, perPage: 1 }),
      /maxPages/u,
    );
    await assert.rejects(
      client
        .repo("github", "example/project")
        .actions.runs("size", { headSha: "head" }, { maxItems: 1, perPage: 1 }),
      /maxItems/u,
    );
    const mismatch = createGitHubClient({
      request: async () => ({
        status: 200,
        data: [],
        headers: { link: '<https://evil.test/repos/example/project/issues?page=2>; rel="next"' },
      }),
      sleep: async () => {},
      withLock: async (_id, _key, action) => action(),
    });
    await assert.rejects(
      mismatch.paginate("bad", "github", { path: "/repos/example/project/issues" }),
      /endpoint/u,
    );
    const truncated = createGitHubClient({
      request: async () => ({ status: 200, data: { total_count: 2, rows: [1] }, headers: {} }),
      sleep: async () => {},
      withLock: async (_id, _key, action) => action(),
    });
    await assert.rejects(
      truncated.paginate("short", "github", {
        path: "/repos/example/project/issues",
        itemsKey: "rows",
      }),
      /incomplete/u,
    );
  });

  it("retries only opted-in reads, persists attempt ids and delays, and honors Retry-After bounds", async () => {
    const operations: OperationRequest[] = [];
    const context = runtime({
      operation: async (request) => {
        operations.push(request);
        if (request.kind === "sleep") return { status: "completed", output: null };
        if (request.id.includes("attempt:2")) return { status: "completed", output: { ok: true } };
        return {
          status: "failed",
          error: "rate limited",
          failure: {
            code: "GITHUB_HTTP",
            outcome: "rejected",
            retryable: true,
            status: 429,
            retryAfterMs: 2000,
          },
        };
      },
      complete: async () => {},
      log: async () => {},
    });
    await assert.rejects(
      context.github.request("once", "github", { method: "GET", path: "/repos/example/project" }),
      GitHubRequestError,
    );
    assert.deepEqual(
      await context.github.request(
        "retry",
        "github",
        { method: "GET", path: "/repos/example/project" },
        { retry: { maxAttempts: 2 } },
      ),
      { ok: true },
    );
    assert.deepEqual(
      operations.slice(1).map((item) => item.id),
      ["retry", "retry:delay:2", "retry:attempt:2"],
    );
    assert.deepEqual(operations[2]?.input, { milliseconds: 2000 });
    await assert.rejects(
      context.github.request(
        "budget",
        "github",
        { method: "GET", path: "/repos/example/project" },
        { retry: { maxAttempts: 2, maxDelayMs: 1500 } },
      ),
      GitHubRequestError,
    );
    const before = operations.length;
    await assert.rejects(
      context.github.request(
        "write",
        "github",
        { method: "POST", path: "/repos/example/project/issues", body: {} },
        { retry: { maxAttempts: 2 } },
      ),
      /only supported for GET/u,
    );
    assert.equal(operations.length, before);
  });

  it("never retries or exposes an unconfirmed external write as success", async () => {
    let posts = 0;
    const f = createGitHubClient({
      request: async (_id, _grant, request) => {
        if (request.method === "POST") {
          posts++;
          throw new GitHubRequestError("unknown", {
            code: "GITHUB_TRANSPORT",
            outcome: "unknown",
            retryable: false,
          });
        }
        return { status: 200, data: [], headers: {} };
      },
      sleep: async () => {},
      withLock: async (_id, _key, action) => action(),
    });
    await assert.rejects(
      f.repo("github", "example/project").comments.publishOnce("reply", publication),
      /unknown/u,
    );
    assert.equal(posts, 1);
  });

  it("reports safe HTTP and rate-limit metadata without retaining response bodies or credentials", async () => {
    await assert.rejects(
      requestGitHub(
        { method: "GET", path: "/repos/example/project" },
        "secret",
        "2099-01-01T00:00:00Z",
        async () =>
          new Response("sensitive body", {
            status: 403,
            headers: { "retry-after": "2", "x-github-request-id": "request-1" },
          }),
      ),
      (error) => {
        assert.ok(error instanceof GitHubRequestError);
        assert.equal(error.status, 403);
        assert.equal(error.retryAfterMs, 2000);
        assert.equal(errorFailure(error)?.retryable, true);
        assert.ok(!JSON.stringify(error).includes("secret"));
        assert.ok(!JSON.stringify(error).includes("sensitive body"));
        return true;
      },
    );
  });
});
